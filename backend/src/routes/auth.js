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

  // Purge globally expired sessions first
  db.prepare("DELETE FROM user_sessions WHERE expires_at <= datetime('now')").run();

  // Single-session enforcement.
  // Sessions are deleted immediately when the user logs out or when the browser/tab
  // is closed (via sendBeacon). If a valid session still exists here the user is
  // actively signed in somewhere else.
  // Force=true (user clicked "Sign out other session") bypasses this check.
  const activeSession = db.prepare(
    "SELECT id FROM user_sessions WHERE user_id = ? AND expires_at > datetime('now')"
  ).get(user.id);

  if (activeSession && !req.body.force) {
    return res.status(409).json({
      error: 'You are already signed in from another location. Sign out that session to continue.',
      code: 'SESSION_ACTIVE',
    });
  }

  // Delete any existing sessions before creating the new one
  db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(user.id);

  const org = user.org_id ? db.prepare('SELECT id, name FROM organizations WHERE id = ?').get(user.org_id) : null;
  const jti = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  const token = jwt.sign({ userId: user.id, jti }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
  db.prepare('INSERT INTO user_sessions (user_id, jti, expires_at) VALUES (?, ?, ?)').run(user.id, jti, expiresAt);

  res.json({ token, user: userPayload(user, org) });
});

// POST /auth/logout
// Accepts token from Authorization header (normal logout) OR from JSON body
// (sendBeacon on browser close — sendBeacon cannot set custom headers).
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

// POST /auth/restore-session
// Called after a page REFRESH: beforeunload deleted the session via sendBeacon,
// so on reload we recreate it from the still-valid JWT (no password needed).
// Blocked if another browser already has an active session.
router.post('/restore-session', (req, res) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET); // must be valid & unexpired
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.userId);
    if (!user || user.status !== 'active') return res.status(401).json({ error: 'Unauthorized' });

    db.prepare("DELETE FROM user_sessions WHERE expires_at <= datetime('now')").run();

    // Block if another device already owns an active session
    const other = db.prepare(
      "SELECT id FROM user_sessions WHERE user_id = ? AND expires_at > datetime('now')"
    ).get(user.id);
    if (other) return res.status(409).json({ error: 'Session active elsewhere', code: 'SESSION_ACTIVE' });

    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    db.prepare('INSERT INTO user_sessions (user_id, jti, expires_at) VALUES (?, ?, ?)')
      .run(user.id, payload.jti, expiresAt);

    const org = user.org_id ? db.prepare('SELECT id, name FROM organizations WHERE id = ?').get(user.org_id) : null;
    res.json({ user: userPayload(user, org) });
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
});

// POST /auth/heartbeat — called every 30s by the frontend to keep last_used_at fresh.
// When the browser closes, heartbeats stop; after 90s the session is inactive and
// another login is allowed without a SESSION_ACTIVE conflict.
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
