'use strict';
// Version: 1.9.11 - MelkiAuth integration
// Updated: 2026-04-18

const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { db } = require('./db');
const { JWT_SECRET } = require('./config');

/**
 * Najti ili sozdat polzovatelja po dannym iz MelkiAuth headers
 */
function getOrCreateUser(username, email, groups) {
  // 1. Iskat po imeni (username iz Authentik)
  let user = db.prepare('SELECT * FROM users WHERE name = ?').get(username);

  // 2. Iskat po email
  if (!user && email) {
    user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  }

  if (!user) {
    // Avtosozdanije polzovatelja
    const id = uuidv4();
    const role = (groups && groups.includes('admins')) ? 'admin' : 'user';
    const userEmail = email || (username + '@melki.top');
    db.prepare(
      'INSERT INTO users (id, email, name, role, active, password) VALUES (?, ?, ?, ?, 1, ?)'
    ).run(id, userEmail, username, role, 'melki-auth');
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    console.log('[AUTH] Auto-created user:', username, '(' + userEmail + ') role=' + role);
  } else {
    // Obnovit rol esli gruppy izmenilis
    const newRole = (groups && groups.includes('admins')) ? 'admin' : 'user';
    if (user.role !== newRole) {
      db.prepare('UPDATE users SET role = ? WHERE id = ?').run(newRole, user.id);
      user.role = newRole;
    }
    // Obnovit last_login
    db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(user.id);
  }

  return user;
}

/**
 * Auth middleware - 2 rezhima:
 * 1. MelkiAuth headers (ot Caddy forward_auth) - osnovnoj
 * 2. Bearer JWT (dlya n8n internal API) - fallback
 */
function authMiddleware(req, res, next) {
  // 1. MelkiAuth headers
  const username = req.headers['x-authentik-username'] || req.headers['remote-user'];
  if (username) {
    const email = req.headers['x-authentik-email'] || req.headers['remote-email'] || '';
    const groupsRaw = req.headers['x-authentik-groups'] || req.headers['remote-groups'] || '';
    const groups = groupsRaw.split(',').filter(Boolean);

    const user = getOrCreateUser(username, email, groups);
    req.user = { id: user.id, email: user.email, name: user.name, role: user.role };
    return next();
  }

  // 2. Fallback: Bearer JWT (n8n, internal API)
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

function adminMiddleware(req, res, next) {
  authMiddleware(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Net dostupa' });
    }
    next();
  });
}

module.exports = { authMiddleware, adminMiddleware, getOrCreateUser };
