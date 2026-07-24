const db = require('../db');

/**
 * Returns the project if the user owns it OR has been assigned to it.
 * Used by all collection/rules/testData routes for access control.
 *
 * Also returns `org_slug` (the PROJECT OWNER's org, via a LEFT JOIN — never affects which
 * rows match, `org_slug` is just null for an org-less owner) so that every caller that
 * already fetches `proj` via this function gets it for free, synchronously, with zero
 * extra DB round-trips — needed by `git.js`'s `getUserWorkspace()`, which resolves the
 * `<Organization>/<Project>/<Actor>` workspace path and must stay synchronous.
 */
module.exports = async function ownsProject(userId, projectId) {
  // Owner
  const owned = await db.prepare(`
    SELECT p.id, p.folder_path, p.name, o.slug AS org_slug FROM projects p
    JOIN users u ON u.id = p.user_id
    LEFT JOIN organizations o ON o.id = u.org_id
    WHERE p.id = ? AND p.user_id = ?
  `).get(projectId, userId);
  if (owned) return owned;

  // Assigned (regular user)
  const user = await db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
  if (user?.role === 'user') {
    const assigned = await db.prepare(`
      SELECT p.id, p.folder_path, p.name, o.slug AS org_slug FROM projects p
      JOIN project_assignments pa ON pa.project_id = p.id
      JOIN users u ON u.id = p.user_id
      LEFT JOIN organizations o ON o.id = u.org_id
      WHERE p.id = ? AND pa.user_id = ?
    `).get(projectId, userId);
    return assigned || null;
  }

  // Org admin sees all projects in their org
  if (user?.role === 'org_admin') {
    const orgProject = await db.prepare(`
      SELECT p.id, p.folder_path, p.name, o.slug AS org_slug FROM projects p
      JOIN users u ON p.user_id = u.id
      LEFT JOIN organizations o ON o.id = u.org_id
      WHERE p.id = ? AND u.org_id = (SELECT org_id FROM users WHERE id = ?)
    `).get(projectId, userId);
    return orgProject || null;
  }

  return null;
};
