# INFRASTRUCTURE.md — Студия Транскрибации

**Обновлено:** 11 апреля 2026

---

## Серверы

| Параметр | 🟢 Веб-сервер | 🔴 GPU-сервер |
|----------|---------------|---------------|
| Хост | `transcribe.melki.top` / `212.67.8.251` | `195.209.214.7` (supreme, immers.cloud) |
| ОС | Ubuntu 22.04 | Ubuntu 22.04 |
| Пользователь | `root` | `ubuntu` |
| SSH | `ssh root@212.67.8.251` | `ssh ubuntu@195.209.214.7` |
| GPU | — | NVIDIA RTX 3090 |
| Хостинг | Beget VPS | immers.cloud (OpenStack) |

---

## 🟢 Веб-сервер — сервисы

### Приложение (transcribe_app)

| Параметр | Значение |
|----------|----------|
| Контейнер | `transcribe_app` |
| Образ | `node:20-alpine` (собственный Dockerfile) |
| Порт | `3000` (внутри контейнера) |
| Внешний доступ | `https://transcribe.melki.top` (через Caddy) |
| Путь на хосте | `/opt/transcribe/app/` |
| Volume (код) | `/opt/transcribe/app:/app` |
| Volume (данные) | `/opt/transcribe/data:/data` |
| Volume node_modules | `/app/node_modules` (анонимный) |
| БД | `/data/db/transcribe.db` (SQLite, better-sqlite3) |
| Загрузки | `/data/uploads/` |
| Результаты | `/data/results/` |
| docker-compose | `/opt/transcribe/docker-compose.yml` |

**Команды:**
```bash
# Перезапуск после изменения файлов
docker restart transcribe_app

# Пересоздание после изменения env/docker-compose.yml
cd /opt/transcribe && docker compose up -d --force-recreate app

# Логи
docker logs -f transcribe_app --tail 100

# Проверка
curl -s https://transcribe.melki.top/api/version
```

### n8n

| Параметр | Значение |
|----------|----------|
| Контейнер | `n8n` |
| Порт | `5678` |
| URL | `http://212.67.8.251:5678` |
| Медиа (входящие) | `/n8n_media/IN/` |
| Медиа (исходящие) | `/n8n_media/OUT/` |

**Workflow'ы:**
- **Секретарь таймкодов v3** — ID: `ho6fwPPZOip7eXof` (основной pipeline)
- **Error Handler** — ID: `zOnO3fTBxyxoJ4LS` (обработка ошибок)

**Команды:**
```bash
docker logs -f n8n --tail 100
docker restart n8n
```

### Caddy (reverse proxy)

| Параметр | Значение |
|----------|----------|
| Функция | TLS-терминация, проксирование → `:3000` |
| Конфиг | `/etc/caddy/Caddyfile` |

```bash
sudo systemctl reload caddy
sudo systemctl status caddy
```

---

## 🔴 GPU-сервер — сервисы

### Whisper (whisper_server)

| Параметр | Значение |
|----------|----------|
| Контейнер | `whisper_server` |
| Образ | `deepdml/faster-whisper-large-v3-turbo-ct2` |
| Порт | `:8000` |
| docker-compose | `/root/whisper/docker-compose.yml` |
| Runtime | `runtime: nvidia` (не `deploy.resources`!) |
| Env | `WHISPER__COMPUTE_TYPE=float16` |
| Restart | `unless-stopped` (автостарт после unshelve) |

```bash
sudo docker compose -f /root/whisper/docker-compose.yml up -d
sudo docker compose -f /root/whisper/docker-compose.yml logs -f --tail 50
sudo docker ps | grep whisper
curl -s http://localhost:8000/health
```

### Diarize (diarize.service)

| Параметр | Значение |
|----------|----------|
| Тип | systemd service |
| Скрипт | `/home/ubuntu/diarize_server.py` (v4) |
| Порт | `:8002` |
| Unit-файл | `/etc/systemd/system/diarize.service` |
| Особенности | Чанки, ffmpeg, без лимита размера, однопоточный |

```bash
sudo systemctl status diarize
sudo systemctl restart diarize
journalctl -u diarize -f --no-pager
curl -s http://localhost:8002/health
```

### Ollama (ollama_engine)

| Параметр | Значение |
|----------|----------|
| Контейнер | `ollama_engine` |
| Порт | `:11434` |
| Модели | `qwen2:7b`, `llama3.1:8b`, `gemma2:9b`, `qwen2.5:14b` |
| Restart | `unless-stopped` |

```bash
docker logs -f ollama_engine --tail 50
curl -s http://localhost:11434/api/tags | jq '.models[].name'
```

### Watchdog (gpu_watchdog)

| Параметр | Значение |
|----------|----------|
| Тип | systemd timer (каждые 3 мин) |
| Скрипт | `/home/ubuntu/gpu_watchdog.py` |
| Unit-файл | `/etc/systemd/system/watchdog.service` |
| Timer | `/etc/systemd/system/watchdog.timer` |
| Логика | Проверяет Whisper/Ollama/Diarize, рестартит упавшие; `is_process_busy()` не убивает занятый diarize |

```bash
sudo systemctl status watchdog.timer
sudo systemctl list-timers | grep watchdog
journalctl -u watchdog --since "1 hour ago" --no-pager
```

---

## Порты (сводка)

| Порт | Сервис | Сервер |
|------|--------|--------|
| 443 | Caddy (HTTPS) | 🟢 веб |
| 3000 | Node.js app | 🟢 веб (внутренний) |
| 5678 | n8n | 🟢 веб |
| 8000 | Whisper | 🔴 GPU |
| 8002 | Diarize | 🔴 GPU |
| 11434 | Ollama | 🔴 GPU |

---

## Модульная структура приложения (v1.9.6)

```
/opt/transcribe/app/
├── server.js          — точка входа, health, version, cleanup, stuck jobs
├── config.js          — все env переменные
├── db.js              — БД, таблицы, миграции, seed промпты
├── middleware.js       — authMiddleware, adminMiddleware
├── utils/
│   ├── helpers.js     — escapeHtml, logEvent, detectFileType, getTranscript
│   └── email.js       — nodemailer
├── routes/
│   ├── auth.js        — register, login, activate
│   ├── prompts.js     — CRUD промптов
│   ├── jobs.js        — upload, list, downloads, rating, delete (soft)
│   ├── internal.js    — webhook/result, job-result, job-prompt, watchdog-event
│   └── admin.js       — users, stats, prompts, GPU panel, monitor, events, archive
└── public/
    └── index.html     — SPA фронтенд
```

---

## OpenStack (immers.cloud) — управление GPU

| Параметр | Значение |
|----------|----------|
| Auth URL | `https://api.immers.cloud:5000/v3` |
| Проект | AlekseyNechaev |
| Server ID | `8baf5a78-ef09-49c9-8aec-ccccf0a46742` |
| Config | `~/.config/openstack/clouds.yaml` (на веб-сервере) |

⚠️ **SHELVE останавливает тариф. SHUTOFF (просто stop) — НЕ останавливает!**

```bash
# С веб-сервера (openstack CLI или через API)
# Unshelve (запуск)
openstack server unshelve 8baf5a78-ef09-49c9-8aec-ccccf0a46742

# Shelve (остановка с экономией)
openstack server shelve 8baf5a78-ef09-49c9-8aec-ccccf0a46742
```

---

## Бэкапы

| Сервер | Путь | Содержимое |
|--------|------|------------|
| 🟢 веб | `/opt/transcribe/backups/2026-04-11/` | server.js, index.html, package.json, Dockerfile, docker-compose.yml, transcribe.db, workflow_v3.json |
| 🔴 GPU | `/home/ubuntu/backups/2026-04-11/` | whisper-compose.yml, diarize.service |

---

## Git

| Параметр | Значение |
|----------|----------|
| Репозиторий | `github.com/AlexeyNN74/transcribot_n8n` |
| Рабочая директория | `/opt/transcribe/app/` (🟢 веб) |

---

## Токены

| Токен | Назначение |
|-------|------------|
| n8n API key | Доступ к n8n REST API (workflow CRUD, execution) |
| JWT n8n→сайт | Внутренний токен для запросов n8n → app (истекает 2036) |

Значения токенов — в ТЗ или в переменных окружения docker-compose.

---

## Важные правила

1. После изменения файлов в `/opt/transcribe/app/` → **`docker restart transcribe_app`**
2. После изменения env в docker-compose.yml → **`docker compose up -d --force-recreate app`**
3. Heredoc с JS/JSON — **ненадёжен**, использовать Python для создания/патча файлов
4. 🟢 веб: `jq` отсутствует → `python3 -m json.tool` или `grep`
5. 🔴 GPU: `jq` есть (v1.6)
6. Логика вкладок: **Саммари** = всегда Ollama, **Транскрипция** = всегда Whisper/diarize
7. GPU shelve — только при нулевой нагрузке (другие проекты, напр. pdfocr!)
