const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../db');
const auth = require('../middleware/auth');

const JWT_SECRET = process.env.JWT_SECRET || 'perf_studio_secret_change_in_prod';
const JWT_EXPIRES = '7d';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function makeSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function userPayload(u, org) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    status: u.status,
    org_id: u.org_id || null,
    org_name: org?.name || null,
  };
}

// POST /auth/register
router.post('/register', (req, res) => {
  const { email, name, password, role, org_id, org_name } = req.body;
  if (!email || !name || !password) return res.status(400).json({ error: 'Name, email and password are required' });
  if (!['org_admin', 'user'].includes(role)) return res.status(400).json({ error: 'Select a role to continue' });

  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'Email already registered' });
  }

  let resolvedOrgId = null;

  if (role === 'org_admin') {
    if (org_id) {
      // Joining an existing organization as admin
      if (!db.prepare('SELECT id FROM organizations WHERE id = ?').get(org_id)) {
        return res.status(400).json({ error: 'Organization not found' });
      }
      resolvedOrgId = org_id;
    } else if (org_name?.trim()) {
      // Creating a new organization
      const slug = makeSlug(org_name.trim());
      if (db.prepare('SELECT id FROM organizations WHERE slug = ?').get(slug)) {
        return res.status(409).json({ error: 'An organization with this name already exists' });
      }
      const result = db.prepare('INSERT INTO organizations (name, slug) VALUES (?, ?)').run(org_name.trim(), slug);
      resolvedOrgId = result.lastInsertRowid;
    } else {
      return res.status(400).json({ error: 'Select an existing organization or provide a new organization name' });
    }
  } else {
    if (!org_id) return res.status(400).json({ error: 'Please select an organization' });
    if (!db.prepare('SELECT id FROM organizations WHERE id = ?').get(org_id)) {
      return res.status(400).json({ error: 'Organization not found' });
    }
    resolvedOrgId = org_id;
  }

  const hash = bcrypt.hashSync(password, 10);
  db.prepare(`
    INSERT INTO users (email, name, password_hash, role, org_id, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `).run(email, name, hash, role, resolvedOrgId);

  res.json({ pending: true, message: 'Registration submitted. Awaiting approval.' });
});

// POST /auth/login
router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  if (user.status === 'pending') {
    return res.status(403).json({ error: 'Your account is pending approval. Please wait for an admin to approve your request.' });
  }
  if (user.status === 'rejected') {
    return res.status(403).json({ error: 'Your account request was rejected. Please contact your administrator.' });
  }

  // Purge globally expired sessions
  db.prepare("DELETE FROM user_sessions WHERE expires_at <= datetime('now')").run();

  // Block only if a browser is *actively* using this account — proven by a heartbeat
  // within the last 10 s (the frontend beats every 1 s while the tab is open).
  // A closed/idle browser stops sending heartbeats so its last_used_at goes stale
  // and no warning is shown, letting the user log in without friction.
  const activeSession = db.prepare(`
    SELECT id FROM user_sessions
    WHERE user_id = ?
      AND expires_at > datetime('now')
      AND datetime(COALESCE(last_used_at, created_at), '+10 seconds') > datetime('now')
  `).get(user.id);

  if (activeSession && !req.body.force) {
    return res.status(409).json({
      error: 'You are already signed in from another location.',
      code: 'SESSION_ACTIVE',
    });
  }

  const org = user.org_id ? db.prepare('SELECT id, name FROM organizations WHERE id = ?').get(user.org_id) : null;
  const jti = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  const token = jwt.sign({ userId: user.id, jti }, JWT_SECRET, { expiresIn: JWT_EXPIRES });

  // Atomically replace the old session with the new one (force=true path).
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(user.id);
    db.prepare('INSERT INTO user_sessions (user_id, jti, expires_at) VALUES (?, ?, ?)').run(user.id, jti, expiresAt);
    db.exec('COMMIT');
  } catch (txErr) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw txErr;
  }

  res.json({ token, user: userPayload(user, org) });
});

// POST /auth/logout
router.post('/logout', (req, res) => {
  let rawToken = null;
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    rawToken = header.slice(7);
  } else if (req.body?.token) {
    rawToken = req.body.token;
  }
  if (rawToken) {
    try {
      const payload = jwt.verify(rawToken, JWT_SECRET, { ignoreExpiration: true });
      if (payload.userId) {
        db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(payload.userId);
      }
    } catch (_) {}
  }
  res.json({ ok: true });
});

// POST /auth/heartbeat — keeps last_used_at fresh while the browser is open.
// A 401 response (session replaced by a newer login) causes the api.js interceptor
// to clear the stored token and reload, redirecting the old browser to login.
router.post('/heartbeat', auth, (req, res) => {
  res.json({ ok: true });
});

// GET /auth/me
router.get('/me', auth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const org = user.org_id ? db.prepare('SELECT id, name FROM organizations WHERE id = ?').get(user.org_id) : null;
  res.json({ user: userPayload(user, org) });
});

// PUT /auth/me
router.put('/me', auth, (req, res) => {
  const { name, email } = req.body;
  if (!name?.trim() || !email?.trim()) return res.status(400).json({ error: 'Name and email required' });
  if (db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, req.userId)) {
    return res.status(409).json({ error: 'Email already in use' });
  }
  db.prepare('UPDATE users SET name = ?, email = ? WHERE id = ?').run(name.trim(), email.trim(), req.userId);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  const org = user.org_id ? db.prepare('SELECT id, name FROM organizations WHERE id = ?').get(user.org_id) : null;
  res.json({ user: userPayload(user, org) });
});

// PUT /auth/me/password
router.put('/me/password', auth, (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error: 'Both fields required' });
  if (new_password.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!bcrypt.compareSync(current_password, user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(new_password, 10), req.userId);
  res.json({ ok: true });
});

module.exports = router;
