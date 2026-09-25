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
  const notifications = req.query.unread_only === 'true'
    ? await db.prepare('SELECT * FROM notifications WHERE read_at IS NULL ORDER BY created_at DESC LIMIT 50').all()
    : await db.prepare('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 50').all();
  const { count } = await db.prepare('SELECT COUNT(*)::int as count FROM notifications WHERE read_at IS NULL').get();
  res.json({ notifications, unread_count: count });
});

router.put('/mark-read', auth, requireSuperAdmin, async (req, res) => {
  await db.prepare('UPDATE notifications SET read_at = NOW() WHERE read_at IS NULL').run();
  res.json({ ok: true });
});

module.exports = router;
