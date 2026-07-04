const router = require('express').Router();
const db     = require('../db');
const auth   = require('../middleware/auth');
const { createInviteCore } = require('./invites');
const { setOrgPlan } = require('../utils/license');

function slugify(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Only appends a disambiguating suffix when the plain slug is already taken.
async function uniqueSlug(base) {
  let slug = base || 'org';
  let n = 2;
  while (await db.prepare('SELECT id FROM organizations WHERE slug = ?').get(slug)) {
    slug = `${base || 'org'}-${n++}`;
  }
  return slug;
}

// ── Public — org list for signup/invite forms ─────────────────────────────────
router.get('/', async (req, res) => {
  const orgs = await db.prepare('SELECT id, name, slug FROM organizations ORDER BY name ASC').all();
  res.json({ orgs });
});

// ── Super Admin — full CRUD for organizations ─────────────────────────────────
router.use(auth);

// List orgs with member counts
router.get('/managed', async (req, res) => {
  const caller = await db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId);
  if (caller?.role !== 'super_admin') return res.status(403).json({ error: 'Forbidden' });

  const orgs = await db.prepare(`
    SELECT o.*,
      COUNT(DISTINCT u.id) as member_count,
      COUNT(DISTINCT p.id) as project_count,
      COUNT(DISTINCT CASE WHEN i.status = 'pending' THEN i.id END) as pending_invites,
      STRING_AGG(DISTINCT CASE WHEN u.role = 'org_admin' THEN u.name END, ',') as admins
    FROM organizations o
    LEFT JOIN users u ON u.org_id = o.id AND u.status = 'active'
    LEFT JOIN projects p ON p.user_id IN (SELECT id FROM users WHERE org_id = o.id)
    LEFT JOIN invites i ON i.org_id = o.id
    GROUP BY o.id
    ORDER BY o.created_at DESC
  `).all();
  res.json({ orgs });
});

// Create organization
router.post('/', async (req, res) => {
  const caller = await db.prepare('SELECT id, name, role FROM users WHERE id = ?').get(req.userId);
  if (caller?.role !== 'super_admin') return res.status(403).json({ error: 'Forbidden' });

  const { name, description, website, industry, plan, admin_email } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Organization name required' });

  const slug = await uniqueSlug(slugify(name));
  let org;
  try {
    const result = await db.prepare(
      'INSERT INTO organizations (name, slug, description, website, industry) VALUES (?, ?, ?, ?, ?)'
    ).run(name.trim(), slug, description || '', website || '', industry || '');
    org = await db.prepare('SELECT * FROM organizations WHERE id = ?').get(result.lastInsertRowid);
  } catch (e) {
    return res.status(400).json({ error: 'Organization name already exists' });
  }

  await setOrgPlan(org.id, plan || 'trial');

  let invite = null;
  if (admin_email?.trim()) {
    try {
      invite = await createInviteCore({
        email: admin_email.trim(),
        name: '',
        role: 'org_admin',
        orgId: org.id,
        invitedByUserId: req.userId,
        invitedByName: caller.name,
        frontendUrl: req.body.frontend_url,
      });
    } catch (e) {
      // Org was created successfully — surface the invite failure without failing the whole request
      invite = { ok: false, message: e.message || e.error || 'Failed to send admin invite' };
    }
  }

  res.json({ org, invite });
});

// Update organization
router.put('/:id', async (req, res) => {
  const caller = await db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId);
  if (caller?.role !== 'super_admin') return res.status(403).json({ error: 'Forbidden' });

  const { name, description, website, industry } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  await db.prepare(
    'UPDATE organizations SET name = ?, description = ?, website = ?, industry = ? WHERE id = ?'
  ).run(name.trim(), description || '', website || '', industry || '', req.params.id);
  res.json({ ok: true });
});

// List org admins for a specific organization
router.get('/:id/admins', async (req, res) => {
  const caller = await db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId);
  if (caller?.role !== 'super_admin') return res.status(403).json({ error: 'Forbidden' });

  const admins = await db.prepare(`
    SELECT id, name, email, created_at FROM users
    WHERE org_id = ? AND role = 'org_admin' AND status = 'active'
    ORDER BY created_at ASC
  `).all(req.params.id);
  res.json({ admins });
});

// Delete organization (only if no active members)
router.delete('/:id', async (req, res) => {
  const caller = await db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId);
  if (caller?.role !== 'super_admin') return res.status(403).json({ error: 'Forbidden' });

  const members = await db.prepare("SELECT COUNT(*) as n FROM users WHERE org_id = ? AND status = 'active'").get(req.params.id);
  if (members.n > 0) return res.status(400).json({ error: `Cannot delete: ${members.n} active member(s) in this organization` });

  await db.prepare('DELETE FROM organizations WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
