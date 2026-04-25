'use strict';
// routes/jobs.js v2.2 — PostgreSQL edition
// Updated: 2026-04-25
// v2.2: KB index-to-kb работает через enqueueIndex() из utils/qdrant.js;
//       заглушка 503 снята; добавлен GET /:id/kb-status;
//       переключено с melki_knowledge на QDRANT_COLLECTION (melki_knowledge_v2).
// v2.1: Qdrant indexing вынесен в utils/qdrant.js (общая очередь concurrency=1).
//       Локальные функции chunkText/sendToQdrant/sendChunkToQdrant удалены.

const express = require('express');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');

const { dbGet, dbAll, dbRun } = require('../db');
const { authMiddleware } = require('../middleware');
const { escapeHtml, logEvent, detectFileType, getTranscript } = require('../utils/helpers');
const { UPLOAD_PATH, RESULTS_PATH, QDRANT_HOST, QDRANT_PORT, QDRANT_COLLECTION } = require('../config');
const { enqueueIndex, getQueueSnapshot } = require('../utils/qdrant');

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
  const project = req.query.project || null;
  const params = [req.user.id];
  let pf = '';
  if (project) { pf = ' AND project = ?'; params.push(project); }
  const jobs = await dbAll(`
    SELECT id, original_name, status, progress, progress_msg, keep_days, created_at, completed_at,
           expires_at, rating, prompt_id, diarize, project,
           CASE WHEN result_txt IS NOT NULL THEN 1 ELSE 0 END as has_result
    FROM transcribe_jobs WHERE user_id = ? AND status != 'archived'${pf} ORDER BY created_at DESC
  `, params);
  res.json(jobs);
});



// ── Delete project from Qdrant ───────────────────────────────
function deleteProjectFromQdrant(username, projectName) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      filter: { must: [
        { key: 'username', match: { value: username } },
        { key: 'project',  match: { value: projectName } }
      ]}
    });
    const http = require('http');
    const req2 = http.request({
      hostname: QDRANT_HOST, port: QDRANT_PORT,
      path: `/collections/${QDRANT_COLLECTION}/points/delete`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(d)); });
    req2.on('error', resolve); // fire-and-forget
    req2.write(body); req2.end();
  });
}

// ===== PROJECTS (from Qdrant) =====
router.get('/projects', authMiddleware, async (req, res) => {
  try {
    const username = req.user.name || req.user.email;
    // Cleanup expired archives
    const expired = await dbAll(
      "SELECT project_name FROM archived_projects WHERE username=? AND delete_at<=NOW() AND deleted_at IS NULL",
      [username]);
    for (const row of expired) {
      await deleteProjectFromQdrant(username, row.project_name);
      await dbRun("UPDATE archived_projects SET deleted_at=NOW() WHERE username=? AND project_name=? AND deleted_at IS NULL", [username, row.project_name]);
    }
    const archivedRows = await dbAll(
      "SELECT project_name, delete_at FROM archived_projects WHERE username=? AND deleted_at IS NULL ORDER BY delete_at",
      [username]);
    const archivedNames = archivedRows.map(r => r.project_name);
    const deletedToday = await dbAll(
      "SELECT project_name FROM archived_projects WHERE username=? AND deleted_at >= NOW()-INTERVAL '24 hours'",
      [username]);
    const body = JSON.stringify({
      filter: { must: [{ key: 'username', match: { value: username } }] },
      with_payload: ['project'], with_vector: false, limit: 100
    });
    const http = require('http');
    const data = await new Promise((resolve, reject) => {
      const req2 = http.request({
        hostname: QDRANT_HOST, port: QDRANT_PORT,
        path: `/collections/${QDRANT_COLLECTION}/points/scroll`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, (r) => {
        let d = ''; r.on('data', c => d += c);
        r.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
      });
      req2.on('error', reject); req2.write(body); req2.end();
    });
    const pts = data.result?.points || [];
    const all = [...new Set(pts.map(p => p.payload?.project).filter(Boolean))].sort();
    const projects = all.filter(p => !archivedNames.includes(p));
    const now = Date.now();
    const notifications = archivedRows
      .map(r => ({ project: r.project_name, days_left: Math.ceil((new Date(r.delete_at)-now)/86400000) }))
      .filter(n => n.days_left <= 3);
    res.json({
      projects: projects.length ? projects : ['default'],
      notifications,
      deleted_today: deletedToday.map(r => r.project_name)
    });
  } catch (e) {
    console.error('[projects]', e.message);
    res.json({ projects: ['default'], notifications: [], deleted_today: [] });
  }
});

router.delete('/projects/:name', authMiddleware, async (req, res) => {
  try {
    const username = req.user.name || req.user.email;
    await deleteProjectFromQdrant(username, req.params.name);
    await dbRun("DELETE FROM archived_projects WHERE username=? AND project_name=?", [username, req.params.name]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/projects/:name/archive', authMiddleware, async (req, res) => {
  try {
    const username = req.user.name || req.user.email;
    const days = Math.min(Math.max(parseInt(req.body?.days)||14,1),90);
    const deleteAt = new Date(Date.now() + days*86400000).toISOString();
    await dbRun(
      "INSERT INTO archived_projects (username,project_name,delete_at) VALUES (?,?,?)",
      [username, req.params.name, deleteAt]);
    res.json({ ok: true, days });
  } catch(e) { res.status(500).json({ error: e.message }); }
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
router.get('/:id/download/docx-clean', authMiddleware, async (req, res) => {
  const job = await dbGet('SELECT * FROM transcribe_jobs WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!job) return res.status(404).json({ error: 'Задание не найдено' });
  if (!job.result_clean) return res.status(404).json({ error: 'Результат не готов' });
  try {
    const { Document, Packer, Paragraph, TextRun } = require('docx');
    const cleanText = job.result_clean
      .replace(/^(\u0413\u043e\u043b\u043e\u0441\s*\d+|SPEAKER_\w+):\s*/gm, '')
      .replace(/^(\u0413\u043e\u043b\u043e\u0441\s*\d+|SPEAKER_\w+)\s*\n/gm, '');
    const lines = cleanText.split('\n');
    const children = [];
    for (const line of lines) {
      children.push(new Paragraph({ children: [new TextRun({ text: line, size: 24, font: 'Arial' })] }));
    }
    const doc = new Document({ sections: [{ properties: {}, children }] });
    const buf = await Packer.toBuffer(doc);
    const baseName = require('path').basename(job.original_name, require('path').extname(job.original_name));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(baseName)}_clean.docx`);
    logEvent('job.downloaded', req.params.id, req.user.id, { format: 'docx-clean' }, 'web');
    res.send(buf);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id/download/:format', authMiddleware, async (req, res) => {
  const { id, format } = req.params;
  if (!['txt', 'srt', 'json', 'clean', 'docx-clean'].includes(format)) return res.status(400).json({ error: 'Неверный формат' });

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
  const username = req.user.name || req.user.email;
  const docId = `transcribe:${job.id}`;

  try {
    const result = await enqueueIndex({
      jobId:         job.id,
      source:        'transcribe',
      text,
      username,
      project,
      doc_id:        docId,
      original_name: job.original_name,
      created_at:    job.created_at,
    });

    await dbRun('UPDATE transcribe_jobs SET project = ? WHERE id = ?', [project, req.params.id]);

    logEvent('job.indexed_to_kb', req.params.id, req.user.id, {
      original_name: job.original_name, project, queue_position: result.position
    }, 'web');

    res.json({ ok: true, project, queued: true, position: result.position, duplicate: !!result.duplicate });
  } catch (e) {
    console.error('[index-to-kb]', e.message);
    res.status(500).json({ error: 'Ошибка постановки в очередь: ' + e.message });
  }
});

// ===== KB STATUS =====
router.get('/:id/kb-status', authMiddleware, async (req, res) => {
  const job = await dbGet(
    'SELECT id, kb_status, kb_chunks, kb_indexed_at, kb_error, project FROM transcribe_jobs WHERE id = ? AND user_id = ?',
    [req.params.id, req.user.id]
  );
  if (!job) return res.status(404).json({ error: 'Задание не найдено' });

  const queue = getQueueSnapshot();
  const positionInQueue = queue.queued_ids.indexOf(req.params.id);

  res.json({
    id: job.id,
    status: job.kb_status || 'none',
    chunks: job.kb_chunks,
    indexed_at: job.kb_indexed_at,
    error: job.kb_error,
    project: job.project,
    queue_position: positionInQueue >= 0 ? positionInQueue + 1 : null,
    queue_running: queue.running,
    queue_length: queue.queue_length,
  });
});

// ===== KB QUEUE (общий снапшот) =====
router.get('/kb-queue/status', authMiddleware, async (req, res) => {
  res.json(getQueueSnapshot());
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

module.exports = router;
