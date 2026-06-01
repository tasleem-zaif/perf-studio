const db = require('../db');

module.exports = function ownsProject(userId, projectId) {
  return db.prepare('SELECT id, folder_path, name FROM projects WHERE id = ? AND user_id = ?').get(projectId, userId);
};
