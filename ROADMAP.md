# Студия Транскрибации + PDF OCR — ПЛАН ЗАДАЧ
# Обновлено: 19 апреля 2026, чат #15
# Транскрибация: v1.9.12 | PDF OCR: v2.6

---

## ✅ ВЫПОЛНЕНО (чаты #1–#15)

### Транскрибация
- ✅ Базовый pipeline: n8n workflow, Whisper, Ollama (чат #1)
- ✅ Diarize v1-v5, промпт-профили, SRT/JSON, security patch (чат #2-7)
- ✅ Модульность server.js (10 файлов), модальные окна (чат #3-4)
- ✅ Callback pipeline: gpu-pipeline.js заменил cron+n8n (чат #13-14)
- ✅ Watchdog deploy (systemd timer 3 мин) (чат #14)
- ✅ Progress_msg: этапы обработки в UI (чат #14)
- ✅ Launch timeout 5 мин (чат #14)
- ✅ Порты закрыты (127.0.0.1) (чат #12)
- ✅ SMTP через smtp.beget.com (чат #12)
- ✅ Soft delete + архив заданий (чат #12)
- ✅ Claude API (Haiku) для саммари (чат #9)
- ✅ Автобэкап БД cron 03:00 (чат #9)

### PDF OCR
- ✅ Callback-архитектура (Подход Б) (чат #11)
- ✅ DOCX конвертация с цветовыми схемами (чат #11-12)
- ✅ Authentik forward_auth (чат #15)
- ✅ Статический фронтенд (session/bcrypt убрано) (чат #15)
- ✅ Internal API (4 endpoint'а) + webhooks (чат #15)
- ✅ md2docx v2.0: 6 схем, blockquotes, h4-h6, alt rows (чат #15)
- ✅ DOCX профили UI (модалка, color picker, preview) (чат #15)
- ✅ Удаление DOCX файлов (Ctrl/Cmd + ×) (чат #15)
- ✅ WebSocket fix (Caddy forward_auth bypass) (чат #15)
- ✅ Auto-shelve GPU с координацией (чат #11)

### Инфраструктура
- ✅ Authentik (forward_domain для *.melki.top) (чат #15)
- ✅ gpu_wrapper.py — универсальный callback wrapper (чат #14)
- ✅ INFRASTRUCTURE.md обновлён (чат #15)

---

## 🔧 БЛИЖАЙШИЕ ЗАДАЧИ

### Быстрые фиксы (без GPU, 30 мин)

| # | Задача | Проект | Описание |
|---|--------|--------|----------|
| F-1 | &nbsp; / <br> очистка | PDF OCR | md2docx.js: replace HTML entities перед парсингом |
| F-2 | Расширить профили DOCX | PDF OCR | Добавить spacing, margins, blockquote в конфиг профиля |

### GPU тесты (нужен unshelve, ~2 ч)

| # | Задача | Проект | Описание |
|---|--------|--------|----------|
| G-1 | PDF OCR на 100+ стр | PDF OCR | Тест callback на длинной задаче |
| G-2 | Diarize v5 на >2ч файле | Транскр. | Стабильность чанков pyannote |
| G-3 | Progress_msg в UI | Транскр. | Загрузить файл, проверить этапы |
| G-4 | Whisper systemd auto-start | GPU | Не docker restart, а systemd |

### UI/UX улучшения (без GPU, ~4 ч)

| # | Задача | Проект | Описание |
|---|--------|--------|----------|
| U-1 | Прогресс обработки | Транскр. | Этапы: загрузка → whisper → diarize → саммари → готово |
| U-2 | Батч-загрузка с очередью | Транскр. | N файлов → очередь → визуализация |

---

## 📋 БЭКЛОГ (когда будет время)

### Качество pipeline

| # | Задача | Описание |
|---|--------|----------|
| Q-1 | Валидация саммари | Автопроверка: если result_txt начинается с шаблонных фраз → перегенерация |
| Q-2 | Whisper постпроцессинг | Коррекция несуществующих русских слов |
| Q-3 | Retry логика | Diarize/Ollama ошибка → retry до 3 раз |

### Мониторинг

| # | Задача | Описание |
|---|--------|----------|
| M-1 | GPU коллектор метрик | Агент пишет VRAM, GPU%, активный процесс каждые 30 сек |
| M-2 | API + UI timeline | «ЭКГ сервера» — горизонтальные дорожки сервисов |
| M-3 | Алерты | VRAM >90% или сервис не отвечает → email |

### Оптимизация

| # | Задача | Описание |
|---|--------|----------|
| O-1 | Параллельная обработка | 2 инстанса diarize (VRAM позволяет) |
| O-2 | Pre-upload SCP | Копировать файлы на GPU при загрузке, не при обработке |
| O-3 | GPU contention | Приоритеты между транскрибацией и pdfocr |

### Межсервисная интеграция

| # | Задача | Описание |
|---|--------|----------|
| I-1 | OpenNotebook ← PDF OCR | Webhook: PDF готов → автоимпорт в Notebook |
| I-2 | OpenClaw ← PDF OCR | Webhook: PDF готов → материал для агентов |
| I-3 | Shared storage | Docker volume или MinIO для обмена файлами |

---

## 📍 ЭТАПЫ РАЗВИТИЯ (из ROADMAP_melki.md)

| Этап | Статус | Описание |
|------|--------|----------|
| 1. Callback Pattern | ✅ ГОТОВ | gpu_wrapper.py, оба сервиса на callbacks |
| 1.5. DOCX схемы | ✅ ГОТОВ | 6 схем + профили + md2docx v2.0 |
| 2. GPU Hub | ⏳ Будущее | melki-dispatcher + Redis + worker-agent |
| 3. Storage & Scaling | ⏳ Будущее | MinIO + PostgreSQL + Grafana |
| 4. Enterprise | ⏳ Будущее | Multi-region, биллинг, SLA |
