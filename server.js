// Студия Транскрибации — server.js v2.0 (PostgreSQL)
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message);
  console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
});
'use strict';
// Version: 2.0.0 (PostgreSQL)
// Updated: 2026-04-24

const express = require('express');
const path = require('path');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const { pool, dbGet, dbRun, initDb } = require('./db');
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
app.use('/api',          require('./routes/internal'));

// ===== HEALTH & VERSION =====
app.get('/api/version', (req, res) => res.json({
  version: '2.0.0', node: process.version, uptime_s: Math.floor(process.uptime())
}));

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    const pending    = await dbGet("SELECT COUNT(*)::int as c FROM transcribe_jobs WHERE status='pending'");
    const processing = await dbGet("SELECT COUNT(*)::int as c FROM transcribe_jobs WHERE status='processing'");
    const queued     = await dbGet("SELECT COUNT(*)::int as c FROM transcribe_jobs WHERE status='queued'");
    res.json({ ok: true, version: '2.0.0', uptime_s: Math.floor(process.uptime()), db: true,
               queue: { queued: queued.c, pending: pending.c, processing: processing.c } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ===== GPU STATUS =====
const { adminMiddleware } = require('./middleware');
const { gpuGetStatus, gpuDoAction } = require('./routes/admin');

app.get('/api/gpu/status', adminMiddleware, async (req, res) => {
  try { res.json({ ok: true, status: await gpuGetStatus() }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
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
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ===== CLEANUP =====
async function cleanupExpiredJobs() {
  try {
    const expired = await pool.query(
      "SELECT * FROM transcribe_jobs WHERE expires_at < NOW() AND status IN ('completed','error') AND status!='archived'"
    );
    for (const job of expired.rows) {
      const filePath = require('path').join(UPLOAD_PATH, require('path').basename(job.filename));
      if (filePath.startsWith(UPLOAD_PATH) && require('fs').existsSync(filePath)) require('fs').unlinkSync(filePath);
      await pool.query("UPDATE transcribe_jobs SET status='archived', archived_at=NOW() WHERE id=$1", [job.id]);
      console.log(`Soft-deleted expired job: ${job.id}`);
    }
  } catch (e) {
    console.error('[cleanup]', e.message);
  }
}
setInterval(cleanupExpiredJobs, 60 * 60 * 1000);

// ===== STUCK JOBS =====
async function checkStuckJobs() {
  try {
    const stuck = await pool.query(
      "SELECT * FROM transcribe_jobs WHERE status IN ('processing', 'pending', 'queued') AND created_at < NOW() - INTERVAL '12 hours'"
    );
    if (stuck.rows.length === 0) return;

    for (const job of stuck.rows) {
      await pool.query(
        "UPDATE transcribe_jobs SET status='error', error='Таймаут: задание зависло (>12ч)', completed_at=NOW() WHERE id=$1",
        [job.id]
      );
      console.warn(`[STUCK] Job ${job.id} (${job.original_name}) → error (timeout)`);
      logEvent('job.stuck', job.id, job.user_id, { original_name: job.original_name }, 'system');
    }

    const adminUser = await dbGet("SELECT email FROM transcribe_users WHERE role='admin' LIMIT 1");
    if (adminUser) {
      const list = stuck.rows.map(j =>
        `<li><b>${escapeHtml(j.original_name)}</b> — создан ${j.created_at}, статус: ${j.status}</li>`
      ).join('');
      sendEmail(
        adminUser.email,
        `⚠️ Студия: ${stuck.rows.length} зависш${stuck.rows.length === 1 ? 'ее задание' : 'их заданий'}`,
        `<p>Следующие задания зависли более 12 часов:</p><ul>${list}</ul>
         <p><a href="${APP_URL}/admin">Открыть админку</a></p>`
      );
    }
  } catch (e) {
    console.error('[stuck-check]', e.message);
  }
}
setInterval(checkStuckJobs, 10 * 60 * 1000);

// ===== BOOTSTRAP =====
async function bootstrap() {
  await initDb();

  // Create default admin if not exists
  const adminExists = await dbGet("SELECT id FROM transcribe_users WHERE role='admin'");
  if (!adminExists) {
    const adminId = uuidv4();
    const adminPassword = await bcrypt.hash('admin123', 10);
    await pool.query(
      "INSERT INTO transcribe_users (id, email, password, name, role, active) VALUES ($1, $2, $3, $4, 'admin', 1)",
      [adminId, ADMIN_EMAIL || 'admin@melki.top', adminPassword, 'Администратор']
    );
    console.log('Default admin created: admin@melki.top / admin123');
    console.log('CHANGE THE PASSWORD IMMEDIATELY!');
  }

  checkStuckJobs();

  const server = app.listen(PORT, () => {
    console.log(`Transcribe Studio v2.0.0 (PostgreSQL) running on port ${PORT}`);
  });

  process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down...');
    server.close(() => {
      pool.end();
      process.exit(0);
    });
  });
}

bootstrap().catch(e => {
  console.error('[FATAL] Bootstrap failed:', e.message);
  process.exit(1);
});
