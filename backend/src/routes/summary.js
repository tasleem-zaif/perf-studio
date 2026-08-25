/**
 * summary.js — Top-level aggregate routes (role-aware, no N+1 queries)
 *
 * GET /api/collections   — all collections across accessible projects
 * GET /api/rules         — all rules across accessible projects
 * GET /api/test-plans    — all test suites across accessible projects
 * GET /api/test-data     — all test-data files across accessible projects
 */

const router = require('express').Router();
const db     = require('../db');
const auth   = require('../middleware/auth');

// NOTE: auth is applied per-route below — NOT globally here.
// A global router.use(auth) would intercept ALL /api/* requests including
// public routes like /api/invites/validate/:token.

/**
 * Returns a sub-query string + params array that resolves to the set of
 * project IDs the calling user is allowed to access (role-based).
 */
async function accessibleProjects(userId) {
  const caller = await db.prepare('SELECT role, org_id FROM users WHERE id = ?').get(userId);

  if (caller.role === 'super_admin') {
    return { sub: 'SELECT id FROM projects', params: [] };
  }
  if (caller.role === 'org_admin') {
    return {
      sub: 'SELECT p.id FROM projects p JOIN users u ON p.user_id = u.id WHERE u.org_id = ?',
      params: [caller.org_id],
    };
  }
  if (caller.role === 'user') {
    return {
      sub: 'SELECT project_id FROM project_assignments WHERE user_id = ?',
      params: [userId],
    };
  }
  // default / legacy role
  return { sub: 'SELECT id FROM projects WHERE user_id = ?', params: [userId] };
}

/* ── GET /api/collections ───────────────────────────────────────────────── */
router.get('/collections', auth, async (req, res) => {
  try {
    const { sub, params } = await accessibleProjects(req.userId);
    const collections = await db.prepare(`
      SELECT c.id, c.name, c.description, c.source_type, c.tool_target, c.created_at,
             p.id   AS project_id,
             p.name AS project_name
      FROM   collections c
      JOIN   projects p ON p.id = c.project_id
      WHERE  c.project_id IN (${sub}) AND c.user_id = ?
      ORDER  BY p.name ASC, c.name ASC
    `).all(...params, req.userId);

    res.json({ collections, total: collections.length });
  } catch (err) {
    console.error('GET /api/collections', err);
    res.status(500).json({ error: `Failed to load collections: ${err.message}. The database may be temporarily unavailable — reload the page.` });
  }
});

/* ── GET /api/rules ─────────────────────────────────────────────────────── */
router.get('/rules', auth, async (req, res) => {
  try {
    const { sub, params } = await accessibleProjects(req.userId);
    const rules = await db.prepare(`
      SELECT r.id, r.metric, r.operator, r.value, r.unit, r.severity, r.created_at,
             p.id   AS project_id,
             p.name AS project_name
      FROM   rules r
      JOIN   projects p ON p.id = r.project_id
      WHERE  r.project_id IN (${sub}) AND r.user_id = ?
      ORDER  BY p.name ASC, r.metric ASC
    `).all(...params, req.userId);

    res.json({ rules, total: rules.length });
  } catch (err) {
    console.error('GET /api/rules', err);
    res.status(500).json({ error: `Failed to load performance rules: ${err.message}. The database may be temporarily unavailable — reload the page.` });
  }
});

/* ── GET /api/test-plans ────────────────────────────────────────────────── */
router.get('/test-plans', auth, async (req, res) => {
  try {
    const { sub, params } = await accessibleProjects(req.userId);
    const testPlans = await db.prepare(`
      SELECT ts.id, ts.name, ts.test_type, ts.engine, ts.status, ts.created_at,
             p.id   AS project_id,
             p.name AS project_name
      FROM   test_suites ts
      JOIN   projects p ON p.id = ts.project_id
      WHERE  ts.project_id IN (${sub}) AND ts.user_id = ?
      ORDER  BY p.name ASC, ts.name ASC
    `).all(...params, req.userId);

    res.json({ test_plans: testPlans, total: testPlans.length });
  } catch (err) {
    console.error('GET /api/test-plans', err);
    res.status(500).json({ error: `Failed to load test plans: ${err.message}. The database may be temporarily unavailable — reload the page.` });
  }
});

/* ── GET /api/test-data ─────────────────────────────────────────────────── */
router.get('/test-data', auth, async (req, res) => {
  try {
    const { sub, params } = await accessibleProjects(req.userId);
    const files = await db.prepare(`
      SELECT tdf.id, tdf.filename, tdf.original_name, tdf.columns, tdf.created_at,
             p.id   AS project_id,
             p.name AS project_name
      FROM   test_data_files tdf
      JOIN   projects p ON p.id = tdf.project_id
      WHERE  tdf.project_id IN (${sub}) AND tdf.user_id = ?
      ORDER  BY p.name ASC, tdf.original_name ASC
    `).all(...params, req.userId);

    res.json({ test_data: files, total: files.length });
  } catch (err) {
    console.error('GET /api/test-data', err);
    res.status(500).json({ error: `Failed to load test data files: ${err.message}. The database may be temporarily unavailable — reload the page.` });
  }
});

module.exports = router;
