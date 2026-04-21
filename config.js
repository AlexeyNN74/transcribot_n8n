'use strict';
// Version: 1.9.8
// Updated: 2026-04-11

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
module.exports = {
  PORT, DB_PATH, UPLOAD_PATH, RESULTS_PATH,
  GPU_SERVER_URL, GPU_API_KEY, JWT_SECRET,
  APP_URL, ADMIN_EMAIL,
  OS_AUTH_URL, OS_GPU_ID, OS_USERNAME, OS_PASSWORD, OS_PROJECT,
  N8N_URL,
  INTERNAL_TOKEN
};
