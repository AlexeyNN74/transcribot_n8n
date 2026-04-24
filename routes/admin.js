'use strict';
// routes/admin.js v2.0 — PostgreSQL edition
// Updated: 2026-04-24

const express = require('express');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const { pool, pgify, dbGet, dbAll, dbRun } = require('../db');
const { adminMiddleware } = require('../middleware');
const { escapeHtml, logEvent } = require('../utils/helpers');
const { sendEmail } = require('../utils/email');
const {
  UPLOAD_PATH, RESULTS_PATH, GPU_SERVER_URL, N8N_URL,
  OS_AUTH_URL, OS_GPU_ID, OS_USERNAME, OS_PASSWORD, OS_PROJECT
} = require('../config');

const router = express.Router();

// ===== USERS =====
router.get('/users', adminMiddleware, async (req, res) => {
  const users = await dbAll(`
    SELECT u.*, COUNT(j.id)::int as jobs_count
    FROM transcribe_users u LEFT JOIN transcribe_jobs j ON u.id = j.user_id
    GROUP BY u.id ORDER BY u.created_at DESC
  `);
  res.json(users);
});

router.put('/users/:id/activate', adminMiddleware, async (req, res) => {
  const user = await dbGet('SELECT * FROM transcribe_users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  await dbRun('UPDATE transcribe_users SET active = 1, activation_token = NULL WHERE id = ?', [req.params.id]);

  const { APP_URL } = require('../config');
  await sendEmail(user.email, 'Ваш аккаунт активирован!', `
    <h2>Добро пожаловать, ${escapeHtml(user.name)}!</h2>
    <p>Ваш аккаунт активирован. Теперь вы можете загружать файлы для транскрибации.</p>
    <a href="${APP_URL}" style="background:#4F46E5;color:white;padding:12px 24px;text-decoration:none;border-radius:6px;display:inline-block">Войти</a>
  `);
  res.json({ message: 'Пользователь активирован' });
});

router.put('/users/:id/deactivate', adminMiddleware, async (req, res) => {
  await dbRun('UPDATE transcribe_users SET active = 0 WHERE id = ?', [req.params.id]);
  res.json({ message: 'Пользователь деактивирован' });
});

router.delete('/users/:id', adminMiddleware, async (req, res) => {
  await dbRun('DELETE FROM transcribe_jobs WHERE user_id = ?', [req.params.id]);
  await dbRun('DELETE FROM transcribe_users WHERE id = ?', [req.params.id]);
  res.json({ message: 'Пользователь удалён' });
});

router.put('/users/:id/video-limit', adminMiddleware, async (req, res) => {
  const limitMb = parseInt(req.body.video_limit_mb);
  if (!limitMb || limitMb < 0 || limitMb > 3000) return res.status(400).json({ error: 'Лимит должен быть от 0 до 3000 МБ' });
  const user = await dbGet('SELECT id, email FROM transcribe_users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  await dbRun('UPDATE transcribe_users SET video_limit_mb = ? WHERE id = ?', [limitMb, req.params.id]);
  logEvent('admin.video_limit', null, req.user.id, { target_user: user.email, limit_mb: limitMb });
  res.json({ ok: true, video_limit_mb: limitMb });
});

// ===== JOBS =====
router.get('/jobs', adminMiddleware, async (req, res) => {
  const jobs = await dbAll(`
    SELECT j.*, u.email, u.name as user_name
    FROM transcribe_jobs j JOIN transcribe_users u ON j.user_id = u.id
    ORDER BY j.created_at DESC LIMIT 100
  `);
  res.json(jobs);
});

router.delete('/jobs/:id', adminMiddleware, async (req, res) => {
  const job = await dbGet('SELECT * FROM transcribe_jobs WHERE id = ?', [req.params.id]);
  if (!job) return res.status(404).json({ error: 'Задание не найдено' });
  const filePath = path.join(UPLOAD_PATH, job.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  await dbRun('DELETE FROM transcribe_jobs WHERE id = ?', [req.params.id]);
  res.json({ message: 'Задание удалено' });
});

// ===== STATS =====
router.get('/stats', adminMiddleware, async (req, res) => {
  const [tu, ta, tp, jt, jp, jc, je] = await Promise.all([
    dbGet('SELECT COUNT(*)::int as c FROM transcribe_users'),
    dbGet('SELECT COUNT(*)::int as c FROM transcribe_users WHERE active=1'),
    dbGet('SELECT COUNT(*)::int as c FROM transcribe_users WHERE active=0 AND activation_token IS NULL'),
    dbGet('SELECT COUNT(*)::int as c FROM transcribe_jobs'),
    dbGet("SELECT COUNT(*)::int as c FROM transcribe_jobs WHERE status='processing'"),
    dbGet("SELECT COUNT(*)::int as c FROM transcribe_jobs WHERE status='completed'"),
    dbGet("SELECT COUNT(*)::int as c FROM transcribe_jobs WHERE status='error'"),
  ]);
  res.json({
    users_total:     tu.c,
    users_active:    ta.c,
    users_pending:   tp.c,
    jobs_total:      jt.c,
    jobs_processing: jp.c,
    jobs_completed:  jc.c,
    jobs_error:      je.c,
  });
});

router.get('/stats/extended', adminMiddleware, async (req, res) => {
  const totals = await dbGet(`
    SELECT
      COUNT(*)::int as jobs_total,
      COUNT(*) FILTER (WHERE status='completed')::int as jobs_completed,
      COUNT(*) FILTER (WHERE status='error')::int    as jobs_error,
      COALESCE(SUM(CASE WHEN status='completed' THEN COALESCE(duration_sec,0) ELSE 0 END), 0) as total_sec,
      AVG(CASE WHEN status='completed' AND duration_sec IS NOT NULL THEN duration_sec END) as avg_sec
    FROM transcribe_jobs
  `);

  const monthRow = await dbGet(`
    SELECT COALESCE(SUM(COALESCE(duration_sec,0)),0) as s FROM transcribe_jobs
    WHERE status='completed' AND created_at >= NOW() - INTERVAL '30 days'
  `);

  const weekRow = await dbGet(`
    SELECT COUNT(*)::int as c FROM transcribe_jobs WHERE created_at >= NOW() - INTERVAL '7 days'
  `);

  const byDay = await dbAll(`
    SELECT created_at::date as day,
      COUNT(*)::int as total,
      COUNT(*) FILTER (WHERE status='completed')::int as completed,
      COUNT(*) FILTER (WHERE status='error')::int    as errors
    FROM transcribe_jobs
    WHERE created_at >= NOW() - INTERVAL '30 days'
    GROUP BY created_at::date
    ORDER BY day ASC
  `);

  const topUsers = await dbAll(`
    SELECT u.name, u.email,
      COUNT(j.id)::int as jobs_count,
      COALESCE(SUM(CASE WHEN j.status='completed' THEN COALESCE(j.duration_sec,0) ELSE 0 END), 0) as total_sec
    FROM transcribe_users u
    LEFT JOIN transcribe_jobs j ON u.id = j.user_id
    GROUP BY u.id
    ORDER BY jobs_count DESC
    LIMIT 10
  `);

  const month_sec = parseFloat(monthRow.s) || 0;
  res.json({
    totals: {
      jobs_total:     totals.jobs_total || 0,
      jobs_completed: totals.jobs_completed || 0,
      jobs_error:     totals.jobs_error || 0,
      total_min:      Math.round((parseFloat(totals.total_sec) || 0) / 60),
      month_min:      Math.round(month_sec / 60),
      week_jobs:      weekRow.c,
      avg_min:        totals.avg_sec ? Math.round(parseFloat(totals.avg_sec) / 60 * 10) / 10 : 0,
      error_rate:     totals.jobs_total > 0 ? Math.round((totals.jobs_error || 0) / totals.jobs_total * 100) : 0,
    },
    by_day: byDay,
    top_users: topUsers
  });
});

// ===== GPU SESSIONS =====
router.get('/gpu-sessions', adminMiddleware, async (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 30, 365);

  const sessions = await dbAll(`
    SELECT * FROM transcribe_gpu_sessions
    WHERE unshelve_at >= NOW() - ($1 || ' days')::interval
    ORDER BY unshelve_at DESC
    LIMIT 100
  `, [days]);

  const totals = await dbGet(`
    SELECT
      COUNT(*)::int as session_count,
      COALESCE(SUM(CASE WHEN duration_sec IS NOT NULL THEN duration_sec ELSE 0 END), 0) as total_sec,
      COALESCE(SUM(jobs_count), 0)::int as total_jobs,
      AVG(CASE WHEN duration_sec IS NOT NULL THEN duration_sec END) as avg_sec
    FROM transcribe_gpu_sessions
    WHERE unshelve_at >= NOW() - ($1 || ' days')::interval AND status = 'closed'
  `, [days]);

  res.json({
    sessions,
    totals: {
      session_count: totals.session_count || 0,
      total_min: Math.round((parseFloat(totals.total_sec) || 0) / 60),
      total_jobs: totals.total_jobs || 0,
      avg_min: totals.avg_sec ? Math.round(parseFloat(totals.avg_sec) / 60 * 10) / 10 : 0,
    },
    days
  });
});

// ===== PROMPTS ADMIN =====
router.get('/prompts', adminMiddleware, async (req, res) => {
  const prompts = await dbAll(`
    SELECT p.*, u.email as user_email, u.name as user_name
    FROM transcribe_prompts p LEFT JOIN transcribe_users u ON p.user_id = u.id
    ORDER BY p.is_system DESC, p.is_default DESC, p.created_at DESC
  `);
  res.json(prompts);
});

router.post('/prompts', adminMiddleware, async (req, res) => {
  const { name, description, prompt_text, is_system } = req.body;
  if (!name || !prompt_text) return res.status(400).json({ error: 'Укажите название и текст промпта' });

  const id = uuidv4();
  await dbRun(
    'INSERT INTO transcribe_prompts (id, user_id, name, description, prompt_text, is_default, is_system) VALUES (?, NULL, ?, ?, ?, 0, ?)',
    [id, name.trim(), description?.trim() || '', prompt_text.trim(), is_system ? 1 : 0]
  );
  const prompt = await dbGet('SELECT * FROM transcribe_prompts WHERE id = ?', [id]);
  res.json(prompt);
});

router.put('/prompts/:id', adminMiddleware, async (req, res) => {
  const prompt = await dbGet('SELECT * FROM transcribe_prompts WHERE id = ?', [req.params.id]);
  if (!prompt) return res.status(404).json({ error: 'Профиль не найден' });

  const { name, description, prompt_text, is_system } = req.body;
  await dbRun(
    'UPDATE transcribe_prompts SET name = ?, description = ?, prompt_text = ?, is_system = ? WHERE id = ?',
    [
      name?.trim() || prompt.name,
      description?.trim() ?? prompt.description,
      prompt_text?.trim() || prompt.prompt_text,
      is_system !== undefined ? (is_system ? 1 : 0) : prompt.is_system,
      req.params.id,
    ]
  );
  const updated = await dbGet('SELECT * FROM transcribe_prompts WHERE id = ?', [req.params.id]);
  res.json(updated);
});

router.put('/prompts/:id/set-default', adminMiddleware, async (req, res) => {
  const prompt = await dbGet('SELECT * FROM transcribe_prompts WHERE id = ?', [req.params.id]);
  if (!prompt) return res.status(404).json({ error: 'Профиль не найден' });
  if (!prompt.is_system) return res.status(400).json({ error: 'Дефолтным может быть только системный профиль' });

  await dbRun('UPDATE transcribe_prompts SET is_default = 0 WHERE is_system = 1');
  await dbRun('UPDATE transcribe_prompts SET is_default = 1 WHERE id = ?', [req.params.id]);
  res.json({ ok: true, default_id: req.params.id });
});

router.delete('/prompts/:id', adminMiddleware, async (req, res) => {
  const prompt = await dbGet('SELECT * FROM transcribe_prompts WHERE id = ?', [req.params.id]);
  if (!prompt) return res.status(404).json({ error: 'Профиль не найден' });
  if (prompt.is_default) return res.status(400).json({ error: 'Нельзя удалить дефолтный профиль. Сначала назначьте другой.' });

  await dbRun('DELETE FROM transcribe_prompts WHERE id = ?', [req.params.id]);
  res.json({ message: 'Профиль удалён' });
});

// ===== JOB BY FILENAME =====
router.get('/job-by-filename', adminMiddleware, async (req, res) => {
  const { filename } = req.query;
  if (!filename) return res.status(400).json({ error: 'filename required' });
  const job = await dbGet(
    'SELECT id, filename, diarize, status, prompt_text, min_speakers, max_speakers, noise_filter FROM transcribe_jobs WHERE filename = ?',
    [filename]
  );
  if (!job) return res.status(404).json({ error: 'Job not found', filename });
  res.json(job);
});

// ===== GPU PANEL =====

let osTokenCache = null;

async function getOpenStackToken() {
  if (osTokenCache && osTokenCache.expires > Date.now()) return osTokenCache;

  const authRes = await fetch(`${OS_AUTH_URL}/auth/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      auth: {
        identity: { methods: ['password'], password: { user: { name: OS_USERNAME, domain: { name: 'Default' }, password: OS_PASSWORD } } },
        scope: { project: { name: OS_PROJECT, domain: { name: 'Default' } } }
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

  osTokenCache = { token, endpoint: computeEndpoint, expires: Date.now() + 50 * 60 * 1000 };
  return osTokenCache;
}

async function gpuGetStatus() {
  const { token, endpoint } = await getOpenStackToken();
  const res = await fetch(`${endpoint}/servers/${OS_GPU_ID}`, { headers: { 'X-Auth-Token': token } });
  if (!res.ok) throw new Error(`Get server status failed: ${res.status}`);
  const data = await res.json();
  return data.server?.status || 'UNKNOWN';
}

async function gpuDoAction(action) {
  const { token, endpoint } = await getOpenStackToken();
  let body;
  if (action === 'shelve')        body = { shelve: null };
  else if (action === 'unshelve') body = { unshelve: null };
  else if (action === 'start')    body = { 'os-start': null };
  const res = await fetch(`${endpoint}/servers/${OS_GPU_ID}/action`, {
    method: 'POST',
    headers: { 'X-Auth-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok && res.status !== 202) throw new Error(`GPU action '${action}' failed: ${res.status}`);
  return true;
}

router.get('/gpu/status', adminMiddleware, async (req, res) => {
  try {
    const status = await gpuGetStatus();
    res.json({ ok: true, status });
  } catch (e) {
    console.error('[GPU]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/gpu/action', adminMiddleware, async (req, res) => {
  const { action } = req.body;
  if (!['shelve', 'unshelve', 'start'].includes(action)) {
    return res.status(400).json({ error: 'Неизвестная команда. Допустимо: shelve, unshelve, start' });
  }
  try {
    await gpuDoAction(action);
    logEvent('gpu.' + action, null, req.user.id);

    if (action === 'unshelve') {
      await dbRun("INSERT INTO transcribe_gpu_sessions (id, unshelve_at, trigger_type, status) VALUES (?, NOW(), 'manual', 'active')", [uuidv4()]);
    } else if (action === 'shelve') {
      await dbRun(`UPDATE transcribe_gpu_sessions SET
        shelve_at=NOW(),
        duration_sec=EXTRACT(EPOCH FROM (NOW() - unshelve_at)),
        status='closed'
        WHERE status='active'`);
    }

    res.json({ ok: true, action });
  } catch (e) {
    console.error('[GPU]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ===== MONITOR =====

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

router.get('/monitor', adminMiddleware, async (req, res) => {
  const [whisper, diarize, ollama, n8n, gpuStatus] = await Promise.allSettled([
    checkService(`http://${GPU_HOST}:8000/health`),
    checkService(`http://${GPU_HOST}:8002/health`),
    checkService(`http://${GPU_HOST}:11434/api/tags`),
    checkService(`${N8N_URL}/healthz`),
    gpuGetStatus()
  ]);

  const [queued, pending, processing, errorToday, completedToday] = await Promise.all([
    dbGet("SELECT COUNT(*)::int as c FROM transcribe_jobs WHERE status='queued'"),
    dbGet("SELECT COUNT(*)::int as c FROM transcribe_jobs WHERE status='pending'"),
    dbGet("SELECT COUNT(*)::int as c FROM transcribe_jobs WHERE status='processing'"),
    dbGet("SELECT COUNT(*)::int as c FROM transcribe_jobs WHERE status='error' AND completed_at::date = CURRENT_DATE"),
    dbGet("SELECT COUNT(*)::int as c FROM transcribe_jobs WHERE status='completed' AND completed_at::date = CURRENT_DATE"),
  ]);

  const queue = {
    queued:          queued.c,
    pending:         pending.c,
    processing:      processing.c,
    error_today:     errorToday.c,
    completed_today: completedToday.c,
  };

  const currentJob = await dbGet(`
    SELECT j.id, j.original_name, j.diarize, j.created_at, u.name as user_name
    FROM transcribe_jobs j JOIN transcribe_users u ON j.user_id = u.id
    WHERE j.status IN ('processing', 'queued')
    ORDER BY j.created_at ASC LIMIT 1
  `) || null;

  const pendingJobs = await dbAll(`
    SELECT j.id, j.original_name, j.diarize, j.created_at, u.name as user_name
    FROM transcribe_jobs j JOIN transcribe_users u ON j.user_id = u.id
    WHERE j.status = 'pending'
    ORDER BY j.created_at ASC LIMIT 20
  `);

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

// ===== EVENTS =====
router.get('/events', adminMiddleware, async (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit || '100'), 500);
  const offset = parseInt(req.query.offset || '0');

  // Build dynamic WHERE
  let whereClause = '1=1';
  const params = [];
  const eventType = req.query.type || null;
  const jobId     = req.query.job_id || null;
  const from      = req.query.from || null;
  const to        = req.query.to || null;

  if (eventType) { whereClause += ' AND e.event_type LIKE ?'; params.push(eventType + '%'); }
  if (jobId)     { whereClause += ' AND e.job_id = ?'; params.push(jobId); }
  if (from)      { whereClause += ' AND e.timestamp >= ?'; params.push(from); }
  if (to)        { whereClause += ' AND e.timestamp <= ?'; params.push(to); }

  const events = await dbAll(`
    SELECT e.*, j.original_name, u.name as user_name, u.email as user_email
    FROM transcribe_events e
    LEFT JOIN transcribe_jobs j ON e.job_id = j.id
    LEFT JOIN transcribe_users u ON e.user_id = u.id
    WHERE ${whereClause}
    ORDER BY e.timestamp DESC
    LIMIT ? OFFSET ?
  `, [...params, limit, offset]);

  const totalRow = await dbGet(
    `SELECT COUNT(*)::int as c FROM transcribe_events e WHERE ${whereClause}`,
    params
  );

  res.json({ events, total: totalRow.c, limit, offset });
});

// ===== CONTROL =====
router.post('/control/reset-stuck', adminMiddleware, async (req, res) => {
  const stuck = await dbAll(
    "SELECT id, original_name FROM transcribe_jobs WHERE status IN ('processing', 'pending', 'queued') AND created_at < NOW() - INTERVAL '2 hours'"
  );
  if (stuck.length === 0) return res.json({ reset: 0, message: 'Нет зависших заданий' });

  const ids = stuck.map(j => j.id);
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
  await pool.query(
    `UPDATE transcribe_jobs SET status='pending', error=NULL, completed_at=NULL WHERE id IN (${placeholders})`,
    ids
  );

  if (fs.existsSync(RESULTS_PATH)) {
    fs.readdirSync(RESULTS_PATH).filter(f => f.endsWith('.lock')).forEach(f => {
      try { fs.unlinkSync(path.join(RESULTS_PATH, f)); } catch(e) {}
    });
  }

  logEvent('admin.reset_stuck', null, req.user.id, { count: stuck.length, jobs: stuck.map(j => j.original_name) });
  res.json({ reset: stuck.length, jobs: stuck });
});

router.post('/control/clear-locks', adminMiddleware, (req, res) => {
  let removed = 0;
  if (fs.existsSync(RESULTS_PATH)) {
    fs.readdirSync(RESULTS_PATH).filter(f => f.endsWith('.lock')).forEach(f => {
      try { fs.unlinkSync(path.join(RESULTS_PATH, f)); removed++; } catch(e) {}
    });
  }
  logEvent('admin.clear_locks', null, req.user.id, { removed });
  res.json({ removed });
});

router.post('/control/reset-errors', adminMiddleware, async (req, res) => {
  const errors = await dbAll("SELECT id, original_name FROM transcribe_jobs WHERE status='error'");
  if (errors.length === 0) return res.json({ reset: 0, message: 'Нет заданий с ошибками' });

  await dbRun("UPDATE transcribe_jobs SET status='pending', error=NULL, completed_at=NULL WHERE status='error'");
  logEvent('admin.reset_errors', null, req.user.id, { count: errors.length });
  res.json({ reset: errors.length });
});

router.post('/control/archive-journal', adminMiddleware, async (req, res) => {
  const events = await dbAll('SELECT * FROM transcribe_events ORDER BY timestamp ASC');
  if (events.length === 0) return res.json({ archived: 0, message: 'Журнал пуст' });

  const archivedJobs = await dbAll("SELECT id FROM transcribe_jobs WHERE status='archived'");
  const archivedJobIds = new Set(archivedJobs.map(r => r.id));

  const archiveDir = path.join(RESULTS_PATH, 'archives');
  if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const archivePath = path.join(archiveDir, 'events_' + ts + '.json');
  fs.writeFileSync(archivePath, JSON.stringify(events, null, 2));

  await dbRun("DELETE FROM transcribe_events WHERE job_id IS NULL OR job_id NOT IN (SELECT id FROM transcribe_jobs WHERE status='archived')");
  logEvent('admin.archive_journal', null, req.user.id, { archived: events.length, file: archivePath });
  res.json({ archived: events.length, file: 'events_' + ts + '.json' });
});

// ===== ARCHIVE =====
router.get('/archive', adminMiddleware, async (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit || '100'), 500);
  const offset = parseInt(req.query.offset || '0');

  const jobs = await dbAll(`
    SELECT j.id, j.original_name, j.archived_at, j.created_at, j.completed_at,
           j.duration_sec, j.diarize, j.rating,
           u.name as user_name, u.email as user_email
    FROM transcribe_jobs j JOIN transcribe_users u ON j.user_id = u.id
    WHERE j.status = 'archived'
    ORDER BY j.archived_at DESC
    LIMIT ? OFFSET ?
  `, [limit, offset]);

  const totalRow = await dbGet("SELECT COUNT(*)::int as c FROM transcribe_jobs WHERE status='archived'");
  res.json({ jobs, total: totalRow.c, limit, offset });
});

router.put('/archive/:id/restore', adminMiddleware, async (req, res) => {
  const job = await dbGet("SELECT * FROM transcribe_jobs WHERE id = ? AND status = 'archived'", [req.params.id]);
  if (!job) return res.status(404).json({ error: 'Задание не найдено в архиве' });

  await dbRun("UPDATE transcribe_jobs SET status='completed', archived_at=NULL WHERE id=?", [req.params.id]);
  logEvent('admin.archive_restore', req.params.id, req.user.id, { original_name: job.original_name });
  res.json({ message: 'Задание восстановлено' });
});

router.delete('/archive/:id', adminMiddleware, async (req, res) => {
  const job = await dbGet("SELECT * FROM transcribe_jobs WHERE id = ? AND status = 'archived'", [req.params.id]);
  if (!job) return res.status(404).json({ error: 'Задание не найдено в архиве' });

  await dbRun('DELETE FROM transcribe_jobs WHERE id = ?', [req.params.id]);
  logEvent('admin.archive_delete', req.params.id, req.user.id, { original_name: job.original_name });
  res.json({ message: 'Задание удалено навсегда' });
});

router.post('/archive/cleanup', adminMiddleware, async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.body.days) || 180, 1), 365);

  const old = await dbAll(
    "SELECT id, original_name FROM transcribe_jobs WHERE status='archived' AND archived_at < NOW() - ($1 || ' days')::interval",
    [days]
  );

  if (old.length === 0) return res.json({ deleted: 0, message: 'Нет заданий старше ' + days + ' дней' });

  await dbRun(
    "DELETE FROM transcribe_jobs WHERE status='archived' AND archived_at < NOW() - ($1 || ' days')::interval",
    [days]
  );

  logEvent('admin.archive_cleanup', null, req.user.id, { deleted: old.length, days });
  res.json({ deleted: old.length, days });
});

module.exports = router;
module.exports.gpuGetStatus = gpuGetStatus;
module.exports.gpuDoAction = gpuDoAction;
