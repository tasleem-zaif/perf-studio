const router = require('express').Router({ mergeParams: true });
const db     = require('../db');
const auth   = require('../middleware/auth');
const ownsProject = require('../utils/ownsProject');
const resetSequence = require('../utils/resetSequence');

router.use(auth);

function syncRules(projectId, userId) {
  setImmediate(() => {
    try {
      const { getUserProjectPath } = require('../utils/projectFolders');
      const { updateCollectionConfigs } = require('../utils/configWriter');
      const fs = require('fs');

      const projRow  = db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId);
      const projName = projRow?.name || '';
      const cols     = db.prepare('SELECT id FROM collections WHERE project_id = ?').all(projectId);

      // Regenerate config for ALL users who have a workspace for this project
      const { isAdminWorkspace } = require('../utils/projectFolders');
      const allUsers = db.prepare('SELECT id, role FROM users').all();
      for (const user of allUsers) {
        try {
          const userProjPath = getUserProjectPath(user.id, user.role, projName);
          if (isAdminWorkspace(userProjPath)) continue; // admin workspace holds no files
          if (!fs.existsSync(userProjPath)) continue;  // skip if workspace not initialised
          cols.forEach(c => updateCollectionConfigs(c.id, userProjPath));
        } catch (_) {}
      }
    } catch (_) {}
  });
}

router.get('/', (req, res) => {
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const rows = db.prepare('SELECT * FROM rules WHERE project_id = ? ORDER BY created_at ASC').all(req.params.projectId);
  res.json({ rules: rows });
});

router.post('/', (req, res) => {
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const { metric, operator, value, value_min, value_max, unit, severity } = req.body;
  if (!metric || !operator || !unit) return res.status(400).json({ error: 'Metric, operator and unit are required' });
  // For 'between', require value_min and value_max; otherwise require value
  if (operator === 'between') {
    if (!value_min || !value_max) return res.status(400).json({ error: 'value_min and value_max required for between operator' });
  } else {
    if (value === undefined || value === '') return res.status(400).json({ error: 'Value is required' });
  }
  const result = db.prepare(
    'INSERT INTO rules (project_id, metric, operator, value, value_min, value_max, unit, severity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(req.params.projectId, metric, operator, value || '', value_min || null, value_max || null, unit, severity || 'error');
  syncRules(req.params.projectId, req.userId);
  res.json({ rule: db.prepare('SELECT * FROM rules WHERE id = ?').get(result.lastInsertRowid) });
});

router.put('/:id', (req, res) => {
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const rule = db.prepare('SELECT * FROM rules WHERE id = ? AND project_id = ?').get(req.params.id, req.params.projectId);
  if (!rule) return res.status(404).json({ error: 'Performance rule not found — it may have been deleted by another user.' });
  const { metric, operator, value, value_min, value_max, unit, severity } = req.body;
  db.prepare('UPDATE rules SET metric=?, operator=?, value=?, value_min=?, value_max=?, unit=?, severity=? WHERE id=?')
    .run(
      metric || rule.metric,
      operator || rule.operator,
      value ?? rule.value,
      value_min !== undefined ? value_min : rule.value_min,
      value_max !== undefined ? value_max : rule.value_max,
      unit || rule.unit,
      severity || rule.severity,
      req.params.id
    );
  syncRules(req.params.projectId, req.userId);
  res.json({ rule: db.prepare('SELECT * FROM rules WHERE id = ?').get(req.params.id) });
});

router.delete('/:id', (req, res) => {
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const rule = db.prepare('SELECT * FROM rules WHERE id = ? AND project_id = ?').get(req.params.id, req.params.projectId);
  if (!rule) return res.status(404).json({ error: 'Performance rule not found — it may have already been deleted.' });
  db.prepare('DELETE FROM rules WHERE id = ?').run(req.params.id);
  resetSequence('rules');
  syncRules(req.params.projectId, req.userId);
  res.json({ ok: true });
});

module.exports = router;
