'use strict';
// routes/prompts.js v2.0 — PostgreSQL edition
// Updated: 2026-04-24

const express = require('express');
const { v4: uuidv4 } = require('uuid');

const { dbGet, dbAll, dbRun } = require('../db');
const { authMiddleware } = require('../middleware');

const router = express.Router();

router.get('/', authMiddleware, async (req, res) => {
  const prompts = await dbAll(`
    SELECT id, user_id, name, description, prompt_text, is_default, is_system, created_at
    FROM transcribe_prompts
    WHERE is_system = 1 OR user_id = ?
    ORDER BY is_system DESC, is_default DESC, name ASC
  `, [req.user.id]);
  res.json(prompts);
});

router.post('/', authMiddleware, async (req, res) => {
  const { name, description, prompt_text } = req.body;
  if (!name || !prompt_text) return res.status(400).json({ error: 'Укажите название и текст промпта' });

  const id = uuidv4();
  await dbRun(`
    INSERT INTO transcribe_prompts (id, user_id, name, description, prompt_text, is_default, is_system)
    VALUES (?, ?, ?, ?, ?, 0, 0)
  `, [id, req.user.id, name.trim(), description?.trim() || '', prompt_text.trim()]);

  const prompt = await dbGet('SELECT * FROM transcribe_prompts WHERE id = ?', [id]);
  res.json(prompt);
});

router.put('/:id', authMiddleware, async (req, res) => {
  const prompt = await dbGet('SELECT * FROM transcribe_prompts WHERE id = ?', [req.params.id]);
  if (!prompt) return res.status(404).json({ error: 'Профиль не найден' });
  if (prompt.user_id !== req.user.id) return res.status(403).json({ error: 'Нет доступа' });

  const { name, description, prompt_text } = req.body;
  await dbRun(
    'UPDATE transcribe_prompts SET name = ?, description = ?, prompt_text = ? WHERE id = ?',
    [
      name?.trim() || prompt.name,
      description?.trim() ?? prompt.description,
      prompt_text?.trim() || prompt.prompt_text,
      req.params.id,
    ]
  );

  const updated = await dbGet('SELECT * FROM transcribe_prompts WHERE id = ?', [req.params.id]);
  res.json(updated);
});

router.delete('/:id', authMiddleware, async (req, res) => {
  const prompt = await dbGet('SELECT * FROM transcribe_prompts WHERE id = ?', [req.params.id]);
  if (!prompt) return res.status(404).json({ error: 'Профиль не найден' });
  if (prompt.user_id !== req.user.id) return res.status(403).json({ error: 'Нет доступа' });

  await dbRun('DELETE FROM transcribe_prompts WHERE id = ?', [req.params.id]);
  res.json({ message: 'Профиль удалён' });
});

module.exports = router;
