'use strict';
// routes/jobs.js v2.0 — PostgreSQL edition
// Updated: 2026-04-24

const express = require('express');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');

const { dbGet, dbAll, dbRun } = require('../db');
const { authMiddleware } = require('../middleware');
const { escapeHtml, logEvent, detectFileType, getTranscript } = require('../utils/helpers');
const { UPLOAD_PATH, RESULTS_PATH } = require('../config');

const router = express.Router();

// ===== GPU PIPELINE =====
let pipeline = null;
function getPipeline() {
  if (!pipeline) {
    pipeline = require('../utils/gpu-pipeline');
    pipeline.recoverOnStartup();
  }
  return pipeline;
}
setTimeout(() => { try { getPipeline(); } catch (_) {} }, 5000);

// ===== MULTER =====
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_PATH),
  filename: (req, file, cb) => {
    const decodedName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const ext = path.extname(decodedName).toLowerCase().replace(/[^a-z0-9.]/g, '');
    cb(null, uuidv4() + (ext || '.bin'));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 3 * 1024 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(mp4|mp3|wav|m4a|avi|mov|mkv|webm|ogg|flac|aac|wma)$/i;
    const decodedName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    if (allowed.test(decodedName)) cb(null, true);
    else cb(new Error('Неподдерживаемый формат файла'));
  }
});

// ===== UPLOAD =====
router.post('/upload', authMiddleware, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });

  const realType = detectFileType(req.file.path);
  if (realType === 'unknown') {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'Файл повреждён или имеет неподдерживаемый формат.' });
  }

  if (realType === 'video') {
    const userRow = await dbGet('SELECT video_limit_mb FROM transcribe_users WHERE id = ?', [req.user.id]);
    const limitMb = (userRow && userRow.video_limit_mb) || 200;
    const fileMb = req.file.size / (1024 * 1024);
    if (fileMb > limitMb) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: `Видеофайл слишком большой (${Math.round(fileMb)} МБ). Максимум: ${limitMb} МБ.` });
    }
  }

  const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  const keepDays = Math.min(Math.max(parseInt(req.body.keep_days) || 7, 1), 90);
  const jobId = uuidv4();
  const expiresAt = new Date(Date.now() + keepDays * 24 * 60 * 60 * 1000).toISOString();
  const diarize = req.body.diarize === '1' ? 1 : 0;
  const minSpeakers = req.body.min_speakers ? parseInt(req.body.min_speakers) : null;
  const maxSpeakers = req.body.max_speakers ? parseInt(req.body.max_speakers) : null;
  const noiseFilter = req.body.noise_filter || null;

  let promptId = req.body.prompt_id || null;
  let promptText = null;

  if (promptId) {
    const prompt = await dbGet(
      'SELECT * FROM transcribe_prompts WHERE id = ? AND (is_system = 1 OR user_id = ?)',
      [promptId, req.user.id]
    );
    if (prompt) {
      promptText = prompt.prompt_text;
    } else {
      promptId = null;
    }
  }

  if (!promptText) {
    const defaultPrompt = await dbGet(
      'SELECT * FROM transcribe_prompts WHERE is_default = 1 AND is_system = 1 LIMIT 1'
    );
    if (defaultPrompt) {
      promptId = defaultPrompt.id;
      promptText = defaultPrompt.prompt_text;
    }
  }

  await dbRun(`
    INSERT INTO transcribe_jobs
      (id, user_id, filename, original_name, keep_days, expires_at, status,
       prompt_id, prompt_text, diarize, min_speakers, max_speakers, noise_filter)
    VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)
  `, [jobId, req.user.id, req.file.filename, originalName, keepDays, expiresAt,
      promptId, promptText, diarize, minSpeakers || null, maxSpeakers || null, noiseFilter]);

  processJob(jobId, req.file.filename, req.file.path).catch(console.error);

  logEvent('job.uploaded', jobId, req.user.id, {
    original_name: req.file.originalname,
    size_mb: Math.round(req.file.size / 1024 / 1024 * 10) / 10,
    diarize,
    min_speakers: minSpeakers,
    prompt_id: promptId
  });
  res.json({ jobId, message: 'Файл загружен и поставлен в очередь' });
});

async function processJob(jobId, filename, filePath) {
  try {
    getPipeline().enqueueJob(jobId);
    console.log(`[jobs] ${jobId}: enqueued for GPU pipeline`);
  } catch (e) {
    console.error(`[jobs] Pipeline error for ${jobId}: ${e.message}`);
    await dbRun("UPDATE transcribe_jobs SET status='error', error=? WHERE id=?", [e.message, jobId]);
  }
}

// ===== LIST / GET =====
router.get('/', authMiddleware, async (req, res) => {
  const jobs = await dbAll(`
    SELECT id, original_name, status, progress, progress_msg, keep_days, created_at, completed_at,
           expires_at, rating, prompt_id, diarize,
           CASE WHEN result_txt IS NOT NULL THEN 1 ELSE 0 END as has_result
    FROM transcribe_jobs WHERE user_id = ? AND status != 'archived' ORDER BY created_at DESC
  `, [req.user.id]);
  res.json(jobs);
});


// ===== PROJECTS (from Qdrant) =====
router.get('/projects', authMiddleware, async (req, res) => {
  try {
    const username = req.user.name || req.user.email;
    const body = JSON.stringify({
      filter: { must: [{ key: 'username', match: { value: username } }] },
      with_payload: ['project'],
      limit: 1000
    });
    const http = require('http');
    const data = await new Promise((resolve, reject) => {
      const req2 = http.request({
        hostname: 'qdrant', port: 6333,
        path: '/collections/melki_knowledge/points/scroll',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, (r) => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
      });
      req2.on('error', reject);
      req2.write(body);
      req2.end();
    });
    const pts = data.result?.points || [];
    const projects = [...new Set(pts.map(p => p.payload?.project).filter(Boolean))].sort();
    res.json({ projects: projects.length ? projects : ['default'] });
  } catch (e) {
    console.error('[projects]', e.message);
    res.json({ projects: ['default'] });
  }
});

router.get('/:id', authMiddleware, async (req, res) => {
  const job = await dbGet('SELECT * FROM transcribe_jobs WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!job) return res.status(404).json({ error: 'Задание не найдено' });
  res.json(job);
});

// ===== RATING =====
router.put('/:id/rating', authMiddleware, async (req, res) => {
  const rating = parseInt(req.body.rating);
  if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Оценка должна быть от 1 до 5' });

  const job = await dbGet('SELECT * FROM transcribe_jobs WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!job) return res.status(404).json({ error: 'Задание не найдено' });
  if (job.status !== 'completed') return res.status(400).json({ error: 'Можно оценить только завершённое задание' });

  await dbRun('UPDATE transcribe_jobs SET rating = ? WHERE id = ?', [rating, req.params.id]);
  res.json({ ok: true, rating });
});

// ===== DOWNLOAD: MD =====
router.get('/:id/download/md', authMiddleware, async (req, res) => {
  const job = await dbGet('SELECT * FROM transcribe_jobs WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!job) return res.status(404).json({ error: 'Задание не найдено' });
  if (!job.result_txt && !job.result_clean && !job.result_srt) return res.status(404).json({ error: 'Результат не готов' });

  const summary = job.result_txt ? job.result_txt.split('\n---\n')[0].trim() : '';
  const transcript = getTranscript(job);

  let content = '';
  if (summary) content += summary;
  if (summary && transcript) content += '\n\n═══════════════════════════════════════\n\n';
  if (transcript) content += transcript;

  const baseName = path.basename(job.original_name, path.extname(job.original_name));
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(baseName)}.md`);
  res.send(content);
});

// ===== DOWNLOAD: DOCX =====
router.get('/:id/download/docx', authMiddleware, async (req, res) => {
  const job = await dbGet('SELECT * FROM transcribe_jobs WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!job) return res.status(404).json({ error: 'Задание не найдено' });
  if (!job.result_txt && !job.result_clean && !job.result_srt) return res.status(404).json({ error: 'Результат не готов' });

  const summary = job.result_txt ? job.result_txt.split('\n---\n')[0].trim() : '';
  const transcript = getTranscript(job);

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
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(baseName + '_clean')}.docx`);
    res.send(buffer);
  } catch (e) {
    console.error('[DOCX-CLEAN]', e.message);
    res.status(500).json({ error: 'Ошибка генерации DOCX: ' + e.message });
  }
});

// ===== DOWNLOAD: TXT / SRT / JSON =====
router.get('/:id/download/:format', authMiddleware, async (req, res) => {
  const { id, format } = req.params;
  if (!['txt', 'srt', 'json'].includes(format)) return res.status(400).json({ error: 'Неверный формат' });

  const job = await dbGet('SELECT * FROM transcribe_jobs WHERE id = ? AND user_id = ?', [id, req.user.id]);
  if (!job) return res.status(404).json({ error: 'Задание не найдено' });

  const baseName = path.basename(job.original_name, path.extname(job.original_name));
  const safeAscii = baseName.replace(/[^\x20-\x7E]/g, '_');
  const encodedBase = encodeURIComponent(baseName);

  const content = job[`result_${format}`];
  if (!content) return res.status(404).json({ error: 'Результат не готов' });
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safeAscii}.${format}"; filename*=UTF-8''${encodedBase}.${format}`);
  logEvent('job.downloaded', id, req.user.id, { format }, 'web');
  res.send(content);
});

// ===== REPROCESS =====
router.put('/:id/reprocess', authMiddleware, async (req, res) => {
  const job = await dbGet('SELECT * FROM transcribe_jobs WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!job) return res.status(404).json({ error: 'Задание не найдено' });
  if (!['error', 'processing'].includes(job.status)) {
    return res.status(400).json({ error: 'Можно переобработать только задания со статусом "ошибка" или "обработка"' });
  }

  const filePath = path.join(UPLOAD_PATH, path.basename(job.filename));
  if (!filePath.startsWith(UPLOAD_PATH) || !fs.existsSync(filePath)) {
    return res.status(400).json({ error: 'Аудиофайл не найден на сервере. Переобработка невозможна.' });
  }

  await dbRun(
    "UPDATE transcribe_jobs SET status='queued', error=NULL, progress=0, completed_at=NULL, result_txt=NULL, result_srt=NULL, result_json=NULL, result_clean=NULL WHERE id=?",
    [req.params.id]
  );
  logEvent('job.reprocess', req.params.id, req.user.id, { original_name: job.original_name });

  try { getPipeline().enqueueJob(req.params.id); } catch (e) { console.error(`[reprocess] Pipeline error: ${e.message}`); }

  res.json({ ok: true, message: 'Задание поставлено на переобработку' });
});

// ===== INDEX TO KNOWLEDGE BASE =====
router.post('/:id/index-to-kb', authMiddleware, async (req, res) => {
  const job = await dbGet('SELECT * FROM transcribe_jobs WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!job) return res.status(404).json({ error: 'Задание не найдено' });
  if (job.status !== 'completed') return res.status(400).json({ error: 'Задание не завершено' });

  const text = job.result_clean || job.result_txt || '';
  if (!text.trim()) return res.status(400).json({ error: 'Нет текстового результата' });

  const project = (req.body && req.body.project || 'default').trim() || 'default';

  sendToQdrant({
    job_id:        String(job.id),
    text,
    source:        'transcribe',
    username:      req.user.name || req.user.email,
    project,
    original_name: job.original_name,
    created_at:    job.created_at,
  });

  logEvent('job.indexed_to_kb', req.params.id, req.user.id, { original_name: job.original_name, project }, 'web');
  res.json({ ok: true, project });
});

// ===== DELETE =====
router.delete('/:id', authMiddleware, async (req, res) => {
  const job = await dbGet('SELECT * FROM transcribe_jobs WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!job) return res.status(404).json({ error: 'Задание не найдено' });

  const filePath = path.join(UPLOAD_PATH, path.basename(job.filename));
  if (filePath.startsWith(UPLOAD_PATH) && fs.existsSync(filePath)) fs.unlinkSync(filePath);

  await dbRun("UPDATE transcribe_jobs SET status='archived', archived_at=NOW() WHERE id=?", [req.params.id]);
  logEvent('job.archived', req.params.id, req.user.id, { original_name: job.original_name });
  res.json({ message: 'Задание удалено' });
});

// ── Qdrant helpers ────────────────────────────────────────────
function chunkText(text, chunkSize = 2000, overlap = 200) {
  const chunks = [];
  let start = 0;
  const t = text.trim();
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

function sendChunkToQdrant({ job_id, chunk, chunk_idx, total_chunks, source, username, project, original_name, created_at }) {
  const body = JSON.stringify({
    job_id: String(job_id), text: chunk, chunk_idx, total_chunks,
    source, username: username || 'unknown',
    project: project || 'default',
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

function sendToQdrant({ job_id, text, source, username, project, original_name, created_at }) {
  const chunks = chunkText(text || '');
  if (!chunks.length) return;
  chunks.forEach((chunk, i) => {
    setTimeout(() => {
      sendChunkToQdrant({ job_id, chunk, chunk_idx: i, total_chunks: chunks.length,
                          source, username, project, original_name, created_at });
    }, i * 300);
  });
  console.log(`[qdrant] ${source}#${job_id}: ${chunks.length} chunks queued`);
}

module.exports = router;
