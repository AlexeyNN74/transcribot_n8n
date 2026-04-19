# melki.top — Roadmap инфраструктурной эволюции

**Создан:** 16 апреля 2026
**Обновлён:** 19 апреля 2026, чат #15
**Автор:** Aleksey + Claude

---

## Философия

> «Для друзей — лучшее начало.»

Архитектура Этапа 2 с инфраструктурой Этапа 1: код знает, что может быть несколько GPU, но пока один GPU, один CPU, SQLite. Паттерны (callbacks, очереди, worker pool) закладываются сразу.

---

## Текущее состояние (19 апреля 2026)

### 🟢 CPU (Beget, 212.67.8.251)
- **Транскрибация** (`transcribe.melki.top`) — v1.9.12, callback pipeline
- **PDF OCR** (`pdf.melki.top`) — v2.6, Authentik, Internal API, md2docx v2.0
- **Authentik** — forward_domain для *.melki.top, SSO для всех сервисов
- **Caddy** (`transcribe_caddy`) — reverse proxy, TLS, Authentik forward_auth
- **Open Notebook** (multi-tenant: aleksey, andrey, vlad, misha, sveta, testtest)
- **OpenClaw** (claw.melki.top)
- **Claude-прокси** (`:5680`)

### 🔴 GPU (immers.cloud, 195.209.214.7, RTX 3090)
- **Whisper** (`:8000`) — faster-whisper-large-v3-turbo
- **Diarize v5** (`:8002`, systemd) — noise filter, чанки
- **Ollama** (`:11434`) — qwen2.5:14b
- **Marker/Surya** — PDF OCR
- **gpu_wrapper.py** — универсальный callback wrapper
- **Watchdog** — systemd timer 3 мин

### Паттерн взаимодействия CPU ↔ GPU
- **Callback pattern** (оба сервиса): SSH nohup → gpu_wrapper.py → HTTP callbacks → SCP результат
- **Auto-shelve** с координацией (nvidia-smi check перед shelve)

---

## Этап 1 — Callback Pattern ✅ ГОТОВ

### 1.1 PDF OCR — Подход Б ✅
- [x] gpu_wrapper.py на GPU — универсальный wrapper
- [x] Endpoint: POST /api/internal/callback/{jobId}
- [x] Переписан runOCR() → nohup + callbacks
- [x] Fallback: проверка GPU при отсутствии callback
- [x] Auto-shelve с grace period

### 1.2 Транскрибация — callback pipeline ✅
- [x] Убран cron task_runner.py
- [x] gpu-pipeline.js → SSH nohup → callbacks
- [x] transcribe_gpu.py на GPU
- [x] Progress_msg в UI (этапы обработки)
- [x] Launch timeout 5 мин

### 1.3 Общая callback инфраструктура ✅
- [x] Единый формат callback JSON (started/progress/done/error)
- [x] gpu_wrapper.py используется обоими сервисами
- [x] Shared secret per-service (callback_secret)
- [x] Watchdog systemd timer

---

## Этап 1.5 — DOCX + цветовые схемы ✅ ГОТОВ

- [x] md2docx.js v2.0: полноценное форматирование
- [x] 6 встроенных схем (strict, modern, academic, creative, minimal, corporate)
- [x] Blockquotes с заливкой и боковой рамкой
- [x] Alternating table rows, heading borders, line spacing
- [x] h1-h6 поддержка
- [x] Пользовательские DOCX профили (до 3 per user)
- [x] UI редактор профилей (color picker, шрифты, preview)
- [x] Кэш DOCX файлов

---

## Этап 1.7 — Authentik + Inter-service API ✅ ГОТОВ (добавлен в чате #15)

- [x] Authentik forward_auth для pdf.melki.top
- [x] app.js → чистый API (убраны session/bcrypt/login/HTML)
- [x] Internal API: 4 endpoint'а (/api/internal/jobs, /files, /download)
- [x] Webhooks при job_done
- [x] WebSocket bypass forward_auth в Caddy

---

## Этап 2 — GPU Hub (при появлении второго GPU)

**Цель:** единая точка управления всеми GPU-задачами.

### 2.1 melki-dispatcher
- [ ] Отдельный проект: `/opt/melki-dispatcher/`
- [ ] Node.js + Express + Redis + SQLite

### 2.2 Очередь задач через Redis
- [ ] Очереди: queue:pdfocr, queue:transcribe, queue:notebook, queue:claw
- [ ] Приоритеты: high/normal/low
- [ ] Dead letter queue

### 2.3 Worker registration
- [ ] worker-agent.py на GPU: capabilities, VRAM, heartbeat
- [ ] При пропаже heartbeat → offline, переназначение задач

### 2.4 Smart routing
- [ ] Выбор worker'а по: модель загружена? VRAM? Round-robin

### 2.5 Централизованный GPU management
- [ ] Auto-shelve/unshelve через dispatcher
- [ ] Mutex на unshelve

**Триггер:** появление второго GPU-сервера или >3 GPU-сервисов

---

## Этап 3 — Storage & Scaling (при >20 пользователях)

- [ ] MinIO (объектное хранилище) → убрать SCP
- [ ] PostgreSQL вместо SQLite
- [ ] Grafana + Prometheus для метрик
- [ ] Закрытие всех портов (уже частично сделано)

---

## Этап 4 — Enterprise Scale (при коммерциализации)

- [ ] Dedicated dispatcher VPS
- [ ] Multi-region GPU
- [ ] Биллинг per-user
- [ ] Usage quotas, SLA

---

## Классификация GPU-сервисов

| Сервис | Модели | VRAM |
|--------|--------|------|
| Транскрибация | Whisper large-v3 + Diarize | ~6 GB |
| PDF OCR | Surya + PP-DocLayout + Claude API | ~14 GB |
| Ollama | qwen2.5:14b | 4-10 GB |

---

## Таймлайн

| Этап | Статус | Триггер |
|------|--------|---------|
| 1. Callback | ✅ Готов | — |
| 1.5. DOCX | ✅ Готов | — |
| 1.7. Authentik + API | ✅ Готов | — |
| 2. GPU Hub | ⏳ | Второй GPU |
| 3. Storage | ⏳ | >20 пользователей |
| 4. Enterprise | ⏳ | Коммерциализация |
