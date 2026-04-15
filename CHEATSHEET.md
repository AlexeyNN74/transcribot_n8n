# Студия Транскрибации — ШПАРГАЛКА
# Обновлено: 2026-04-15

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

## 🔒 Безопасность — порты (15 апр 2026)

### Принцип: наружу только 22 (SSH) + 80/443 (Caddy). Всё остальное — 127.0.0.1.

| Порт | Сервис | Привязка | Доступ |
|------|--------|----------|--------|
| 22 | SSH | 0.0.0.0 | ✅ Норма (fail2ban) |
| 80, 443 | Caddy (HTTPS) | 0.0.0.0 | ✅ Норма |
| 5678 | n8n | 127.0.0.1 | 🔒 SSH-туннель |
| 8502, 5055 | Open Notebook | 127.0.0.1 | 🔒 SSH-туннель |
| 8000 | SurrealDB | — (docker-сеть) | 🔒 Только из open_notebook |
| 11434 | Ollama | 127.0.0.1 | 🔒 Только локально |
| 3000 | transcribe_app | — (docker-сеть) | 🔒 Через Caddy |

### Проверка — ничего лишнего не торчит:
```bash
ss -tlnp | grep '0.0.0.0' | grep -vE ':(22|80|443) '
# Ожидание: пусто
```

### Доступ к n8n / Open Notebook — через SSH-туннель (Termius):
```
Termius → хост → Port Forwarding → правила:
  Type: Local
  Local: 127.0.0.1:5678   → Remote: 127.0.0.1:5678    # n8n
  Local: 127.0.0.1:8502   → Remote: 127.0.0.1:8502    # Open Notebook

Подключиться по SSH → открыть http://localhost:5678 (n8n)
```

### Как контейнеры запущены (для воспроизведения):

**n8n** — docker run (не compose):
```bash
docker run -d --name n8n --restart unless-stopped \
  -p 127.0.0.1:5678:5678 \
  --network transcribe_transcribe_net \
  -v n8n_data:/home/node/.n8n \
  -v /opt/transcribe/data:/opt/transcribe/data \
  -v /opt/pdfocr:/opt/pdfocr \
  -v /root/.ssh:/home/node/.ssh:ro \
  -v /opt/transcribe/app/scripts:/opt/transcribe/app/scripts:ro \
  -e NODE_FUNCTION_ALLOW_BUILTIN=fs,path,child_process \
  -e EXECUTIONS_DATA_PRUNE=true \
  -e "NODE_OPTIONS=--max-old-space-size=4096" \
  -e "N8N_RESTRICT_FILE_ACCESS_TO=" \
  -e EXECUTIONS_DATA_PRUNE_MAX_COUNT=50 \
  -e N8N_SECURE_COOKIE=false \
  -e EXECUTIONS_DATA_MAX_AGE=24 \
  -e N8N_PORT=5678 \
  -e "NODE_FUNCTION_ALLOW_EXTERNAL=*" \
  -e EXECUTIONS_CONCURRENCY_PRODUCTION_LIMIT=1 \
  -e N8N_HOST=0.0.0.0 \
  -e N8N_PROTOCOL=http \
  docker.n8n.io/n8nio/n8n:latest
```

**ollama** — docker run (не compose):
```bash
docker run -d --name ollama --restart unless-stopped \
  -p 127.0.0.1:11434:11434 \
  -v ollama_data:/root/.ollama \
  ollama/ollama
```

**open-notebook** — compose: `/root/open-notebook/docker-compose.yml`
- SurrealDB: ports убраны (доступ только по docker-сети)
- Open Notebook: `127.0.0.1:8502`, `127.0.0.1:5055`

**transcribe** — compose: `/opt/transcribe/docker-compose.yml`
- N8N_URL = `http://n8n:5678` (docker-сеть, не внешний IP)

---

## 🌐 Caddy — домены и reverse proxy

Конфиг: `/opt/transcribe/caddy/Caddyfile`

| Домен | Прокси куда | Auth |
|-------|-------------|------|
| transcribe.melki.top | app:3000 | нет (свой JWT) |
| notebook.melki.top | UI: open_notebook:8502, API: open_notebook:5055 | basic_auth на UI |

```
Caddy перезагрузка:
docker exec transcribe_caddy caddy reload --config /etc/caddy/Caddyfile

Добавить нового пользователя в notebook:
docker exec transcribe_caddy caddy hash-password --plaintext "ПАРОЛЬ"
→ вставить в Caddyfile: username $2a$14$...
```

### Open Notebook — compose: `/root/open-notebook/docker-compose.yml`
- `API_URL=https://notebook.melki.top` (env, фронт ходит через Caddy)
- SurrealDB: ports убраны, доступ по docker-сети
- Open Notebook: `127.0.0.1:8502`, `127.0.0.1:5055`
- **После каждого `docker compose down/up`** — пересоединять сеть:
```bash
docker network connect transcribe_transcribe_net open-notebook-open_notebook-1
docker network connect transcribe_transcribe_net open-notebook-surrealdb-1
```

### DNS записи (Beget)
| Запись | IP | Назначение |
|--------|-----|-----------|
| transcribe | 212.67.8.251 | Студия Транскрибации |
| notebook | 212.67.8.251 | Open Notebook |
| notebook-api | 212.67.8.251 | (не используется, можно удалить) |
| n8n | 212.67.8.251 | (резерв, Caddy не настроен) |
| pdf | 195.209.214.7 | PDF OCR (GPU) |

---

## ⏰ Cron-задачи (🟢 веб-сервер)

```bash
# Просмотр: crontab -l
* * * * * ANTHROPIC_API_KEY=sk-ant-... /usr/bin/python3 /opt/transcribe/app/scripts/task_runner.py >> /opt/transcribe/data/tasks/runner.log 2>&1
0 3 * * * /opt/transcribe/app/scripts/backup_db.sh
0 4 * * * /opt/transcribe/app/scripts/rotate_runner_log.sh
```

---

## 📊 Таблицы БД

| Таблица | Назначение |
|---------|-----------|
| users | Пользователи (email, password, role, active) |
| jobs | Задания (status, result_txt/srt/json/clean, rating) |
| prompts | Профили промптов (system + user) |
| events | Журнал событий (upload, completed, error, gpu) |
| gpu_sessions | Сессии GPU (unshelve_at, shelve_at, duration_sec, jobs_count) |
| settings | Key-value настройки |

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
# URL: http://localhost:5678 (127.0.0.1, не внешний IP!)

# Список workflows
curl -s -H "X-N8N-API-KEY: <token>" http://localhost:5678/api/v1/workflows | python3 -m json.tool

# Активировать workflow
curl -s -X PATCH -H "X-N8N-API-KEY: <token>" -H "Content-Type: application/json" \
  -d '{"active": true}' \
  http://localhost:5678/api/v1/workflows/<id>

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

## Pipeline v4: аудио → БД (автоматический)

```
Пользователь загружает файл → transcribe.melki.top
    ↓ (до 1 мин)
n8n v4 (Schedule Trigger + Scan & Create Tasks) → /data/tasks/{filename}.json
    ↓ (до 1 мин)
task_runner.py (cron каждую минуту, хост)
    → ensure_gpu_active() → unshelve если SHELVED
    → gpu_session_start() → запись в gpu_sessions
    → process_single.py {filename}
        → SCP на GPU
        → POST /diarize (или /whisper)
        → Claude API Haiku (саммари)
        → JSON в stdout
    → запись в SQLite (result_txt, result_srt, result_json, result_clean)
    → если очередь пуста → gpu_session_end() → shelve GPU
```

### Файлы pipeline (🟢 /opt/transcribe/app/scripts/)
| Файл | Назначение |
|------|------------|
| task_runner.py | Хост-оркестратор (cron), GPU management, gpu_sessions |
| process_single.py | Обработка одного файла: SCP→GPU→Claude→JSON (retry 3x) |
| rotate_runner_log.sh | Ротация runner.log (cron 04:00) |
| backup_db.sh | Бэкап БД (cron 03:00) |
| batch_diarize.py | Ручной батч (устаревший) |
| claude_summaries.py | Ручная перегенерация саммари |

**Ключевое:**
- Саммари генерирует **Claude API Haiku** (не Ollama)
- Конвертацию diarize JSON → SRT/clean делает process_single.py
- Табы в UI: «Саммари» = result_txt, «Транскрипция» = result_srt/result_clean
- gpu_sessions отслеживает время работы GPU для биллинга

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
13. **Порты: наружу ТОЛЬКО 22/80/443** — при создании новых контейнеров ВСЕГДА `-p 127.0.0.1:PORT:PORT`, никогда `0.0.0.0`
14. **n8n и ollama — docker run** (не compose), пересоздание по команде из раздела «Безопасность»
15. **Деплой: сначала /tmp/** — загрузить все файлы в /tmp/, потом бэкапы, потом раскладка по папкам

---

## Версия приложения

- Текущая: **v1.9.10** (git: 411a2a1, 15 Apr)
- Эндпоинт: GET /api/version
- Git: github.com/AlexeyNN74/transcribot_n8n
- Git workflow: `git add -A && git commit -m "vX.X.X — description" && git push && docker restart transcribe_app`

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
│   ├── jobs.js        — CRUD задач, загрузка, переобработка
│   ├── prompts.js     — промпт-профили
│   ├── internal.js    — API для n8n (JWT)
│   └── admin.js       — админ-панель, gpu_sessions, мониторинг
├── utils/
│   ├── helpers.js     — cleanupExpired, scanUploads
│   └── email.js       — nodemailer
├── scripts/
│   ├── task_runner.py      — cron-оркестратор pipeline
│   ├── process_single.py   — обработка файла (retry, валидация)
│   ├── rotate_runner_log.sh — ротация лога
│   ├── backup_db.sh        — бэкап БД
│   ├── batch_diarize.py    — ручной батч (legacy)
│   └── claude_summaries.py — перегенерация саммари
├── public/
│   └── index.html     — фронтенд (SPA)
├── Dockerfile
├── docker-compose.yml
└── package.json
```

---

## 📝 CHANGELOG (последние версии)

| Версия | Дата | Что сделано |
|--------|------|-------------|
| v1.9.10 | 15 апр | T1 валидация саммари, T2 retry 3x, T3 ротация логов, gpu_sessions, закрытие портов, Caddy proxy для notebook |
| v1.9.9 | 15 апр | UI: completed_at, days remaining, download marks, batch ZIP, reprocess, row selection |
| v1.9.8 | 11 апр | Fix double processing, metadata UI, docx fix, diarize v5 |
| v1.9.7 | 11 апр | Min/max speakers, noise filter, Error Handler v3 |
| v1.9.6 | 11 апр | Модульность server.js (11 файлов), watchdog prep |
