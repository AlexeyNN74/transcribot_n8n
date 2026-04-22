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

CLAUDE_SYSTEM = """Ты — программа-конспектировщик аудиозаписей. Перед тобой транскрипция разговорной аудиозаписи.

Формат ответа — строго по пунктам:
1. Тема записи (2–3 предложения о содержании и жанре).
2. Ключевые тезисы — маркированный список. Если есть метки «Голос 1», «Голос 2» — сохраняй их: «- Голос 1: …».
3. Основные выводы и рекомендации — маркированный список. Если рекомендаций нет — опусти пункт.
4. Интересные или спорные моменты. Если таких нет — опусти пункт.

Правила: без вводных фраз, без обращения «вы/вам», имена и термины — точно, язык = язык записи, plain text без markdown-заголовков.

ВАЖНО: этот промпт используется ТОЛЬКО как fallback для process_single.py (ручной запуск).
Основной pipeline — gpu-pipeline.js — берёт промпт из БД (jobs.prompt_text / prompts)."""


# ═══════════════════════════════════════════════════
# ⚠️  НЕ УДАЛЯТЬ И НЕ УПРОЩАТЬ  ⚠️
#
# Whisper anti-hallucination (v1.9.14 — 2026-04-22, git tag v1.9.14)
#
# Параметры prompt / condition_on_previous_text / compression_ratio_threshold /
# no_speech_threshold / temperature + функция filter_whisper_parasites() —
# это ЗАЩИТА ОТ YouTube-СУБТИТРОВЫХ ГАЛЛЮЦИНАЦИЙ ("Субтитры создавал ..." и т.п.).
#
# Упрощение параметров или удаление фильтра СЛОМАЕТ транскрипцию.
# Если собираешься рефакторить этот блок — сначала прочитай:
#   - коммит cfa7332 (описание проблемы и лечения)
#   - prompts/universal.txt (эталонный текст дефолтного профиля)
# ═══════════════════════════════════════════════════

# Нейтральный initial_prompt — уводит модель от YouTube-субтитровых паттернов,
# не привязывая к конкретному домену (психология/лекция/интервью).
WHISPER_PROMPT = "Это аудиозапись на русском языке. Говорящие произносят связные фразы естественной речи."

import re as _re

# Известные паразитные фразы, которые Whisper-large-v3 галлюцинирует
# на длинной тишине/шуме (в основном — паттерны YouTube-субтитров).
WHISPER_PARASITE_PATTERNS = [_re.compile(p, _re.IGNORECASE) for p in [
    r'субтитры\s+(создавал|создал|подготовил|подготовлены|сделал|сделаны|выполнены|редактировал)',
    r'корректор\s+субтитров',
    r'редактор\s+субтитров',
    r'перевод(?:ил|чик)?\s+[А-ЯA-Z][^.]{0,30}',
    r'озвучив(?:ание|ал(?:а)?)\s+[А-ЯA-Z][^.]{0,30}',
    r'продолжение\s+следует',
    r'(?:спасибо|благодарим)\s+за\s+(?:просмотр|внимание)',
    r'подписывайтесь\s+на\s+(?:наш\s+)?канал',
    r'ставьте\s+(?:лайк|лайки|палец\s+вверх)',
    r'ещё\s+больше\s+на\s+канале',
    r'(?:больше|ещё)\s+видео\s+на\s+(?:канале|сайте)',
    r'dima\s*torzok',
    r'allsubtitles',
    r'amara\.org',
    r'субтитры\s+[А-ЯA-Z][^.]{0,40}\.(?:ru|com|org|net)',
]]


def _is_whisper_parasite(text):
    """True, если текст — известная паразитная галлюцинация Whisper."""
    if not text:
        return False
    t = text.strip().lower().rstrip('.!?…—- ')
    if not t or len(t) < 8:
        return False
    for pat in WHISPER_PARASITE_PATTERNS:
        m = pat.search(t)
        if m and (m.end() - m.start()) >= len(t) * 0.5:
            return True
    return False


def filter_whisper_parasites(segments):
    """
    Чистит сегменты от паразитов Whisper. Возвращает (очищенные, число_удалённых).
    Правила:
      1. Срезаем паразиты с хвоста (чаще всего именно там).
      2. Срезаем паразиты с начала.
      3. Защита от зацикливания: >=3 одинаковых коротких повторов в хвосте.
    """
    if not segments:
        return segments, 0
    result = list(segments)
    removed = 0

    while result and _is_whisper_parasite(result[-1].get('text', '')):
        log(f"[parasite] tail: {(result[-1].get('text') or '')[:80]!r}")
        result.pop()
        removed += 1

    while result and _is_whisper_parasite(result[0].get('text', '')):
        log(f"[parasite] head: {(result[0].get('text') or '')[:80]!r}")
        result.pop(0)
        removed += 1

    if len(result) >= 3:
        last = (result[-1].get('text') or '').strip()
        if 0 < len(last) <= 60:
            same = 0
            for s in reversed(result):
                if (s.get('text') or '').strip() == last:
                    same += 1
                else:
                    break
            if same >= 3:
                log(f"[parasite] loop x{same}: {last!r}")
                result = result[:-same]
                removed += same

    return result, removed


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
# T-2: Retry с экспоненциальным backoff
# ═══════════════════════════════════════════════════

MAX_RETRIES = 3

def retry(fn, label, retries=MAX_RETRIES, backoff=10):
    """Обёртка для повторных попыток. fn() должен вернуть (result, error)"""
    for attempt in range(1, retries + 1):
        result, error = fn()
        if error is None:
            return result, None
        if attempt < retries:
            wait = backoff * attempt
            log(f"[RETRY] {label}: attempt {attempt}/{retries} failed ({error}), wait {wait}s...")
            time.sleep(wait)
        else:
            log(f"[RETRY] {label}: all {retries} attempts failed")
            return None, error
    return None, "retry exhausted"


# ═══════════════════════════════════════════════════
# T-1: Валидация саммари
# ═══════════════════════════════════════════════════

BAD_SUMMARY_STARTS = [
    "Ваш", "Из ваш", "Из данн", "Из этог", "Из предоставлен",
    "Кажется", "Похоже", "Давайте", "Можете", "Вот основн",
    "Я вижу", "Я замет", "Мне кажется", "Позвольте",
    "Хотите", "Могу помочь", "Если вам", "Рад помочь",
    "Это звучит", "Это очень", "К сожалению",
]

def validate_summary(summary, clean_text_len):
    """Проверяет саммари на мусор. Возвращает (is_valid, warning)"""
    if not summary or len(summary.strip()) < 30:
        return False, "summary_too_short"

    if summary.startswith("(ошибка"):
        return False, "claude_api_error"

    first_line = summary.strip().split('\n')[0]
    for bad in BAD_SUMMARY_STARTS:
        if first_line.startswith(bad):
            return False, f"chatbot_style:{bad}"

    # Если транскрипция > 500 символов, а саммари < 100 — подозрительно
    if clean_text_len > 500 and len(summary.strip()) < 100:
        return False, "suspiciously_short"

    return True, None


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
        f'-F \'prompt={WHISPER_PROMPT}\' '
        f'-F \'condition_on_previous_text=false\' '
        f'-F \'compression_ratio_threshold=2.4\' '
        f'-F \'no_speech_threshold=0.6\' '
        f'-F \'temperature=0.0\' '
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

    # Подстраховка: фильтр Whisper-паразитов (основной срабатывает на GPU-стороне)
    segments, dropped = filter_whisper_parasites(segments)
    if dropped:
        log(f"[parasite] process_whisper: dropped {dropped} segments")

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

    # Подстраховка: фильтр Whisper-паразитов (основной — на GPU в diarize_server.py)
    segments, dropped = filter_whisper_parasites(segments)
    if dropped:
        log(f"[parasite] process_diarize: dropped {dropped} segments")

    return {
        "result_srt": segments_to_srt(segments),
        "result_clean": segments_to_clean(segments),
        "result_json": json.dumps({**data, "segments": segments}, ensure_ascii=False),
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

    # 3. Транскрипция (с retry)
    t0 = time.time()
    if args.diarize:
        def do_diarize():
            return process_diarize(
                remote_path, result_path,
                args.min_speakers, args.max_speakers, args.noise_filter
            )
        result, error = retry(do_diarize, "diarize")
    else:
        def do_whisper():
            return process_whisper(remote_path, result_path)
        result, error = retry(do_whisper, "whisper")

    if error:
        print(json.dumps({"error": error}))
        # Чистим GPU
        run_cmd(f'ssh {GPU_HOST} "rm -f {remote_path} {result_path}"')
        sys.exit(1)

    elapsed = time.time() - t0
    log(f"Transcription: {elapsed:.0f}s, SRT={len(result['result_srt'])} chars")

    # 4. Claude API саммари (с retry)
    def do_summary():
        s = generate_summary(result["result_clean"], api_key)
        valid, warning = validate_summary(s, len(result["result_clean"]))
        if not valid:
            return None, f"bad_summary:{warning}"
        return s, None

    summary, sum_error = retry(do_summary, "claude_summary")
    if sum_error:
        log(f"Summary validation failed after retries: {sum_error}")
        summary = f"(⚠️ саммари не прошло валидацию: {sum_error})"

    timestamp = time.strftime("%d.%m.%Y, %H:%M:%S")
    result_txt = f"Обработано: {timestamp}\n{'═' * 60}\n{summary}"
    log(f"Summary: {len(summary)} chars, valid={sum_error is None}")

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
