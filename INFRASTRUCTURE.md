# INFRASTRUCTURE.md — Студия Транскрибации + PDF OCR

**Обновлено:** 19 апреля 2026 (чат #12)

---

## Серверы

| Параметр | 🟢 Веб-сервер | 🔴 GPU-сервер |
|----------|---------------|---------------|
| Хост | `transcribe.melki.top` / `212.67.8.251` | `195.209.214.7` (supreme, immers.cloud) |
| ОС | Ubuntu 22.04 | Ubuntu 22.04 |
| RAM | 3.8 GB | 24 GB VRAM (RTX 3090) |
| Пользователь | `root` | `ubuntu` |
| SSH | `ssh root@212.67.8.251` | `ssh ubuntu@195.209.214.7` |
| GPU | — | NVIDIA RTX 3090 24GB |
| Хостинг | Beget VPS | immers.cloud (OpenStack) |

---

## 🟢 Веб-сервер — сервисы

### Транскрибация (transcribe_app) — v1.9.11

| Параметр | Значение |
|----------|----------|
| Контейнер | `transcribe_app` |
| Образ | `node:20-alpine` (собственный Dockerfile) |
| Порт | `3000` (внутри контейнера) |
| Внешний доступ | `https://transcribe.melki.top` (через Caddy + Authentik) |
| Путь на хосте | `/opt/transcribe/app/` |
| Volume (код) | `/opt/transcribe/app:/app` |
| Volume (данные) | `/opt/transcribe/data:/data` |
| Volume node_modules | `/app/node_modules` (анонимный) |
| БД | `/data/db/transcribe.db` (SQLite, better-sqlite3) |
| Загрузки | `/data/uploads/` |
| Результаты | `/data/results/` |
| docker-compose | `/opt/transcribe/docker-compose.yml` |
| Git | `github.com/AlexeyNN74/transcribot_n8n` |
| Commit | `9213b8a` |

**Команды:**
```bash
docker restart transcribe_app
docker logs -f transcribe_app --tail 100
curl -s https://transcribe.melki.top/api/version
```

**Таблицы БД:**
- `users` — пользователи (id, email, password, name, role, active)
- `jobs` — задания (id, user_id, status, result_txt/srt/json/clean, completed_at, expires_at, archived_at)
- `prompts` — профили промптов (system + user)
- `events` — журнал событий (timestamp, event_type, job_id, user_id, details)
- `settings` — ключ-значение

### PDF OCR (pdfocr_app) — v2.2

| Параметр | Значение |
|----------|----------|
| Контейнер | `pdfocr_app` |
| Порт | `3001` (внутри контейнера) |
| Внешний доступ | `https://pdf.melki.top` (через Caddy) |
| Путь на хосте | `/opt/pdfocr/app/` |
| БД | `/opt/pdfocr/data/db/pdfocr.db` (SQLite) |
| docker-compose | `/opt/pdfocr/app/docker-compose.yml` |
| Git | локальный (`/opt/pdfocr/app/`) |
| Commit | `2ec80e5` |
| SSH ключ | `/root/.ssh/id_ed25519` |
| Контейнер shell | `sh` (Alpine, НЕ bash) |

**Команды:**
```bash
docker restart pdfocr_app
docker logs -f pdfocr_app --tail 100
```

**Таблицы БД:**
- `users` — пользователи
- `jobs` — задания (id, user_id, status, output_md, output_json, gpu_pid, progress, progress_msg)
- `docx_profiles` — пользовательские DOCX-профили (user_id, name, config JSON, макс 3)

### n8n

| Параметр | Значение |
|----------|----------|
| Контейнер | `n8n` |
| Порт | `127.0.0.1:5678` (только локально) |
| URL | `http://212.67.8.251:5678` (с хоста) |
| NODE_OPTIONS | `--max-old-space-size=4096` |

**Workflow'ы:**
- **Секретарь таймкодов v3** — ID: `ho6fwPPZOip7eXof`
- **Error Handler** — ID: `zOnO3fTBxyxoJ4LS`

### Caddy (reverse proxy)

| Домен | Backend |
|-------|---------|
| `transcribe.melki.top` | `:3000` (+ Authentik forward_auth) |
| `pdf.melki.top` | `:3001` |
| `auth.melki.top` | Authentik |

### Другие контейнеры

| Контейнер | Порт | Назначение |
|-----------|------|------------|
| `ollama` | `127.0.0.1:11434` | LLM (локальный) |
| `speaches` | `127.0.0.1:8969` | TTS |
| `nb-*` | не проброшены | Open Notebook (multi-tenant) |

### Cron

| Расписание | Скрипт | Назначение |
|------------|--------|------------|
| `* * * * *` | `task_runner.py` | Pipeline транскрибации (автоцикл) |
| `0 3 * * *` | `backup_db.sh` | Бэкап transcribe.db |

---

## 🔴 GPU-сервер — сервисы

### Whisper

| Параметр | Значение |
|----------|----------|
| Контейнер | `whisper_server` |
| Модель | `deepdml/faster-whisper-large-v3-turbo-ct2` |
| Порт | `:8000` |
| docker-compose | `/root/whisper/docker-compose.yml` |
| Env | `WHISPER__COMPUTE_TYPE=float16` |
| Restart | `unless-stopped` |

### Diarize (v5)

| Параметр | Значение |
|----------|----------|
| Тип | systemd service |
| Скрипт | `/home/ubuntu/diarize_server.py` |
| Порт | `:8002` |
| Особенности | Чанки, ffmpeg, шумоподавление (light/aggressive), однопоточный |

### Ollama

| Параметр | Значение |
|----------|----------|
| Контейнер | `ollama_engine` |
| Порт | `:11434` |
| Модели | `qwen2.5:14b` (основная), `qwen2:7b` |

### Marker (PDF OCR)

| Параметр | Значение |
|----------|----------|
| Контейнер | `marker_service` |
| Назначение | PDF → MD конвертация |

### gpu_wrapper.py

| Параметр | Значение |
|----------|----------|
| Путь | `/home/ubuntu/gpu_wrapper.py` |
| Назначение | nohup + HTTP callbacks для PDF OCR |

### Watchdog (НЕ ЗАДЕПЛОЕН)

| Параметр | Значение |
|----------|----------|
| Скрипт | `/home/ubuntu/gpu_watchdog.py` |
| Статус | Файлы готовы, systemd не настроен |

---

## Порты (сводка)

### 🟢 Веб-сервер
| Порт | Сервис | Доступ |
|------|--------|--------|
| 443 | Caddy (HTTPS) | Внешний |
| 3000 | transcribe_app | Внутренний |
| 3001 | pdfocr_app | Внутренний |
| 5678 | n8n | 127.0.0.1 only |
| 5680 | Claude-proxy | systemd |
| 8969 | speaches | 127.0.0.1 only |
| 11434 | ollama | 127.0.0.1 only |

### 🔴 GPU-сервер
| Порт | Сервис |
|------|--------|
| 8000 | Whisper |
| 8001 | Marker |
| 8002 | Diarize |
| 11434 | Ollama |

---

## Модульная структура транскрибации (v1.9.11)

```
/opt/transcribe/app/
├── server.js          — entry point, cleanup, stuck jobs
├── config.js          — env переменные
├── db.js              — таблицы, миграции, seed промпты
├── middleware.js       — authMiddleware, adminMiddleware
├── utils/
│   ├── helpers.js     — escapeHtml, logEvent, detectFileType, getTranscript
│   └── email.js       — nodemailer (smtp.beget.com)
├── routes/
│   ├── auth.js        — register, login, activate
│   ├── prompts.js     — CRUD промптов
│   ├── jobs.js        — upload, list, downloads, rating, soft delete
│   ├── internal.js    — webhook/result, job-result, job-prompt
│   └── admin.js       — users, stats, GPU panel, monitor, events (from/to), archive
└── public/
    └── index.html     — SPA (чекбоксы, подсветка, архив заданий, массовые действия)
```

## Файловая структура PDF OCR

```
/opt/pdfocr/
├── app/
│   ├── app.js              — v2.2 (Подход Б + DOCX + профили)
│   ├── md2docx.js          — v1.2, resolveScheme(), 2 встроенные + кастомные схемы
│   ├── package.json        — docx ^8.5.0
│   ├── Dockerfile
│   ├── docker-compose.yml  — CALLBACK_SECRET, OPENSTACK_PASSWORD
│   ├── .env                — SMTP credentials
│   └── .gitignore
└── data/
    ├── db/pdfocr.db
    ├── uploads/
    └── results/{jobId}/    — MD + DOCX файлы
```

---

## OpenStack (immers.cloud)

| Параметр | Значение |
|----------|----------|
| Auth URL | `https://api.immers.cloud:5000/v3` |
| Проект | AlekseyNechaev |
| Server ID | `8baf5a78-ef09-49c9-8aec-ccccf0a46742` |

⚠️ **SHELVE останавливает тариф. SHUTOFF (stop) — НЕ останавливает!**

Auto-shelve работает через API: `POST /api/admin/gpu/action` + internal JWT.

---

## Бэкапы

| Сервер | Путь | Содержимое |
|--------|------|------------|
| 🟢 веб | `/opt/transcribe/backups/` | Cron 03:00 — transcribe.db |
| 🟢 веб | `/opt/transcribe/backups/2026-04-11/` | Полный: server.js, index.html, etc. |
| 🔴 GPU | `/home/ubuntu/backups/2026-04-11/` | whisper-compose.yml, diarize.service |

---

## Важные правила

1. После изменения файлов → **`docker restart transcribe_app`** / **`docker restart pdfocr_app`**
2. После изменения env в docker-compose.yml → **`docker compose down && docker compose up -d --build`**
3. Heredoc с JS/JSON — **ненадёжен**, использовать Python для создания/патча файлов
4. 🟢 веб: `jq` отсутствует → `python3 -m json.tool`
5. 🔴 GPU: `jq` ✅ (v1.6), Ollama = Docker, Whisper = docker-compose, Diarize = systemd
6. pdfocr контейнер: Alpine = `sh`, не `bash`
7. GPU shelve — координировать с pdfocr (обе системы используют один GPU)
8. Файл на сервере может отличаться от project knowledge — всегда проверять `sed -n` перед патчем
