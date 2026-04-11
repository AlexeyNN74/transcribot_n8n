'use strict';
const express = require('express');
const { v4: uuidv4 } = require('uuid');

const { db } = require('../db');
const { authMiddleware } = require('../middleware');

const router = express.Router();

// Получить список профилей: свои + все системные
router.get('/', authMiddleware, (req, res) => {
  const prompts = db.prepare(`
    SELECT id, user_id, name, description, prompt_text, is_default, is_system, created_at
    FROM prompts
    WHERE is_system = 1 OR user_id = ?
    ORDER BY is_system DESC, is_default DESC, name ASC
  `).all(req.user.id);
  res.json(prompts);
});

// Создать личный профиль
router.post('/', authMiddleware, (req, res) => {
  const { name, description, prompt_text } = req.body;
  if (!name || !prompt_text) return res.status(400).json({ error: 'Укажите название и текст промпта' });

  const id = uuidv4();
  db.prepare(`
    INSERT INTO prompts (id, user_id, name, description, prompt_text, is_default, is_system)
    VALUES (?, ?, ?, ?, ?, 0, 0)
  `).run(id, req.user.id, name.trim(), description?.trim() || '', prompt_text.trim());

  res.json(db.prepare('SELECT * FROM prompts WHERE id = ?').get(id));
});

// Редактировать свой профиль
router.put('/:id', authMiddleware, (req, res) => {
  const prompt = db.prepare('SELECT * FROM prompts WHERE id = ?').get(req.params.id);
  if (!prompt) return res.status(404).json({ error: 'Профиль не найден' });
  if (prompt.user_id !== req.user.id) return res.status(403).json({ error: 'Нет доступа' });

  const { name, description, prompt_text } = req.body;
  db.prepare(`UPDATE prompts SET name = ?, description = ?, prompt_text = ? WHERE id = ?`)
    .run(
      name?.trim() || prompt.name,
      description?.trim() ?? prompt.description,
      prompt_text?.trim() || prompt.prompt_text,
      req.params.id
    );

  res.json(db.prepare('SELECT * FROM prompts WHERE id = ?').get(req.params.id));
});

// Удалить свой профиль
router.delete('/:id', authMiddleware, (req, res) => {
  const prompt = db.prepare('SELECT * FROM prompts WHERE id = ?').get(req.params.id);
  if (!prompt) return res.status(404).json({ error: 'Профиль не найден' });
  if (prompt.user_id !== req.user.id) return res.status(403).json({ error: 'Нет доступа' });

  db.prepare('DELETE FROM prompts WHERE id = ?').run(req.params.id);
  res.json({ message: 'Профиль удалён' });
});

module.exports = router;
