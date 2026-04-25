'use strict';
// routes/internal.js v2.2 — PostgreSQL edition
// Updated: 2026-04-25
// v2.2: Автоматический sendToQdrant в /job-result отключён.
//       Индексация в KB — только по явному нажатию 🧠 на UI.

const fs = require('fs');
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');

const { dbGet, dbAll, dbRun } = require('../db');
const { escapeHtml, logEvent } = require('../utils/helpers');
const { sendEmail } = require('../utils/email');
const { JWT_SECRET, GPU_API_KEY, APP_URL, RESULTS_PATH, UPLOAD_PATH, INTERNAL_TOKEN } = require('../config');
const { enqueueIndex } = require('../utils/qdrant');

const router = express.Router();

// ===== WEBHOOK FROM GPU SERVER =====
router.post('/webhook/result', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== GPU_API_KEY) return res.status(401).json({ error: 'Unauthorized' });

  const { jobId, status, result_txt, result_srt, result_json, error } = req.body;
  if (!jobId) return res.status(400).json({ error: 'No jobId' });

  if (status === 'completed') {
    await dbRun(
      "UPDATE transcribe_jobs SET status='completed', result_txt=?, result_srt=?, result_json=?, completed_at=NOW() WHERE id=?",
      [result_txt || '', result_srt || '', result_json || '', jobId]
    );
    const job = await dbGet(
      'SELECT j.*, u.email, u.name FROM transcribe_jobs j JOIN transcribe_users u ON j.user_id=u.id WHERE j.id=?',
      [jobId]
    );
    if (job) {
      sendEmail(job.email, 'Транскрипция готова!', `
        <h2>Привет, ${escapeHtml(job.name)}!</h2>
        <p>Транскрипция файла <b>${escapeHtml(job.original_name)}</b> готова.</p>
        <a href="${APP_URL}/dashboard" style="background:#4F46E5;color:white;padding:12px 24px;text-decoration:none;border-radius:6px;display:inline-block">Скачать результат</a>
        <p>Файл будет доступен ${job.keep_days} дней.</p>
      `);
    }
  } else if (status === 'error') {
    await dbRun('UPDATE transcribe_jobs SET status=?, error=? WHERE id=?', ['error', error || 'Unknown error', jobId]);
  }

  res.json({ ok: true });
});

// ===== GET PROMPT FOR JOB =====
router.get('/job-prompt/:jobId', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== GPU_API_KEY) return res.status(401).json({ error: 'Unauthorized' });

  const job = await dbGet(
    'SELECT id, prompt_text, original_name FROM transcribe_jobs WHERE id = ?',
    [req.params.jobId]
  );
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ jobId: job.id, prompt_text: job.prompt_text, original_name: job.original_name });
});

// ===== RECEIVE RESULT FROM N8N =====
router.post('/job-result', async (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    jwt.verify(authHeader.slice(7), JWT_SECRET);
  } catch(e) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const { filename, result_txt, result_srt, result_json, result_clean } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename required' });

  const job = await dbGet('SELECT * FROM transcribe_jobs WHERE filename = ?', [filename]);
  if (!job) return res.status(404).json({ error: 'Job not found', filename });

  let durationSec = null;
  if (result_json) {
    try {
      const parsed = JSON.parse(result_json);
      const segs = parsed.segments || parsed.words || [];
      if (segs.length > 0) durationSec = segs[segs.length - 1].end || null;
    } catch (_) {}
  }

  await dbRun(
    "UPDATE transcribe_jobs SET status='completed', result_txt=?, result_srt=?, result_json=?, result_clean=?, duration_sec=?, completed_at=NOW() WHERE filename=?",
    [result_txt || '', result_srt || '', result_json || '', result_clean || '', durationSec, filename]
  );

  const fullJob = await dbGet(
    'SELECT j.*, u.email, u.name FROM transcribe_jobs j JOIN transcribe_users u ON j.user_id=u.id WHERE j.filename=?',
    [filename]
  );
  if (fullJob) {
    sendEmail(fullJob.email, 'Транскрипция готова!', `
      <h2>Привет, ${escapeHtml(fullJob.name)}!</h2>
      <p>Транскрипция файла <b>${escapeHtml(fullJob.original_name)}</b> готова.</p>
      <a href="${APP_URL}/dashboard" style="background:#4F46E5;color:white;padding:12px 24px;
        text-decoration:none;border-radius:6px;display:inline-block">Открыть результат</a>
      <p>Файл будет доступен ${fullJob.keep_days} дней.</p>
    `);
    // v2.2: автоматическая индексация в KB отключена.
    // Пользователь индексирует явным нажатием 🧠 — там можно выбрать проект.
  }

  logEvent('job.completed', job.id, job.user_id, {
    original_name: job.original_name,
    has_srt: !!result_srt,
    has_clean: !!result_clean
  }, 'n8n');

  res.json({ ok: true });
});

// ===== WATCHDOG EVENT =====
router.post('/watchdog-event', async (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try { jwt.verify(authHeader.slice(7), JWT_SECRET); } catch(e) { return res.status(401).json({ error: 'Invalid token' }); }

  const { event_type, details, source } = req.body;
  if (!event_type) return res.status(400).json({ error: 'event_type required' });

  logEvent(event_type, null, null, details, source || 'watchdog');

  if (event_type.includes('critical') || event_type === 'service.restart') {
    const adminUser = await dbGet("SELECT email FROM transcribe_users WHERE role='admin' LIMIT 1");
    if (adminUser) {
      sendEmail(adminUser.email, '⚠️ GPU Watchdog: ' + event_type, '<pre>' + JSON.stringify(req.body, null, 2) + '</pre>');
    }
  }

  res.json({ ok: true });
});

// ===== CALLBACK FROM GPU WRAPPER =====
router.post('/callback/transcribe/:jobId', async (req, res) => {
  const pipeline = require('../utils/gpu-pipeline');

  const secret = req.headers['x-callback-secret'];
  if (secret !== pipeline.getCallbackSecret()) {
    return res.status(401).json({ error: 'Invalid callback secret' });
  }

  const jobId = req.params.jobId;
  const payload = req.body;

  if (!payload || !payload.type) return res.status(400).json({ error: 'Missing type in callback' });

  res.json({ ok: true });

  try {
    await pipeline.handleCallback(jobId, payload);
  } catch (e) {
    console.error(`[callback] Error handling ${payload.type} for ${jobId}: ${e.message}`);
  }
});

// ===== RECONCILE =====
router.post('/reconcile', async (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try { jwt.verify(authHeader.slice(7), JWT_SECRET); } catch(e) { return res.status(401).json({ error: 'Invalid token' }); }

  const jobs = await dbAll("SELECT id, filename, original_name, status FROM transcribe_jobs WHERE status IN ('pending','processing','queued')");
  let fixed = 0;
  const fixed_names = [];
  for (const j of jobs) {
    const baseName = j.filename.replace(/\.[^/.]+$/, '');
    const resultPath = path.join(RESULTS_PATH, baseName + '_result.txt');
    if (fs.existsSync(resultPath)) {
      const txt = fs.readFileSync(resultPath, 'utf8');
      await dbRun("UPDATE transcribe_jobs SET status='completed', result_txt=?, completed_at=NOW() WHERE id=?", [txt, j.id]);
      fixed++;
      fixed_names.push(j.original_name);
    }
  }
  res.json({ reconciled: fixed, jobs: fixed_names });
});

// ===== MARK JOB AS PROCESSING =====
router.post('/job-start', async (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try { jwt.verify(authHeader.slice(7), JWT_SECRET); } catch(e) { return res.status(401).json({ error: 'Invalid token' }); }

  const { filename } = req.body;
  if (!filename) return res.status(400).json({ error: 'filename required' });
  const job = await dbGet("SELECT id FROM transcribe_jobs WHERE filename = ?", [filename]);
  if (job) {
    await dbRun("UPDATE transcribe_jobs SET status = 'processing' WHERE id = ?", [job.id]);
    res.json({ ok: true, job_id: job.id });
  } else {
    res.json({ ok: false, message: 'job not found' });
  }
});

// ===== EVENTS API =====
router.get('/events', async (req, res) => {
  const token = req.headers['x-internal-token'];
  if (!token || token !== INTERNAL_TOKEN) return res.status(403).json({ error: 'Invalid internal token' });

  const from  = req.query.from  || '2020-01-01';
  const to    = req.query.to    || '2099-12-31';
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);

  const rows = await dbAll(`
    SELECT e.*, j.original_name, j.filename, u.name as user_name
    FROM transcribe_events e
    LEFT JOIN transcribe_jobs j ON e.job_id = j.id
    LEFT JOIN transcribe_users u ON e.user_id = u.id
    WHERE e.timestamp >= ? AND e.timestamp <= ? || ' 23:59:59'
    ORDER BY e.timestamp DESC
    LIMIT ?
  `, [from, to, limit]);

  const events = rows.map(r => {
    let message = r.event_type;
    if (r.event_type === 'job.completed' && r.original_name) message = 'Транскрипция: ' + r.original_name;
    else if (r.event_type === 'job.error' && r.original_name) message = 'Ошибка: ' + r.original_name;
    else if (r.event_type === 'gpu.unshelve') message = 'GPU сервер запущен';
    else if (r.event_type === 'gpu.shelve') message = 'GPU сервер остановлен';
    else if (r.event_type === 'service.restart') message = 'Перезапуск сервиса';

    let details = null;
    try { details = r.details ? JSON.parse(r.details) : null; } catch(_) { details = r.details; }

    return {
      service: 'transcribe',
      type: r.event_type,
      username: r.user_name || '',
      message,
      details,
      created_at: r.timestamp,
    };
  });

  res.json(events);
});

// ===== BULK INDEX (md-файлы из CLI/скрипта) =====
// Защищён INTERNAL_TOKEN. Принимает один документ за запрос
// (несколько файлов = несколько запросов). Два режима:
//
//   1. text: одним блоком — стандартное чанкование chunkText() в qdrant.js
//   2. chunks: [{text, extra_payload?}] — заранее нарезанные блоки
//      (например, поблочная нарезка профилей с метаданными flower_id, block_number)
//
// Поля: { username, project, source?, doc_id, original_name?, created_at?,
//         text? | chunks? }
router.post('/bulk-index', async (req, res) => {
  const token = req.headers['x-internal-token'];
  if (!token || token !== INTERNAL_TOKEN) return res.status(403).json({ error: 'Invalid internal token' });

  const { username, project, source, doc_id, original_name, text, chunks, created_at } = req.body || {};
  if (!username) return res.status(400).json({ error: 'username required' });
  if (!project)  return res.status(400).json({ error: 'project required' });
  if (!doc_id)   return res.status(400).json({ error: 'doc_id required' });

  const hasText = typeof text === 'string' && text.trim();
  const hasChunks = Array.isArray(chunks) && chunks.length;
  if (!hasText && !hasChunks) return res.status(400).json({ error: 'text or chunks required' });
  if (hasText && hasChunks)   return res.status(400).json({ error: 'pass text OR chunks, not both' });

  // Валидация chunks: каждый элемент должен иметь .text
  if (hasChunks) {
    for (let i = 0; i < chunks.length; i++) {
      if (!chunks[i] || typeof chunks[i].text !== 'string') {
        return res.status(400).json({ error: `chunks[${i}].text required` });
      }
    }
  }

  // Псевдо-jobId для bulk = doc_id (он уникален). В transcribe_jobs запись НЕ создаём —
  // это импорт извне, не транскрипция. enqueueIndex попытается обновить kb_status в БД,
  // но WHERE id = ? просто ничего не найдёт — это нормально для bulk.
  try {
    const task = {
      jobId:         doc_id,
      source:        source || 'bulk',
      username,
      project,
      doc_id,
      original_name: original_name || '',
      created_at:    created_at || new Date().toISOString(),
    };
    if (hasChunks) task.pre_chunks = chunks;
    else           task.text = text;

    const result = await enqueueIndex(task);

    logEvent('kb.bulk_indexed', null, null, {
      doc_id, project, username, source: source || 'bulk',
      original_name: original_name || '',
      mode: hasChunks ? 'pre_chunked' : 'text',
      chunks_count: hasChunks ? chunks.length : null,
      text_length: hasText ? text.length : null,
    }, 'bulk').catch(() => {});

    res.json({ ok: true, doc_id, project, queue_position: result.position, duplicate: !!result.duplicate });
  } catch (e) {
    console.error('[bulk-index]', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
