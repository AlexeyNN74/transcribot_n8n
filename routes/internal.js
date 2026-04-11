'use strict';
// Version: 1.9.8
// Updated: 2026-04-11

const express = require('express');
const jwt = require('jsonwebtoken');

const { db } = require('../db');
const { escapeHtml, logEvent } = require('../utils/helpers');
const { sendEmail } = require('../utils/email');
const { JWT_SECRET, GPU_API_KEY, APP_URL } = require('../config');

const router = express.Router();

// ===== WEBHOOK FROM GPU SERVER =====
router.post('/webhook/result', (req, res) => {
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
        <h2>Привет, ${escapeHtml(job.name)}!</h2>
        <p>Транскрипция файла <b>${escapeHtml(job.original_name)}</b> готова.</p>
        <a href="${APP_URL}/dashboard" style="background:#4F46E5;color:white;padding:12px 24px;text-decoration:none;border-radius:6px;display:inline-block">Скачать результат</a>
        <p>Файл будет доступен ${job.keep_days} дней.</p>
      `);
    }
  } else if (status === 'error') {
    db.prepare('UPDATE jobs SET status=?, error=? WHERE id=?').run('error', error || 'Unknown error', jobId);
  }

  res.json({ ok: true });
});

// ===== GET PROMPT FOR JOB =====
router.get('/job-prompt/:jobId', (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== GPU_API_KEY) return res.status(401).json({ error: 'Unauthorized' });

  const job = db.prepare('SELECT id, prompt_text, original_name FROM jobs WHERE id = ?').get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.json({ jobId: job.id, prompt_text: job.prompt_text, original_name: job.original_name });
});

// ===== RECEIVE RESULT FROM N8N =====
router.post('/job-result', (req, res) => {
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

  // Длительность из JSON
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
      <h2>Привет, ${escapeHtml(fullJob.name)}!</h2>
      <p>Транскрипция файла <b>${escapeHtml(fullJob.original_name)}</b> готова.</p>
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

// ===== WATCHDOG EVENT =====
router.post('/watchdog-event', (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try { jwt.verify(authHeader.slice(7), JWT_SECRET); } catch(e) { return res.status(401).json({ error: 'Invalid token' }); }

  const { event_type, details, source } = req.body;
  if (!event_type) return res.status(400).json({ error: 'event_type required' });

  logEvent(event_type, null, null, details, source || 'watchdog');

  if (event_type.includes('critical') || event_type === 'service.restart') {
    const adminUser = db.prepare("SELECT email FROM users WHERE role='admin' LIMIT 1").get();
    if (adminUser) {
      sendEmail(adminUser.email, '⚠️ GPU Watchdog: ' + event_type, '<pre>' + JSON.stringify(req.body, null, 2) + '</pre>');
    }
  }

  res.json({ ok: true });
});

module.exports = router;
