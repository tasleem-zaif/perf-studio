const router = require('express').Router();
const db = require('../db');
const auth = require('../middleware/auth');

function requireAdmin(req, res, next) {
  const caller = db.prepare('SELECT role, org_id FROM users WHERE id = ?').get(req.userId);
  if (!caller || !['super_admin', 'org_admin'].includes(caller.role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  req.callerRole = caller.role;
  req.callerOrgId = caller.org_id;
  next();
}

// GET /admin/users
router.get('/users', auth, requireAdmin, (req, res) => {
  let users;
  if (req.callerRole === 'super_admin') {
    users = db.prepare(`
      SELECT u.id, u.email, u.name, u.role, u.status, u.created_at,
             o.name as org_name, o.id as org_id
      FROM users u
      LEFT JOIN organizations o ON u.org_id = o.id
      WHERE u.role != 'super_admin'
      ORDER BY u.created_at DESC
    `).all();
  } else {
    users = db.prepare(`
      SELECT u.id, u.email, u.name, u.role, u.status, u.created_at,
             o.name as org_name, o.id as org_id
      FROM users u
      LEFT JOIN organizations o ON u.org_id = o.id
      WHERE u.org_id = ? AND u.role = 'user'
      ORDER BY u.created_at DESC
    `).all(req.callerOrgId);
  }
  res.json({ users });
});

// PUT /admin/users/:id/status
router.put('/users/:id/status', auth, requireAdmin, (req, res) => {
  const { status } = req.body;
  if (!['active', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Status must be active or rejected' });
  }
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.role === 'super_admin') return res.status(403).json({ error: 'Cannot modify super admin' });

  if (req.callerRole === 'org_admin') {
    if (target.org_id !== req.callerOrgId || target.role !== 'user') {
      return res.status(403).json({ error: 'Forbidden' });
    }
  }

  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ ok: true });
});

// DELETE /admin/users/:id
router.delete('/users/:id', auth, requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.role === 'super_admin') return res.status(403).json({ error: 'Cannot delete super admin' });

  if (req.callerRole === 'org_admin') {
    if (target.org_id !== req.callerOrgId || target.role !== 'user') {
      return res.status(403).json({ error: 'Forbidden' });
    }
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
