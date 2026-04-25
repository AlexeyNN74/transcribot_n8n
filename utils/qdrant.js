'use strict';
/**
 * utils/qdrant.js v2.0 — Knowledge Base индексация и поиск
 * Updated: 2026-04-25
 *
 * Архитектура (Этап 1+2, чат #32):
 *  - QdrantClient — singleton, через @qdrant/js-client-rest
 *  - EmbeddingProvider — фабрика
 *      - CpuEmbedder — bge-m3 INT8 через @huggingface/transformers
 *                      lazy + autounload через 30 мин простоя
 *      - GpuEmbedder — заглушка throw, реализуется в Этапе 3
 *  - In-memory FIFO worker — concurrency=1 (нельзя параллельно — два embed съедят 1.6 ГБ RAM)
 *  - recoverOnStartup() — задачи в pending/indexing → в очередь после рестарта
 *  - При переиндексации — сначала удалить чанки документа по doc_id, потом записать новые
 *
 * Никаких setTimeout-каскадов. Никаких автомaтических индексаций без явного запроса.
 */

const { QdrantClient } = require('@qdrant/js-client-rest');
const { v5: uuidv5 } = require('uuid');

const {
  QDRANT_HOST, QDRANT_PORT, QDRANT_COLLECTION,
  EMBED_MODEL, EMBED_QUANTIZATION, EMBED_VECTOR_SIZE,
  EMBED_AUTOUNLOAD_MS, EMBED_CACHE_DIR,
  KB_CHUNK_SIZE, KB_CHUNK_OVERLAP,
} = require('../config');

const { dbAll, dbRun, dbGet } = require('../db');

// ═══════════════════════════════════════════════════
// Утилиты
// ═══════════════════════════════════════════════════

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [qdrant] ${msg}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function sanitizeText(s) {
  // Удаляем управляющие символы, иначе Qdrant вернёт "Bad control character in JSON"
  return (s || '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

function chunkText(text, chunkSize = KB_CHUNK_SIZE, overlap = KB_CHUNK_OVERLAP) {
  const chunks = [];
  const t = sanitizeText((text || '').trim());
  if (!t) return chunks;
  let start = 0;
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
    if (end >= t.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

// Стабильный UUID для точки в Qdrant — детерминированный по (doc_id, chunk_idx)
// (Qdrant требует UUID или uint64; uuidv5 генерирует одинаковый UUID для одних и тех же входов)
const POINT_ID_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8'; // фиксированный namespace
function pointIdFor(docId, chunkIdx) {
  return uuidv5(`${docId}::${chunkIdx}`, POINT_ID_NAMESPACE);
}

// ═══════════════════════════════════════════════════
// Qdrant client (singleton)
// ═══════════════════════════════════════════════════

let _qdrant = null;
function qdrant() {
  if (!_qdrant) {
    _qdrant = new QdrantClient({
      host: QDRANT_HOST,
      port: QDRANT_PORT,
      checkCompatibility: false,
    });
  }
  return _qdrant;
}

async function ensureCollection() {
  const client = qdrant();
  let exists = false;
  try {
    const list = await client.getCollections();
    exists = (list.collections || []).some(c => c.name === QDRANT_COLLECTION);
  } catch (e) {
    log(`getCollections failed: ${e.message}`);
    throw e;
  }

  if (!exists) {
    log(`Creating collection ${QDRANT_COLLECTION} (size=${EMBED_VECTOR_SIZE}, distance=Cosine)`);
    await client.createCollection(QDRANT_COLLECTION, {
      vectors: { size: EMBED_VECTOR_SIZE, distance: 'Cosine' },
      on_disk_payload: true,
    });
  }

  // Payload-индексы (идемпотентно — повторное создание возвращает 200)
  for (const field of ['username', 'project', 'source', 'doc_id']) {
    try {
      await client.createPayloadIndex(QDRANT_COLLECTION, {
        field_name: field,
        field_schema: 'keyword',
      });
    } catch (e) {
      // 400 = уже существует, игнорируем
      if (!(e.status === 400 || /already exists/i.test(e.message || ''))) {
        log(`createPayloadIndex(${field}) failed: ${e.message}`);
      }
    }
  }
}

// ═══════════════════════════════════════════════════
// EmbeddingProvider
// ═══════════════════════════════════════════════════

class EmbeddingProvider {
  async embed(texts) { throw new Error('Not implemented'); }
}

class CpuEmbedder extends EmbeddingProvider {
  constructor() {
    super();
    this.pipe = null;
    this.lastUsed = 0;
    this.unloadTimer = null;
    this.loading = null; // Promise защиты от конкурентной загрузки
  }

  async _load() {
    if (this.pipe) return this.pipe;
    if (this.loading) return this.loading;

    this.loading = (async () => {
      const t0 = Date.now();
      log(`Loading embedding model: ${EMBED_MODEL} (quantization=${EMBED_QUANTIZATION})`);

      // Lazy import — модуль большой, грузим только при первой индексации
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = EMBED_CACHE_DIR;
      env.allowLocalModels = true;
      env.allowRemoteModels = true;

      // dtype: 'q8' = INT8 квантизация, ~600 МБ для bge-m3
      this.pipe = await pipeline('feature-extraction', EMBED_MODEL, {
        dtype: EMBED_QUANTIZATION,
      });

      log(`Embedding model loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return this.pipe;
    })();

    try {
      return await this.loading;
    } finally {
      this.loading = null;
    }
  }

  _scheduleUnload() {
    if (this.unloadTimer) clearTimeout(this.unloadTimer);
    this.unloadTimer = setTimeout(() => {
      const idleMs = Date.now() - this.lastUsed;
      if (idleMs >= EMBED_AUTOUNLOAD_MS && this.pipe) {
        log(`Embedding model idle for ${Math.round(idleMs / 1000)}s — unloading`);
        this.pipe = null;
        if (global.gc) global.gc();
      }
    }, EMBED_AUTOUNLOAD_MS + 5000);
    this.unloadTimer.unref?.();
  }

  async embed(texts) {
    const arr = Array.isArray(texts) ? texts : [texts];
    if (!arr.length) return [];

    await this._load();
    this.lastUsed = Date.now();
    this._scheduleUnload();

    // Делаем по одному — bge-m3 на CPU INT8: ~250-500 мс на чанк ~2000 символов
    const out = [];
    for (const t of arr) {
      const result = await this.pipe(t, { pooling: 'mean', normalize: true });
      out.push(Array.from(result.data));
    }
    return out;
  }
}

class GpuEmbedder extends EmbeddingProvider {
  async embed(_texts) {
    throw new Error('GpuEmbedder не реализован — будет добавлен в Этапе 3 (two-tier indexing)');
  }
}

// Singleton провайдер
let _embedder = null;
function getEmbedder() {
  if (!_embedder) _embedder = new CpuEmbedder();
  return _embedder;
}

// ═══════════════════════════════════════════════════
// In-memory FIFO worker (concurrency=1)
// ═══════════════════════════════════════════════════

const _queue = []; // массив { jobId, source, ... }
let _running = false;

function getQueueSnapshot() {
  return {
    running: _running,
    queue_length: _queue.length,
    queued_ids: _queue.map(j => j.jobId),
  };
}

async function _processOne(task) {
  const { jobId } = task;
  const source = task.source || 'transcribe';
  const docId = task.doc_id || `${source}:${jobId}`;

  log(`indexing ${docId} (project=${task.project})`);
  const t0 = Date.now();

  try {
    // 1) Чанкование
    const chunks = chunkText(task.text);
    if (!chunks.length) {
      log(`${docId}: empty text, marking 'none'`);
      await dbRun(
        "UPDATE transcribe_jobs SET kb_status='error', kb_error=?, kb_chunks=0 WHERE id=?",
        ['Пустой текст', jobId]
      );
      return;
    }

    // 2) Удалить старые чанки этого документа (если переиндексация)
    try {
      await qdrant().delete(QDRANT_COLLECTION, {
        filter: { must: [{ key: 'doc_id', match: { value: docId } }] },
        wait: true,
      });
    } catch (e) {
      log(`${docId}: delete-by-doc_id warning: ${e.message}`);
    }

    // 3) Эмбеддинги
    const embedder = getEmbedder();
    const vectors = await embedder.embed(chunks);

    // 4) Запись в Qdrant пакетом
    const indexedAt = new Date().toISOString();
    const points = chunks.map((text, i) => ({
      id: pointIdFor(docId, i),
      vector: vectors[i],
      payload: {
        text,
        source,
        username: task.username || 'unknown',
        project: task.project || 'default',
        doc_id: docId,
        chunk_idx: i,
        total_chunks: chunks.length,
        original_name: task.original_name || '',
        created_at: task.created_at || indexedAt,
        indexed_at: indexedAt,
      },
    }));

    await qdrant().upsert(QDRANT_COLLECTION, { points, wait: true });

    // 5) Обновить БД
    await dbRun(
      "UPDATE transcribe_jobs SET kb_status='done', kb_chunks=?, kb_indexed_at=NOW(), kb_error=NULL, project=COALESCE(?, project) WHERE id=?",
      [chunks.length, task.project || null, jobId]
    );

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    log(`${docId}: done ${chunks.length} chunks in ${elapsed}s`);
  } catch (e) {
    log(`${docId}: ERROR ${e.message}`);
    await dbRun(
      "UPDATE transcribe_jobs SET kb_status='error', kb_error=? WHERE id=?",
      [String(e.message || e).slice(0, 500), jobId]
    ).catch(() => {});
  }
}

async function _runWorker() {
  if (_running) return;
  _running = true;
  try {
    while (_queue.length > 0) {
      const task = _queue.shift();
      try {
        await dbRun("UPDATE transcribe_jobs SET kb_status='indexing', kb_error=NULL WHERE id=?", [task.jobId]);
      } catch (_) {}
      await _processOne(task);
    }
  } finally {
    _running = false;
  }
}

/**
 * Поставить документ в очередь индексации.
 * Возвращает { queued: true, position: N } сразу.
 * task = { jobId, source, text, username, project, doc_id?, original_name, created_at }
 */
async function enqueueIndex(task) {
  if (!task || !task.jobId) throw new Error('enqueueIndex: jobId required');
  if (!task.text || !String(task.text).trim()) throw new Error('enqueueIndex: text required');

  // Проверка на дубль в очереди
  if (_queue.some(t => t.jobId === task.jobId)) {
    return { queued: true, position: _queue.findIndex(t => t.jobId === task.jobId) + 1, duplicate: true };
  }

  _queue.push(task);
  const position = _queue.length;

  try {
    await dbRun(
      "UPDATE transcribe_jobs SET kb_status='pending', kb_error=NULL, project=COALESCE(?, project) WHERE id=?",
      [task.project || null, task.jobId]
    );
  } catch (_) {}

  // Запускаем worker асинхронно
  setImmediate(() => _runWorker().catch(e => log(`worker crashed: ${e.message}`)));

  return { queued: true, position };
}

// ═══════════════════════════════════════════════════
// Recovery on startup
// ═══════════════════════════════════════════════════

async function recoverOnStartup() {
  try {
    await ensureCollection();
  } catch (e) {
    log(`ensureCollection failed on startup: ${e.message}`);
    // Продолжаем — индексации будут падать с понятной ошибкой,
    // но сам сервис не должен ронять старт.
    return;
  }

  try {
    const stuck = await dbAll(
      "SELECT id, original_name, project, result_clean, result_txt, user_id FROM transcribe_jobs WHERE kb_status IN ('pending','indexing')"
    );
    if (!stuck.length) {
      log('Recovery: no stuck KB jobs');
      return;
    }

    log(`Recovery: ${stuck.length} stuck KB jobs → re-enqueue`);
    for (const row of stuck) {
      const text = row.result_clean || row.result_txt || '';
      if (!text.trim()) {
        await dbRun(
          "UPDATE transcribe_jobs SET kb_status='error', kb_error=? WHERE id=?",
          ['Recovery: пустой текст', row.id]
        );
        continue;
      }
      // Имя пользователя восстанавливаем из join'а
      const u = await dbGet(
        'SELECT name, email FROM transcribe_users WHERE id=?',
        [row.user_id]
      );
      _queue.push({
        jobId: row.id,
        source: 'transcribe',
        text,
        username: u?.name || u?.email || 'unknown',
        project: row.project || 'default',
        original_name: row.original_name || '',
        created_at: null,
      });
    }
    setImmediate(() => _runWorker().catch(e => log(`worker crashed: ${e.message}`)));
  } catch (e) {
    log(`Recovery error: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════
// Search API
// ═══════════════════════════════════════════════════

/**
 * Семантический поиск по KB.
 * filters = { username, project?, source? }
 * limit = 10 (default), max 50
 * Возвращает [{ score, text, source, project, doc_id, original_name, created_at, chunk_idx, total_chunks }]
 */
async function searchKb(query, filters = {}, limit = 10) {
  if (!query || !String(query).trim()) return [];
  const lim = Math.min(Math.max(parseInt(limit) || 10, 1), 50);

  const must = [];
  if (filters.username) must.push({ key: 'username', match: { value: filters.username } });
  if (filters.project)  must.push({ key: 'project',  match: { value: filters.project } });
  if (filters.source)   must.push({ key: 'source',   match: { value: filters.source } });

  const embedder = getEmbedder();
  const [vec] = await embedder.embed([sanitizeText(query)]);

  const result = await qdrant().search(QDRANT_COLLECTION, {
    vector: vec,
    filter: must.length ? { must } : undefined,
    limit: lim,
    with_payload: true,
    with_vector: false,
  });

  return (result || []).map(r => ({
    score: r.score,
    text: r.payload?.text || '',
    source: r.payload?.source || '',
    project: r.payload?.project || '',
    doc_id: r.payload?.doc_id || '',
    original_name: r.payload?.original_name || '',
    created_at: r.payload?.created_at || null,
    chunk_idx: r.payload?.chunk_idx ?? null,
    total_chunks: r.payload?.total_chunks ?? null,
  }));
}

// ═══════════════════════════════════════════════════
// Удаление
// ═══════════════════════════════════════════════════

async function deleteDocument(docId) {
  await qdrant().delete(QDRANT_COLLECTION, {
    filter: { must: [{ key: 'doc_id', match: { value: docId } }] },
    wait: true,
  });
}

async function deleteProject(username, projectName) {
  await qdrant().delete(QDRANT_COLLECTION, {
    filter: {
      must: [
        { key: 'username', match: { value: username } },
        { key: 'project',  match: { value: projectName } },
      ],
    },
    wait: true,
  });
}

async function listProjects(username) {
  // Скролл чанков с фильтром по username, with_vector:false, малый лимит
  const result = await qdrant().scroll(QDRANT_COLLECTION, {
    filter: { must: [{ key: 'username', match: { value: username } }] },
    with_payload: ['project'],
    with_vector: false,
    limit: 200,
  });
  const points = result?.points || [];
  return [...new Set(points.map(p => p.payload?.project).filter(Boolean))].sort();
}

// ═══════════════════════════════════════════════════
// Backwards-compat: sendToQdrant был старым публичным API.
// Теперь это просто алиас на enqueueIndex с маппингом полей.
// (Используется в gpu-pipeline.js и internal.js, но автоиндексацию
// мы там отключили — функция остаётся для случаев явного вызова.)
// ═══════════════════════════════════════════════════

function sendToQdrant(params) {
  return enqueueIndex({
    jobId:         params.job_id || params.jobId,
    source:        params.source || 'transcribe',
    text:          params.text || '',
    username:      params.username,
    project:       params.project || 'default',
    doc_id:        params.doc_id || `${params.source || 'transcribe'}:${params.job_id || params.jobId}`,
    original_name: params.original_name,
    created_at:    params.created_at,
  });
}

module.exports = {
  // Lifecycle
  ensureCollection,
  recoverOnStartup,

  // Indexing
  enqueueIndex,
  sendToQdrant, // backwards-compat
  getQueueSnapshot,

  // Search
  searchKb,

  // Management
  deleteDocument,
  deleteProject,
  listProjects,

  // Helpers (для тестов)
  chunkText,
  pointIdFor,
};
