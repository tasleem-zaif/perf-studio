const router = require('express').Router({ mergeParams: true });
const db = require('../db');
const auth = require('../middleware/auth');
const ownsProject = require('../utils/ownsProject');
const resetSequence = require('../utils/resetSequence');
const { updateProjectCollectionConfigs } = require('../utils/configWriter');

router.use(auth);

function syncRules(projectId) {
  setImmediate(() => updateProjectCollectionConfigs(projectId));
}

router.get('/', (req, res) => {
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const rows = db.prepare('SELECT * FROM rules WHERE project_id = ? ORDER BY created_at ASC').all(req.params.projectId);
  res.json({ rules: rows });
});

router.post('/', (req, res) => {
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const { metric, operator, value, unit, severity } = req.body;
  if (!metric || !operator || !value || !unit) return res.status(400).json({ error: 'All fields required' });
  const result = db.prepare(
    'INSERT INTO rules (project_id, metric, operator, value, unit, severity) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(req.params.projectId, metric, operator, value, unit, severity || 'error');
  syncRules(req.params.projectId);
  res.json({ rule: db.prepare('SELECT * FROM rules WHERE id = ?').get(result.lastInsertRowid) });
});

router.put('/:id', (req, res) => {
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const rule = db.prepare('SELECT * FROM rules WHERE id = ? AND project_id = ?').get(req.params.id, req.params.projectId);
  if (!rule) return res.status(404).json({ error: 'Not found' });
  const { metric, operator, value, unit, severity } = req.body;
  db.prepare('UPDATE rules SET metric=?, operator=?, value=?, unit=?, severity=? WHERE id=?')
    .run(metric || rule.metric, operator || rule.operator, value ?? rule.value, unit || rule.unit, severity || rule.severity, req.params.id);
  syncRules(req.params.projectId);
  res.json({ rule: db.prepare('SELECT * FROM rules WHERE id = ?').get(req.params.id) });
});

router.delete('/:id', (req, res) => {
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const rule = db.prepare('SELECT * FROM rules WHERE id = ? AND project_id = ?').get(req.params.id, req.params.projectId);
  if (!rule) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM rules WHERE id = ?').run(req.params.id);
  resetSequence('rules');
  syncRules(req.params.projectId);
  res.json({ ok: true });
});

module.exports = router;
