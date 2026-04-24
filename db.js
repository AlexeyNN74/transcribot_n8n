'use strict';
// db.js v2.0 — PostgreSQL edition
// Updated: 2026-04-24

const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

const pool = new Pool({
  host:     process.env.PG_HOST     || 'melki_postgres',
  port:     parseInt(process.env.PG_PORT || '5432'),
  database: process.env.PG_DB       || 'melki',
  user:     process.env.PG_USER     || 'melki',
  password: process.env.PG_PASSWORD || 'melki2026',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Converts SQLite ? placeholders to PostgreSQL $1, $2, ...
const pgify = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };

const dbGet = async (sql, params = []) => {
  const r = await pool.query(pgify(sql), params);
  return r.rows[0] || null;
};

const dbAll = async (sql, params = []) => {
  const r = await pool.query(pgify(sql), params);
  return r.rows;
};

const dbRun = async (sql, params = []) => {
  const r = await pool.query(pgify(sql), params);
  return { rowCount: r.rowCount, rows: r.rows };
};

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transcribe_users (
      id               TEXT PRIMARY KEY,
      email            TEXT UNIQUE NOT NULL,
      password         TEXT NOT NULL DEFAULT '',
      name             TEXT NOT NULL,
      role             TEXT DEFAULT 'user',
      active           INTEGER DEFAULT 0,
      activation_token TEXT,
      video_limit_mb   INTEGER DEFAULT 200,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      last_login       TIMESTAMPTZ
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS transcribe_jobs (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL,
      filename      TEXT NOT NULL,
      original_name TEXT NOT NULL,
      status        TEXT DEFAULT 'pending',
      progress      INTEGER DEFAULT 0,
      progress_msg  TEXT,
      result_txt    TEXT,
      result_srt    TEXT,
      result_json   TEXT,
      result_clean  TEXT,
      error         TEXT,
      keep_days     INTEGER DEFAULT 7,
      prompt_id     TEXT,
      prompt_text   TEXT,
      rating        INTEGER,
      diarize       INTEGER DEFAULT 0,
      min_speakers  INTEGER,
      max_speakers  INTEGER,
      noise_filter  TEXT,
      duration_sec  REAL,
      archived_at   TIMESTAMPTZ,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      completed_at  TIMESTAMPTZ,
      expires_at    TIMESTAMPTZ
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS transcribe_settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS transcribe_events (
      id         BIGSERIAL PRIMARY KEY,
      timestamp  TIMESTAMPTZ DEFAULT NOW(),
      event_type TEXT NOT NULL,
      job_id     TEXT,
      user_id    TEXT,
      details    TEXT,
      source     TEXT DEFAULT 'web'
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tr_events_ts   ON transcribe_events(timestamp)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tr_events_type ON transcribe_events(event_type)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tr_events_job  ON transcribe_events(job_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS transcribe_prompts (
      id          TEXT PRIMARY KEY,
      user_id     TEXT,
      name        TEXT NOT NULL,
      description TEXT DEFAULT '',
      prompt_text TEXT NOT NULL,
      is_default  INTEGER DEFAULT 0,
      is_system   INTEGER DEFAULT 0,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS transcribe_gpu_sessions (
      id           TEXT PRIMARY KEY,
      unshelve_at  TIMESTAMPTZ NOT NULL,
      shelve_at    TIMESTAMPTZ,
      duration_sec REAL,
      jobs_count   INTEGER DEFAULT 0,
      job_ids      TEXT DEFAULT '[]',
      trigger_type TEXT DEFAULT 'auto',
      status       TEXT DEFAULT 'active'
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tr_gpu_sessions ON transcribe_gpu_sessions(unshelve_at)`);

  // Seed default prompts
  const { rows } = await pool.query('SELECT COUNT(*)::int as c FROM transcribe_prompts WHERE is_system=1');
  if (rows[0].c === 0) {
    await pool.query(
      `INSERT INTO transcribe_prompts (id, user_id, name, description, prompt_text, is_default, is_system)
       VALUES ($1, NULL, $2, $3, $4, 1, 1)`,
      [uuidv4(), 'Универсальный', 'Подходит для любого типа записи',
        `Ты — профессиональный редактор транскрипций. Перед тобой транскрипция аудио/видео записи.\n\nТвоя задача:\n1. Составь краткое саммари (3-5 предложений) — о чём запись в целом.\n2. Выдели ключевые темы и тезисы — маркированным списком.\n3. Если есть конкретные факты, цифры, имена — сохрани их точно.\n4. Язык саммари должен совпадать с языком записи.\n\nОтвечай только структурированным текстом, без вводных фраз.`]
    );

    const systemProfiles = [
      {
        name: 'Вебинар', desc: 'Обучающие вебинары и онлайн-курсы',
        prompt: 'Ты — ассистент по обработке вебинаров. Перед тобой транскрипция обучающего вебинара.\n\nСоставь структурированный конспект:\n1. Тема вебинара и спикер (если упоминается).\n2. Основные блоки и темы — с заголовками.\n3. Ключевые тезисы и выводы по каждому блоку.\n4. Практические советы и рекомендации (если есть).\n5. Вопросы из аудитории и ответы (если есть).\n\nЯзык вывода — язык записи. Без вводных фраз.',
      },
      {
        name: 'Медитация', desc: 'Медитации, практики, релаксация',
        prompt: 'Ты — помощник для обработки медитативных практик. Перед тобой транскрипция медитации или практики.\n\nСоставь описание:\n1. Тип практики и её цель.\n2. Основные этапы (с таймингом если есть).\n3. Ключевые инструкции и образы, которые использует ведущий.\n4. Общая атмосфера и особенности подачи.\n\nТон — спокойный, нейтральный. Язык вывода — язык записи.',
      },
      {
        name: 'Консультация', desc: 'Бизнес-консультации, коучинг, интервью',
        prompt: 'Ты — ассистент по обработке деловых консультаций. Перед тобой транскрипция консультации или интервью.\n\nСоставь структурированный отчёт:\n1. Участники и контекст встречи.\n2. Обсуждаемые проблемы/задачи.\n3. Предложенные решения и рекомендации.\n4. Договорённости и следующие шаги (если есть).\n5. Ключевые цитаты (если значимы).\n\nЯзык вывода — язык записи. Деловой стиль.',
      },
    ];

    for (const p of systemProfiles) {
      await pool.query(
        `INSERT INTO transcribe_prompts (id, user_id, name, description, prompt_text, is_default, is_system)
         VALUES ($1, NULL, $2, $3, $4, 0, 1)`,
        [uuidv4(), p.name, p.desc, p.prompt]
      );
    }
    console.log('[db] Default prompt profiles created');
  }

  console.log('[db] PostgreSQL initialized (transcribe schema)');
}

module.exports = { pool, pgify, dbGet, dbAll, dbRun, initDb };
