'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const { db } = require('../db');
const { adminMiddleware } = require('../middleware');
const { escapeHtml, logEvent } = require('../utils/helpers');
const { sendEmail } = require('../utils/email');
const {
  UPLOAD_PATH, RESULTS_PATH, GPU_SERVER_URL, N8N_URL,
  OS_AUTH_URL, OS_GPU_ID, OS_USERNAME, OS_PASSWORD, OS_PROJECT
} = require('../config');

const router = express.Router();

// ===== USERS =====
router.get('/users', adminMiddleware, (req, res) => {
  const users = db.prepare(`
    SELECT u.*, COUNT(j.id) as jobs_count
    FROM users u LEFT JOIN jobs j ON u.id = j.user_id
    GROUP BY u.id ORDER BY u.created_at DESC
  `).all();
  res.json(users);
});

router.put('/users/:id/activate', adminMiddleware, async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  db.prepare('UPDATE users SET active = 1, activation_token = NULL WHERE id = ?').run(req.params.id);

  const { APP_URL } = require('../config');
  await sendEmail(user.email, 'Ваш аккаунт активирован!', `
    <h2>Добро пожаловать, ${escapeHtml(user.name)}!</h2>
    <p>Ваш аккаунт активирован. Теперь вы можете загружать файлы для транскрибации.</p>
    <a href="${APP_URL}" style="background:#4F46E5;color:white;padding:12px 24px;text-decoration:none;border-radius:6px;display:inline-block">Войти</a>
  `);

  res.json({ message: 'Пользователь активирован' });
});

router.put('/users/:id/deactivate', adminMiddleware, (req, res) => {
  db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ message: 'Пользователь деактивирован' });
});

router.delete('/users/:id', adminMiddleware, (req, res) => {
  db.prepare('DELETE FROM jobs WHERE user_id = ?').run(req.params.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ message: 'Пользователь удалён' });
});

router.put('/users/:id/video-limit', adminMiddleware, (req, res) => {
  const limitMb = parseInt(req.body.video_limit_mb);
  if (!limitMb || limitMb < 0 || limitMb > 3000) {
    return res.status(400).json({ error: 'Лимит должен быть от 0 до 3000 МБ' });
  }
  const user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  db.prepare('UPDATE users SET video_limit_mb = ? WHERE id = ?').run(limitMb, req.params.id);
  logEvent('admin.video_limit', null, req.user.id, { target_user: user.email, limit_mb: limitMb });
  res.json({ ok: true, video_limit_mb: limitMb });
});

// ===== JOBS =====
router.get('/jobs', adminMiddleware, (req, res) => {
  const jobs = db.prepare(`
    SELECT j.*, u.email, u.name as user_name
    FROM jobs j JOIN users u ON j.user_id = u.id
    ORDER BY j.created_at DESC LIMIT 100
  `).all();
  res.json(jobs);
});

router.delete('/jobs/:id', adminMiddleware, (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Задание не найдено' });

  const filePath = path.join(UPLOAD_PATH, job.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  db.prepare('DELETE FROM jobs WHERE id = ?').run(req.params.id);
  res.json({ message: 'Задание удалено' });
});

// ===== STATS =====
router.get('/stats', adminMiddleware, (req, res) => {
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

router.get('/stats/extended', adminMiddleware, (req, res) => {
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
      jobs_total:     totals.jobs_total || 0,
      jobs_completed: totals.jobs_completed || 0,
      jobs_error:     totals.jobs_error || 0,
      total_min:      Math.round((totals.total_sec || 0) / 60),
      month_min:      Math.round(month_sec / 60),
      week_jobs,
      avg_min:        totals.avg_sec ? Math.round(totals.avg_sec / 60 * 10) / 10 : 0,
      error_rate:     totals.jobs_total > 0 ? Math.round((totals.jobs_error || 0) / totals.jobs_total * 100) : 0,
    },
    by_day: byDay,
    top_users: topUsers
  });
});

// ===== GPU SESSIONS =====
router.get('/gpu-sessions', adminMiddleware, (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 30, 365);

  const sessions = db.prepare(`
    SELECT * FROM gpu_sessions
    WHERE unshelve_at >= datetime('now', '-' || ? || ' days')
    ORDER BY unshelve_at DESC
    LIMIT 100
  `).all(days);

  const totals = db.prepare(`
    SELECT
      COUNT(*) as session_count,
      SUM(CASE WHEN duration_sec IS NOT NULL THEN duration_sec ELSE 0 END) as total_sec,
      SUM(jobs_count) as total_jobs,
      AVG(CASE WHEN duration_sec IS NOT NULL THEN duration_sec END) as avg_sec
    FROM gpu_sessions
    WHERE unshelve_at >= datetime('now', '-' || ? || ' days')
      AND status = 'closed'
  `).get(days);

  res.json({
    sessions,
    totals: {
      session_count: totals.session_count || 0,
      total_min: Math.round((totals.total_sec || 0) / 60),
      total_jobs: totals.total_jobs || 0,
      avg_min: totals.avg_sec ? Math.round(totals.avg_sec / 60 * 10) / 10 : 0,
    },
    days
  });
});

// ===== PROMPTS ADMIN =====
router.get('/prompts', adminMiddleware, (req, res) => {
  const prompts = db.prepare(`
    SELECT p.*, u.email as user_email, u.name as user_name
    FROM prompts p LEFT JOIN users u ON p.user_id = u.id
    ORDER BY p.is_system DESC, p.is_default DESC, p.created_at DESC
  `).all();
  res.json(prompts);
});

router.post('/prompts', adminMiddleware, (req, res) => {
  const { name, description, prompt_text, is_system } = req.body;
  if (!name || !prompt_text) return res.status(400).json({ error: 'Укажите название и текст промпта' });

  const id = uuidv4();
  db.prepare(`
    INSERT INTO prompts (id, user_id, name, description, prompt_text, is_default, is_system)
    VALUES (?, NULL, ?, ?, ?, 0, ?)
  `).run(id, name.trim(), description?.trim() || '', prompt_text.trim(), is_system ? 1 : 0);

  res.json(db.prepare('SELECT * FROM prompts WHERE id = ?').get(id));
});

router.put('/prompts/:id', adminMiddleware, (req, res) => {
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

router.put('/prompts/:id/set-default', adminMiddleware, (req, res) => {
  const prompt = db.prepare('SELECT * FROM prompts WHERE id = ?').get(req.params.id);
  if (!prompt) return res.status(404).json({ error: 'Профиль не найден' });
  if (!prompt.is_system) return res.status(400).json({ error: 'Дефолтным может быть только системный профиль' });

  db.prepare('UPDATE prompts SET is_default = 0 WHERE is_system = 1').run();
  db.prepare('UPDATE prompts SET is_default = 1 WHERE id = ?').run(req.params.id);

  res.json({ ok: true, default_id: req.params.id });
});

router.delete('/prompts/:id', adminMiddleware, (req, res) => {
  const prompt = db.prepare('SELECT * FROM prompts WHERE id = ?').get(req.params.id);
  if (!prompt) return res.status(404).json({ error: 'Профиль не найден' });
  if (prompt.is_default) return res.status(400).json({ error: 'Нельзя удалить дефолтный профиль. Сначала назначьте другой.' });

  db.prepare('DELETE FROM prompts WHERE id = ?').run(req.params.id);
  res.json({ message: 'Профиль удалён' });
});

// ===== JOB BY FILENAME (n8n) =====
router.get('/job-by-filename', adminMiddleware, (req, res) => {
  const { filename } = req.query;
  if (!filename) return res.status(400).json({ error: 'filename required' });

  const job = db.prepare('SELECT id, filename, diarize, status, prompt_text, min_speakers, max_speakers, noise_filter FROM jobs WHERE filename = ?').get(filename);
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
        identity: {
          methods: ['password'],
          password: { user: { name: OS_USERNAME, domain: { name: 'Default' }, password: OS_PASSWORD } }
        },
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
  if (action === 'shelve')   body = { shelve: null };
  else if (action === 'unshelve') body = { unshelve: null };
  else if (action === 'start') body = { 'os-start': null };
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

    // GPU session tracking
    if (action === 'unshelve') {
      const { v4: uuidv4 } = require('uuid');
      db.prepare("INSERT INTO gpu_sessions (id, unshelve_at, trigger_type, status) VALUES (?, datetime('now'), 'manual', 'active')")
        .run(uuidv4());
    } else if (action === 'shelve') {
      // Закрыть открытую сессию (если есть)
      db.prepare(`UPDATE gpu_sessions SET
        shelve_at=datetime('now'),
        duration_sec=CAST((julianday(datetime('now')) - julianday(unshelve_at)) * 86400 AS REAL),
        status='closed'
        WHERE status='active'`)
        .run();
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

  const queue = {
    queued:      db.prepare("SELECT COUNT(*) as c FROM jobs WHERE status='queued'").get().c,
    pending:     db.prepare("SELECT COUNT(*) as c FROM jobs WHERE status='pending'").get().c,
    processing:  db.prepare("SELECT COUNT(*) as c FROM jobs WHERE status='processing'").get().c,
    error_today: db.prepare("SELECT COUNT(*) as c FROM jobs WHERE status='error' AND date(completed_at)=date('now')").get().c,
    completed_today: db.prepare("SELECT COUNT(*) as c FROM jobs WHERE status='completed' AND date(completed_at)=date('now')").get().c,
  };

  const currentJob = db.prepare(`
    SELECT j.id, j.original_name, j.diarize, j.created_at, u.name as user_name
    FROM jobs j JOIN users u ON j.user_id = u.id
    WHERE j.status IN ('processing', 'queued')
    ORDER BY j.created_at ASC LIMIT 1
  `).get() || null;

  const pendingJobs = db.prepare(`
    SELECT j.id, j.original_name, j.diarize, j.created_at, u.name as user_name
    FROM jobs j JOIN users u ON j.user_id = u.id
    WHERE j.status = 'pending'
    ORDER BY j.created_at ASC LIMIT 20
  `).all();

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
router.get('/events', adminMiddleware, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100'), 500);
  const offset = parseInt(req.query.offset || '0');
  const eventType = req.query.type || null;
  const jobId = req.query.job_id || null;

  let where = '1=1';
  const params = [];
  if (eventType) { where += ' AND event_type LIKE ?'; params.push(eventType + '%'); }
  if (jobId) { where += ' AND job_id = ?'; params.push(jobId); }
  const from = req.query.from || null;
  const to = req.query.to || null;
  if (from) { where += ' AND e.timestamp >= ?'; params.push(from); }
  if (to) { where += ' AND e.timestamp <= ?'; params.push(to); }

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

// ===== CONTROL =====
router.post('/control/reset-stuck', adminMiddleware, (req, res) => {
  const stuck = db.prepare(
    "SELECT id, original_name FROM jobs WHERE status IN ('processing', 'pending', 'queued') AND created_at < datetime('now', '-2 hours')"
  ).all();
  if (stuck.length === 0) return res.json({ reset: 0, message: 'Нет зависших заданий' });

  const ids = stuck.map(j => j.id);
  db.prepare(
    "UPDATE jobs SET status='pending', error=NULL, completed_at=NULL WHERE id IN (" + ids.map(() => '?').join(',') + ")"
  ).run(...ids);

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

router.post('/control/reset-errors', adminMiddleware, (req, res) => {
  const errors = db.prepare("SELECT id, original_name FROM jobs WHERE status='error'").all();
  if (errors.length === 0) return res.json({ reset: 0, message: 'Нет заданий с ошибками' });

  db.prepare("UPDATE jobs SET status='pending', error=NULL, completed_at=NULL WHERE status='error'").run();

  logEvent('admin.reset_errors', null, req.user.id, { count: errors.length });
  res.json({ reset: errors.length });
});

router.post('/control/archive-journal', adminMiddleware, (req, res) => {
  const events = db.prepare('SELECT * FROM events ORDER BY timestamp ASC').all();
  if (events.length === 0) return res.json({ archived: 0, message: 'Журнал пуст' });
  const archivedJobIds = new Set(db.prepare("SELECT id FROM jobs WHERE status='archived'").all().map(r => r.id));

  const archiveDir = path.join(RESULTS_PATH, 'archives');
  if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const archivePath = path.join(archiveDir, 'events_' + ts + '.json');
  fs.writeFileSync(archivePath, JSON.stringify(events, null, 2));

  db.prepare("DELETE FROM events WHERE job_id IS NULL OR job_id NOT IN (SELECT id FROM jobs WHERE status='archived')").run();
  logEvent('admin.archive_journal', null, req.user.id, { archived: events.length, file: archivePath });

  res.json({ archived: events.length, file: 'events_' + ts + '.json' });
});


// ===== ARCHIVE =====

// Список архивных заданий
router.get('/archive', adminMiddleware, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100'), 500);
  const offset = parseInt(req.query.offset || '0');

  const jobs = db.prepare(`
    SELECT j.id, j.original_name, j.archived_at, j.created_at, j.completed_at,
           j.duration_sec, j.diarize, j.rating,
           u.name as user_name, u.email as user_email
    FROM jobs j JOIN users u ON j.user_id = u.id
    WHERE j.status = 'archived'
    ORDER BY j.archived_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);

  const total = db.prepare("SELECT COUNT(*) as c FROM jobs WHERE status='archived'").get().c;
  res.json({ jobs, total, limit, offset });
});

// Восстановить задание из архива
router.put('/archive/:id/restore', adminMiddleware, (req, res) => {
  const job = db.prepare("SELECT * FROM jobs WHERE id = ? AND status = 'archived'").get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Задание не найдено в архиве' });

  db.prepare("UPDATE jobs SET status='completed', archived_at=NULL WHERE id=?").run(req.params.id);
  logEvent('admin.archive_restore', req.params.id, req.user.id, { original_name: job.original_name });
  res.json({ message: 'Задание восстановлено' });
});

// Удалить одно задание из архива навсегда
router.delete('/archive/:id', adminMiddleware, (req, res) => {
  const job = db.prepare("SELECT * FROM jobs WHERE id = ? AND status = 'archived'").get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Задание не найдено в архиве' });

  db.prepare('DELETE FROM jobs WHERE id = ?').run(req.params.id);
  logEvent('admin.archive_delete', req.params.id, req.user.id, { original_name: job.original_name });
  res.json({ message: 'Задание удалено навсегда' });
});

// Очистить архив старше N дней (по умолчанию 180)
router.post('/archive/cleanup', adminMiddleware, (req, res) => {
  const days = Math.min(Math.max(parseInt(req.body.days) || 180, 1), 365);

  const old = db.prepare(
    "SELECT id, original_name FROM jobs WHERE status='archived' AND archived_at < datetime('now', '-' || ? || ' days')"
  ).all(days);

  if (old.length === 0) return res.json({ deleted: 0, message: 'Нет заданий старше ' + days + ' дней' });

  db.prepare(
    "DELETE FROM jobs WHERE status='archived' AND archived_at < datetime('now', '-' || ? || ' days')"
  ).run(days);

  logEvent('admin.archive_cleanup', null, req.user.id, { deleted: old.length, days });
  res.json({ deleted: old.length, days });
});

module.exports = router;
module.exports.gpuGetStatus = gpuGetStatus;
module.exports.gpuDoAction = gpuDoAction;
