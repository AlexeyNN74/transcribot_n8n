#!/usr/bin/env python3
"""
process_single.py — Обработка одного файла: SCP → GPU diarize → Claude API → JSON
Запускается из n8n (Execute Command) или вручную.

Использование:
  python3 process_single.py <filename> [--diarize 1] [--min-speakers N] [--max-speakers N] [--noise-filter X]

Вывод: JSON в stdout с полями result_txt, result_srt, result_json, result_clean
Ошибки: в stderr

Требует:
  - SSH доступ к GPU (ключ web-to-gpu)
  - ANTHROPIC_API_KEY в env (для саммари)
  - Файл в /opt/transcribe/data/uploads/<filename>
"""

import subprocess
import json
import sys
import time
import os
import argparse
import urllib.request
import urllib.error

# ═══════════════════════════════════════════════════
# Конфигурация
# ═══════════════════════════════════════════════════

UPLOADS_PATH = "/opt/transcribe/data/uploads"
GPU_HOST = "ubuntu@195.209.214.7"
GPU_WORK_DIR = "/tmp/transcribe_batch"
DIARIZE_URL = "http://localhost:8002/diarize"
WHISPER_URL = "http://localhost:8000/v1/audio/transcriptions"
CLAUDE_API_URL = "https://api.anthropic.com/v1/messages"
CLAUDE_MODEL = "claude-haiku-4-5-20251001"
CHUNK_SIZE = 15000

CLAUDE_SYSTEM = """Ты — программа-конспектировщик аудиозаписей. Ты получаешь транскрипцию группового занятия по психологии и возвращаешь структурированный конспект.

Формат ответа:

Саммари:
[3-5 предложений — о чём запись в целом]

Ключевые темы:
- [тема 1]
- [тема 2]

Участники:
- [имена и роли, если упоминаются в записи]

Основные тезисы:
- [тезис 1]
- [тезис 2]

Правила:
- Пиши только конспект
- Не обращайся к собеседнику
- Сохраняй имена и факты точно
- Язык — русский"""


def log(msg):
    """Логи в stderr, stdout только для JSON-результата"""
    sys.stderr.write(f"[{time.strftime('%H:%M:%S')}] {msg}\n")
    sys.stderr.flush()


def run_cmd(cmd, timeout=None):
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout.strip(), r.stderr.strip()
    except subprocess.TimeoutExpired:
        return -1, "", "TIMEOUT"


# ═══════════════════════════════════════════════════
# SRT конвертация
# ═══════════════════════════════════════════════════

def seconds_to_srt_time(seconds):
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds - int(seconds)) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def segments_to_srt(segments):
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
    lines = []
    for seg in segments:
        speaker = seg.get("speaker", "Голос ?")
        text = seg.get("text", "").strip()
        if text:
            lines.append(f"{speaker}: {text}")
    return "\n\n".join(lines)


# ═══════════════════════════════════════════════════
# Whisper (без диаризации)
# ═══════════════════════════════════════════════════

def process_whisper(remote_path, result_path):
    """Whisper без диаризации — для файлов без diarize флага"""
    log("Whisper transcription...")

    rc, out, err = run_cmd(
        f'ssh {GPU_HOST} "curl -s -X POST {WHISPER_URL} '
        f'-F \'file=@{remote_path}\' '
        f'-F \'model=deepdml/faster-whisper-large-v3-turbo-ct2\' '
        f'-F \'response_format=verbose_json\' '
        f'-F \'language=ru\' '
        f'-F \'vad_filter=true\' '
        f'-o {result_path} '
        f'-w \'%{{http_code}}\'"',
        timeout=7200
    )

    if rc != 0 or out != "200":
        return None, f"Whisper error: rc={rc}, http={out}"

    # Скачать результат
    local_result = f"/tmp/whisper_result_{os.getpid()}.json"
    rc, _, _ = run_cmd(f'scp {GPU_HOST}:{result_path} {local_result}', timeout=60)
    if rc != 0:
        return None, "SCP result failed"

    with open(local_result, 'r') as f:
        data = json.load(f)
    os.unlink(local_result)

    segments = data.get("segments", [])

    # Конвертация в SRT (без спикеров)
    srt_lines = []
    clean_lines = []
    clean_segs = []
    for i, seg in enumerate(segments, 1):
        text = seg.get("text", "").strip()
        if not text or len(text) < 3:
            continue
        start = seconds_to_srt_time(seg["start"])
        end = seconds_to_srt_time(seg["end"])
        srt_lines.append(f"{i}\n{start} --> {end}\n{text}\n")
        clean_lines.append(text)
        clean_segs.append({"start": seg["start"], "end": seg["end"], "text": text})

    return {
        "result_srt": "\n".join(srt_lines),
        "result_clean": "\n".join(clean_lines),
        "result_json": json.dumps(clean_segs, ensure_ascii=False),
        "duration_sec": segments[-1]["end"] if segments else None
    }, None


# ═══════════════════════════════════════════════════
# Diarize (с диаризацией)
# ═══════════════════════════════════════════════════

def process_diarize(remote_path, result_path, min_speakers=None, max_speakers=None, noise_filter=None):
    """Diarize — полная обработка с разделением по спикерам"""
    log("Diarize transcription...")

    extra_fields = ""
    if min_speakers:
        extra_fields += f" -F 'min_speakers={min_speakers}'"
    if max_speakers:
        extra_fields += f" -F 'max_speakers={max_speakers}'"
    if noise_filter:
        extra_fields += f" -F 'noise_filter={noise_filter}'"

    rc, out, err = run_cmd(
        f'ssh {GPU_HOST} "curl -s -X POST {DIARIZE_URL} '
        f'-F \'file=@{remote_path}\'{extra_fields} '
        f'-o {result_path} '
        f'-w \'%{{http_code}}\'"',
        timeout=7200
    )

    if rc != 0 or out != "200":
        return None, f"Diarize error: rc={rc}, http={out}"

    # Скачать результат
    local_result = f"/tmp/diarize_result_{os.getpid()}.json"
    rc, _, _ = run_cmd(f'scp {GPU_HOST}:{result_path} {local_result}', timeout=60)
    if rc != 0:
        return None, "SCP result failed"

    with open(local_result, 'r') as f:
        data = json.load(f)
    os.unlink(local_result)

    segments = data.get("segments", [])
    if not segments:
        return None, "Empty segments"

    return {
        "result_srt": segments_to_srt(segments),
        "result_clean": segments_to_clean(segments),
        "result_json": json.dumps(data, ensure_ascii=False),
        "duration_sec": data.get("stats", {}).get("duration_sec")
    }, None


# ═══════════════════════════════════════════════════
# Claude API саммари
# ═══════════════════════════════════════════════════

def smart_sample(text):
    total = len(text)
    if total <= CHUNK_SIZE * 3:
        return text
    start = text[:CHUNK_SIZE]
    mid_pos = total // 2 - CHUNK_SIZE // 2
    middle = text[mid_pos:mid_pos + CHUNK_SIZE]
    end = text[-CHUNK_SIZE:]
    return (
        "=== НАЧАЛО ЗАПИСИ ===\n" + start +
        "\n\n=== СЕРЕДИНА ЗАПИСИ ===\n" + middle +
        "\n\n=== КОНЕЦ ЗАПИСИ ===\n" + end
    )


def generate_summary(clean_text, api_key):
    """Генерирует саммари через Claude API"""
    if not api_key:
        log("Нет ANTHROPIC_API_KEY — пропускаем саммари")
        return "(саммари не создано — нет API ключа)"

    sampled = smart_sample(clean_text)
    log(f"Claude API: {len(clean_text)} → {len(sampled)} символов")

    payload = json.dumps({
        "model": CLAUDE_MODEL,
        "max_tokens": 2000,
        "system": CLAUDE_SYSTEM,
        "messages": [{
            "role": "user",
            "content": f"Составь конспект этой аудиозаписи:\n\n{sampled}"
        }]
    }).encode("utf-8")

    req = urllib.request.Request(
        CLAUDE_API_URL,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01"
        },
        method="POST"
    )

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            parts = [c["text"] for c in data.get("content", []) if c.get("type") == "text"]
            return "\n".join(parts).strip()
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:300]
        log(f"Claude HTTP {e.code}: {body}")
        return f"(ошибка Claude API: HTTP {e.code})"
    except Exception as e:
        log(f"Claude error: {e}")
        return f"(ошибка Claude API: {e})"


# ═══════════════════════════════════════════════════
# Главная функция
# ═══════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("filename", help="UUID filename in uploads/")
    parser.add_argument("--diarize", type=int, default=1, help="1=diarize, 0=whisper only")
    parser.add_argument("--min-speakers", type=int, default=None)
    parser.add_argument("--max-speakers", type=int, default=None)
    parser.add_argument("--noise-filter", type=str, default=None)
    args = parser.parse_args()

    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    filename = args.filename
    local_path = os.path.join(UPLOADS_PATH, filename)
    remote_path = f"{GPU_WORK_DIR}/{filename}"
    result_path = f"{GPU_WORK_DIR}/result_{os.getpid()}.json"

    if not os.path.exists(local_path):
        print(json.dumps({"error": f"File not found: {local_path}"}))
        sys.exit(1)

    size_mb = os.path.getsize(local_path) / 1024 / 1024
    log(f"File: {filename} ({size_mb:.0f} MB), diarize={args.diarize}")

    # 1. Проверка GPU
    rc, out, _ = run_cmd(f'ssh -o ConnectTimeout=10 {GPU_HOST} "curl -s http://localhost:8002/health"', timeout=15)
    if rc != 0 or out != "ok":
        print(json.dumps({"error": "GPU diarize not responding"}))
        sys.exit(1)
    log("GPU: OK")

    # 2. SCP на GPU
    run_cmd(f'ssh {GPU_HOST} "mkdir -p {GPU_WORK_DIR}"')
    log("SCP...")
    t0 = time.time()
    rc, _, err = run_cmd(f'scp {local_path} {GPU_HOST}:{remote_path}', timeout=600)
    if rc != 0:
        print(json.dumps({"error": f"SCP failed: {err}"}))
        sys.exit(1)
    log(f"SCP: {time.time()-t0:.0f}s")

    # 3. Транскрипция
    t0 = time.time()
    if args.diarize:
        result, error = process_diarize(
            remote_path, result_path,
            args.min_speakers, args.max_speakers, args.noise_filter
        )
    else:
        result, error = process_whisper(remote_path, result_path)

    if error:
        print(json.dumps({"error": error}))
        # Чистим GPU
        run_cmd(f'ssh {GPU_HOST} "rm -f {remote_path} {result_path}"')
        sys.exit(1)

    elapsed = time.time() - t0
    log(f"Transcription: {elapsed:.0f}s, SRT={len(result['result_srt'])} chars")

    # 4. Claude API саммари
    summary = generate_summary(result["result_clean"], api_key)
    timestamp = time.strftime("%d.%m.%Y, %H:%M:%S")
    result_txt = f"Обработано: {timestamp}\n{'═' * 60}\n{summary}"
    log(f"Summary: {len(summary)} chars")

    # 5. Чистим GPU
    run_cmd(f'ssh {GPU_HOST} "rm -f {remote_path} {result_path}"')

    # 6. Вывод JSON в stdout
    output = {
        "result_txt": result_txt,
        "result_srt": result["result_srt"],
        "result_json": result["result_json"],
        "result_clean": result["result_clean"],
        "duration_sec": result.get("duration_sec"),
        "processing_sec": elapsed
    }
    print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    main()
