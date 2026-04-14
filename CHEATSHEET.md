# Студия Транскрибации — ШПАРГАЛКА
# Обновлено: 2026-04-14

---

## Серверы

| | 🟢 Веб-сервер | 🔴 GPU-сервер |
|---|---|---|
| **IP** | 212.67.8.251 | 195.209.214.7 |
| **Хостинг** | Beget | immers.cloud (supreme) |
| **Пользователь** | root | ubuntu |
| **ОС** | — | Ubuntu 22.04 |
| **GPU** | — | RTX 3090 |

---

## 🟢 Веб-сервер — пути

```
ПРИЛОЖЕНИЕ (код):
  Хост:      /opt/transcribe/app/
  Контейнер: /app/
  Маунт:     /opt/transcribe/app → /app (bind, rw)

ДАННЫЕ:
  Хост:      /opt/transcribe/data/
  Контейнер: /data/
  Маунт:     /opt/transcribe/data → /data (bind, rw)

БАЗА ДАННЫХ:
  Хост:      /opt/transcribe/data/db/transcribe.db
  Контейнер: /data/db/transcribe.db

ЗАГРУЗКИ (аудио):
  Хост:      /opt/transcribe/data/uploads/
  Контейнер: /data/uploads/

РЕЗУЛЬТАТЫ:
  Хост:      /opt/transcribe/data/results/
  Контейнер: /data/results/

ФРОНТЕНД:
  Хост:      /opt/transcribe/app/public/
  Контейнер: /app/public/
  Маунт:     /opt/transcribe/app/public → /app/public (bind, rw)

NODE_MODULES:
  Контейнер: /app/node_modules (anonymous volume, НЕ хост)

БЭКАПЫ:
  /opt/transcribe/backups/YYYY-MM-DD/
```

---

## 🔴 GPU-сервер — пути

```
DIARIZE:
  Скрипт:    /home/ubuntu/diarize_server.py
  Сервис:    systemd diarize.service
  Порт:      8002

WHISPER:
  Compose:   /root/whisper/docker-compose.yml
  Контейнер: whisper (nvidia runtime)
  Порт:      8000

OLLAMA:
  Контейнер: ollama_engine
  Порт:      11434
  Модели:    qwen2:7b, qwen2.5:14b

N8N (pdfocr):
  Контейнер: n8n_app (отдельный от веб-сервера!)

БЭКАПЫ:
  /home/ubuntu/backups/YYYY-MM-DD/

МЕДИА (n8n pipeline):
  /n8n_media/IN/   — входящие файлы
  /n8n_media/OUT/  — результаты
```

---

## Часто используемые команды

### SQLite — запросы к БД (с хоста 🟢)

```bash
# Базовый запрос
sqlite3 /opt/transcribe/data/db/transcribe.db "SELECT ... ;" -header -column

# Все completed jobs
sqlite3 /opt/transcribe/data/db/transcribe.db \
  "SELECT id, filename, status, created_at, LENGTH(result_txt) as txt_len, LENGTH(result_srt) as srt_len, LENGTH(result_clean) as clean_len, LENGTH(result_json) as json_len FROM jobs WHERE status='completed' ORDER BY filename, created_at;" \
  -header -column

# Джобы конкретного файла
sqlite3 /opt/transcribe/data/db/transcribe.db \
  "SELECT * FROM jobs WHERE filename LIKE '%dayXX%';" -header -column

# Счётчики по статусам
sqlite3 /opt/transcribe/data/db/transcribe.db \
  "SELECT status, COUNT(*) as cnt FROM jobs GROUP BY status;" -header -column

# Последние события
sqlite3 /opt/transcribe/data/db/transcribe.db \
  "SELECT * FROM events ORDER BY timestamp DESC LIMIT 20;" -header -column
```

### Node.js внутри контейнера (🟢)

```bash
# ВАЖНО: require("./db") возвращает { db }, а НЕ голый объект!
# Правильно: const {db} = require("./db");

# Использовать Python для создания .js файлов с кавычками:
python3 -c "
open('/tmp/q.js','w').write('''
const {db} = require(\"./db\");
const rows = db.prepare(\"SELECT ...\").all();
console.log(JSON.stringify(rows, null, 2));
''')
"
docker exec transcribe_app node /tmp/q.js
# ⚠️ /tmp внутри контейнера ≠ /tmp на хосте!
# Лучше: sqlite3 напрямую с хоста
```

### Docker (🟢)

```bash
# Перезапуск приложения (ОБЯЗАТЕЛЬНО после изменения кода!)
docker restart transcribe_app

# Логи
docker logs transcribe_app --tail 50
docker logs transcribe_app --since 1h

# Маунты
docker inspect transcribe_app --format '{{json .Mounts}}' | python3 -m json.tool

# n8n
docker start n8n          # запустить
docker stop n8n           # остановить
docker logs n8n --tail 30

# Статус контейнеров
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```

### Файлы загрузок (🟢)

```bash
# Список аудио на диске
ls -lhS /opt/transcribe/data/uploads/ | head -30

# Размер папки
du -sh /opt/transcribe/data/uploads/
```

### n8n API (🟢)

```bash
# Заголовок: X-N8N-API-KEY (НЕ Bearer!)
# URL: http://212.67.8.251:5678

# Список workflows
curl -s -H "X-N8N-API-KEY: <token>" http://212.67.8.251:5678/api/v1/workflows | python3 -m json.tool

# Активировать workflow
curl -s -X PATCH -H "X-N8N-API-KEY: <token>" -H "Content-Type: application/json" \
  -d '{"active": true}' \
  http://212.67.8.251:5678/api/v1/workflows/<id>

# jq НЕ установлен на веб-сервере → python3 -m json.tool
```

### GPU сервер (🔴)

```bash
# Diarize
sudo systemctl status diarize
sudo systemctl restart diarize
journalctl -u diarize --since "1 hour ago"

# Whisper (docker-compose)
cd /root/whisper && sudo docker-compose ps
cd /root/whisper && sudo docker-compose restart

# Ollama
docker exec ollama_engine ollama list
docker exec ollama_engine ollama run qwen2.5:14b "test"

# GPU мониторинг
nvidia-smi
watch -n2 nvidia-smi
```

### OpenStack / GPU биллинг

```bash
# ⚠️ ТОЛЬКО SHELVE ОСТАНАВЛИВАЕТ БИЛЛИНГ!
# SHUTOFF/stop — биллинг продолжается!
# Server ID: 8baf5a78-ef09-49c9-8aec-ccccf0a46742
```

---

## Pipeline данных: аудио → БД

```
АУДИОФАЙЛ
    ↓
[diarize_server :8002]  POST /diarize  file=<audio>
    ↓
ОТВЕТ JSON:
  {
    "segments": [{start, end, speaker, text}, ...],
    "plain_text": "сплошной текст без спикеров",
    "stats": {duration_sec, num_speakers, ...}
  }
    ↓
[n8n workflow / batch_diarize.py]  — КОНВЕРТАЦИЯ:
    ↓
  result_srt   = SRT с голосами:  "1\n00:08:02,260 --> 00:09:28,150\nГолос 1: текст\n"
  result_clean = текст с голосами без таймкодов: "Голос 1: текст\n\nГолос 2: ответ"
  result_json  = JSON.stringify(полный ответ diarize)
  result_txt   = саммари от Ollama (ОТДЕЛЬНЫЙ ЭТАП, не из diarize!)
    ↓
[POST /api/internal/job-result]  — ЗАПИСЬ В БД
  Auth: Bearer <JWT>
  Body: {filename, result_txt, result_srt, result_json, result_clean}
  Ищет job по filename (UUID-имя файла на диске)
```

**Ключевое:**
- Конвертацию diarize JSON → SRT/clean делает НЕ сервер, а n8n/скрипт
- result_txt (саммари) — отдельный этап через Ollama, не связан с diarize
- Табы в UI: «Саммари» = result_txt, «Транскрипция» = result_srt/result_clean

---

## Правила работы с файлами

- 🟢 Веб: временные файлы/скрипты → **`/tmp/`**, НИКОГДА не `/root/`
- 🔴 GPU: временные файлы → **`/tmp/`**, скрипты → **`/home/ubuntu/`**
- Готовые скрипты для повторного использования → `/home/ubuntu/` (GPU) или `/opt/transcribe/` (Веб)
- **Не мусорить в домашней папке!**

---

## Ловушки (запомнить навсегда)

1. **db.js экспортирует `{ db }`** — пиши `const {db} = require("./db")`, а не `const db = require("./db")`
2. **Heredoc + JS/JSON = ненадёжно** — используй Python для создания файлов с кавычками/бэктиками
3. **docker restart обязателен** — после любого изменения кода в /opt/transcribe/app/
4. **jq нет на веб-сервере** — используй `python3 -m json.tool`
5. **Кавычки в docker exec -e** — bash съедает экранирование. Лучше sqlite3 с хоста или Python-скрипт
6. **n8n_app на GPU ≠ n8n на вебе** — два разных контейнера на разных серверах
7. **Ollama на GPU = Docker** (ollama_engine), не systemd
8. **Whisper на GPU = docker-compose** в /root/whisper/, нужен sudo
9. **n8n API key** — заголовок `X-N8N-API-KEY`, не Bearer
10. **watch через SSH не работает** — `Error opening terminal: unknown`. Используй `while true; do ...; sleep 5; done`
11. **$? = код выхода** — `0` = успех, НЕ количество обработанных записей
12. **Файлы только в /tmp/** — не мусорить в `/root/` или `/home/ubuntu/`

---

## Версия приложения

- Текущая: **v1.9.8** (git: edef19a, 11 Apr)
- Эндпоинт: GET /api/version
- Git: github.com/AlexeyNN74/transcribot_n8n
- Git workflow: `git add . && git commit -m "vX.X.X — description" && git push && docker restart transcribe_app`

---

## Структура кода (модульная, с v1.9.6)

```
/opt/transcribe/app/
├── server.js          — точка входа
├── config.js          — все env-переменные и пути
├── db.js              — SQLite init + миграции + seed prompts
├── middleware.js       — auth middleware
├── routes/
│   ├── auth.js        — регистрация, логин, активация
│   ├── jobs.js        — CRUD задач, загрузка файлов
│   ├── prompts.js     — промпт-профили
│   ├── internal.js    — API для n8n (JWT)
│   └── admin.js       — админ-панель
├── utils/
│   ├── helpers.js     — cleanupExpired, scanUploads
│   └── email.js       — nodemailer
├── public/
│   └── index.html     — фронтенд (SPA)
├── Dockerfile
├── docker-compose.yml
└── package.json
```
