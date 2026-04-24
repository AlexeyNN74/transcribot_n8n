'use strict';
// middleware.js v2.0 — PostgreSQL edition
// Updated: 2026-04-24

const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbRun } = require('./db');
const { JWT_SECRET } = require('./config');

async function getOrCreateUser(username, email, groups) {
  let user = await dbGet('SELECT * FROM transcribe_users WHERE name = ?', [username]);

  if (!user && email) {
    user = await dbGet('SELECT * FROM transcribe_users WHERE email = ?', [email]);
  }

  if (!user) {
    const id = uuidv4();
    const role = (groups && groups.includes('admins')) ? 'admin' : 'user';
    const userEmail = email || (username + '@melki.top');
    await dbRun(
      'INSERT INTO transcribe_users (id, email, name, role, active, password) VALUES (?, ?, ?, ?, 1, ?)',
      [id, userEmail, username, role, 'melki-auth']
    );
    user = await dbGet('SELECT * FROM transcribe_users WHERE id = ?', [id]);
    console.log('[AUTH] Auto-created user:', username, '(' + userEmail + ') role=' + role);
  } else {
    const newRole = (groups && groups.includes('admins')) ? 'admin' : 'user';
    if (user.role !== newRole) {
      await dbRun('UPDATE transcribe_users SET role = ? WHERE id = ?', [newRole, user.id]);
      user.role = newRole;
    }
    await dbRun("UPDATE transcribe_users SET last_login = NOW() WHERE id = ?", [user.id]);
  }

  return user;
}

async function authMiddleware(req, res, next) {
  const username = req.headers['x-authentik-username'] || req.headers['remote-user'];
  if (username) {
    const email = req.headers['x-authentik-email'] || req.headers['remote-email'] || '';
    const groupsRaw = req.headers['x-authentik-groups'] || req.headers['remote-groups'] || '';
    const groups = groupsRaw.split(',').filter(Boolean);

    try {
      const user = await getOrCreateUser(username, email, groups);
      req.user = { id: user.id, email: user.email, name: user.name, role: user.role };
      return next();
    } catch (e) {
      console.error('[AUTH] Error:', e.message);
      return res.status(500).json({ error: 'Auth error' });
    }
  }

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) {
    try {
      req.user = jwt.verify(token, JWT_SECRET);
      return next();
    } catch {
      return res.status(401).json({ error: 'Nevernyj token' });
    }
  }

  return res.status(401).json({ error: 'Net avtorizatsii' });
}

async function adminMiddleware(req, res, next) {
  await authMiddleware(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Net dostupa' });
    }
    next();
  });
}

module.exports = { authMiddleware, adminMiddleware, getOrCreateUser };
