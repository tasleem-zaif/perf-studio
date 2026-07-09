const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../db');
const auth = require('../middleware/auth');
const { decrypt } = require('../utils/encryption');

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
router.post('/register', async (req, res) => {
  const { email, name, password, role, org_id, org_name } = req.body;
  if (!email || !name || !password) return res.status(400).json({ error: 'Name, email and password are required' });
  if (!['org_admin', 'user'].includes(role)) return res.status(400).json({ error: 'Select a role to continue' });

  if (await db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'Email already registered' });
  }

  let resolvedOrgId = null;

  if (role === 'org_admin') {
    if (org_id) {
      if (!await db.prepare('SELECT id FROM organizations WHERE id = ?').get(org_id)) {
        return res.status(400).json({ error: 'Organization not found' });
      }
      resolvedOrgId = org_id;
    } else if (org_name?.trim()) {
      const slug = makeSlug(org_name.trim());
      if (await db.prepare('SELECT id FROM organizations WHERE slug = ?').get(slug)) {
        return res.status(409).json({ error: 'An organization with this name already exists' });
      }
      const result = await db.prepare('INSERT INTO organizations (name, slug) VALUES (?, ?)').run(org_name.trim(), slug);
      resolvedOrgId = result.lastInsertRowid;
    } else {
      return res.status(400).json({ error: 'Select an existing organization or provide a new organization name' });
    }
  } else {
    if (!org_id) return res.status(400).json({ error: 'Please select an organization' });
    if (!await db.prepare('SELECT id FROM organizations WHERE id = ?').get(org_id)) {
      return res.status(400).json({ error: 'Organization not found' });
    }
    resolvedOrgId = org_id;
  }

  const hash = bcrypt.hashSync(password, 10);
  await db.prepare(`
    INSERT INTO users (email, name, password_hash, role, org_id, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `).run(email, name, hash, role, resolvedOrgId);

  res.json({ pending: true, message: 'Registration submitted. Awaiting approval.' });
});

// POST /auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const user = await db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  if (user.status === 'pending') {
    return res.status(403).json({ error: 'Your account is pending approval. Please wait for an admin to approve your request.' });
  }
  if (user.status === 'rejected') {
    return res.status(403).json({ error: 'Your account request was rejected. Please contact your administrator.' });
  }

  await db.prepare('DELETE FROM user_sessions WHERE expires_at <= NOW()').run();

  const activeSession = await db.prepare(`
    SELECT id FROM user_sessions
    WHERE user_id = ?
      AND expires_at > NOW()
      AND COALESCE(last_used_at, created_at) + interval '10 seconds' > NOW()
  `).get(user.id);

  if (activeSession && !req.body.force) {
    return res.status(409).json({
      error: 'You are already signed in from another location.',
      code: 'SESSION_ACTIVE',
    });
  }

  const org = user.org_id ? await db.prepare('SELECT id, name FROM organizations WHERE id = ?').get(user.org_id) : null;
  const jti = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  const token = jwt.sign({ userId: user.id, jti }, JWT_SECRET, { expiresIn: JWT_EXPIRES });

  // Atomically replace the old session with the new one.
  await db.transaction(async (client) => {
    await client.query('DELETE FROM user_sessions WHERE user_id = $1', [user.id]);
    await client.query(
      'INSERT INTO user_sessions (user_id, jti, expires_at) VALUES ($1, $2, $3)',
      [user.id, jti, expiresAt]
    );
  });

  res.json({ token, user: userPayload(user, org) });
});

// POST /auth/logout
router.post('/logout', async (req, res) => {
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
        await db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(payload.userId);
      }
    } catch (_) {}
  }
  res.json({ ok: true });
});

// POST /auth/heartbeat
router.post('/heartbeat', auth, (req, res) => {
  res.json({ ok: true });
});

// GET /auth/me
router.get('/me', auth, async (req, res) => {
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const org = user.org_id ? await db.prepare('SELECT id, name FROM organizations WHERE id = ?').get(user.org_id) : null;
  res.json({ user: userPayload(user, org) });
});

// PUT /auth/me
router.put('/me', auth, async (req, res) => {
  const { name, email } = req.body;
  if (!name?.trim() || !email?.trim()) return res.status(400).json({ error: 'Name and email required' });
  if (await db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, req.userId)) {
    return res.status(409).json({ error: 'Email already in use' });
  }
  await db.prepare('UPDATE users SET name = ?, email = ? WHERE id = ?').run(name.trim(), email.trim(), req.userId);
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  const org = user.org_id ? await db.prepare('SELECT id, name FROM organizations WHERE id = ?').get(user.org_id) : null;
  res.json({ user: userPayload(user, org) });
});

// PUT /auth/me/password
router.put('/me/password', auth, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error: 'Both fields required' });
  if (new_password.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!bcrypt.compareSync(current_password, user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(new_password, 10), req.userId);
  res.json({ ok: true });
});

// GET /auth/me/registry-token — org's npm registry token, viewable by any member
router.get('/me/registry-token', auth, async (req, res) => {
  try {
    const user = await db.prepare('SELECT org_id FROM users WHERE id = ?').get(req.userId);
    if (!user?.org_id) return res.json({ orgName: null, token: null, registryUrl: null });

    const org = await db.prepare(
      'SELECT name, registry_token_enc FROM organizations WHERE id = ?'
    ).get(user.org_id);

    res.json({
      orgName: org?.name || null,
      token: org?.registry_token_enc ? decrypt(org.registry_token_enc) : null,
      registryUrl: `${process.env.ARTIFACT_KEEPER_URL || 'https://artifact-keeper.qtsolvdev.com'}/npm/@peako/`,
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load registry token' });
  }
});

module.exports = router;
