/**
 * notifications.js — in-app feed for infra-only ops alerts (e.g. S3 failures) that have
 * no owning user/org to email. super_admin-only. A single `read_at` per row is enough
 * since the only audience today is the (typically small, fixed) set of super_admins —
 * read by any of them marks it read for all.
 */
const router = require('express').Router();
const db = require('../db');
const auth = require('../middleware/auth');

async function requireSuperAdmin(req, res, next) {
  const caller = await db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId);
  if (!caller || caller.role !== 'super_admin') return res.status(403).json({ error: 'Forbidden' });
  next();
}

router.get('/', auth, requireSuperAdmin, async (req, res) => {
  try {
    const notifications = req.query.unread_only === 'true'
      ? await db.prepare('SELECT * FROM notifications WHERE read_at IS NULL ORDER BY created_at DESC LIMIT 50').all()
      : await db.prepare('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 50').all();
    const { count } = await db.prepare('SELECT COUNT(*)::int as count FROM notifications WHERE read_at IS NULL').get();
    res.json({ notifications, unread_count: count });
  } catch (e) {
    console.error('[notifications] GET / failed:', e.message);
    res.status(500).json({ error: 'Failed to load notifications' });
  }
});

router.put('/mark-read', auth, requireSuperAdmin, async (req, res) => {
  try {
    await db.prepare('UPDATE notifications SET read_at = NOW() WHERE read_at IS NULL').run();
    res.json({ ok: true });
  } catch (e) {
    console.error('[notifications] PUT /mark-read failed:', e.message);
    res.status(500).json({ error: 'Failed to mark notifications read' });
  }
});

module.exports = router;
