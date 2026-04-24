'use strict';
/**
 * gpu-pipeline.js v2.0 — PostgreSQL edition
 * Updated: 2026-04-24
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const { pool, pgify, dbGet, dbAll, dbRun } = require('../db');
const { logEvent, escapeHtml } = require('../utils/helpers');
const { sendEmail } = require('../utils/email');

const execAsync = promisify(exec);

// ═══════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════

const GPU_SSH_HOST    = process.env.GPU_SSH_HOST   || 'ubuntu@195.209.214.7';
const GPU_SSH_KEY     = process.env.GPU_SSH_KEY    || '/root/.ssh/id_ed25519';
const GPU_WORK_DIR    = process.env.GPU_WORK_DIR   || '/tmp/transcribe_batch';
const CALLBACK_SECRET = process.env.TRANSCRIBE_CALLBACK_SECRET || 'transcribe_cb_2026';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const APP_URL = process.env.APP_URL || 'https://transcribe.melki.top';
const UPLOAD_PATH = process.env.UPLOAD_PATH || '/data/uploads';
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const CHUNK_SIZE = 15000;

const SSH_OPTS = `-i ${GPU_SSH_KEY} -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o ServerAliveInterval=30`;

const GPU_UNSHELVE_TIMEOUT = 240000;
const GPU_SERVICES_TIMEOUT = 120000;
const JOB_TIMEOUT          = 7200000;
const SCP_TIMEOUT          = 600000;
const LAUNCH_TIMEOUT       = 300000;

// ═══════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════

let gpuBusy = false;
let currentJobId = null;
let currentSessionId = null;
let processedInSession = [];
let jobTimeoutTimer = null;
let launchTimeoutTimer = null;

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [pipeline] ${msg}`);
}

// ═══════════════════════════════════════════════════
// DB helpers (shorthand wrappers)
// ═══════════════════════════════════════════════════

async function setProgressMsg(jobId, msg, progress) {
  try {
    if (progress !== undefined) {
      await dbRun('UPDATE transcribe_jobs SET progress_msg=?, progress=? WHERE id=?', [msg, progress, jobId]);
    } else {
      await dbRun('UPDATE transcribe_jobs SET progress_msg=? WHERE id=?', [msg, jobId]);
    }
  } catch(_) {}
}

async function getJobWithUser(jobId) {
  return dbGet(
    'SELECT j.*, u.email, u.name FROM transcribe_jobs j JOIN transcribe_users u ON j.user_id=u.id WHERE j.id=?',
    [jobId]
  );
}

async function getJob(jobId) {
  return dbGet('SELECT * FROM transcribe_jobs WHERE id=?', [jobId]);
}

async function getQueued() {
  return dbGet(
    'SELECT j.*, u.email as user_email, u.name as user_name FROM transcribe_jobs j JOIN transcribe_users u ON j.user_id = u.id WHERE j.status=\'queued\' ORDER BY j.created_at ASC LIMIT 1'
  );
}

async function getNextQueued() {
  return dbGet("SELECT id FROM transcribe_jobs WHERE status='queued' ORDER BY created_at ASC LIMIT 1");
}

async function countQueued() {
  return dbGet("SELECT COUNT(*)::int as cnt FROM transcribe_jobs WHERE status='queued'");
}

// ═══════════════════════════════════════════════════
// GPU Management — reuse from admin.js
// ═══════════════════════════════════════════════════

let _adminModule = null;
function getAdmin() {
  if (!_adminModule) _adminModule = require('../routes/admin');
  return _adminModule;
}

async function gpuGetStatus() { return getAdmin().gpuGetStatus(); }
async function gpuDoAction(action) { return getAdmin().gpuDoAction(action); }

// ═══════════════════════════════════════════════════
// SSH / SCP helpers
// ═══════════════════════════════════════════════════

async function sshExec(cmd, timeout = 30000) {
  const full = `ssh ${SSH_OPTS} ${GPU_SSH_HOST} "${cmd.replace(/"/g, '\\"')}"`;
  try {
    const { stdout } = await execAsync(full, { timeout });
    return stdout.trim();
  } catch (e) {
    throw new Error(`SSH failed: ${e.message}`);
  }
}

async function scpTo(localPath, remotePath) {
  const cmd = `scp ${SSH_OPTS} "${localPath}" ${GPU_SSH_HOST}:${remotePath}`;
  await execAsync(cmd, { timeout: SCP_TIMEOUT });
}

async function scpFrom(remotePath, localPath) {
  const cmd = `scp -r ${SSH_OPTS} ${GPU_SSH_HOST}:${remotePath} "${localPath}"`;
  await execAsync(cmd, { timeout: SCP_TIMEOUT });
}

// ═══════════════════════════════════════════════════
// GPU lifecycle
// ═══════════════════════════════════════════════════

async function ensureGpuActive() {
  let status;
  try { status = await gpuGetStatus(); } catch (e) {
    throw new Error(`GPU status check failed: ${e.message}`);
  }
  log(`GPU status: ${typeof status === 'string' ? status : JSON.stringify(status)}`);
  const st = typeof status === 'string' ? status : (status?.status || 'UNKNOWN');

  if (st === 'ACTIVE') return;

  if (st.includes('SHELVED')) {
    log('Unshelving GPU...');
    await gpuDoAction('unshelve');
    const deadline = Date.now() + GPU_UNSHELVE_TIMEOUT;
    while (Date.now() < deadline) {
      await sleep(10000);
      try {
        const s = await gpuGetStatus();
        const cur = typeof s === 'string' ? s : (s?.status || '');
        log(`  GPU: ${cur}`);
        if (cur === 'ACTIVE') { await sleep(30000); return; }
      } catch (_) {}
    }
    throw new Error('GPU не проснулся за 4 минуты');
  }

  throw new Error(`Неизвестный статус GPU: ${st}`);
}

async function checkGpuServices() {
  const deadline = Date.now() + GPU_SERVICES_TIMEOUT;
  while (Date.now() < deadline) {
    try {
      const out = await sshExec('curl -s http://localhost:8002/health', 10000);
      if (out === 'ok') { log('GPU diarize: OK'); return; }
    } catch (_) {}
    log('  Diarize not ready, waiting...');
    await sleep(10000);
  }
  throw new Error('Diarize не ответил за 2 минуты');
}

async function shelveGpu() {
  try {
    const pending = await countQueued();
    if (pending.cnt > 0) { log(`Queue has ${pending.cnt} more jobs — GPU stays active`); return false; }
    log('Queue empty — shelving GPU');
    await gpuDoAction('shelve');
    logEvent('gpu.shelve', null, null, { trigger: 'pipeline_auto' }, 'pipeline');
    return true;
  } catch (e) {
    log(`Shelve error: ${e.message}`);
    return false;
  }
}

// ═══════════════════════════════════════════════════
// GPU session tracking
// ═══════════════════════════════════════════════════

async function gpuSessionStart() {
  const sid = uuidv4();
  currentSessionId = sid;
  processedInSession = [];
  try {
    await dbRun("INSERT INTO transcribe_gpu_sessions (id, unshelve_at, trigger_type, status) VALUES (?, NOW(), 'auto', 'active')", [sid]);
    log(`GPU session: ${sid.slice(0, 8)}`);
  } catch (e) {
    log(`Session start error: ${e.message}`);
  }
}

async function gpuSessionEnd() {
  if (!currentSessionId) return;
  try {
    await dbRun(
      `UPDATE transcribe_gpu_sessions SET
         shelve_at=NOW(),
         duration_sec=EXTRACT(EPOCH FROM (NOW() - unshelve_at)),
         jobs_count=$1, job_ids=$2,
         status='closed'
       WHERE id=$3`,
      [processedInSession.length, JSON.stringify(processedInSession), currentSessionId]
    );
    log(`GPU session closed: ${currentSessionId.slice(0, 8)}, jobs=${processedInSession.length}`);
  } catch (e) {
    log(`Session end error: ${e.message}`);
  }
  currentSessionId = null;
  processedInSession = [];
}

// ═══════════════════════════════════════════════════
// Queue management
// ═══════════════════════════════════════════════════

function enqueueJob(jobId) {
  log(`Enqueued: ${jobId}`);
  setTimeout(processQueue, 500);
}

async function processQueue() {
  if (gpuBusy) { log('GPU busy, queue check deferred'); return; }
  const job = await getQueued();
  if (!job) return;
  await startJob(job);
}

async function startJob(job) {
  gpuBusy = true;
  currentJobId = job.id;

  await dbRun("UPDATE transcribe_jobs SET status='processing', progress=0 WHERE id=?", [job.id]);
  logEvent('job.processing', job.id, job.user_id, { stage: 'gpu_pipeline' }, 'pipeline');
  log(`Starting: ${job.id} (${job.original_name})`);
  await setProgressMsg(job.id, 'Подготовка GPU...', 0);

  try {
    await ensureGpuActive();
    if (!currentSessionId) await gpuSessionStart();
    await setProgressMsg(job.id, 'Проверка сервисов GPU...', 5);

    await checkGpuServices();

    const localPath = path.join(UPLOAD_PATH, job.filename);
    if (!fs.existsSync(localPath)) throw new Error(`File not found: ${localPath}`);

    const remotePath = `${GPU_WORK_DIR}/${job.filename}`;
    await sshExec(`mkdir -p ${GPU_WORK_DIR}`, 10000);
    await setProgressMsg(job.id, 'Загрузка файла на GPU...', 10);
    log(`SCP → GPU: ${job.filename}`);
    await scpTo(localPath, remotePath);

    const resultDir = `/tmp/transcribe_results/${job.id}`;
    const callbackUrl = `${APP_URL}/api/internal/callback/transcribe/${job.id}`;

    let tCmd = `python3 /home/ubuntu/transcribe_gpu.py --input ${remotePath} --result-dir ${resultDir} --diarize ${job.diarize || 1}`;
    if (job.min_speakers) tCmd += ` --min-speakers ${job.min_speakers}`;
    if (job.max_speakers) tCmd += ` --max-speakers ${job.max_speakers}`;
    if (job.noise_filter) tCmd += ` --noise-filter ${job.noise_filter}`;

    const escapedCmd = tCmd.replace(/'/g, "'\\''");
    const escapedUrl = callbackUrl.replace(/'/g, "'\\''");
    const wrapperCmd = [
      'nohup python3 /opt/gpu-wrapper.py',
      `--job-id '${job.id}'`,
      `--service transcribe`,
      `--callback-url '${escapedUrl}'`,
      `--callback-secret '${CALLBACK_SECRET}'`,
      `--command '${escapedCmd}'`,
      `--result-dir '${resultDir}'`,
      '> /dev/null 2>&1 &',
    ].join(' ');

    await sshExec(wrapperCmd, 15000);
    log(`GPU wrapper launched for ${job.id}`);
    await setProgressMsg(job.id, job.diarize ? 'Диаризация...' : 'Транскрипция...', 15);
    logEvent('job.gpu_launched', job.id, job.user_id, {}, 'pipeline');

    if (launchTimeoutTimer) clearTimeout(launchTimeoutTimer);
    launchTimeoutTimer = setTimeout(() => handleLaunchTimeout(job.id).catch(e => log('launch timeout error: ' + e.message)), LAUNCH_TIMEOUT);

    if (jobTimeoutTimer) clearTimeout(jobTimeoutTimer);
    jobTimeoutTimer = setTimeout(() => handleTimeout(job.id).catch(e => log('job timeout error: ' + e.message)), JOB_TIMEOUT);

  } catch (e) {
    log(`Launch failed: ${e.message}`);
    await dbRun("UPDATE transcribe_jobs SET status='error', error=? WHERE id=?", [e.message, job.id]);
    logEvent('job.error', job.id, job.user_id, { error: e.message, stage: 'launch' }, 'pipeline');
    gpuBusy = false;
    currentJobId = null;
    setTimeout(processQueue, 5000);
  }
}

// ═══════════════════════════════════════════════════
// Callback handlers
// ═══════════════════════════════════════════════════

async function handleCallback(jobId, payload) {
  const { type } = payload;

  switch (type) {
    case 'started':
      log(`Callback started: ${jobId} (pid=${payload.pid})`);
      if (launchTimeoutTimer) { clearTimeout(launchTimeoutTimer); launchTimeoutTimer = null; }
      await dbRun("UPDATE transcribe_jobs SET status='processing' WHERE id=?", [jobId]);
      break;

    case 'progress':
      await dbRun(
        'UPDATE transcribe_jobs SET progress=?, progress_msg=? WHERE id=?',
        [payload.progress || 0, payload.message || 'Обработка...', jobId]
      );
      break;

    case 'done':
      log(`Callback done: ${jobId} (${payload.elapsed_sec}s)`);
      if (jobTimeoutTimer) { clearTimeout(jobTimeoutTimer); jobTimeoutTimer = null; }
      await handleDone(jobId, payload);
      break;

    case 'error':
      log(`Callback error: ${jobId} — ${payload.message}`);
      if (jobTimeoutTimer) { clearTimeout(jobTimeoutTimer); jobTimeoutTimer = null; }
      await handleError(jobId, payload);
      break;

    default:
      log(`Unknown callback type: ${type}`);
  }
}

async function handleDone(jobId, payload) {
  const job = await getJobWithUser(jobId);
  if (!job) { log(`Job not found: ${jobId}`); await finishJob(jobId); return; }

  try {
    const localResultDir = `/tmp/transcribe_results/${jobId}`;
    if (fs.existsSync(localResultDir)) fs.rmSync(localResultDir, { recursive: true, force: true });
    fs.mkdirSync('/tmp/transcribe_results', { recursive: true });

    const remoteResultDir = `/tmp/transcribe_results/${jobId}`;
    await scpFrom(remoteResultDir, '/tmp/transcribe_results/');
    log(`Results downloaded: ${jobId}`);

    const readFile = (name) => {
      const p = path.join(localResultDir, name);
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    };

    const resultClean = readFile('result_clean.txt');
    const resultSrt   = readFile('result_srt.txt');
    const resultJson  = readFile('result_json.txt');
    const metaRaw     = readFile('meta.json');

    let meta = {};
    try { meta = JSON.parse(metaRaw); } catch (_) {}

    await setProgressMsg(jobId, 'Генерация саммари...', 85);
    log(`Claude summary: ${jobId} (${resultClean.length} chars)`);
    const summary = await generateSummary(resultClean, job.prompt_text);
    const timestamp = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
    const resultTxt = `Обработано: ${timestamp}\n${'═'.repeat(60)}\n${summary}`;
    log(`Summary done: ${summary.length} chars`);

    await dbRun(
      "UPDATE transcribe_jobs SET status='completed', result_txt=?, result_srt=?, result_json=?, result_clean=?, duration_sec=?, completed_at=NOW(), progress=100 WHERE id=?",
      [resultTxt, resultSrt, resultJson, resultClean, meta.duration_sec || null, jobId]
    );
    await setProgressMsg(jobId, 'Готово', 100);

    logEvent('job.completed', jobId, job.user_id, {
      original_name: job.original_name,
      duration_sec: meta.duration_sec,
      processing_sec: meta.processing_sec,
      has_srt: !!resultSrt,
    }, 'pipeline');

    if (job.email) {
      sendEmail(job.email, 'Транскрипция готова!', `
        <h2>Привет, ${escapeHtml(job.name)}!</h2>
        <p>Транскрипция файла <b>${escapeHtml(job.original_name)}</b> готова.</p>
        <a href="${APP_URL}/dashboard" style="background:#4F46E5;color:white;padding:12px 24px;text-decoration:none;border-radius:6px;display:inline-block">Открыть результат</a>
        <p>Файл будет доступен ${job.keep_days} дней.</p>
      `).catch(e => log(`Email error: ${e.message}`));
    }

    log(`Job completed: ${jobId}`);
    try {
      sendToQdrant({ job_id: jobId, text: resultClean || resultTxt, source: 'transcribe', username: job.name, original_name: job.original_name, created_at: job.created_at });
    } catch(_e) { log('[qdrant] ' + _e.message); }

    fs.rmSync(localResultDir, { recursive: true, force: true });
    sshExec(`rm -rf ${remoteResultDir}`, 10000).catch(() => {});

  } catch (e) {
    log(`handleDone error: ${e.message}`);
    await dbRun("UPDATE transcribe_jobs SET status='error', error=? WHERE id=?", [`Post-processing: ${e.message}`, jobId]);
    logEvent('job.error', jobId, job.user_id, { error: e.message, stage: 'post_processing' }, 'pipeline');
  }

  await finishJob(jobId);
}

async function handleError(jobId, payload) {
  const job = await getJob(jobId);
  if (job) {
    await dbRun("UPDATE transcribe_jobs SET status='error', error=? WHERE id=?", [payload.message || 'GPU processing error', jobId]);
    logEvent('job.error', jobId, job.user_id, {
      error: payload.message,
      exit_code: payload.exit_code,
      elapsed_sec: payload.elapsed_sec,
    }, 'pipeline');
  }
  await finishJob(jobId);
}

async function handleLaunchTimeout(jobId) {
  log('LAUNCH TIMEOUT: ' + jobId);
  const job = await getJob(jobId);
  if (job && job.status === 'processing') {
    await dbRun("UPDATE transcribe_jobs SET status='error', error=? WHERE id=?", ['Launch timeout: GPU wrapper не ответил за 5 мин', jobId]);
    logEvent('job.error', jobId, job.user_id, { error: 'launch_timeout' }, 'pipeline');
  }
  await finishJob(jobId);
}

async function handleTimeout(jobId) {
  log(`TIMEOUT: ${jobId}`);
  const job = await getJob(jobId);
  if (job && job.status === 'processing') {
    await dbRun("UPDATE transcribe_jobs SET status='error', error=? WHERE id=?", ['Timeout: GPU не ответил', jobId]);
    logEvent('job.error', jobId, job.user_id, { error: 'timeout' }, 'pipeline');
  }
  await finishJob(jobId);
}

async function finishJob(jobId) {
  processedInSession.push(jobId);
  gpuBusy = false;
  currentJobId = null;

  const next = await getNextQueued();
  if (next) {
    log(`Next in queue: ${next.id}`);
    setTimeout(processQueue, 2000);
  } else {
    await gpuSessionEnd();
    await shelveGpu();
  }
}

// ═══════════════════════════════════════════════════
// Recovery
// ═══════════════════════════════════════════════════

async function recoverOnStartup() {
  try {
    const stuck = await dbAll("SELECT id FROM transcribe_jobs WHERE status='processing'");
    if (stuck.length > 0) {
      log(`Recovery: ${stuck.length} stuck jobs → queued`);
      await dbRun("UPDATE transcribe_jobs SET status='queued', progress=0 WHERE status='processing'");
      setTimeout(processQueue, 10000);
    }
  } catch (e) {
    log(`Recovery error: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════
// Claude API summary
// ═══════════════════════════════════════════════════

const DEFAULT_SYSTEM_PROMPT = `Ты — программа-конспектировщик аудиозаписей. Ты получаешь транскрипцию группового занятия по психологии и возвращаешь структурированный конспект.

Формат ответа:

Саммари:
[3-5 предложений — о чём запись в целом]

Ключевые темы:
- [тема 1]
- [тема 2]

Участники:
- [имена и роли, если упоминаются в записи]

Основные тезисы:
- [тезис 1]
- [тезис 2]

Правила:
- Пиши только конспект
- Не обращайся к собеседнику
- Сохраняй имена и факты точно
- Язык — русский`;

function smartSample(text) {
  const total = text.length;
  if (total <= CHUNK_SIZE * 3) return text;
  const start = text.slice(0, CHUNK_SIZE);
  const midPos = Math.floor(total / 2 - CHUNK_SIZE / 2);
  const middle = text.slice(midPos, midPos + CHUNK_SIZE);
  const end = text.slice(-CHUNK_SIZE);
  return '=== НАЧАЛО ЗАПИСИ ===\n' + start + '\n\n=== СЕРЕДИНА ЗАПИСИ ===\n' + middle + '\n\n=== КОНЕЦ ЗАПИСИ ===\n' + end;
}

async function generateSummary(cleanText, promptText) {
  if (!ANTHROPIC_API_KEY) return '(саммари не создано — нет ANTHROPIC_API_KEY)';
  if (!cleanText || cleanText.length < 50) return '(текст слишком короткий для саммари)';

  const sampled = smartSample(cleanText);
  log(`Claude API: ${cleanText.length} → ${sampled.length} символов`);
  const systemPrompt = promptText || DEFAULT_SYSTEM_PROMPT;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: 'user', content: `Составь конспект этой аудиозаписи:\n\n${sampled}` }],
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      log(`Claude HTTP ${response.status}: ${body.slice(0, 200)}`);
      return `(ошибка Claude API: HTTP ${response.status})`;
    }

    const data = await response.json();
    return data.content.filter(c => c.type === 'text').map(c => c.text).join('\n').trim() || '(пустой ответ Claude)';
  } catch (e) {
    log(`Claude error: ${e.message}`);
    return `(ошибка Claude API: ${e.message})`;
  }
}

// ═══════════════════════════════════════════════════
// Qdrant
// ═══════════════════════════════════════════════════

function chunkText(text, chunkSize = 2000, overlap = 200) {
  const chunks = [];
  let start = 0;
  const t = (text || '').trim();
  while (start < t.length) {
    let end = Math.min(start + chunkSize, t.length);
    if (end < t.length) {
      const nlIdx  = t.lastIndexOf('\n', end);
      const dotIdx = t.lastIndexOf('. ', end);
      const brk    = Math.max(nlIdx, dotIdx);
      if (brk > start + chunkSize * 0.4) end = brk + 1;
    }
    const chunk = t.slice(start, end).trim();
    if (chunk.length > 50) chunks.push(chunk);
    start = end - overlap;
    if (start >= t.length) break;
  }
  return chunks;
}

function sendChunkToQdrant({ job_id, chunk, chunk_idx, total_chunks, source, username, original_name, created_at }) {
  const body = JSON.stringify({
    job_id: String(job_id), text: chunk, chunk_idx, total_chunks,
    source, username: username || 'unknown',
    original_name: original_name || '',
    created_at: created_at || new Date().toISOString(),
  });
  const http = require('http');
  const req = http.request({
    hostname: 'n8n', port: 5678, path: '/webhook/qdrant-index', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    timeout: 10000,
  }, (r) => { r.resume(); });
  req.on('error', () => {});
  req.write(body); req.end();
}

function sendToQdrant({ job_id, text, source, username, original_name, created_at }) {
  const chunks = chunkText(text);
  if (!chunks.length) return;
  chunks.forEach((chunk, i) => {
    setTimeout(() => {
      sendChunkToQdrant({ job_id, chunk, chunk_idx: i, total_chunks: chunks.length, source, username, original_name, created_at });
    }, i * 300);
  });
  log(`[qdrant] ${source}#${job_id}: ${chunks.length} chunks queued`);
}

// ═══════════════════════════════════════════════════
// Utils
// ═══════════════════════════════════════════════════

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function getCallbackSecret() { return CALLBACK_SECRET; }
function isGpuBusy() { return gpuBusy; }

module.exports = { enqueueJob, processQueue, handleCallback, recoverOnStartup, getCallbackSecret, isGpuBusy };
