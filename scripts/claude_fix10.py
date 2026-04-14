import json, sqlite3, time, os, urllib.request, urllib.error

DB = "/opt/transcribe/data/db/transcribe.db"
URL = "https://api.anthropic.com/v1/messages"
KEY = os.environ["ANTHROPIC_API_KEY"]
MODEL = "claude-haiku-4-5-20251001"
CHUNK = 15000

SYSTEM = """Ты — программа-конспектировщик аудиозаписей. Ты получаешь транскрипцию группового занятия по психологии и возвращаешь структурированный конспект.

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

JOBS = [
    ("f36e9cf0-3f1e-4195-bbaa-64517823bb56", "day08_NA"),
    ("f6b2dae5-2d14-4e73-b157-42bd465950a9", "day09_NA"),
    ("8d911c37-f417-428e-873d-bd8ca36c0638", "day10_NA"),
    ("47a791d8-d981-4236-b9d0-82196269ddea", "day11_NA"),
    ("22c555fc-1e81-498d-92d8-637e5ed14d17", "day12_NA"),
    ("c89fdbfb-adc0-4cdf-a8dd-e3071366cd97", "day13_NA"),
    ("b6bfec29-763a-4941-b01c-c0889a1f245c", "day14_NA"),
    ("01f0a20b-432e-4e2d-a631-6e16c6b4b22f", "day15_NA"),
    ("2ad8a4c7-5472-4974-bb42-9459257eb0af", "day16_NA"),
    ("deb63c72-8d8a-4bea-9c12-a4c7f2889541", "day18_NA"),
]

def sample(t):
    if len(t) <= CHUNK*3: return t
    return "=== НАЧАЛО ===\n"+t[:CHUNK]+"\n\n=== СЕРЕДИНА ===\n"+t[len(t)//2-CHUNK//2:len(t)//2+CHUNK//2]+"\n\n=== КОНЕЦ ===\n"+t[-CHUNK:]

conn = sqlite3.connect(DB)
ok = 0
for i,(jid,label) in enumerate(JOBS):
    row = conn.execute("SELECT result_clean FROM jobs WHERE id=?",(jid,)).fetchone()
    if not row or not row[0]:
        print(f"[{label}] НЕТ ДАННЫХ"); continue
    txt = sample(row[0])
    print(f"[{time.strftime('%H:%M:%S')}] [{i+1}/10] {label}: {len(row[0])} -> {len(txt)} символов", flush=True)
    payload = json.dumps({"model":MODEL,"max_tokens":2000,"system":SYSTEM,"messages":[{"role":"user","content":"Составь конспект:\n\n"+txt}]}).encode()
    req = urllib.request.Request(URL,data=payload,headers={"Content-Type":"application/json","x-api-key":KEY,"anthropic-version":"2023-06-01"},method="POST")
    try:
        with urllib.request.urlopen(req,timeout=120) as r:
            data=json.loads(r.read())
            s="".join(c["text"] for c in data["content"] if c.get("type")=="text").strip()
    except urllib.error.HTTPError as e:
        body=e.read().decode("utf-8",errors="replace")[:200]
        print(f"  ОШИБКА HTTP {e.code}: {body}"); continue
    except Exception as e:
        print(f"  ОШИБКА: {e}"); continue
    ts=time.strftime("%d.%m.%Y, %H:%M:%S")
    conn.execute("UPDATE jobs SET result_txt=? WHERE id=?",(f"Обработано: {ts}\n{'═'*60}\n{s}",jid))
    conn.commit()
    ok += 1
    print(f"  OK: {s[:120]}...", flush=True)
    if i < len(JOBS)-1:
        print("  Пауза 30 сек...", flush=True)
        time.sleep(30)
print(f"\nГотово: {ok}/10")
conn.close()
