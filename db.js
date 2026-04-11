'use strict';
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const { DB_PATH } = require('./config');

const db = new Database(DB_PATH);

// ===== TABLES =====
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    active INTEGER DEFAULT 0,
    activation_token TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    last_login TEXT
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    progress INTEGER DEFAULT 0,
    result_txt TEXT,
    result_srt TEXT,
    result_json TEXT,
    result_clean TEXT,
    error TEXT,
    keep_days INTEGER DEFAULT 7,
    created_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT,
    expires_at TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT DEFAULT (datetime('now')),
    event_type TEXT NOT NULL,
    job_id TEXT,
    user_id TEXT,
    details TEXT,
    source TEXT DEFAULT 'web'
  );
  CREATE INDEX IF NOT EXISTS idx_events_ts ON events(timestamp);
  CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
  CREATE INDEX IF NOT EXISTS idx_events_job ON events(job_id);

  CREATE TABLE IF NOT EXISTS prompts (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    prompt_text TEXT NOT NULL,
    is_default INTEGER DEFAULT 0,
    is_system INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
`);

// ===== MIGRATIONS =====
['prompt_id TEXT', 'prompt_text TEXT', 'rating INTEGER', 'diarize INTEGER DEFAULT 0', 'result_clean TEXT', 'duration_sec REAL', 'video_limit_mb INTEGER DEFAULT 200', 'archived_at TEXT', 'archived_at TEXT'].forEach(col => {
  try { db.exec(`ALTER TABLE jobs ADD COLUMN ${col}`); } catch (_) {}
});

// ===== SEED PROMPTS =====
const promptCount = db.prepare('SELECT COUNT(*) as c FROM prompts WHERE is_system=1').get().c;
if (promptCount === 0) {
  db.prepare(`
    INSERT INTO prompts (id, user_id, name, description, prompt_text, is_default, is_system)
    VALUES (?, NULL, ?, ?, ?, 1, 1)
  `).run(
    uuidv4(),
    'Универсальный',
    'Подходит для любого типа записи',
    `Ты — профессиональный редактор транскрипций. Перед тобой транскрипция аудио/видео записи.

Твоя задача:
1. Составь краткое саммари (3-5 предложений) — о чём запись в целом.
2. Выдели ключевые темы и тезисы — маркированным списком.
3. Если есть конкретные факты, цифры, имена — сохрани их точно.
4. Язык саммари должен совпадать с языком записи.

Отвечай только структурированным текстом, без вводных фраз.`
  );

  const systemProfiles = [
    {
      name: 'Вебинар',
      description: 'Обучающие вебинары и онлайн-курсы',
      prompt: `Ты — ассистент по обработке вебинаров. Перед тобой транскрипция обучающего вебинара.

Составь структурированный конспект:
1. Тема вебинара и спикер (если упоминается).
2. Основные блоки и темы — с заголовками.
3. Ключевые тезисы и выводы по каждому блоку.
4. Практические советы и рекомендации (если есть).
5. Вопросы из аудитории и ответы (если есть).

Язык вывода — язык записи. Без вводных фраз.`
    },
    {
      name: 'Медитация',
      description: 'Медитации, практики, релаксация',
      prompt: `Ты — помощник для обработки медитативных практик. Перед тобой транскрипция медитации или практики.

Составь описание:
1. Тип практики и её цель.
2. Основные этапы (с таймингом если есть).
3. Ключевые инструкции и образы, которые использует ведущий.
4. Общая атмосфера и особенности подачи.

Тон — спокойный, нейтральный. Язык вывода — язык записи.`
    },
    {
      name: 'Консультация',
      description: 'Бизнес-консультации, коучинг, интервью',
      prompt: `Ты — ассистент по обработке деловых консультаций. Перед тобой транскрипция консультации или интервью.

Составь структурированный отчёт:
1. Участники и контекст встречи.
2. Обсуждаемые проблемы/задачи.
3. Предложенные решения и рекомендации.
4. Договорённости и следующие шаги (если есть).
5. Ключевые цитаты (если значимы).

Язык вывода — язык записи. Деловой стиль.`
    }
  ];

  systemProfiles.forEach(p => {
    db.prepare(`
      INSERT INTO prompts (id, user_id, name, description, prompt_text, is_default, is_system)
      VALUES (?, NULL, ?, ?, ?, 0, 1)
    `).run(uuidv4(), p.name, p.description, p.prompt);
  });

  console.log('Default prompt profiles created');
}

module.exports = { db };
