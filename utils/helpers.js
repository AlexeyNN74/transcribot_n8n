'use strict';
// utils/helpers.js v2.0 — PostgreSQL edition
// Updated: 2026-04-24

const fs = require('fs');
const { pool, pgify } = require('../db');

function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Fire-and-forget logging — callers don't need to await
async function logEvent(eventType, jobId = null, userId = null, details = null, source = 'web') {
  try {
    await pool.query(
      pgify('INSERT INTO transcribe_events (event_type, job_id, user_id, details, source) VALUES (?, ?, ?, ?, ?)'),
      [eventType, jobId, userId, typeof details === 'object' ? JSON.stringify(details) : details, source]
    );
  } catch (e) {
    console.error('[logEvent]', e.message);
  }
}

const AUDIO_EXTS = new Set(['.mp3','.wav','.ogg','.flac','.m4a','.aac','.wma']);
const VIDEO_EXTS = new Set(['.mp4','.mkv','.avi','.mov','.webm']);

function detectFileType(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(12);
  fs.readSync(fd, buf, 0, 12, 0);
  fs.closeSync(fd);
  if (buf[0]===0x49 && buf[1]===0x44 && buf[2]===0x33) return 'audio';
  if (buf[0]===0xFF && (buf[1]&0xE0)===0xE0) return 'audio';
  if (buf.toString('ascii',0,4)==='RIFF') {
    return buf.toString('ascii',8,11)==='AVI' ? 'video' : 'audio';
  }
  if (buf.toString('ascii',0,4)==='OggS') return 'audio';
  if (buf.toString('ascii',0,4)==='fLaC') return 'audio';
  if (buf.toString('ascii',4,8)==='ftyp') {
    const brand = buf.toString('ascii',8,12);
    if (['M4A ','M4B '].includes(brand)) return 'audio';
    return 'video';
  }
  if (buf[0]===0x1A && buf[1]===0x45 && buf[2]===0xDF && buf[3]===0xA3) return 'video';
  if (buf[0]===0x30 && buf[1]===0x26 && buf[2]===0xB2 && buf[3]===0x75) return 'audio';
  if (buf[0]===0xFF && (buf[1]&0xF6)===0xF0) return 'audio';
  return 'unknown';
}

function getTranscript(job) {
  if (job.result_clean && job.result_clean.trim()) return job.result_clean.trim();
  if (job.result_srt && job.result_srt.trim()) {
    const lines = job.result_srt
      .replace(/^\d+\n[\d:,]+ --> [\d:,]+\n/gm, '')
      .split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const paragraphs = [];
    let cur = '';
    for (const line of lines) {
      cur = cur ? cur + ' ' + line : line;
      if (/[.!?]\s*$/.test(line)) { paragraphs.push(cur); cur = ''; }
    }
    if (cur) paragraphs.push(cur);
    return paragraphs.join('\n\n');
  }
  return '';
}

module.exports = { escapeHtml, logEvent, detectFileType, getTranscript };
