#!/usr/bin/env python3
"""
batch_diarize.py — Батч-обработка файлов через GPU (diarize_server)
Запускать на 🟢 Веб-сервере из /tmp/batch_diarize.py
Файлы копируются на GPU по SCP, обрабатываются, результат пишется в БД.
"""

import subprocess
import json
import sqlite3
import sys
import time
import os

# ═══════════════════════════════════════════════════
# Конфигурация
# ═══════════════════════════════════════════════════

DB_PATH = "/opt/transcribe/data/db/transcribe.db"
UPLOADS_PATH = "/opt/transcribe/data/uploads"
GPU_HOST = "ubuntu@195.209.214.7"
GPU_WORK_DIR = "/tmp/transcribe_batch"
DIARIZE_URL = "http://localhost:8002/diarize"

# 7 файлов Группы 3 — ID → filename (UUID на диске)
JOBS = [
    {"job_id": "81df1ed3-a06f-460a-9054-051d29fe803f", "disk_name": "8c6dd41f-9b5d-4654-a3dd-497e124945e0.mp3", "label": "day01_NA"},
    {"job_id": "4b04cd88-ac98-4e75-a6b7-c457f1b32a79", "disk_name": "69d074c5-d03f-417b-9c80-1b4499158f0f.mp3", "label": "day03_M5"},
    {"job_id": "08418459-e6f9-4b8a-b4fe-b339078375a1", "disk_name": "75f83d5b-166e-4b0a-9714-ac950d883d59.mp3", "label": "day03_NA"},
    {"job_id": "d68a11d5-a4ce-4004-9457-921b6991d175", "disk_name": "6e00c1a9-b15a-45ba-b28a-9941d1216851.mp3", "label": "day07_NA"},
    {"job_id": "f6b2dae5-2d14-4e73-b157-42bd465950a9", "disk_name": "7e55e895-c4da-4338-9e50-13e7ac633067.mp3", "label": "day09_NA"},
    {"job_id": "8d911c37-f417-428e-873d-bd8ca36c0638", "disk_name": "8f0f3e79-dd34-44b4-872b-10f866b600f7.mp3", "label": "day10_NA"},
    {"job_id": "991e7644-dd66-4635-9b9f-4194dcedd456", "disk_name": "9f42799c-3bfb-4791-97de-208c49bdbbd0.mp3", "label": "day17_NA"},
]


# ═══════════════════════════════════════════════════
# Конвертация diarize JSON → SRT
# ═══════════════════════════════════════════════════

def seconds_to_srt_time(seconds):
    """Конвертирует секунды в формат SRT: HH:MM:SS,mmm"""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds - int(seconds)) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def segments_to_srt(segments):
    """Конвертирует массив сегментов diarize в SRT формат с голосами"""
    lines = []
    for i, seg in enumerate(segments, 1):
        start = seconds_to_srt_time(seg["start"])
        end = seconds_to_srt_time(seg["end"])
        speaker = seg.get("speaker", "Голос ?")
        text = seg.get("text", "").strip()
        lines.append(f"{i}")
        lines.append(f"{start} --> {end}")
        lines.append(f"{speaker}: {text}")
        lines.append("")
    return "\n".join(lines)


def segments_to_clean(segments):
    """Конвертирует сегменты в чистый текст с голосами (без таймкодов)"""
    lines = []
    for seg in segments:
        speaker = seg.get("speaker", "Голос ?")
        text = seg.get("text", "").strip()
        if text:
            lines.append(f"{speaker}: {text}")
    return "\n\n".join(lines)


# ═══════════════════════════════════════════════════
# Утилиты
# ═══════════════════════════════════════════════════

def run_cmd(cmd, timeout=None):
    """Запуск команды, возврат (returncode, stdout, stderr)"""
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout.strip(), r.stderr.strip()
    except subprocess.TimeoutExpired:
        return -1, "", "TIMEOUT"


def log(msg):
    ts = time.strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


# ═══════════════════════════════════════════════════
# Основной цикл
# ═══════════════════════════════════════════════════

def main():
    # Проверка доступности GPU
    rc, out, _ = run_cmd(f'ssh -o ConnectTimeout=5 {GPU_HOST} "curl -s http://localhost:8002/health"')
    if rc != 0 or out != "ok":
        log(f"ОШИБКА: GPU diarize не отвечает (rc={rc}, out={out})")
        sys.exit(1)
    log("GPU diarize: OK")

    # Создать рабочую папку на GPU
    run_cmd(f'ssh {GPU_HOST} "mkdir -p {GPU_WORK_DIR}"')

    # Подключение к БД
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    total = len(JOBS)
    success = 0
    errors = []

    for i, job in enumerate(JOBS, 1):
        job_id = job["job_id"]
        disk_name = job["disk_name"]
        label = job["label"]
        local_path = f"{UPLOADS_PATH}/{disk_name}"
        remote_path = f"{GPU_WORK_DIR}/{disk_name}"
        result_path = f"{GPU_WORK_DIR}/result_{label}.json"

        log(f"═══ [{i}/{total}] {label} ({disk_name}) ═══")

        # Проверить что файл есть на диске
        if not os.path.exists(local_path):
            log(f"  ОШИБКА: файл не найден: {local_path}")
            errors.append(label)
            continue

        size_mb = os.path.getsize(local_path) / 1024 / 1024
        log(f"  Файл: {size_mb:.0f} MB")

        # SCP на GPU
        log(f"  SCP → GPU...")
        t0 = time.time()
        rc, _, err = run_cmd(f'scp {local_path} {GPU_HOST}:{remote_path}', timeout=300)
        if rc != 0:
            log(f"  ОШИБКА SCP: {err}")
            errors.append(label)
            continue
        log(f"  SCP: {time.time()-t0:.0f}s")

        # Запуск diarize
        log(f"  Diarize...")
        t0 = time.time()
        rc, out, err = run_cmd(
            f'ssh {GPU_HOST} "curl -s -X POST {DIARIZE_URL} '
            f'-F \'file=@{remote_path}\' '
            f'-o {result_path} '
            f'-w \'%{{http_code}}\'"',
            timeout=3600  # макс 1 час на файл
        )
        elapsed = time.time() - t0

        if rc != 0 or out != "200":
            log(f"  ОШИБКА diarize: rc={rc}, http={out}, err={err[:200]}")
            errors.append(label)
            continue
        log(f"  Diarize: {elapsed:.0f}s (HTTP {out})")

        # Скачать результат
        log(f"  Скачиваем результат...")
        local_result = f"/tmp/result_{label}.json"
        rc, _, err = run_cmd(f'scp {GPU_HOST}:{result_path} {local_result}', timeout=60)
        if rc != 0:
            log(f"  ОШИБКА скачивания: {err}")
            errors.append(label)
            continue

        # Парсить и конвертировать
        try:
            with open(local_result, 'r') as f:
                data = json.load(f)

            segments = data.get("segments", [])
            plain_text = data.get("plain_text", "")
            stats = data.get("stats", {})

            if not segments:
                log(f"  ОШИБКА: пустые сегменты!")
                errors.append(label)
                continue

            result_srt = segments_to_srt(segments)
            result_clean = segments_to_clean(segments)
            result_json = json.dumps(data, ensure_ascii=False)
            duration_sec = stats.get("duration_sec")

            log(f"  Сегментов: {len(segments)}, SRT: {len(result_srt)} символов, Clean: {len(result_clean)} символов")

        except Exception as e:
            log(f"  ОШИБКА парсинга: {e}")
            errors.append(label)
            continue

        # Записать в БД (НЕ трогаем result_txt — саммари уже есть!)
        try:
            conn.execute(
                "UPDATE jobs SET result_srt=?, result_json=?, result_clean=?, duration_sec=? WHERE id=?",
                (result_srt, result_json, result_clean, duration_sec, job_id)
            )
            conn.commit()
            log(f"  БД обновлена ✓")
            success += 1
        except Exception as e:
            log(f"  ОШИБКА записи в БД: {e}")
            errors.append(label)
            continue

        # Удалить файл с GPU (экономим место)
        run_cmd(f'ssh {GPU_HOST} "rm -f {remote_path} {result_path}"')
        # Удалить локальный результат
        os.unlink(local_result)

        log(f"  Готово ✓ ({elapsed:.0f}s)")

    # Итоги
    log(f"═══════════════════════════════════════")
    log(f"Итого: {success}/{total} успешно")
    if errors:
        log(f"Ошибки: {', '.join(errors)}")
    else:
        log(f"Все файлы обработаны без ошибок!")

    conn.close()


if __name__ == "__main__":
    main()
