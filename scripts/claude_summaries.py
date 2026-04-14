#!/usr/bin/env python3
"""
claude_summaries.py — Перегенерация саммари через Claude API (Haiku)
Запускать на 🟢 Веб-сервере из /tmp/claude_summaries.py

Использование:
  ANTHROPIC_API_KEY=sk-ant-... python3 /tmp/claude_summaries.py

GPU НЕ НУЖЕН — запрос идёт с веб-сервера напрямую в api.anthropic.com
Стоимость: ~$0.01-0.03 за файл (Haiku), ~$0.50-1.00 за все 20 файлов
"""

import json
import sqlite3
import sys
import time
import os
import urllib.request
import urllib.error

# ═══════════════════════════════════════════════════
# Конфигурация
# ═══════════════════════════════════════════════════

DB_PATH = "/opt/transcribe/data/db/transcribe.db"
API_URL = "https://api.anthropic.com/v1/messages"
MODEL = "claude-haiku-4-5-20251001"  # Быстрый и дешёвый, отлично следует инструкциям
MAX_TOKENS = 2000

# Берём начало + середину + конец
CHUNK_SIZE = 15000  # Claude Haiku: 200K контекст, можно больше чем qwen

# Тестовые файлы — НЕ ТРОГАЕМ
SKIP_IDS = [
    "36607aeb-5a62-45c6-b3aa-65cd78d84d60",  # day01_M6 тест 11.04
    "4c1f5c41-5172-43d0-9e85-9ffe5b284a03",  # day01_NA тест 11.04
    "a3ff8886-e3bd-40e7-a465-2b0131b85aea",  # Новая запись 3
    "621caf98-9254-4d39-892d-5ee3717254f6",  # Новая запись 4
]

SYSTEM_PROMPT = """Ты — программа-конспектировщик аудиозаписей. Ты получаешь транскрипцию группового занятия по психологии и возвращаешь структурированный конспект.

Формат ответа:

Саммари:
[3-5 предложений — о чём запись в целом]

Ключевые темы:
- [тема 1]
- [тема 2]
- ...

Участники:
- [имена и роли, если упоминаются в записи]

Основные тезисы:
- [тезис 1]
- [тезис 2]
- ...

Правила:
- Пиши только конспект, ничего больше
- Не обращайся к собеседнику, не используй "вы/ваш"
- Не давай советов и рекомендаций
- Сохраняй имена, факты и цифры точно
- Язык — русский"""


def log(msg):
    ts = time.strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def smart_sample(text):
    """Берёт начало + середину + конец текста"""
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


def call_claude(api_key, text):
    """Отправляет текст на Claude API"""

    sampled = smart_sample(text)

    payload = json.dumps({
        "model": MODEL,
        "max_tokens": MAX_TOKENS,
        "system": SYSTEM_PROMPT,
        "messages": [
            {
                "role": "user",
                "content": f"Составь конспект этой аудиозаписи группового занятия по психологии.\n\nТРАНСКРИПЦИЯ:\n{sampled}"
            }
        ]
    }).encode("utf-8")

    req = urllib.request.Request(
        API_URL,
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
            # Извлекаем текст из ответа
            content = data.get("content", [])
            text_parts = [c["text"] for c in content if c.get("type") == "text"]
            return "\n".join(text_parts).strip()
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        log(f"  HTTP {e.code}: {body[:300]}")
        return None
    except Exception as e:
        log(f"  ОШИБКА: {e}")
        return None


def main():
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key or not api_key.startswith("sk-ant-"):
        log("ОШИБКА: установи ANTHROPIC_API_KEY=sk-ant-...")
        log("Запуск: ANTHROPIC_API_KEY=sk-ant-... python3 /tmp/claude_summaries.py")
        sys.exit(1)

    # Тест API
    log(f"Модель: {MODEL}")
    log("Тест API...")
    test_payload = json.dumps({
        "model": MODEL,
        "max_tokens": 10,
        "messages": [{"role": "user", "content": "Скажи ОК"}]
    }).encode("utf-8")

    req = urllib.request.Request(
        API_URL,
        data=test_payload,
        headers={
            "Content-Type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01"
        },
        method="POST"
    )

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            log("API OK ✓")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        log(f"API ОШИБКА {e.code}: {body[:200]}")
        sys.exit(1)

    # Загрузить все completed jobs
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    rows = conn.execute(
        "SELECT id, original_name, result_clean, result_txt FROM jobs WHERE status='completed' ORDER BY original_name"
    ).fetchall()

    # Фильтруем тестовые
    jobs = [r for r in rows if r["id"] not in SKIP_IDS]
    log(f"Файлов к обработке: {len(jobs)} (пропущено тестовых: {len(rows) - len(jobs)})")

    total = len(jobs)
    success = 0
    errors = []
    total_cost = 0

    for i, row in enumerate(jobs, 1):
        job_id = row["id"]
        name = row["original_name"]
        clean = row["result_clean"]

        log(f"═══ [{i}/{total}] {name[:50]} ═══")

        if not clean:
            log(f"  ПРОПУСК: нет result_clean")
            errors.append(name[:20])
            continue

        text_len = len(clean)
        sampled_len = len(smart_sample(clean))
        log(f"  Текст: {text_len} → сэмпл {sampled_len} символов")

        t0 = time.time()
        summary = call_claude(api_key, clean)
        elapsed = time.time() - t0

        if not summary:
            errors.append(name[:20])
            continue

        # Шапка
        timestamp = time.strftime("%d.%m.%Y, %H:%M:%S")
        formatted = f"Обработано: {timestamp}\n{'═' * 60}\n{summary}"

        log(f"  Claude: {len(summary)} симв, {elapsed:.1f}s")
        log(f"  Начало: {summary[:120]}...")

        # Запись в БД
        conn.execute("UPDATE jobs SET result_txt=? WHERE id=?", (formatted, job_id))
        conn.commit()
        log(f"  БД ✓")
        success += 1

        # Пауза чтобы не упираться в rate limit
        if i < total:
            time.sleep(1)

    log(f"═══════════════════════════════════════")
    log(f"Итого: {success}/{total} успешно")
    if errors:
        log(f"Ошибки: {', '.join(errors)}")
    else:
        log(f"Все саммари обновлены через Claude!")

    conn.close()


if __name__ == "__main__":
    main()
