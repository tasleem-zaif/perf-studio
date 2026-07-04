const router = require('express').Router();
const db     = require('../db');
const auth   = require('../middleware/auth');
const { getOrgLicenseStatus, setOrgPlan, setOrgStatus, PLAN_DEFAULTS } = require('../utils/license');

async function loadCaller(req, res, next) {
  const caller = await db.prepare('SELECT role, org_id FROM users WHERE id = ?').get(req.userId);
  if (!caller) return res.status(401).json({ error: 'Unauthorized' });
  req.callerRole  = caller.role;
  req.callerOrgId = caller.org_id;
  next();
}

router.use(auth, loadCaller);

// ── Plan catalog — any admin (super or org) can read the tier definitions ─────
router.get('/plans', (req, res) => {
  if (!['super_admin', 'org_admin'].includes(req.callerRole)) return res.status(403).json({ error: 'Forbidden' });
  res.json({ plans: PLAN_DEFAULTS });
});

// ── Org Admin — view own org's license + live usage ───────────────────────────
router.get('/mine', async (req, res) => {
  if (req.callerRole !== 'org_admin') return res.status(403).json({ error: 'Forbidden' });
  if (!req.callerOrgId) return res.status(400).json({ error: 'You are not assigned to an organization' });

  const license = await getOrgLicenseStatus(req.callerOrgId);
  res.json({ license });
});

// ── Super Admin — list every org with its license status ──────────────────────
router.get('/', async (req, res) => {
  if (req.callerRole !== 'super_admin') return res.status(403).json({ error: 'Forbidden' });

  const orgs = await db.prepare('SELECT id, name, slug FROM organizations ORDER BY name ASC').all();
  const licenses = await Promise.all(orgs.map(async org => ({
    org,
    license: await getOrgLicenseStatus(org.id),
  })));
  res.json({ licenses });
});

// ── Super Admin — single org's license status ──────────────────────────────────
router.get('/:orgId', async (req, res) => {
  if (req.callerRole !== 'super_admin') return res.status(403).json({ error: 'Forbidden' });

  const org = await db.prepare('SELECT id, name, slug FROM organizations WHERE id = ?').get(req.params.orgId);
  if (!org) return res.status(404).json({ error: 'Organization not found' });

  const license = await getOrgLicenseStatus(org.id);
  res.json({ org, license });
});

// ── Super Admin — assign a plan (resets limits + starts a fresh trial window) ─
router.put('/:orgId', async (req, res) => {
  if (req.callerRole !== 'super_admin') return res.status(403).json({ error: 'Forbidden' });

  const orgId = Number(req.params.orgId);
  const org = await db.prepare('SELECT id FROM organizations WHERE id = ?').get(orgId);
  if (!org) return res.status(404).json({ error: 'Organization not found' });

  const { plan, maxUsers, maxProjects, expiresAt } = req.body;
  if (!plan || !PLAN_DEFAULTS[plan]) {
    return res.status(400).json({ error: `Valid plan required. One of: ${Object.keys(PLAN_DEFAULTS).join(', ')}` });
  }

  const overrides = {};
  if (maxUsers !== undefined)    overrides.maxUsers    = maxUsers === null ? null : Number(maxUsers);
  if (maxProjects !== undefined) overrides.maxProjects = maxProjects === null ? null : Number(maxProjects);
  if (expiresAt !== undefined)   overrides.expiresAt   = expiresAt;

  const license = await setOrgPlan(orgId, plan, overrides);
  res.json({ license });
});

// ── Super Admin — enable / disable an org's license ────────────────────────────
router.put('/:orgId/status', async (req, res) => {
  if (req.callerRole !== 'super_admin') return res.status(403).json({ error: 'Forbidden' });

  const { status } = req.body;
  if (!['active', 'disabled'].includes(status)) return res.status(400).json({ error: "status must be 'active' or 'disabled'" });

  const org = await db.prepare('SELECT id FROM organizations WHERE id = ?').get(req.params.orgId);
  if (!org) return res.status(404).json({ error: 'Organization not found' });

  const license = await setOrgStatus(Number(req.params.orgId), status);
  res.json({ license });
});

module.exports = router;
