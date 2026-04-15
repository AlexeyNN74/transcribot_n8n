#!/usr/bin/env python3
"""
task_runner.py — Хостовый обработчик задач
Запуск: cron каждую минуту на 🟢 веб-сервере

Архитектура:
  n8n (Docker) → пишет task-файл в /opt/transcribe/data/tasks/
  task_runner.py (хост, cron) → подхватывает → SCP → GPU → Claude → БД

Cron:
  * * * * * ANTHROPIC_API_KEY=sk-ant-... /usr/bin/python3 /opt/transcribe/app/scripts/task_runner.py >> /opt/transcribe/data/tasks/runner.log 2>&1
"""

import json
import sqlite3
import subprocess
import sys
import time
import os
import glob
import fcntl
import uuid

# ═══════════════════════════════════════════════════
# Конфигурация
# ═══════════════════════════════════════════════════

TASKS_DIR = "/opt/transcribe/data/tasks"
LOCK_FILE = "/opt/transcribe/data/tasks/.runner.lock"
DB_PATH = "/opt/transcribe/data/db/transcribe.db"
PROCESS_SCRIPT = "/opt/transcribe/app/scripts/process_single.py"
GPU_HOST = "ubuntu@195.209.214.7"

# GPU management через Node.js в контейнере
SHELVE_CMD = 'docker exec transcribe_app node -e "const {gpuDoAction}=require(\'./routes/admin\');gpuDoAction(\'shelve\').then(()=>console.log(\'OK\')).catch(e=>console.error(e.message));"'
UNSHELVE_CMD = 'docker exec transcribe_app node -e "const {gpuDoAction}=require(\'./routes/admin\');gpuDoAction(\'unshelve\').then(()=>console.log(\'OK\')).catch(e=>console.error(e.message));"'
GPU_STATUS_CMD = 'docker exec transcribe_app node -e "const {gpuGetStatus}=require(\'./routes/admin\');gpuGetStatus().then(s=>console.log(JSON.stringify(s))).catch(e=>console.error(e.message));"'


def log(msg):
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def run_cmd(cmd, timeout=None):
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout.strip(), r.stderr.strip()
    except subprocess.TimeoutExpired:
        return -1, "", "TIMEOUT"


# ═══════════════════════════════════════════════════
# GPU management
# ═══════════════════════════════════════════════════

def get_gpu_status():
    """Возвращает статус GPU: ACTIVE, SHELVED_OFFLOADED, и т.д."""
    rc, out, err = run_cmd(GPU_STATUS_CMD, timeout=30)
    if rc != 0:
        log(f"GPU status error: {err}")
        return "UNKNOWN"
    try:
        data = json.loads(out)
        return data if isinstance(data, str) else data.get("status", "UNKNOWN")
    except:
        return "UNKNOWN"


def ensure_gpu_active():
    """Убеждается что GPU активен, unshelve если нужно"""
    status = get_gpu_status()
    log(f"GPU status: {status}")

    if status == "ACTIVE":
        return True

    if "SHELVED" in status:
        log("Unshelving GPU...")
        rc, out, err = run_cmd(UNSHELVE_CMD, timeout=30)
        log(f"Unshelve: {out} {err}")

        # Ждём до 3 минут
        for i in range(18):
            time.sleep(10)
            status = get_gpu_status()
            if status == "ACTIVE":
                log(f"GPU active after {(i+1)*10}s")
                # Ждём ещё 30 сек для старта сервисов
                time.sleep(30)
                return True
            log(f"  Waiting... ({status})")

        log("GPU не проснулся за 3 минуты!")
        return False

    log(f"Неизвестный статус GPU: {status}")
    return False


def check_gpu_services():
    """Проверяет что diarize и whisper отвечают"""
    rc, out, _ = run_cmd(f'ssh -o ConnectTimeout=10 {GPU_HOST} "curl -s http://localhost:8002/health"', timeout=15)
    if rc != 0 or out != "ok":
        log(f"Diarize not ready: {out}")
        # Ждём ещё
        for i in range(6):
            time.sleep(10)
            rc, out, _ = run_cmd(f'ssh -o ConnectTimeout=5 {GPU_HOST} "curl -s http://localhost:8002/health"', timeout=10)
            if out == "ok":
                return True
        return False
    return True


def shelve_gpu():
    """Отправляет GPU на полку"""
    log("Shelving GPU...")
    rc, out, err = run_cmd(SHELVE_CMD, timeout=30)
    log(f"Shelve: {out} {err}")


# ═══════════════════════════════════════════════════
# GPU session tracking
# ═══════════════════════════════════════════════════

_current_session_id = None

def gpu_session_start():
    """Создаёт запись о начале GPU-сессии"""
    global _current_session_id
    sid = str(uuid.uuid4())
    _current_session_id = sid
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.execute(
            "INSERT INTO gpu_sessions (id, unshelve_at, trigger_type, status) VALUES (?, datetime('now'), 'auto', 'active')",
            (sid,)
        )
        conn.commit()
        conn.close()
        log(f"GPU session started: {sid[:8]}")
    except Exception as e:
        log(f"GPU session start error: {e}")
    return sid


def gpu_session_end(job_ids_list):
    """Закрывает текущую GPU-сессию"""
    global _current_session_id
    sid = _current_session_id
    if not sid:
        return
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.execute(
            """UPDATE gpu_sessions SET
                shelve_at=datetime('now'),
                duration_sec=CAST((julianday(datetime('now')) - julianday(unshelve_at)) * 86400 AS REAL),
                jobs_count=?,
                job_ids=?,
                status='closed'
               WHERE id=?""",
            (len(job_ids_list), json.dumps(job_ids_list), sid)
        )
        conn.commit()
        conn.close()
        log(f"GPU session closed: {sid[:8]}, jobs={len(job_ids_list)}")
    except Exception as e:
        log(f"GPU session end error: {e}")
    _current_session_id = None


# ═══════════════════════════════════════════════════
# Обработка задач
# ═══════════════════════════════════════════════════

def process_task(task_file):
    """Обрабатывает один task-файл"""
    with open(task_file, 'r') as f:
        task = json.load(f)

    filename = task["filename"]
    diarize = task.get("diarize", 1)
    min_speakers = task.get("min_speakers")
    max_speakers = task.get("max_speakers")
    noise_filter = task.get("noise_filter")

    log(f"Processing: {filename} (diarize={diarize})")

    # Собираем аргументы
    args = [sys.executable, PROCESS_SCRIPT, filename, f"--diarize={diarize}"]
    if min_speakers:
        args.append(f"--min-speakers={min_speakers}")
    if max_speakers:
        args.append(f"--max-speakers={max_speakers}")
    if noise_filter:
        args.append(f"--noise-filter={noise_filter}")

    # Запуск process_single.py
    env = os.environ.copy()
    try:
        result = subprocess.run(
            args, capture_output=True, text=True,
            timeout=7200, env=env  # 2 часа макс
        )
    except subprocess.TimeoutExpired:
        log(f"TIMEOUT processing {filename}")
        return False

    if result.returncode != 0:
        log(f"ERROR processing {filename}: {result.stderr[-300:]}")
        # Логируем stderr (progress messages)
        for line in result.stderr.strip().split('\n')[-5:]:
            log(f"  {line}")
        return False

    # Парсим JSON из stdout
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        log(f"Invalid JSON output: {result.stdout[:200]}")
        return False

    if "error" in data:
        log(f"Process error: {data['error']}")
        return False

    # Пишем в БД
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute(
            """UPDATE jobs SET
                status='completed',
                result_txt=?, result_srt=?, result_json=?, result_clean=?,
                duration_sec=?, completed_at=datetime('now')
               WHERE filename=?""",
            (
                data["result_txt"],
                data["result_srt"],
                data["result_json"],
                data["result_clean"],
                data.get("duration_sec"),
                filename
            )
        )
        conn.commit()
        log(f"DB updated: {filename}")
    except Exception as e:
        log(f"DB error: {e}")
        conn.close()
        return False
    conn.close()

    # Удаляем task-файл
    os.unlink(task_file)
    log(f"Task done: {filename} ({data.get('processing_sec', '?')}s)")
    return True


# ═══════════════════════════════════════════════════
# Главный цикл
# ═══════════════════════════════════════════════════

def main():
    os.makedirs(TASKS_DIR, exist_ok=True)

    # Singleton lock — не запускать два runner одновременно
    lock_fd = open(LOCK_FILE, 'w')
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except IOError:
        # Другой runner уже работает
        sys.exit(0)

    # Ищем task-файлы
    tasks = sorted(glob.glob(os.path.join(TASKS_DIR, "*.json")))
    # Исключаем служебные файлы
    tasks = [t for t in tasks if not os.path.basename(t).startswith('.')]

    if not tasks:
        lock_fd.close()
        sys.exit(0)

    log(f"Found {len(tasks)} task(s)")

    # Поднимаем GPU
    if not ensure_gpu_active():
        log("GPU не доступен — задачи откладываются")
        lock_fd.close()
        sys.exit(1)

    # Начинаем GPU-сессию
    gpu_session_start()

    if not check_gpu_services():
        log("GPU сервисы не готовы — задачи откладываются")
        lock_fd.close()
        sys.exit(1)

    # Обрабатываем задачи
    success = 0
    processed_filenames = []
    for task_file in tasks:
        # Читаем filename из task для отчёта
        try:
            with open(task_file, 'r') as f:
                task_data = json.load(f)
            fname = task_data.get("filename", os.path.basename(task_file))
        except:
            fname = os.path.basename(task_file)

        if process_task(task_file):
            success += 1
            processed_filenames.append(fname)
        else:
            # При ошибке — не продолжаем, разберёмся в следующем запуске
            break

    # Проверяем, остались ли задачи
    remaining = [t for t in glob.glob(os.path.join(TASKS_DIR, "*.json"))
                 if not os.path.basename(t).startswith('.')]

    if not remaining:
        log("Queue empty — shelving GPU")
        gpu_session_end(processed_filenames)
        shelve_gpu()
    else:
        log(f"Remaining tasks: {len(remaining)} — GPU stays active")

    log(f"Done: {success}/{len(tasks)}")
    lock_fd.close()


if __name__ == "__main__":
    main()
