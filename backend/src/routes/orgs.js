const router = require('express').Router();
const db     = require('../db');
const auth   = require('../middleware/auth');

// ── Public — org list for signup/invite forms ─────────────────────────────────
router.get('/', (req, res) => {
  const orgs = db.prepare('SELECT id, name, slug FROM organizations ORDER BY name ASC').all();
  res.json({ orgs });
});

// ── Super Admin — full CRUD for organizations ─────────────────────────────────
router.use(auth);

// List orgs with member counts
router.get('/managed', (req, res) => {
  const caller = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId);
  if (caller?.role !== 'super_admin') return res.status(403).json({ error: 'Forbidden' });

  const orgs = db.prepare(`
    SELECT o.*,
      COUNT(DISTINCT u.id) as member_count,
      COUNT(DISTINCT p.id) as project_count,
      GROUP_CONCAT(DISTINCT CASE WHEN u.role = 'org_admin' THEN u.name END) as admins
    FROM organizations o
    LEFT JOIN users u ON u.org_id = o.id AND u.status = 'active'
    LEFT JOIN projects p ON p.user_id IN (SELECT id FROM users WHERE org_id = o.id)
    GROUP BY o.id
    ORDER BY o.created_at DESC
  `).all();
  res.json({ orgs });
});

// Create organization
router.post('/', (req, res) => {
  const caller = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId);
  if (caller?.role !== 'super_admin') return res.status(403).json({ error: 'Forbidden' });

  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Organization name required' });

  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]/g, '-') + '-' + Date.now();
  try {
    const result = db.prepare('INSERT INTO organizations (name, slug) VALUES (?, ?)').run(name.trim(), slug);
    const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(result.lastInsertRowid);
    res.json({ org });
  } catch (e) {
    res.status(400).json({ error: 'Organization name already exists' });
  }
});

// Update organization
router.put('/:id', (req, res) => {
  const caller = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId);
  if (caller?.role !== 'super_admin') return res.status(403).json({ error: 'Forbidden' });

  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  db.prepare('UPDATE organizations SET name = ? WHERE id = ?').run(name.trim(), req.params.id);
  res.json({ ok: true });
});

// Delete organization (only if no active members)
router.delete('/:id', (req, res) => {
  const caller = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId);
  if (caller?.role !== 'super_admin') return res.status(403).json({ error: 'Forbidden' });

  const members = db.prepare("SELECT COUNT(*) as n FROM users WHERE org_id = ? AND status = 'active'").get(req.params.id);
  if (members.n > 0) return res.status(400).json({ error: `Cannot delete: ${members.n} active member(s) in this organization` });

  db.prepare('DELETE FROM organizations WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
