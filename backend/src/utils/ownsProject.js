const db = require('../db');

/**
 * Returns the project if the user owns it OR has been assigned to it.
 * Used by all collection/rules/testData routes for access control.
 */
module.exports = async function ownsProject(userId, projectId) {
  // Owner
  const owned = await db.prepare('SELECT id, folder_path, name FROM projects WHERE id = ? AND user_id = ?').get(projectId, userId);
  if (owned) return owned;

  // Assigned (regular user)
  const user = await db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
  if (user?.role === 'user') {
    const assigned = await db.prepare(`
      SELECT p.id, p.folder_path, p.name FROM projects p
      JOIN project_assignments pa ON pa.project_id = p.id
      WHERE p.id = ? AND pa.user_id = ?
    `).get(projectId, userId);
    return assigned || null;
  }

  // Org admin sees all projects in their org
  if (user?.role === 'org_admin') {
    const orgProject = await db.prepare(`
      SELECT p.id, p.folder_path, p.name FROM projects p
      JOIN users u ON p.user_id = u.id
      WHERE p.id = ? AND u.org_id = (SELECT org_id FROM users WHERE id = ?)
    `).get(projectId, userId);
    return orgProject || null;
  }

  return null;
};
