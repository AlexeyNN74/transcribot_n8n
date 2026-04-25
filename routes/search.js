'use strict';
// routes/search.js v1.0 — Семантический поиск по базе знаний
// Created: 2026-04-25 (Этап 2, чат #32)

const express = require('express');
const { authMiddleware } = require('../middleware');
const { searchKb } = require('../utils/qdrant');
const { logEvent } = require('../utils/helpers');

const router = express.Router();

// POST /api/search
// Body: { query, project?, source?, limit?, scope? }
//   scope: 'mine' (default) — только свои чанки;
//          'all' — игнорирует фильтр по username (только для admin)
router.post('/search', authMiddleware, async (req, res) => {
  try {
    const query = (req.body?.query || '').trim();
    if (!query) return res.status(400).json({ error: 'Пустой запрос' });
    if (query.length > 1000) return res.status(400).json({ error: 'Запрос слишком длинный (макс. 1000 символов)' });

    const limit  = Math.min(Math.max(parseInt(req.body?.limit) || 10, 1), 50);
    const scope  = req.body?.scope === 'all' && req.user?.role === 'admin' ? 'all' : 'mine';

    const filters = {};
    if (scope === 'mine') {
      filters.username = req.user.name || req.user.email;
    }
    if (req.body?.project) filters.project = String(req.body.project).trim();
    if (req.body?.source)  filters.source  = String(req.body.source).trim();

    const t0 = Date.now();
    const results = await searchKb(query, filters, limit);
    const elapsed = Date.now() - t0;

    logEvent('kb.search', null, req.user.id, {
      query: query.slice(0, 200),
      filters,
      results_count: results.length,
      elapsed_ms: elapsed,
    }, 'web').catch(() => {});

    res.json({
      query,
      filters,
      elapsed_ms: elapsed,
      results,
    });
  } catch (e) {
    console.error('[search]', e.message);
    res.status(500).json({ error: 'Ошибка поиска: ' + e.message });
  }
});

module.exports = router;
