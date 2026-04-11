'use strict';
// Version: 1.9.8
// Updated: 2026-04-11

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const { db } = require('../db');
const { escapeHtml } = require('../utils/helpers');
const { sendEmail } = require('../utils/email');
const { JWT_SECRET, APP_URL, ADMIN_EMAIL } = require('../config');

const router = express.Router();

router.post('/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'Заполните все поля' });
  if (password.length < 8) return res.status(400).json({ error: 'Пароль минимум 8 символов' });

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.status(400).json({ error: 'Email уже зарегистрирован' });

  const id = uuidv4();
  const hashedPassword = await bcrypt.hash(password, 10);
  const activationToken = uuidv4();

  db.prepare('INSERT INTO users (id, email, password, name, activation_token) VALUES (?, ?, ?, ?, ?)')
    .run(id, email.toLowerCase(), hashedPassword, name, activationToken);

  const activationUrl = `${APP_URL}/activate?token=${activationToken}`;

  await sendEmail(email, 'Активация аккаунта — Студия Транскрибации', `
    <h2>Добро пожаловать, ${escapeHtml(name)}!</h2>
    <p>Для активации аккаунта перейдите по ссылке:</p>
    <a href="${activationUrl}" style="background:#4F46E5;color:white;padding:12px 24px;text-decoration:none;border-radius:6px;display:inline-block">Активировать аккаунт</a>
    <p>Ссылка действительна 24 часа.</p>
    <p>После активации администратор подтвердит ваш доступ.</p>
  `);

  await sendEmail(ADMIN_EMAIL, 'Новая регистрация — Студия Транскрибации', `
    <h2>Новый пользователь</h2>
    <p>Email: ${escapeHtml(email)}</p>
    <p>Имя: ${escapeHtml(name)}</p>
    <p><a href="${APP_URL}/admin">Открыть админку</a></p>
  `);

  res.json({ message: 'Проверьте почту для активации аккаунта' });
});

router.get('/activate', (req, res) => {
  const { token } = req.query;
  const user = db.prepare('SELECT * FROM users WHERE activation_token = ?').get(token);
  if (!user) return res.status(400).json({ error: 'Неверная ссылка активации' });

  db.prepare('UPDATE users SET activation_token = NULL WHERE id = ?').run(user.id);
  res.json({ message: 'Email подтверждён. Ожидайте активации администратором.' });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email?.toLowerCase());

  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ error: 'Неверный email или пароль' });
  }
  if (user.activation_token) return res.status(403).json({ error: 'Подтвердите email' });
  if (!user.active) return res.status(403).json({ error: 'Аккаунт ожидает активации администратором' });

  db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(user.id);

  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

module.exports = router;
