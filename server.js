// Студия Транскрибации — server.js (модульный)
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message);
  console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
});
'use strict';
// Version: 1.9.8
// Updated: 2026-04-15


const express = require('express');
const path = require('path');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const { db } = require('./db');
const { escapeHtml, logEvent } = require('./utils/helpers');
const { sendEmail } = require('./utils/email');
const { PORT, UPLOAD_PATH, RESULTS_PATH, APP_URL, ADMIN_EMAIL } = require('./config');

// ===== EXPRESS APP =====
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    console.error('[body-parser] Invalid JSON from', req.ip, req.path);
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  next(err);
});
app.set('trust proxy', 1);
app.use(express.static(path.join(__dirname, 'public')));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use('/api/', limiter);

// ===== ROUTES =====
app.use('/api/auth',     require('./routes/auth'));
app.use('/api/prompts',  require('./routes/prompts'));
app.use('/api/jobs',     require('./routes/jobs'));
app.use('/api/internal', require('./routes/internal'));
app.use('/api/admin',    require('./routes/admin'));

// Legacy path: /api/webhook/result (internal router handles /webhook/result)
app.use('/api', require('./routes/internal'));

// ===== HEALTH & VERSION =====
app.get('/api/version', (req, res) => res.json({
  version: '1.9.10', node: process.version, uptime_s: Math.floor(process.uptime())
}));

app.get('/api/health', (req, res) => {
  try {
    const dbOk = !!db.prepare('SELECT 1').get();
    const pending    = db.prepare("SELECT COUNT(*) as c FROM jobs WHERE status='pending'").get().c;
    const processing = db.prepare("SELECT COUNT(*) as c FROM jobs WHERE status='processing'").get().c;
    const queued     = db.prepare("SELECT COUNT(*) as c FROM jobs WHERE status='queued'").get().c;
    res.json({ ok: true, version: '1.9.10', uptime_s: Math.floor(process.uptime()), db: dbOk, queue: { queued, pending, processing } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ===== GPU STATUS (backward-compatible /api/gpu/* paths) =====
const { adminMiddleware } = require('./middleware');
const { gpuGetStatus, gpuDoAction } = require('./routes/admin');

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

// ===== CLEANUP =====
function cleanupExpiredJobs() {
  const expired = db.prepare("SELECT * FROM jobs WHERE expires_at < datetime('now') AND status IN ('completed','error') AND status!='archived'").all();
  expired.forEach(job => {
    const filePath = path.join(UPLOAD_PATH, path.basename(job.filename));
    if (filePath.startsWith(UPLOAD_PATH) && require('fs').existsSync(filePath)) require('fs').unlinkSync(filePath);
    db.prepare('DELETE FROM jobs WHERE id = ?').run(job.id);
    console.log(`Cleaned up expired job: ${job.id}`);
  });
}
setInterval(cleanupExpiredJobs, 60 * 60 * 1000);

// ===== STUCK JOBS =====
function checkStuckJobs() {
  const twoHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString().replace('T',' ').replace('Z','');
  const stuck = db.prepare(`
    SELECT * FROM jobs WHERE status IN ('processing', 'pending', 'queued') AND created_at < ?
  `).all(twoHoursAgo);

  if (stuck.length === 0) return;

  stuck.forEach(job => {
    db.prepare(`UPDATE jobs SET status='error', error='Таймаут: задание зависло (>12ч)', completed_at=datetime('now') WHERE id=?`).run(job.id);
    console.warn(`[STUCK] Job ${job.id} (${job.original_name}) → error (timeout)`);
    logEvent('job.stuck', job.id, job.user_id, { original_name: job.original_name }, 'system');
  });

  const adminUser = db.prepare("SELECT email FROM users WHERE role='admin' LIMIT 1").get();
  if (adminUser) {
    const list = stuck.map(j =>
      `<li><b>${escapeHtml(j.original_name)}</b> — создан ${j.created_at}, статус был: ${j.status}</li>`
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
setInterval(checkStuckJobs, 10 * 60 * 1000);
checkStuckJobs();

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

// ===== START =====
const server = app.listen(PORT, () => {
  console.log(`Transcribe Studio v1.9.6 running on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  server.close(() => {
    db.close();
    process.exit(0);
  });
});
