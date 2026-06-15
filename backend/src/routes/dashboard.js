const router = require('express').Router();
const db     = require('../db');
const auth   = require('../middleware/auth');

router.use(auth);

/**
 * GET /api/dashboard/stats
 *
 * Returns all dashboard data in 2 SQL queries (no N+1):
 *   1. Aggregate counts (projects, collections, rules, test plans, test data, orgs)
 *   2. Project list with per-project counts + basic collection/rule arrays for the workspace
 *
 * Role-based filtering:
 *   super_admin → all projects across all orgs
 *   org_admin   → projects in their org
 *   user        → projects explicitly assigned to them
 */
router.get('/stats', (req, res) => {
  try {
    const caller = db.prepare('SELECT role, org_id FROM users WHERE id = ?').get(req.userId);

    // ── Build WHERE clause per role ──────────────────────────────────────────
    let projectFilter;    // for the aggregate query
    let projectListSQL;   // full SELECT for the projects list
    let params = [];

    if (caller.role === 'super_admin') {
      projectFilter = '1=1';
      projectListSQL = `
        SELECT p.id, p.name, p.description, p.color, p.bg, p.created_at,
               u.name  AS owner_name,
               o.name  AS org_name,
               (SELECT COUNT(*) FROM collections   c  WHERE c.project_id  = p.id) AS collection_count,
               (SELECT COUNT(*) FROM rules         r  WHERE r.project_id  = p.id) AS rule_count,
               (SELECT COUNT(*) FROM test_suites   ts WHERE ts.project_id = p.id) AS test_plan_count,
               (SELECT COUNT(*) FROM test_data_files tdf WHERE tdf.project_id = p.id) AS test_data_count
        FROM projects p
        JOIN  users         u ON p.user_id  = u.id
        LEFT JOIN organizations o ON u.org_id = o.id
        ORDER BY o.name ASC, p.created_at DESC
      `;
    } else if (caller.role === 'org_admin') {
      projectFilter = 'u.org_id = ?';
      params = [caller.org_id];
      projectListSQL = `
        SELECT p.id, p.name, p.description, p.color, p.bg, p.created_at,
               u.name  AS owner_name,
               o.name  AS org_name,
               (SELECT COUNT(*) FROM collections   c   WHERE c.project_id  = p.id) AS collection_count,
               (SELECT COUNT(*) FROM rules         r   WHERE r.project_id  = p.id) AS rule_count,
               (SELECT COUNT(*) FROM test_suites   ts  WHERE ts.project_id = p.id) AS test_plan_count,
               (SELECT COUNT(*) FROM test_data_files tdf WHERE tdf.project_id = p.id) AS test_data_count
        FROM projects p
        JOIN  users         u ON p.user_id  = u.id
        LEFT JOIN organizations o ON u.org_id = o.id
        WHERE u.org_id = ?
        ORDER BY p.created_at DESC
      `;
    } else if (caller.role === 'user') {
      projectFilter = 'EXISTS (SELECT 1 FROM project_assignments pa WHERE pa.project_id = p.id AND pa.user_id = ?)';
      params = [req.userId];
      projectListSQL = `
        SELECT p.id, p.name, p.description, p.color, p.bg, p.created_at,
               u.name  AS owner_name,
               o.name  AS org_name,
               (SELECT COUNT(*) FROM collections   c   WHERE c.project_id  = p.id) AS collection_count,
               (SELECT COUNT(*) FROM rules         r   WHERE r.project_id  = p.id) AS rule_count,
               (SELECT COUNT(*) FROM test_suites   ts  WHERE ts.project_id = p.id) AS test_plan_count,
               (SELECT COUNT(*) FROM test_data_files tdf WHERE tdf.project_id = p.id) AS test_data_count
        FROM projects p
        JOIN  project_assignments pa ON pa.project_id = p.id AND pa.user_id = ?
        JOIN  users         u ON p.user_id  = u.id
        LEFT JOIN organizations o ON u.org_id = o.id
        ORDER BY p.created_at DESC
      `;
    } else {
      projectFilter = 'p.user_id = ?';
      params = [req.userId];
      projectListSQL = `
        SELECT p.id, p.name, p.description, p.color, p.bg, p.created_at,
               u.name  AS owner_name,
               o.name  AS org_name,
               (SELECT COUNT(*) FROM collections   c   WHERE c.project_id  = p.id) AS collection_count,
               (SELECT COUNT(*) FROM rules         r   WHERE r.project_id  = p.id) AS rule_count,
               (SELECT COUNT(*) FROM test_suites   ts  WHERE ts.project_id = p.id) AS test_plan_count,
               (SELECT COUNT(*) FROM test_data_files tdf WHERE tdf.project_id = p.id) AS test_data_count
        FROM projects p
        JOIN  users         u ON p.user_id  = u.id
        LEFT JOIN organizations o ON u.org_id = o.id
        WHERE p.user_id = ?
        ORDER BY p.created_at DESC
      `;
    }

    // ── Query 1: aggregate totals ────────────────────────────────────────────
    const aggSQL = `
      SELECT
        COUNT(DISTINCT p.id)   AS total_projects,
        COUNT(DISTINCT c.id)   AS total_collections,
        COUNT(DISTINCT r.id)   AS total_rules,
        COUNT(DISTINCT ts.id)  AS total_test_plans,
        COUNT(DISTINCT tdf.id) AS total_test_data,
        COUNT(DISTINCT u.org_id) AS total_orgs
      FROM projects p
      JOIN  users             u   ON p.user_id    = u.id
      LEFT JOIN collections   c   ON c.project_id  = p.id
      LEFT JOIN rules         r   ON r.project_id  = p.id
      LEFT JOIN test_suites   ts  ON ts.project_id = p.id
      LEFT JOIN test_data_files tdf ON tdf.project_id = p.id
      WHERE ${projectFilter}
    `;
    const totals = db.prepare(aggSQL).get(...params);

    // ── Query 2: project list with per-project counts ────────────────────────
    const projects = db.prepare(projectListSQL).all(...params);

    // Attach empty arrays so ProjectWorkspace doesn't crash before lazy-load
    projects.forEach(p => {
      p.collections = [];
      p.rules = [];
    });

    res.json({
      stats: {
        total_projects:    totals.total_projects    || 0,
        total_collections: totals.total_collections || 0,
        total_rules:       totals.total_rules       || 0,
        total_test_plans:  totals.total_test_plans  || 0,
        total_test_data:   totals.total_test_data   || 0,
        total_orgs:        totals.total_orgs        || 0,
      },
      projects,
    });
  } catch (err) {
    console.error('dashboard/stats error:', err);
    res.status(500).json({ error: 'Failed to load dashboard stats' });
  }
});

module.exports = router;
