#!/usr/bin/env python3
"""
regen_summaries.py — Перегенерация Claude-саммари для уже transcribed джоб.

Не трогает Whisper, не требует GPU — только Claude API. Быстро и бесплатно
(относительно GPU).

Использует актуальный prompt_text из таблицы prompts по job.prompt_id.
Если у джобы prompt_id пуст — берётся дефолтный профиль (is_default=1).
Так же синхронизирует jobs.prompt_text с актуальным текстом профиля.

Использование:
  # перегенерить все completed джобы за последние сутки
  ANTHROPIC_API_KEY=sk-ant-... python3 regen_summaries.py --since 1

  # только одну конкретную
  ANTHROPIC_API_KEY=sk-ant-... python3 regen_summaries.py --job-id <uuid>

  # увидеть что будет, ничего не делать
  ANTHROPIC_API_KEY=sk-ant-... python3 regen_summaries.py --since 1 --dry-run

Опции:
  --since N       дней назад (по умолчанию 1)
  --job-id UUID   только одна джоба
  --dry-run       не писать в БД, не звать API
  --sleep N       секунд пауза между API-вызовами (по умолчанию 3)
"""

import argparse
import json
import os
import sqlite3
import sys
import time
import urllib.request
import urllib.error

DB_PATH = "/opt/transcribe/data/db/transcribe.db"
CLAUDE_API_URL = "https://api.anthropic.com/v1/messages"
CLAUDE_MODEL = "claude-haiku-4-5-20251001"
CHUNK_SIZE = 15000

FALLBACK_SYSTEM = (
    "Ты — программа-конспектировщик аудиозаписей. "
    "Составь структурированный конспект транскрипции: "
    "тема, ключевые тезисы, выводы, интересные моменты. "
    "Язык — русский. Без вводных фраз."
)


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


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


def generate_summary(clean_text, system_prompt, api_key):
    sampled = smart_sample(clean_text)
    payload = json.dumps({
        "model": CLAUDE_MODEL,
        "max_tokens": 2000,
        "system": system_prompt or FALLBACK_SYSTEM,
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
        raise RuntimeError(f"Claude HTTP {e.code}: {body}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", type=int, default=1, help="дней назад")
    ap.add_argument("--job-id", default=None, help="только одна джоба")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--sleep", type=int, default=3, help="пауза между API (сек)")
    args = ap.parse_args()

    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key and not args.dry_run:
        log("❌ ANTHROPIC_API_KEY не задан")
        sys.exit(1)

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    # Дефолтный профиль
    default_row = conn.execute(
        "SELECT id, prompt_text FROM prompts WHERE is_default=1 LIMIT 1"
    ).fetchone()
    default_prompt_text = default_row["prompt_text"] if default_row else None
    default_prompt_id = default_row["id"] if default_row else None

    # Выбор джоб
    if args.job_id:
        rows = conn.execute(
            "SELECT id, prompt_id, LENGTH(result_clean) as clen FROM jobs WHERE id=?",
            (args.job_id,)
        ).fetchall()
    else:
        rows = conn.execute(
            """SELECT id, prompt_id, LENGTH(result_clean) as clen
               FROM jobs
               WHERE status='completed'
                 AND result_clean IS NOT NULL
                 AND LENGTH(result_clean) > 100
                 AND created_at >= datetime('now', ?)
               ORDER BY created_at DESC""",
            (f"-{args.since} days",)
        ).fetchall()

    if not rows:
        log("нет подходящих джоб")
        return

    log(f"найдено {len(rows)} джоб для перегенерации")
    log(f"дефолтный профиль: id={default_prompt_id}, len={len(default_prompt_text or '')}")

    for i, row in enumerate(rows, 1):
        jid = row["id"]
        prompt_id = row["prompt_id"] or default_prompt_id

        # Взять актуальный prompt_text
        prompt_text = default_prompt_text
        if row["prompt_id"]:
            p = conn.execute(
                "SELECT prompt_text FROM prompts WHERE id=?",
                (row["prompt_id"],)
            ).fetchone()
            if p:
                prompt_text = p["prompt_text"]

        # clean_text
        clean_row = conn.execute(
            "SELECT result_clean FROM jobs WHERE id=?", (jid,)
        ).fetchone()
        clean = clean_row["result_clean"] or ""

        log(f"[{i}/{len(rows)}] {jid[:8]}… clean={len(clean)}ch, prompt={len(prompt_text or '')}ch")

        if args.dry_run:
            continue

        try:
            summary = generate_summary(clean, prompt_text, api_key)
        except Exception as e:
            log(f"  ❌ error: {e}")
            continue

        ts = time.strftime("%d.%m.%Y, %H:%M:%S")
        result_txt = f"Обработано: {ts}\n{'═' * 60}\n{summary}"

        conn.execute(
            "UPDATE jobs SET result_txt=?, prompt_id=?, prompt_text=? WHERE id=?",
            (result_txt, prompt_id, prompt_text, jid)
        )
        conn.commit()
        log(f"  ✅ summary={len(summary)}ch")

        if i < len(rows):
            time.sleep(args.sleep)

    log("готово.")
    conn.close()


if __name__ == "__main__":
    main()