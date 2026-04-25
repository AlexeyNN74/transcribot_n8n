'use strict';
// Version: 2.1.0
// Updated: 2026-04-25
// v2.1: + Qdrant/Embeddings конфиг для семантического поиска (Этап 1+2)

const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || '/data/db/transcribe.db';
const UPLOAD_PATH = process.env.UPLOAD_PATH || '/data/uploads';
const RESULTS_PATH = process.env.RESULTS_PATH || '/data/results';
const GPU_SERVER_URL = process.env.GPU_SERVER_URL || '';
const GPU_API_KEY = process.env.GPU_SERVER_API_KEY || '';
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) { console.error('FATAL: JWT_SECRET environment variable is not set!'); process.exit(1); }
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';

// OpenStack credentials for GPU management
const OS_AUTH_URL = process.env.OPENSTACK_AUTH_URL || 'https://api.immers.cloud:5000/v3';
const OS_GPU_ID   = process.env.GPU_SERVER_ID || '8baf5a78-ef09-49c9-8aec-ccccf0a46742';
const OS_USERNAME = process.env.OPENSTACK_USERNAME || '';
const OS_PASSWORD = process.env.OPENSTACK_PASSWORD || '';
const OS_PROJECT  = process.env.OPENSTACK_PROJECT  || '';
const N8N_URL = process.env.N8N_URL || 'http://212.67.8.251:5678';

// Ensure directories exist
[UPLOAD_PATH, RESULTS_PATH, path.dirname(DB_PATH)].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || 'melki_internal_2026';

// ─── Qdrant + Embeddings (новое в v2.1) ──────────────────────
const QDRANT_HOST       = process.env.QDRANT_HOST       || 'qdrant';
const QDRANT_PORT       = parseInt(process.env.QDRANT_PORT || '6333');
const QDRANT_COLLECTION = process.env.QDRANT_COLLECTION || 'melki_knowledge_v2';

// bge-m3 в ONNX INT8: размер вектора 1024, distance Cosine.
// Кэш модели монтируется как volume — см. инструкцию деплоя.
const EMBED_MODEL          = process.env.EMBED_MODEL          || 'Xenova/bge-m3';
const EMBED_QUANTIZATION   = process.env.EMBED_QUANTIZATION   || 'q8';
const EMBED_VECTOR_SIZE    = parseInt(process.env.EMBED_VECTOR_SIZE    || '1024');
const EMBED_AUTOUNLOAD_MS  = parseInt(process.env.EMBED_AUTOUNLOAD_MS  || '1800000'); // 30 мин
const EMBED_CACHE_DIR      = process.env.EMBED_CACHE_DIR      || '/root/.cache/huggingface';

// Чанкование документа
const KB_CHUNK_SIZE    = parseInt(process.env.KB_CHUNK_SIZE    || '2000');
const KB_CHUNK_OVERLAP = parseInt(process.env.KB_CHUNK_OVERLAP || '200');

module.exports = {
  PORT, DB_PATH, UPLOAD_PATH, RESULTS_PATH,
  GPU_SERVER_URL, GPU_API_KEY, JWT_SECRET,
  APP_URL, ADMIN_EMAIL,
  OS_AUTH_URL, OS_GPU_ID, OS_USERNAME, OS_PASSWORD, OS_PROJECT,
  N8N_URL,
  INTERNAL_TOKEN,
  QDRANT_HOST, QDRANT_PORT, QDRANT_COLLECTION,
  EMBED_MODEL, EMBED_QUANTIZATION, EMBED_VECTOR_SIZE,
  EMBED_AUTOUNLOAD_MS, EMBED_CACHE_DIR,
  KB_CHUNK_SIZE, KB_CHUNK_OVERLAP,
};
