// Студия Транскрибации — server.js
// Version: 1.8.2
// Updated: 2026-04-10
// Changes: restored MD/DOCX routes, fixed os-start syntax, diarize routing v10
'use strict';

// ================================================================
// Студия Транскрибации — server.js
// version : 1.8.1
// updated : 2026-04-09
// changelog:
//   1.8.1 — восстановлен фикс кодировки latin1→utf8 для имён файлов,
//            восстановлены MD и DOCX эндпоинты скачивания
//   1.8.0 — статистика: duration_sec, /api/admin/stats/extended,
//            график заданий, топ пользователей
//   1.7.0 — монитор-дашборд: /api/admin/monitor, статусы сервисов,
//            GPU shelve/unshelve из UI
//   1.6.0 — стабильность: /api/health, checkStuckJobs (stuck→error >2ч),
//            email-алерт при зависших заданиях
//   1.5.0 — версионирование, GET /api/version
//   1.4.0 — GPU управление через OpenStack API (shelve/unshelve)
//   1.3.0 — MD/DOCX экспорт, фикс кодировки русских имён файлов
//   1.2.0 — diarize флаг, result_clean, /api/admin/job-by-filename
//   1.1.0 — промпт-профили, рейтинг, /api/internal/job-result
//   1.0.0 — первый релиз: auth, jobs, n8n webhook
// ================================================================

const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || '/data/db/transcribe.db';
const UPLOAD_PATH = process.env.UPLOAD_PATH || '/data/uploads';
const RESULTS_PATH = process.env.RESULTS_PATH || '/data/results';
const GPU_SERVER_URL = process.env.GPU_SERVER_URL || '';
const GPU_API_KEY = process.env.GPU_SERVER_API_KEY || '';
const JWT_SECRET = process.env.JWT_SECRET || 'change_me';
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';

// OpenStack credentials for GPU management
const OS_AUTH_URL = process.env.OPENSTACK_AUTH_URL || 'https://api.immers.cloud:5000/v3';
const OS_GPU_ID   = process.env.GPU_SERVER_ID || '8baf5a78-ef09-49c9-8aec-ccccf0a46742';
const OS_USERNAME = process.env.OPENSTACK_USERNAME || '';
const OS_PASSWORD = process.env.OPENSTACK_PASSWORD || '';
const OS_PROJECT  = process.env.OPENSTACK_PROJECT  || '';
const N8N_URL = process.env.N8N_URL || 'http://212.67.8.251:5678';

// Ensure directories exist
[UPLOAD_PATH, RESULTS_PATH, path.dirname(DB_PATH)].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ===== DATABASE SETUP =====

const db = new Database(DB_PATH);

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

// Миграция колонок (безопасно — игнорируем ошибку если уже есть)
['prompt_id TEXT', 'prompt_text TEXT', 'rating INTEGER', 'diarize INTEGER DEFAULT 0', 'result_clean TEXT', 'duration_sec REAL'].forEach(col => {
  try { db.exec(`ALTER TABLE jobs ADD COLUMN ${col}`); } catch (_) {}
});

// Создаём системные промпты если таблица пустая
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


// ===== EVENT LOG =====
function logEvent(eventType, jobId = null, userId = null, details = null, source = 'web') {
  try {
    db.prepare(
      'INSERT INTO events (event_type, job_id, user_id, details, source) VALUES (?, ?, ?, ?, ?)'
    ).run(eventType, jobId, userId, typeof details === 'object' ? JSON.stringify(details) : details, source);
  } catch (e) {
    console.error('[logEvent]', e.message);
  }
}

// ===== EMAIL =====

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.beget.com',
  port: parseInt(process.env.SMTP_PORT || '465'),
  secure: true,
  auth: {
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || ''
  }
});

async function sendEmail(to, subject, html) {
  try {
    await transporter.sendMail({
      from: `"Студия Транскрибации" <${process.env.SMTP_FROM}>`,
      to, subject, html
    });
  } catch (e) {
    console.error('Email error:', e.message);
  }
}

// ===== MULTER =====

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_PATH),
  filename: (req, file, cb) => {
    // Исправляем кодировку: браузер передаёт UTF-8, multer читает как latin1
    const decodedName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const ext = path.extname(decodedName).toLowerCase().replace(/[^a-z0-9.]/g, '');
    cb(null, uuidv4() + (ext || '.bin'));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB
  fileFilter: (req, file, cb) => {
    const allowed = /\.(mp4|mp3|wav|m4a|avi|mov|mkv|webm|ogg|flac)$/i;
    const decodedName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    if (allowed.test(decodedName)) cb(null, true);
    else cb(new Error('Неподдерживаемый формат файла'));
  }
});

// ===== MIDDLEWARE =====

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.set('trust proxy', 1);
app.use(express.static(path.join(__dirname, 'public')));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use('/api/', limiter);

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Нет авторизации' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Неверный токен' });
  }
}

function adminMiddleware(req, res, next) {
  authMiddleware(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Нет доступа' });
    next();
  });
}

// ===== AUTH ROUTES =====

app.post('/api/auth/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'Заполните все поля' });
  if (password.length < 8) return res.status(400).json({ error: 'Пароль минимум 8 символов' });

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.status(400).json({ error: 'Email уже зарегистрирован' });

  const id = uuidv4();
  const hashedPassword = await bcrypt.hash(password, 10);
  const activationToken = uuidv4();

  db.prepare('INSERT INTO users (id, email, password, name, activation_token) VALUES (?, ?, ?, ?, ?)')
    .run(id, email.toLowerCase(), hashedPassword, name, activationToken);

  const activationUrl = `${APP_URL}/activate?token=${activationToken}`;

  await sendEmail(email, 'Активация аккаунта — Студия Транскрибации', `
    <h2>Добро пожаловать, ${name}!</h2>
    <p>Для активации аккаунта перейдите по ссылке:</p>
    <a href="${activationUrl}" style="background:#4F46E5;color:white;padding:12px 24px;text-decoration:none;border-radius:6px;display:inline-block">Активировать аккаунт</a>
    <p>Ссылка действительна 24 часа.</p>
    <p>После активации администратор подтвердит ваш доступ.</p>
  `);

  await sendEmail(ADMIN_EMAIL, 'Новая регистрация — Студия Транскрибации', `
    <h2>Новый пользователь</h2>
    <p>Email: ${email}</p>
    <p>Имя: ${name}</p>
    <p><a href="${APP_URL}/admin">Открыть админку</a></p>
  `);

  res.json({ message: 'Проверьте почту для активации аккаунта' });
});

app.get('/api/auth/activate', (req, res) => {
  const { token } = req.query;
  const user = db.prepare('SELECT * FROM users WHERE activation_token = ?').get(token);
  if (!user) return res.status(400).json({ error: 'Неверная ссылка активации' });

  db.prepare('UPDATE users SET activation_token = NULL WHERE id = ?').run(user.id);
  res.json({ message: 'Email подтверждён. Ожидайте активации администратором.' });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email?.toLowerCase());

  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ error: 'Неверный email или пароль' });
  }
  if (user.activation_token) return res.status(403).json({ error: 'Подтвердите email' });
  if (!user.active) return res.status(403).json({ error: 'Аккаунт ожидает активации администратором' });

  db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(user.id);

  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

// ===== PROMPTS ROUTES =====

// Получить список профилей: свои + все системные
app.get('/api/prompts', authMiddleware, (req, res) => {
  const prompts = db.prepare(`
    SELECT id, user_id, name, description, prompt_text, is_default, is_system, created_at
    FROM prompts
    WHERE is_system = 1 OR user_id = ?
    ORDER BY is_system DESC, is_default DESC, name ASC
  `).all(req.user.id);
  res.json(prompts);
});

// Создать личный профиль
app.post('/api/prompts', authMiddleware, (req, res) => {
  const { name, description, prompt_text } = req.body;
  if (!name || !prompt_text) return res.status(400).json({ error: 'Укажите название и текст промпта' });

  const id = uuidv4();
  db.prepare(`
    INSERT INTO prompts (id, user_id, name, description, prompt_text, is_default, is_system)
    VALUES (?, ?, ?, ?, ?, 0, 0)
  `).run(id, req.user.id, name.trim(), description?.trim() || '', prompt_text.trim());

  res.json(db.prepare('SELECT * FROM prompts WHERE id = ?').get(id));
});

// Редактировать свой профиль
app.put('/api/prompts/:id', authMiddleware, (req, res) => {
  const prompt = db.prepare('SELECT * FROM prompts WHERE id = ?').get(req.params.id);
  if (!prompt) return res.status(404).json({ error: 'Профиль не найден' });
  if (prompt.user_id !== req.user.id) return res.status(403).json({ error: 'Нет доступа' });

  const { name, description, prompt_text } = req.body;
  db.prepare(`UPDATE prompts SET name = ?, description = ?, prompt_text = ? WHERE id = ?`)
    .run(
      name?.trim() || prompt.name,
      description?.trim() ?? prompt.description,
      prompt_text?.trim() || prompt.prompt_text,
      req.params.id
    );

  res.json(db.prepare('SELECT * FROM prompts WHERE id = ?').get(req.params.id));
});

// Удалить свой профиль
app.delete('/api/prompts/:id', authMiddleware, (req, res) => {
  const prompt = db.prepare('SELECT * FROM prompts WHERE id = ?').get(req.params.id);
  if (!prompt) return res.status(404).json({ error: 'Профиль не найден' });
  if (prompt.user_id !== req.user.id) return res.status(403).json({ error: 'Нет доступа' });

  db.prepare('DELETE FROM prompts WHERE id = ?').run(req.params.id);
  res.json({ message: 'Профиль удалён' });
});

// ===== JOBS ROUTES =====

app.post('/api/jobs/upload', authMiddleware, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });

  // Исправляем кодировку имени файла (браузер шлёт UTF-8, multer читает как latin1)
  const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');

  const keepDays = parseInt(req.body.keep_days || '7');
  const jobId = uuidv4();
  const expiresAt = new Date(Date.now() + keepDays * 24 * 60 * 60 * 1000).toISOString();

  // Флаг диаризации (разделение по голосам)
  const diarize = req.body.diarize === '1' ? 1 : 0;

  // Определяем промпт: указанный пользователем или дефолтный системный
  let promptId = req.body.prompt_id || null;
  let promptText = null;

  if (promptId) {
    const prompt = db.prepare(`
      SELECT * FROM prompts WHERE id = ? AND (is_system = 1 OR user_id = ?)
    `).get(promptId, req.user.id);
    if (prompt) {
      promptText = prompt.prompt_text;
    } else {
      promptId = null;
    }
  }

  if (!promptText) {
    const defaultPrompt = db.prepare(`
      SELECT * FROM prompts WHERE is_default = 1 AND is_system = 1 LIMIT 1
    `).get();
    if (defaultPrompt) {
      promptId = defaultPrompt.id;
      promptText = defaultPrompt.prompt_text;
    }
  }

  db.prepare(`
    INSERT INTO jobs (id, user_id, filename, original_name, keep_days, expires_at, status, prompt_id, prompt_text, diarize)
    VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
  `).run(jobId, req.user.id, req.file.filename, originalName, keepDays, expiresAt, promptId, promptText, diarize);

  processJob(jobId, req.file.filename, req.file.path).catch(console.error);

  logEvent('job.uploaded', jobId, req.user.id, {
    original_name: req.file.originalname,
    size_mb: Math.round(req.file.size / 1024 / 1024 * 10) / 10,
    diarize,
    prompt_id: promptId
  });
  res.json({ jobId, message: 'Файл загружен и поставлен в очередь' });
});

async function processJob(jobId, filename, filePath) {
  db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run('processing', jobId);
  try {
    console.log(`Job ${jobId}: file ${filename} ready for processing`);
  } catch (e) {
    db.prepare('UPDATE jobs SET status = ?, error = ? WHERE id = ?').run('error', e.message, jobId);
  }
}

app.get('/api/jobs', authMiddleware, (req, res) => {
  const jobs = db.prepare(`
    SELECT id, original_name, status, progress, keep_days, created_at, completed_at, expires_at,
    rating, prompt_id, diarize,
    CASE WHEN result_txt IS NOT NULL THEN 1 ELSE 0 END as has_result
    FROM jobs WHERE user_id = ? ORDER BY created_at DESC
  `).all(req.user.id);
  res.json(jobs);
});

app.get('/api/jobs/:id', authMiddleware, (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!job) return res.status(404).json({ error: 'Задание не найдено' });
  res.json(job);
});

// Поставить оценку результату (1–5 звёзд)
app.put('/api/jobs/:id/rating', authMiddleware, (req, res) => {
  const rating = parseInt(req.body.rating);
  if (!rating || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Оценка должна быть от 1 до 5' });
  }
  const job = db.prepare('SELECT * FROM jobs WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!job) return res.status(404).json({ error: 'Задание не найдено' });
  if (job.status !== 'completed') return res.status(400).json({ error: 'Можно оценить только завершённое задание' });

  db.prepare('UPDATE jobs SET rating = ? WHERE id = ?').run(rating, req.params.id);
  res.json({ ok: true, rating });
});

// ===== DOWNLOAD: MD =====

app.get('/api/jobs/:id/download/md', authMiddleware, (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!job) return res.status(404).json({ error: 'Задание не найдено' });
  if (!job.result_txt && !job.result_clean) return res.status(404).json({ error: 'Результат не готов' });

  const summary = job.result_txt ? job.result_txt.split('\n---\n')[0].trim() : '';
  const transcript = job.result_clean ? job.result_clean.trim() : '';

  let content = '';
  if (summary) content += summary;
  if (summary && transcript) content += '\n\n═══════════════════════════════════════\n\n';
  if (transcript) content += transcript;

  const baseName = path.basename(job.original_name, path.extname(job.original_name));
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${baseName}.md"`);
  res.send(content);
});

// ===== DOWNLOAD: DOCX =====

app.get('/api/jobs/:id/download/docx', authMiddleware, async (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!job) return res.status(404).json({ error: 'Задание не найдено' });

  if (!job.result_txt && !job.result_clean) {
    return res.status(404).json({ error: 'Результат не готов' });
  }

  // Саммари + чистая транскрипция
  const summary = job.result_txt ? job.result_txt.split('\n---\n')[0].trim() : '';
  const transcript = job.result_clean ? job.result_clean.trim() : '';

  let content = '';
  if (summary) content += summary;
  if (summary && transcript) content += '\n\n═══════════════════════════════════════\n\n';
  if (transcript) content += transcript;

  try {
    const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
    const lines = content.split('\n');
    const children = [];

    children.push(new Paragraph({ text: job.original_name, heading: HeadingLevel.HEADING_1 }));
    children.push(new Paragraph({
      children: [new TextRun({ text: 'Дата: ' + new Date(job.created_at).toLocaleDateString('ru-RU'), color: '888888', size: 20 })],
      spacing: { after: 300 },
    }));

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        children.push(new Paragraph({ text: '' }));
      } else if (/^Голос \d+$/i.test(trimmed) || /^SPEAKER_\d+$/i.test(trimmed)) {
        children.push(new Paragraph({ children: [new TextRun({ text: trimmed, bold: true, size: 26 })], spacing: { before: 200, after: 60 } }));
      } else if (trimmed.startsWith('### ')) {
        children.push(new Paragraph({ text: trimmed.slice(4), heading: HeadingLevel.HEADING_3 }));
      } else if (trimmed.startsWith('## ')) {
        children.push(new Paragraph({ text: trimmed.slice(3), heading: HeadingLevel.HEADING_2 }));
      } else if (trimmed.startsWith('# ')) {
        children.push(new Paragraph({ text: trimmed.slice(2), heading: HeadingLevel.HEADING_1 }));
      } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
        children.push(new Paragraph({ text: trimmed.slice(2), bullet: { level: 0 } }));
      } else {
        children.push(new Paragraph({ text: trimmed, spacing: { after: 120 } }));
      }
    }

    const doc = new Document({ creator: 'Студия Транскрибации', title: job.original_name, sections: [{ children }] });
    const buffer = await Packer.toBuffer(doc);
    const baseName = path.basename(job.original_name, path.extname(job.original_name));

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${baseName}.docx"`);
    res.send(buffer);
  } catch (e) {
    console.error('[DOCX]', e.message);
    res.status(500).json({ error: 'Ошибка генерации DOCX: ' + e.message });
  }
});

// ===== DOWNLOAD: DOCX без голосов =====

app.get('/api/jobs/:id/download/docx-clean', authMiddleware, async (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!job) return res.status(404).json({ error: 'Задание не найдено' });
  if (!job.result_txt && !job.result_clean) return res.status(404).json({ error: 'Результат не готов' });

  const summary = job.result_txt ? job.result_txt.split('\n---\n')[0].trim() : '';
  let transcript = job.result_clean ? job.result_clean.trim() : '';

  // Убираем метки говорящих: "Голос 1: текст" → "текст"
  transcript = transcript.replace(/^Голос \d+:\s*/gm, '').replace(/^SPEAKER_\d+:\s*/gm, '');

  let content = '';
  if (summary) content += summary;
  if (summary && transcript) content += '\n\n═══════════════════════════════════════\n\n';
  if (transcript) content += transcript;

  try {
    const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
    const lines = content.split('\n');
    const children = [];

    children.push(new Paragraph({ text: job.original_name, heading: HeadingLevel.HEADING_1 }));
    children.push(new Paragraph({
      children: [new TextRun({ text: 'Дата: ' + new Date(job.created_at).toLocaleDateString('ru-RU'), color: '888888', size: 20 })],
      spacing: { after: 300 },
    }));

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        children.push(new Paragraph({ text: '' }));
      } else if (trimmed.startsWith('### ')) {
        children.push(new Paragraph({ text: trimmed.slice(4), heading: HeadingLevel.HEADING_3 }));
      } else if (trimmed.startsWith('## ')) {
        children.push(new Paragraph({ text: trimmed.slice(3), heading: HeadingLevel.HEADING_2 }));
      } else if (trimmed.startsWith('# ')) {
        children.push(new Paragraph({ text: trimmed.slice(2), heading: HeadingLevel.HEADING_1 }));
      } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
        children.push(new Paragraph({ text: trimmed.slice(2), bullet: { level: 0 } }));
      } else {
        children.push(new Paragraph({ text: trimmed, spacing: { after: 120 } }));
      }
    }

    const doc = new Document({ creator: 'Студия Транскрибации', title: job.original_name, sections: [{ children }] });
    const buffer = await Packer.toBuffer(doc);
    const baseName = path.basename(job.original_name, path.extname(job.original_name));

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${baseName}_clean.docx"`);
    res.send(buffer);
  } catch (e) {
    console.error('[DOCX-CLEAN]', e.message);
    res.status(500).json({ error: 'Ошибка генерации DOCX: ' + e.message });
  }
});

app.get('/api/jobs/:id/download/:format', authMiddleware, (req, res) => {
  const { id, format } = req.params;
  if (!['txt', 'srt', 'json', 'md', 'docx'].includes(format)) return res.status(400).json({ error: 'Неверный формат' });

  const job = db.prepare('SELECT * FROM jobs WHERE id = ? AND user_id = ?').get(id, req.user.id);
  if (!job) return res.status(404).json({ error: 'Задание не найдено' });

  const baseName = path.basename(job.original_name, path.extname(job.original_name));
  const safeAscii = baseName.replace(/[^\x20-\x7E]/g, '_');
  const encodedBase = encodeURIComponent(baseName);

  // MD — саммари + чистый текст без таймкодов
  if (format === 'md') {
    const summary = job.result_txt || '';
    const cleanText = (job.result_srt || '').replace(/^\d+\n[\d:,]+ --> [\d:,]+\n/gm, '').replace(/\n{3,}/g, '\n\n').trim();
    const mdContent = `# ${baseName}\n\n## Саммари\n\n${summary}\n\n---\n\n## Транскрипция\n\n${cleanText}`;
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeAscii}.md"; filename*=UTF-8''${encodedBase}.md`);
    return res.send(mdContent);
  }

  // DOCX — простой XML-based docx
  if (format === 'docx') {
    const summary = job.result_txt || '';
    const cleanText = (job.result_srt || '').replace(/^\d+\n[\d:,]+ --> [\d:,]+\n/gm, '').replace(/\n{3,}/g, '\n\n').trim();

    const escXml = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const toParas = text => text.split('\n').filter(l=>l.trim()).map(l=>`<w:p><w:r><w:t xml:space="preserve">${escXml(l)}</w:t></w:r></w:p>`).join('');

    const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${escXml(baseName)}</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Саммари</w:t></w:r></w:p>
${toParas(summary)}
<w:p><w:r><w:t>---</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Транскрипция</w:t></w:r></w:p>
${toParas(cleanText)}
</w:body></w:document>`;

    const AdmZip = (() => { try { return require('adm-zip'); } catch { return null; } })();
    if (!AdmZip) {
      // fallback: отдаём как plain text если adm-zip не установлен
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${safeAscii}.txt"; filename*=UTF-8''${encodedBase}.txt`);
      return res.send(`${baseName}\n\nСАММАРИ\n\n${summary}\n\n---\n\nТРАНСКРИПЦИЯ\n\n${cleanText}`);
    }

    const zip = new AdmZip();
    zip.addFile('word/document.xml', Buffer.from(docXml, 'utf8'));
    zip.addFile('[Content_Types].xml', Buffer.from(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`, 'utf8'));
    zip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`, 'utf8'));

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${safeAscii}.docx"; filename*=UTF-8''${encodedBase}.docx`);
    return res.send(zip.toBuffer());
  }

  // TXT / SRT / JSON
  const content = job[`result_${format}`];
  if (!content) return res.status(404).json({ error: 'Результат не готов' });
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safeAscii}.${format}"; filename*=UTF-8''${encodedBase}.${format}`);
  logEvent('job.downloaded', id, req.user.id, { format }, 'web');
  res.send(content);
});

app.delete('/api/jobs/:id', authMiddleware, (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!job) return res.status(404).json({ error: 'Задание не найдено' });

  const filePath = path.join(UPLOAD_PATH, job.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  logEvent('job.deleted', req.params.id, req.user.id, { original_name: job.original_name });
  db.prepare('DELETE FROM jobs WHERE id = ?').run(req.params.id);
  res.json({ message: 'Задание удалено' });
});

// ===== WEBHOOK FROM GPU SERVER =====

app.post('/api/webhook/result', (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== GPU_API_KEY) return res.status(401).json({ error: 'Unauthorized' });

  const { jobId, status, result_txt, result_srt, result_json, error } = req.body;
  if (!jobId) return res.status(400).json({ error: 'No jobId' });

  if (status === 'completed') {
    db.prepare(`
      UPDATE jobs SET status='completed', result_txt=?, result_srt=?, result_json=?,
      completed_at=datetime('now') WHERE id=?
    `).run(result_txt || '', result_srt || '', result_json || '', jobId);

    const job = db.prepare('SELECT j.*, u.email, u.name FROM jobs j JOIN users u ON j.user_id=u.id WHERE j.id=?').get(jobId);
    if (job) {
      sendEmail(job.email, 'Транскрипция готова!', `
        <h2>Привет, ${job.name}!</h2>
        <p>Транскрипция файла <b>${job.original_name}</b> готова.</p>
        <a href="${APP_URL}/dashboard" style="background:#4F46E5;color:white;padding:12px 24px;text-decoration:none;border-radius:6px;display:inline-block">Скачать результат</a>
        <p>Файл будет доступен ${job.keep_days} дней.</p>
      `);
    }
  } else if (status === 'error') {
    db.prepare('UPDATE jobs SET status=?, error=? WHERE id=?').run('error', error || 'Unknown error', jobId);
  }

  res.json({ ok: true });
});

// ===== INTERNAL API (n8n → web server) =====

// Получить prompt_text для задания по jobId
app.get('/api/internal/job-prompt/:jobId', (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== GPU_API_KEY) return res.status(401).json({ error: 'Unauthorized' });

  const job = db.prepare('SELECT id, prompt_text, original_name FROM jobs WHERE id = ?').get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.json({ jobId: job.id, prompt_text: job.prompt_text, original_name: job.original_name });
});

// Получить diarize флаг и prompt по filename (n8n вызывает перед обработкой)
app.get('/api/admin/job-by-filename', adminMiddleware, (req, res) => {
  const { filename } = req.query;
  if (!filename) return res.status(400).json({ error: 'filename required' });

  const job = db.prepare('SELECT id, filename, diarize, status, prompt_text FROM jobs WHERE filename = ?').get(filename);
  if (!job) return res.status(404).json({ error: 'Job not found', filename });

  res.json(job);
});

// Принять результат транскрипции от n8n (по filename)
app.post('/api/internal/job-result', (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    jwt.verify(authHeader.slice(7), JWT_SECRET);
  } catch(e) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const { filename, result_txt, result_srt, result_json, result_clean } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename required' });

  const job = db.prepare('SELECT * FROM jobs WHERE filename = ?').get(filename);
  if (!job) return res.status(404).json({ error: 'Job not found', filename });

  // Извлекаем длительность из JSON-результата Whisper (последний сегмент → end)
  let durationSec = null;
  if (result_json) {
    try {
      const parsed = JSON.parse(result_json);
      const segs = parsed.segments || parsed.words || [];
      if (segs.length > 0) durationSec = segs[segs.length - 1].end || null;
    } catch (_) {}
  }

  db.prepare(`
    UPDATE jobs SET status='completed', result_txt=?, result_srt=?, result_json=?,
    result_clean=?, duration_sec=?, completed_at=datetime('now') WHERE filename=?
  `).run(result_txt || '', result_srt || '', result_json || '', result_clean || '', durationSec, filename);

  const fullJob = db.prepare(
    'SELECT j.*, u.email, u.name FROM jobs j JOIN users u ON j.user_id=u.id WHERE j.filename=?'
  ).get(filename);
  if (fullJob) {
    sendEmail(fullJob.email, 'Транскрипция готова!', `
      <h2>Привет, ${fullJob.name}!</h2>
      <p>Транскрипция файла <b>${fullJob.original_name}</b> готова.</p>
      <a href="${APP_URL}/dashboard" style="background:#4F46E5;color:white;padding:12px 24px;
        text-decoration:none;border-radius:6px;display:inline-block">Открыть результат</a>
      <p>Файл будет доступен ${fullJob.keep_days} дней.</p>
    `);
  }

  logEvent('job.completed', job.id, job.user_id, {
    original_name: job.original_name,
    has_srt: !!result_srt,
    has_clean: !!result_clean
  }, 'n8n');
  res.json({ ok: true });
});

// ===== ADMIN ROUTES =====

app.get('/api/admin/users', adminMiddleware, (req, res) => {
  const users = db.prepare(`
    SELECT u.*, COUNT(j.id) as jobs_count
    FROM users u LEFT JOIN jobs j ON u.id = j.user_id
    GROUP BY u.id ORDER BY u.created_at DESC
  `).all();
  res.json(users);
});

app.put('/api/admin/users/:id/activate', adminMiddleware, async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  db.prepare('UPDATE users SET active = 1, activation_token = NULL WHERE id = ?').run(req.params.id);

  await sendEmail(user.email, 'Ваш аккаунт активирован!', `
    <h2>Добро пожаловать, ${user.name}!</h2>
    <p>Ваш аккаунт активирован. Теперь вы можете загружать файлы для транскрибации.</p>
    <a href="${APP_URL}" style="background:#4F46E5;color:white;padding:12px 24px;text-decoration:none;border-radius:6px;display:inline-block">Войти</a>
  `);

  res.json({ message: 'Пользователь активирован' });
});

app.put('/api/admin/users/:id/deactivate', adminMiddleware, (req, res) => {
  db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ message: 'Пользователь деактивирован' });
});

app.delete('/api/admin/users/:id', adminMiddleware, (req, res) => {
  db.prepare('DELETE FROM jobs WHERE user_id = ?').run(req.params.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ message: 'Пользователь удалён' });
});

app.get('/api/admin/jobs', adminMiddleware, (req, res) => {
  const jobs = db.prepare(`
    SELECT j.*, u.email, u.name as user_name
    FROM jobs j JOIN users u ON j.user_id = u.id
    ORDER BY j.created_at DESC LIMIT 100
  `).all();
  res.json(jobs);
});

app.delete('/api/admin/jobs/:id', adminMiddleware, (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Задание не найдено' });

  const filePath = path.join(UPLOAD_PATH, job.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  db.prepare('DELETE FROM jobs WHERE id = ?').run(req.params.id);
  res.json({ message: 'Задание удалено' });
});

app.get('/api/admin/stats', adminMiddleware, (req, res) => {
  const stats = {
    users_total: db.prepare('SELECT COUNT(*) as c FROM users').get().c,
    users_active: db.prepare('SELECT COUNT(*) as c FROM users WHERE active=1').get().c,
    users_pending: db.prepare('SELECT COUNT(*) as c FROM users WHERE active=0 AND activation_token IS NULL').get().c,
    jobs_total: db.prepare('SELECT COUNT(*) as c FROM jobs').get().c,
    jobs_processing: db.prepare("SELECT COUNT(*) as c FROM jobs WHERE status='processing'").get().c,
    jobs_completed: db.prepare("SELECT COUNT(*) as c FROM jobs WHERE status='completed'").get().c,
    jobs_error: db.prepare("SELECT COUNT(*) as c FROM jobs WHERE status='error'").get().c,
  };
  res.json(stats);
});

// ===== ADMIN: PROMPTS MANAGEMENT =====

app.get('/api/admin/prompts', adminMiddleware, (req, res) => {
  const prompts = db.prepare(`
    SELECT p.*, u.email as user_email, u.name as user_name
    FROM prompts p
    LEFT JOIN users u ON p.user_id = u.id
    ORDER BY p.is_system DESC, p.is_default DESC, p.created_at DESC
  `).all();
  res.json(prompts);
});

app.post('/api/admin/prompts', adminMiddleware, (req, res) => {
  const { name, description, prompt_text, is_system } = req.body;
  if (!name || !prompt_text) return res.status(400).json({ error: 'Укажите название и текст промпта' });

  const id = uuidv4();
  db.prepare(`
    INSERT INTO prompts (id, user_id, name, description, prompt_text, is_default, is_system)
    VALUES (?, NULL, ?, ?, ?, 0, ?)
  `).run(id, name.trim(), description?.trim() || '', prompt_text.trim(), is_system ? 1 : 0);

  res.json(db.prepare('SELECT * FROM prompts WHERE id = ?').get(id));
});

app.put('/api/admin/prompts/:id', adminMiddleware, (req, res) => {
  const prompt = db.prepare('SELECT * FROM prompts WHERE id = ?').get(req.params.id);
  if (!prompt) return res.status(404).json({ error: 'Профиль не найден' });

  const { name, description, prompt_text, is_system } = req.body;
  db.prepare(`UPDATE prompts SET name = ?, description = ?, prompt_text = ?, is_system = ? WHERE id = ?`)
    .run(
      name?.trim() || prompt.name,
      description?.trim() ?? prompt.description,
      prompt_text?.trim() || prompt.prompt_text,
      is_system !== undefined ? (is_system ? 1 : 0) : prompt.is_system,
      req.params.id
    );

  res.json(db.prepare('SELECT * FROM prompts WHERE id = ?').get(req.params.id));
});

app.put('/api/admin/prompts/:id/set-default', adminMiddleware, (req, res) => {
  const prompt = db.prepare('SELECT * FROM prompts WHERE id = ?').get(req.params.id);
  if (!prompt) return res.status(404).json({ error: 'Профиль не найден' });
  if (!prompt.is_system) return res.status(400).json({ error: 'Дефолтным может быть только системный профиль' });

  db.prepare('UPDATE prompts SET is_default = 0 WHERE is_system = 1').run();
  db.prepare('UPDATE prompts SET is_default = 1 WHERE id = ?').run(req.params.id);

  res.json({ ok: true, default_id: req.params.id });
});

app.delete('/api/admin/prompts/:id', adminMiddleware, (req, res) => {
  const prompt = db.prepare('SELECT * FROM prompts WHERE id = ?').get(req.params.id);
  if (!prompt) return res.status(404).json({ error: 'Профиль не найден' });
  if (prompt.is_default) return res.status(400).json({ error: 'Нельзя удалить дефолтный профиль. Сначала назначьте другой.' });

  db.prepare('DELETE FROM prompts WHERE id = ?').run(req.params.id);
  res.json({ message: 'Профиль удалён' });
});

// ===== HEALTH =====

app.get('/api/health', (req, res) => {
  try {
    const dbOk = !!db.prepare('SELECT 1').get();
    const pending     = db.prepare("SELECT COUNT(*) as c FROM jobs WHERE status='pending'").get().c;
    const processing  = db.prepare("SELECT COUNT(*) as c FROM jobs WHERE status='processing'").get().c;
    const queued      = db.prepare("SELECT COUNT(*) as c FROM jobs WHERE status='queued'").get().c;
    res.json({
      ok: true,
      version: '1.8.1',
      uptime_s: Math.floor(process.uptime()),
      db: dbOk,
      queue: { queued, pending, processing }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ===== GPU PANEL =====

let osTokenCache = null;

async function getOpenStackToken() {
  if (osTokenCache && osTokenCache.expires > Date.now()) {
    return osTokenCache;
  }

  const authRes = await fetch(`${OS_AUTH_URL}/auth/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      auth: {
        identity: {
          methods: ['password'],
          password: {
            user: {
              name: OS_USERNAME,
              domain: { name: 'Default' },
              password: OS_PASSWORD
            }
          }
        },
        scope: {
          project: {
            name: OS_PROJECT,
            domain: { name: 'Default' }
          }
        }
      }
    })
  });

  if (!authRes.ok) {
    const txt = await authRes.text();
    throw new Error(`OpenStack auth failed (${authRes.status}): ${txt}`);
  }

  const token = authRes.headers.get('x-subject-token');
  const data = await authRes.json();

  const catalog = data.token?.catalog || [];
  const computeService = catalog.find(s => s.type === 'compute');
  const computeEndpoint = computeService?.endpoints?.find(e => e.interface === 'public')?.url;

  if (!computeEndpoint) throw new Error('Compute endpoint not found in OpenStack catalog');

  osTokenCache = {
    token,
    endpoint: computeEndpoint,
    expires: Date.now() + 50 * 60 * 1000
  };

  return osTokenCache;
}

async function gpuGetStatus() {
  const { token, endpoint } = await getOpenStackToken();
  const res = await fetch(`${endpoint}/servers/${OS_GPU_ID}`, {
    headers: { 'X-Auth-Token': token }
  });
  if (!res.ok) throw new Error(`Get server status failed: ${res.status}`);
  const data = await res.json();
  return data.server?.status || 'UNKNOWN';
}

async function gpuDoAction(action) {
  const { token, endpoint } = await getOpenStackToken();
  let body;
  if (action === 'shelve')   body = { shelve: null };
  else if (action === 'unshelve') body = { unshelve: null };
  else if (action === 'start') body = { 'os-start': null };
  const res = await fetch(`${endpoint}/servers/${OS_GPU_ID}/action`, {
    method: 'POST',
    headers: { 'X-Auth-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok && res.status !== 202) {
    throw new Error(`GPU action '${action}' failed: ${res.status}`);
  }
  return true;
}

app.get('/api/gpu/status', adminMiddleware, async (req, res) => {
  try {
    const status = await gpuGetStatus();
    res.json({ ok: true, status });
  } catch (e) {
    console.error('[GPU]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/gpu/action', adminMiddleware, async (req, res) => {
  const { action } = req.body;
  if (!['shelve', 'unshelve', 'start'].includes(action)) {
    return res.status(400).json({ error: 'Неизвестная команда. Допустимо: shelve, unshelve, start' });
  }
  try {
    await gpuDoAction(action);
    logEvent('gpu.' + action, null, req.user.id);
    res.json({ ok: true, action });
  } catch (e) {
    console.error('[GPU]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ===== STATS EXTENDED =====

app.get('/api/admin/stats/extended', adminMiddleware, (req, res) => {
  // Сводные показатели
  const totals = db.prepare(`
    SELECT
      COUNT(*) as jobs_total,
      SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as jobs_completed,
      SUM(CASE WHEN status='error'     THEN 1 ELSE 0 END) as jobs_error,
      SUM(CASE WHEN status='completed' THEN COALESCE(duration_sec,0) ELSE 0 END) as total_sec,
      AVG(CASE WHEN status='completed' AND duration_sec IS NOT NULL THEN duration_sec END) as avg_sec
    FROM jobs
  `).get();

  const month_sec = db.prepare(`
    SELECT SUM(COALESCE(duration_sec,0)) as s FROM jobs
    WHERE status='completed' AND created_at >= datetime('now','-30 days')
  `).get().s || 0;

  const week_jobs = db.prepare(`
    SELECT COUNT(*) as c FROM jobs WHERE created_at >= datetime('now','-7 days')
  `).get().c;

  // Jobs по дням за последние 30 дней
  const byDay = db.prepare(`
    SELECT date(created_at) as day,
      COUNT(*) as total,
      SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status='error'     THEN 1 ELSE 0 END) as errors
    FROM jobs
    WHERE created_at >= datetime('now','-30 days')
    GROUP BY date(created_at)
    ORDER BY day ASC
  `).all();

  // Топ пользователей
  const topUsers = db.prepare(`
    SELECT u.name, u.email,
      COUNT(j.id) as jobs_count,
      SUM(CASE WHEN j.status='completed' THEN COALESCE(j.duration_sec,0) ELSE 0 END) as total_sec
    FROM users u
    LEFT JOIN jobs j ON u.id = j.user_id
    GROUP BY u.id
    ORDER BY jobs_count DESC
    LIMIT 10
  `).all();

  res.json({
    totals: {
      jobs_total:     totals.jobs_total,
      jobs_completed: totals.jobs_completed,
      jobs_error:     totals.jobs_error,
      total_min:      Math.round((totals.total_sec || 0) / 60),
      month_min:      Math.round(month_sec / 60),
      week_jobs,
      avg_min:        totals.avg_sec ? Math.round(totals.avg_sec / 60 * 10) / 10 : null,
      error_rate:     totals.jobs_total > 0 ? Math.round(totals.jobs_error / totals.jobs_total * 100) : 0,
    },
    by_day: byDay,
    top_users: topUsers
  });
});

// ===== MONITOR =====

// Извлекаем хост GPU сервера из GPU_SERVER_URL (напр. http://195.209.214.7:8000 → 195.209.214.7)
const gpuHostMatch = GPU_SERVER_URL.match(/https?:\/\/([^:/]+)/);
const GPU_HOST = gpuHostMatch ? gpuHostMatch[1] : '195.209.214.7';

async function checkService(url, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return { ok: r.ok, code: r.status };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: e.message.includes('abort') ? 'timeout' : e.message };
  }
}

app.get('/api/admin/monitor', adminMiddleware, async (req, res) => {
  const [whisper, diarize, ollama, n8n, gpuStatus] = await Promise.allSettled([
    checkService(`http://${GPU_HOST}:8000/health`),
    checkService(`http://${GPU_HOST}:8002/health`),
    checkService(`http://${GPU_HOST}:11434/api/tags`),
    checkService(`${N8N_URL}/healthz`),
    gpuGetStatus()
  ]);

  const queue = {
    queued:      db.prepare("SELECT COUNT(*) as c FROM jobs WHERE status='queued'").get().c,
    pending:     db.prepare("SELECT COUNT(*) as c FROM jobs WHERE status='pending'").get().c,
    processing:  db.prepare("SELECT COUNT(*) as c FROM jobs WHERE status='processing'").get().c,
    error_today: db.prepare("SELECT COUNT(*) as c FROM jobs WHERE status='error' AND date(completed_at)=date('now')").get().c,
    completed_today: db.prepare("SELECT COUNT(*) as c FROM jobs WHERE status='completed' AND date(completed_at)=date('now')").get().c,
  };

  // Текущий обрабатываемый файл
  const currentJob = db.prepare(`
    SELECT j.id, j.original_name, j.diarize, j.created_at, u.name as user_name
    FROM jobs j JOIN users u ON j.user_id = u.id
    WHERE j.status IN ('processing', 'queued')
    ORDER BY j.created_at ASC LIMIT 1
  `).get() || null;

  // Ожидающие файлы
  const pendingJobs = db.prepare(`
    SELECT j.id, j.original_name, j.diarize, j.created_at, u.name as user_name
    FROM jobs j JOIN users u ON j.user_id = u.id
    WHERE j.status = 'pending'
    ORDER BY j.created_at ASC LIMIT 20
  `).all();

  // Lock-файлы
  const lockFiles = fs.existsSync(RESULTS_PATH)
    ? fs.readdirSync(RESULTS_PATH).filter(f => f.endsWith('.lock'))
    : [];

  res.json({
    services: {
      whisper:  whisper.status  === 'fulfilled' ? whisper.value  : { ok: false, error: whisper.reason?.message },
      diarize:  diarize.status  === 'fulfilled' ? diarize.value  : { ok: false, error: diarize.reason?.message },
      ollama:   ollama.status   === 'fulfilled' ? ollama.value   : { ok: false, error: ollama.reason?.message },
      n8n:      n8n.status      === 'fulfilled' ? n8n.value      : { ok: false, error: n8n.reason?.message },
    },
    gpu: gpuStatus.status === 'fulfilled' ? gpuStatus.value : 'UNKNOWN',
    queue,
    current_job: currentJob,
    pending_jobs: pendingJobs,
    lock_files: lockFiles,
    checked_at: new Date().toISOString()
  });
});


// ===== EVENT LOG API =====
app.get('/api/admin/events', adminMiddleware, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100'), 500);
  const offset = parseInt(req.query.offset || '0');
  const eventType = req.query.type || null;
  const jobId = req.query.job_id || null;

  let where = '1=1';
  const params = [];
  if (eventType) { where += ' AND event_type LIKE ?'; params.push(eventType + '%'); }
  if (jobId) { where += ' AND job_id = ?'; params.push(jobId); }

  const events = db.prepare(`
    SELECT e.*, j.original_name, u.name as user_name, u.email as user_email
    FROM events e
    LEFT JOIN jobs j ON e.job_id = j.id
    LEFT JOIN users u ON e.user_id = u.id
    WHERE ${where}
    ORDER BY e.timestamp DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const total = db.prepare(`SELECT COUNT(*) as c FROM events WHERE ${where}`).all(...params)[0].c;
  res.json({ events, total, limit, offset });
});


// ===== ADMIN CONTROL =====
app.post('/api/admin/control/reset-stuck', adminMiddleware, (req, res) => {
  const stuck = db.prepare(
    "SELECT id, original_name FROM jobs WHERE status IN ('processing', 'pending', 'queued') AND created_at < datetime('now', '-2 hours')"
  ).all();
  if (stuck.length === 0) return res.json({ reset: 0, message: 'Нет зависших заданий' });

  const ids = stuck.map(j => j.id);
  db.prepare(
    "UPDATE jobs SET status='pending', error=NULL, completed_at=NULL WHERE id IN (" + ids.map(() => '?').join(',') + ")"
  ).run(...ids);

  // Удаляем lock-файлы
  const lockDir = RESULTS_PATH;
  if (fs.existsSync(lockDir)) {
    fs.readdirSync(lockDir).filter(f => f.endsWith('.lock')).forEach(f => {
      try { fs.unlinkSync(path.join(lockDir, f)); } catch(e) {}
    });
  }

  logEvent('admin.reset_stuck', null, req.user.id, { count: stuck.length, jobs: stuck.map(j => j.original_name) });
  res.json({ reset: stuck.length, jobs: stuck });
});

app.post('/api/admin/control/clear-locks', adminMiddleware, (req, res) => {
  const lockDir = RESULTS_PATH;
  let removed = 0;
  if (fs.existsSync(lockDir)) {
    fs.readdirSync(lockDir).filter(f => f.endsWith('.lock')).forEach(f => {
      try { fs.unlinkSync(path.join(lockDir, f)); removed++; } catch(e) {}
    });
  }
  logEvent('admin.clear_locks', null, req.user.id, { removed });
  res.json({ removed });
});

app.post('/api/admin/control/reset-errors', adminMiddleware, (req, res) => {
  const errors = db.prepare("SELECT id, original_name FROM jobs WHERE status='error'").all();
  if (errors.length === 0) return res.json({ reset: 0, message: 'Нет заданий с ошибками' });

  db.prepare("UPDATE jobs SET status='pending', error=NULL, completed_at=NULL WHERE status='error'").run();

  logEvent('admin.reset_errors', null, req.user.id, { count: errors.length });
  res.json({ reset: errors.length });
});

// Watchdog на GPU → присылает события
app.post('/api/internal/watchdog-event', (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try { jwt.verify(authHeader.slice(7), JWT_SECRET); } catch(e) { return res.status(401).json({ error: 'Invalid token' }); }

  const { event_type, details, source } = req.body;
  if (!event_type) return res.status(400).json({ error: 'event_type required' });

  logEvent(event_type, null, null, details, source || 'watchdog');

  // Email-алерт для критических событий
  if (event_type.includes('critical') || event_type === 'service.restart') {
    const adminUser = db.prepare("SELECT email FROM users WHERE role='admin' LIMIT 1").get();
    if (adminUser) {
      sendEmail(adminUser.email, '⚠️ GPU Watchdog: ' + event_type, '<pre>' + JSON.stringify(req.body, null, 2) + '</pre>');
    }
  }

  res.json({ ok: true });
});


app.post('/api/admin/control/archive-journal', adminMiddleware, (req, res) => {
  const events = db.prepare('SELECT * FROM events ORDER BY timestamp ASC').all();
  if (events.length === 0) return res.json({ archived: 0, message: 'Журнал пуст' });

  // Сохраняем в файл
  const archiveDir = path.join(RESULTS_PATH, 'archives');
  if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const archivePath = path.join(archiveDir, 'events_' + ts + '.json');
  fs.writeFileSync(archivePath, JSON.stringify(events, null, 2));

  // Очищаем таблицу
  db.prepare('DELETE FROM events').run();
  logEvent('admin.archive_journal', null, req.user.id, { archived: events.length, file: archivePath });

  res.json({ archived: events.length, file: 'events_' + ts + '.json' });
});

// ===== CLEANUP =====

function cleanupExpiredJobs() {
  const expired = db.prepare("SELECT * FROM jobs WHERE expires_at < datetime('now') AND status='completed'").all();
  expired.forEach(job => {
    const filePath = path.join(UPLOAD_PATH, job.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    db.prepare('DELETE FROM jobs WHERE id = ?').run(job.id);
    console.log(`Cleaned up expired job: ${job.id}`);
  });
}
setInterval(cleanupExpiredJobs, 60 * 60 * 1000);

// ===== STUCK JOBS =====

function checkStuckJobs() {
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString().replace('T',' ').replace('Z','');
  const stuck = db.prepare(`
    SELECT * FROM jobs
    WHERE status IN ('processing', 'pending', 'queued')
    AND created_at < ?
  `).all(twoHoursAgo);

  if (stuck.length === 0) return;

  stuck.forEach(job => {
    db.prepare(`
      UPDATE jobs SET status='error', error='Таймаут: задание зависло (>2ч)', completed_at=datetime('now')
      WHERE id=?
    `).run(job.id);
    console.warn(`[STUCK] Job ${job.id} (${job.original_name}) → error (timeout)`);
    logEvent('job.stuck', job.id, job.user_id, { original_name: job.original_name }, 'system');
  });

  // Email-алерт администратору
  const adminUser = db.prepare("SELECT email FROM users WHERE role='admin' LIMIT 1").get();
  if (adminUser) {
    const list = stuck.map(j =>
      `<li><b>${j.original_name}</b> — создан ${j.created_at}, статус был: ${j.status}</li>`
    ).join('');
    sendEmail(
      adminUser.email,
      `⚠️ Студия: ${stuck.length} зависш${stuck.length === 1 ? 'ее задание' : 'их заданий'}`,
      `<p>Следующие задания зависли более 2 часов и переведены в статус <b>error</b>:</p>
       <ul>${list}</ul>
       <p><a href="${APP_URL}/admin">Открыть админку</a></p>`
    );
  }
}
setInterval(checkStuckJobs, 10 * 60 * 1000); // каждые 10 минут
checkStuckJobs(); // сразу при старте — на случай застрявших после перезапуска

// ===== BOOTSTRAP =====

const adminExists = db.prepare("SELECT id FROM users WHERE role='admin'").get();
if (!adminExists) {
  const adminId = uuidv4();
  const adminPassword = bcrypt.hashSync('admin123', 10);
  db.prepare("INSERT INTO users (id, email, password, name, role, active) VALUES (?, ?, ?, ?, 'admin', 1)")
    .run(adminId, ADMIN_EMAIL || 'admin@melki.top', adminPassword, 'Администратор');
  console.log('Default admin created: admin@melki.top / admin123');
  console.log('CHANGE THE PASSWORD IMMEDIATELY!');
}

app.listen(PORT, () => {
  console.log(`Transcribe Studio running on port ${PORT}`);
});
