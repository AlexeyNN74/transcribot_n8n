# INFRASTRUCTURE.md — Платформа melki.top

**Обновлено:** 19 апреля 2026, чат #15

---

## Серверы

| Параметр | 🟢 Веб-сервер | 🔴 GPU-сервер |
|----------|---------------|---------------|
| Хост | `212.67.8.251` (Beget VPS) | `195.209.214.7` (immers.cloud, supreme) |
| ОС | Ubuntu 22.04 | Ubuntu 22.04 |
| Пользователь | `root` | `ubuntu` |
| RAM | 3.8 GB | — |
| GPU | — | NVIDIA RTX 3090 (24 GB VRAM) |
| SSH | `ssh root@212.67.8.251` | `ssh -i /root/.ssh/id_ed25519 ubuntu@195.209.214.7` |

---

## 🟢 Веб-сервер — сервисы

### Транскрибация (transcribe_app) — v1.9.12

| Параметр | Значение |
|----------|----------|
| Контейнер | `transcribe_app` |
| Образ | `node:20-alpine` (Dockerfile + openssh-client) |
| Порт | `3000` (внутренний) |
| URL | `https://transcribe.melki.top` (Authentik + Caddy) |
| Путь | `/opt/transcribe/app/` |
| БД | `/opt/transcribe/data/db/transcribe.db` (SQLite) |
| Pipeline | Callback: gpu-pipeline.js → SSH nohup → callback → Claude Haiku |
| Git | `/opt/transcribe/app/` → github.com/AlexeyNN74/transcribot_n8n |

Модульная структура:
```
/opt/transcribe/app/
├── server.js, config.js, db.js, middleware.js
├── routes/ (auth.js, jobs.js, prompts.js, internal.js, admin.js)
├── utils/ (helpers.js, email.js, gpu-pipeline.js)
└── public/index.html
```

### PDF OCR (pdfocr_app) — v2.6

| Параметр | Значение |
|----------|----------|
| Контейнер | `pdfocr_app` |
| Образ | `node:20-alpine` |
| Порт | `3001` (внутренний) |
| URL | `https://pdf.melki.top` (Authentik + Caddy) |
| Путь | `/opt/pdfocr/app/` |
| БД | `/opt/pdfocr/data/db/pdfocr.db` (SQLite) |
| Pipeline | Callback: app.js → SSH nohup gpu_wrapper.py → callback |
| Git | `/opt/pdfocr/.git` |
| DOCX | md2docx.js v2.0 (6 встроенных схем + пользовательские профили) |
| Internal API | `/api/internal/*` с X-Internal-Token |

### Caddy (transcribe_caddy)

| Параметр | Значение |
|----------|----------|
| Контейнер | `transcribe_caddy` |
| Конфиг | `/opt/transcribe/caddy/Caddyfile` |
| Функции | TLS, reverse proxy, Authentik forward_auth |

Домены:
- `transcribe.melki.top` → transcribe_app:3000 (Authentik + internal bypass)
- `pdf.melki.top` → pdfocr_app:3001 (Authentik + WS bypass + internal bypass)
- `hub.melki.top` → /opt/hub (Authentik)
- `auth.melki.top` → melki-auth:3333
- `authentik.melki.top` → authentik-server:9000
- `notebook.melki.top` → per-user containers (Authentik)
- `claw.melki.top` → openclaw (Authentik + WS bypass)
- `amdin.melki.top` → melki-admin:3001 (admins only)

```bash
docker exec transcribe_caddy caddy reload --config /etc/caddy/Caddyfile
```

### Authentik

| Параметр | Значение |
|----------|----------|
| Контейнер | `authentik-server` |
| Provider | `melki-forward-auth` (mode: forward_domain) |
| Cookie domain | `melki.top` (покрывает все *.melki.top) |
| Application | `melki-platform` |

### n8n (ОТКЛЮЧЁН для транскрибации)

| Параметр | Значение |
|----------|----------|
| Контейнер | `n8n` |
| Порт | `127.0.0.1:5678` (закрыт снаружи) |
| URL | `http://212.67.8.251:5678` (только внутри) |
| Статус | task_runner.py ОТКЛЮЧЁН, pipeline заменён на callback |
| NODE_OPTIONS | `--max-old-space-size=4096` |

### Claude-прокси

| Параметр | Значение |
|----------|----------|
| Тип | systemd service |
| Порт | `5680` |

### Порты (все закрыты для внешнего доступа)

| Порт | Сервис | Bind |
|------|--------|------|
| 443 | Caddy (HTTPS) | 0.0.0.0 |
| 3000 | transcribe_app | внутренний (Docker) |
| 3001 | pdfocr_app | внутренний (Docker) |
| 5678 | n8n | 127.0.0.1 |
| 5680 | Claude-прокси | 0.0.0.0 |
| 8969 | speaches | 127.0.0.1 |
| 11434 | ollama (local) | 127.0.0.1 |

---

## 🔴 GPU-сервер — сервисы

**Статус по умолчанию: SHELVED (auto-shelve после обработки)**

### Whisper (whisper_server)

| Параметр | Значение |
|----------|----------|
| Контейнер | `whisper_server` |
| Модель | `deepdml/faster-whisper-large-v3-turbo-ct2` |
| Порт | `:8000` |
| docker-compose | `/root/whisper/docker-compose.yml` |
| Restart | `unless-stopped` |
| Env | `WHISPER__COMPUTE_TYPE=float16` |

### Diarize (v5, systemd)

| Параметр | Значение |
|----------|----------|
| Скрипт | `/home/ubuntu/diarize_server.py` (v5) |
| Порт | `:8002` |
| Unit | `/etc/systemd/system/diarize.service` |
| Noise filter | light=«Zoom» (hp80+anlmdn3), aggressive=«Кафе» (lp6000+anlmdn3) |

### Ollama (ollama_engine)

| Параметр | Значение |
|----------|----------|
| Контейнер | `ollama_engine` |
| Порт | `:11434` |
| Модели | `qwen2.5:14b` (primary), `qwen2:7b` |

### Marker/Surya (marker_service)

| Параметр | Значение |
|----------|----------|
| Контейнер | `marker_service` |
| OCR скрипт | `/app/pdf_ocr_vX_4.py` |
| Данные IN | `/n8n_media/IN/` |
| Данные OUT | `/n8n_media/OUT/` |

### GPU Wrapper (gpu_wrapper.py)

| Параметр | Значение |
|----------|----------|
| Скрипт | `/home/ubuntu/gpu_wrapper.py` |
| Symlink | `/opt/gpu-wrapper.py` → `/home/ubuntu/gpu_wrapper.py` |
| Функция | Универсальный wrapper: nohup + callbacks (started/progress/done/error) |
| Используется | Транскрибация + PDF OCR |

### Watchdog (systemd timer)

| Параметр | Значение |
|----------|----------|
| Скрипт | `/home/ubuntu/gpu_watchdog.py` |
| Интервал | каждые 3 мин |
| Логика | Проверяет Whisper/Ollama/Diarize, рестартит упавшие |

### Скрипты обработки

| Скрипт | Назначение |
|--------|------------|
| `gpu_wrapper.py` | Универсальный callback wrapper |
| `transcribe_gpu.py` | Транскрибация: diarize+whisper локально |

### Healthcheck

```bash
curl -s http://195.209.214.7:8002/health   # diarize
curl -s http://195.209.214.7:8000/health   # whisper
curl -s http://195.209.214.7:11434/api/tags # ollama
```

---

## OpenStack (immers.cloud)

| Параметр | Значение |
|----------|----------|
| Auth URL | `https://api.immers.cloud:5000/v3` |
| Проект | AlekseyNechaev |
| Server ID | `8baf5a78-ef09-49c9-8aec-ccccf0a46742` |

⚠️ **Только SHELVE останавливает тариф. SHUTOFF — НЕ останавливает!**

Auto-shelve: оба сервиса (transcribe + pdfocr) проверяют GPU load и shelve'ят через API после grace period. Координация: nvidia-smi check перед shelve.

---

## Pipeline обработки

### Транскрибация (callback pipeline v1.9.12)
```
Upload → gpu-pipeline.js → unshelve GPU → SCP файл
→ SSH nohup transcribe_gpu.py → callbacks (progress)
→ SCP результат ← GPU → Claude Haiku (саммари)
→ DB → email → auto-shelve
```

### PDF OCR (callback pipeline v2.6)
```
Upload → processQueue() → unshelve GPU → SCP файл
→ SSH nohup gpu_wrapper.py → callbacks (progress)
→ SCP результат ← GPU → DB → email → webhooks
→ auto-shelve
```

---

## Токены и секреты

| Токен | Назначение | Где |
|-------|------------|-----|
| n8n API key | REST API n8n | env N8N_API_KEY |
| JWT internal | n8n→transcribe (expires 2036) | env INTERNAL_JWT |
| Callback secret | GPU→CPU callbacks | env CALLBACK_SECRET |
| PDF OCR internal token | Межсервисный API | env INTERNAL_TOKEN (default: pdfocr_internal_2026) |
| ANTHROPIC_API_KEY | Claude API (Haiku) для саммари | env |
| OPENSTACK_PASSWORD | GPU management | env |

---

## Бэкапы

| Что | Где | Когда |
|-----|-----|-------|
| transcribe.db | `/opt/transcribe/backups/` | cron 03:00 ежедневно |
| pdfocr файлы | `/opt/pdfocr/backups/2026-04-19/` | ручной перед деплоем |
| GPU скрипты | `/home/ubuntu/backups/2026-04-11/` | ручной |

---

## Git

| Проект | Путь | Remote |
|--------|------|--------|
| Транскрибация | `/opt/transcribe/app/` | github.com/AlexeyNN74/transcribot_n8n |
| PDF OCR | `/opt/pdfocr/` | (local only) |

---

## Важные правила

1. После изменения файлов → **`docker restart transcribe_app`** / **`docker restart pdfocr_app`**
2. После изменения env в docker-compose → **`docker compose up -d --force-recreate`**
3. Heredoc с JS/JSON — **ненадёжен**, использовать Python или файл→docker cp→node
4. 🟢 веб: `jq` ❌ → `python3 -m json.tool`
5. 🔴 GPU: `jq` ✅ (v1.6)
6. Файлы >50 строк с русским текстом → Claude → скачать → SFTP (не cat/heredoc)
7. GPU shelve — координация между транскрибацией и pdfocr (nvidia-smi check)
8. Caddy контейнер: **transcribe_caddy** (не `caddy`)
9. Alpine контейнеры: **sh**, не bash
