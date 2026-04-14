# INFRASTRUCTURE.md — Студия Транскрибации

**Обновлено:** 15 апреля 2026

---

## Серверы

| Параметр | 🟢 Веб-сервер | 🔴 GPU-сервер |
|----------|---------------|---------------|
| Хост | `transcribe.melki.top` / `212.67.8.251` | `195.209.214.7` (supreme, immers.cloud) |
| ОС | Ubuntu 22.04 | Ubuntu 22.04 |
| Пользователь | `root` | `ubuntu` |
| SSH | `ssh root@212.67.8.251` | `ssh ubuntu@195.209.214.7` |
| GPU | — | NVIDIA RTX 3090 (24 GB VRAM) |
| Хостинг | Beget VPS | immers.cloud (OpenStack) |
| SSH между серверами | `ssh ubuntu@195.209.214.7` (ключ `web-to-gpu`, ed25519) |

---

## Pipeline данных: аудио → результат

```
ПОЛЬЗОВАТЕЛЬ загружает файл
    ↓
🟢 Веб-сервер: /data/uploads/{uuid}.mp3
    ↓  (n8n workflow или batch_diarize.py через SCP)
🔴 GPU-сервер: diarize_server :8002
    ↓
  POST /diarize  file=<audio>
    ↓
  ffmpeg (CPU): MP3 → mono 16kHz WAV + loudnorm + SNR-анализ + noise filter
    ↓
  Whisper (GPU, :8000): WAV → segments [{start, end, text}, ...]
    ↓
  Pyannote (GPU): диаризация чанками по 20 мин → speaker labels
    ↓
  Merge + Group: объединение → [{start, end, speaker, text}, ...]
    ↓
ОТВЕТ JSON: {segments, plain_text, stats}
    ↓
🟢 Веб-сервер: конвертация (n8n/скрипт)
    ↓
  result_srt   = SRT с голосами: "1\n00:08:02,260 --> 00:09:28,150\nГолос 1: текст"
  result_clean = текст с голосами без таймкодов
  result_json  = JSON.stringify(полный ответ diarize)
    ↓
🟢 Саммари (ОТДЕЛЬНО от diarize):
  Claude API (Haiku) с веб-сервера → result_txt
  ИЛИ Ollama на GPU (qwen2.5:14b) → result_txt (устаревший путь)
    ↓
🟢 БД: POST /api/internal/job-result
  {filename, result_txt, result_srt, result_json, result_clean}
  Auth: Bearer <JWT>
```

**Табы в UI:** «Саммари» = result_txt (ВСЕГДА), «Транскрипция» = result_srt/result_clean (ВСЕГДА)

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
| БД | `/opt/transcribe/data/db/transcribe.db` (SQLite, better-sqlite3) |
| Загрузки | `/opt/transcribe/data/uploads/` |
| Результаты | `/opt/transcribe/data/results/` |
| docker-compose | `/opt/transcribe/docker-compose.yml` |

**Команды:**
```bash
docker restart transcribe_app
cd /opt/transcribe && docker compose up -d --force-recreate app
docker logs -f transcribe_app --tail 100
curl -s https://transcribe.melki.top/api/version
```

### n8n

| Параметр | Значение |
|----------|----------|
| Контейнер | `n8n` |
| Порт | `5678` |
| URL | `http://212.67.8.251:5678` |
| NODE_OPTIONS | `--max-old-space-size=4096` |
| Медиа (входящие) | `/n8n_media/IN/` |
| Медиа (исходящие) | `/n8n_media/OUT/` |

**Workflow'ы:**
- **Секретарь таймкодов v3** — ID: `ho6fwPPZOip7eXof` (основной pipeline)
- **Error Handler** — ID: `zOnO3fTBxyxoJ4LS` (обработка ошибок)

⚠️ **n8n OOM на файлах >88MB** — передаёт файлы через HTTP. Решение: SCP файлов на GPU (задача 2.4 в ROADMAP)

```bash
docker start n8n
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

### Claude API (для саммари)

| Параметр | Значение |
|----------|----------|
| Доступ | С веб-сервера Beget напрямую (HTTP 405 = ОК) |
| Модель | `claude-haiku-4-5-20251001` |
| Стоимость | ~$0.03/файл |
| Rate limit | 50K input tokens/min → пауза 30 сек между файлами |
| Скрипт | `/tmp/claude_summaries.py` |
| API ключ | через env `ANTHROPIC_API_KEY` |

```bash
ANTHROPIC_API_KEY=sk-ant-... python3 /tmp/claude_summaries.py
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
curl -s http://localhost:8000/health
```

### Diarize (diarize.service)

| Параметр | Значение |
|----------|----------|
| Тип | systemd service |
| Скрипт | `/home/ubuntu/diarize_server.py` (**v5**) |
| Порт | `:8002` |
| Unit-файл | `/etc/systemd/system/diarize.service` |
| Чанки | 20 мин + 30 сек overlap |
| VRAM | ~4 GB при работе |
| Скорость | ~10x realtime (67 мин аудио → 6 мин) |
| Особенности | SNR-анализ, noise_filter_override, min/max speakers, без лимита размера |

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
| Модели | `qwen2:7b`, `qwen2.5:14b`, `qwen2.5vl:3b/7b`, `llama3.1:8b`, `gemma2:9b`, `deepseek-ocr`, `glm-ocr` |
| Restart | `unless-stopped` |
| Примечание | Используется также проектом pdfocr |

⚠️ **Для саммари теперь используется Claude API** — Ollama для саммари не рекомендуется (qwen2.5:14b не следует формату)

```bash
docker logs -f ollama_engine --tail 50
curl -s http://localhost:11434/api/tags | jq '.models[].name'
```

### n8n_app (pdfocr)

| Параметр | Значение |
|----------|----------|
| Контейнер | `n8n_app` |
| Назначение | PDF OCR проект (отдельный от веб-сервера n8n!) |
| Статус | По умолчанию остановлен |

```bash
docker start n8n_app   # запустить для pdfocr
docker stop n8n_app    # остановить
```

### Watchdog (gpu_watchdog)

| Параметр | Значение |
|----------|----------|
| Тип | systemd timer (каждые 3 мин) |
| Скрипт | `/home/ubuntu/gpu_watchdog.py` |
| Unit-файл | `/etc/systemd/system/watchdog.service` |
| Timer | `/etc/systemd/system/watchdog.timer` |
| Статус | **Файлы готовы, НЕ ЗАДЕПЛОЕНЫ** |
| Логика | Проверяет Whisper/Ollama/Diarize, рестартит упавшие; `is_process_busy()` не убивает занятый diarize |

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

## SSH между серверами

| Параметр | Значение |
|----------|----------|
| Направление | 🟢 веб → 🔴 GPU |
| Ключ | `/root/.ssh/id_ed25519` (web-to-gpu) |
| Команда | `ssh ubuntu@195.209.214.7` |
| SCP | `scp <файл> ubuntu@195.209.214.7:/path/` |
| Скорость | ~80-100 MB/s |

---

## Модульная структура приложения (v1.9.8)

```
/opt/transcribe/app/
├── server.js          — точка входа, health, version, cleanup, stuck jobs
├── config.js          — все env переменные и пути
├── db.js              — БД, таблицы, миграции, seed промпты
│                        ЭКСПОРТИРУЕТ: { db } — НЕ голый объект!
├── middleware.js       — authMiddleware, adminMiddleware
├── utils/
│   ├── helpers.js     — escapeHtml, logEvent, detectFileType, getTranscript
│   └── email.js       — nodemailer (SMTP работает)
├── routes/
│   ├── auth.js        — register, login, activate
│   ├── prompts.js     — CRUD промптов
│   ├── jobs.js        — upload, list (JOIN prompts), downloads (docx/md/srt/json), rating, delete
│   ├── internal.js    — webhook/result, job-result (atomic write), job-prompt, watchdog-event
│   └── admin.js       — users, stats, prompts, GPU panel (shelve/unshelve), monitor, events, archive
├── public/
│   └── index.html     — SPA фронтенд
├── CHEATSHEET.md      — шпаргалка по командам и путям
├── INFRASTRUCTURE.md  — этот файл
├── Dockerfile
├── docker-compose.yml
└── package.json
```

---

## OpenStack (immers.cloud) — управление GPU

| Параметр | Значение |
|----------|----------|
| Auth URL | `https://api.immers.cloud:5000/v3` |
| Проект | AlekseyNechaev |
| Server ID | `8baf5a78-ef09-49c9-8aec-ccccf0a46742` |

⚠️ **SHELVE останавливает тариф. SHUTOFF (просто stop) — НЕ останавливает!**

Управление через админку transcribe.melki.top (Монитор → Запустить/Остановить) или через API:
```bash
# Из Node.js (внутри контейнера)
docker exec transcribe_app node -e "const {gpuDoAction} = require('./routes/admin'); gpuDoAction('shelve').then(()=>console.log('OK')).catch(e=>console.error(e.message));"
```

---

## Батч-скрипты

| Скрипт | Расположение | Назначение |
|--------|-------------|------------|
| `batch_diarize.py` | `/tmp/` на 🟢 | Транскрипция файлов: SCP→GPU→diarize→БД |
| `claude_summaries.py` | `/tmp/` на 🟢 | Генерация саммари через Claude API |
| `fix_summaries_v3.py` | `/tmp/` на 🟢 | Саммари через Ollama (устаревший) |

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
| Текущая версия | **v1.9.8** (коммит 9130996, 15 Apr) |

```bash
cd /opt/transcribe/app
git add -A && git commit -m "vX.X.X — description" && git push
docker restart transcribe_app
```

---

## Важные правила

1. После изменения файлов в `/opt/transcribe/app/` → **`docker restart transcribe_app`**
2. После изменения env в docker-compose.yml → **`docker compose up -d --force-recreate app`**
3. Heredoc с JS/JSON — **ненадёжен**, использовать Python для создания/патча файлов
4. 🟢 веб: `jq` отсутствует → `python3 -m json.tool` или `grep`
5. 🔴 GPU: `jq` есть (v1.6)
6. Логика вкладок: **Саммари** = Claude API, **Транскрипция** = Whisper/diarize
7. GPU shelve — только при нулевой нагрузке (другие проекты, напр. pdfocr!)
8. `db.js` экспортирует `{ db }` — пиши `const {db} = require("./db")`
9. `watch` через SSH не работает — использовать `while true; do ...; sleep 5; done`
10. Файлы/скрипты → `/tmp/`, не мусорить в `/root/`
11. n8n API: заголовок `X-N8N-API-KEY`, не Bearer
