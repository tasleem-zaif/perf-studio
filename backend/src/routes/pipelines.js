const router = require('express').Router({ mergeParams: true });
const db     = require('../db');
const auth   = require('../middleware/auth');
const ownsProject = require('../utils/ownsProject');

router.use(auth);

// GET / — list all pipelines for project
router.get('/', (req, res) => {
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const pipelines = db.prepare('SELECT * FROM pipeline_configs WHERE project_id = ? ORDER BY created_at DESC').all(req.params.projectId);
  res.json({ pipelines });
});

// POST / — create pipeline
router.post('/', (req, res) => {
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const { name, description, steps, stop_on_failure, environment } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Pipeline name is required' });
  const result = db.prepare(
    'INSERT INTO pipeline_configs (project_id, name, description, steps, stop_on_failure, environment) VALUES (?,?,?,?,?,?)'
  ).run(req.params.projectId, name.trim(), description || '', JSON.stringify(steps || []), stop_on_failure !== false ? 1 : 0, environment || '');
  const pipeline = db.prepare('SELECT * FROM pipeline_configs WHERE id = ?').get(result.lastInsertRowid);
  res.json({ pipeline });
});

// PUT /:id — update pipeline
router.put('/:id', (req, res) => {
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const { name, description, steps, stop_on_failure, environment } = req.body;
  const existing = db.prepare('SELECT * FROM pipeline_configs WHERE id = ? AND project_id = ?').get(req.params.id, req.params.projectId);
  if (!existing) return res.status(404).json({ error: 'Pipeline not found' });
  db.prepare(
    'UPDATE pipeline_configs SET name=?, description=?, steps=?, stop_on_failure=?, environment=? WHERE id=?'
  ).run(name || existing.name, description ?? existing.description, JSON.stringify(steps || JSON.parse(existing.steps)), stop_on_failure !== undefined ? (stop_on_failure ? 1 : 0) : existing.stop_on_failure, environment ?? existing.environment, req.params.id);
  res.json({ pipeline: db.prepare('SELECT * FROM pipeline_configs WHERE id = ?').get(req.params.id) });
});

// DELETE /:id — delete pipeline
router.delete('/:id', (req, res) => {
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  db.prepare('DELETE FROM pipeline_configs WHERE id = ? AND project_id = ?').run(req.params.id, req.params.projectId);
  res.json({ ok: true });
});

// GET /:id/runs — get run history for a pipeline
router.get('/:id/runs', (req, res) => {
  const runs = db.prepare('SELECT * FROM pipeline_runs WHERE pipeline_id = ? ORDER BY started_at DESC LIMIT 20').all(req.params.id);
  res.json({ runs });
});

// POST /:id/run — trigger a pipeline run (records it; actual execution handled by runner)
router.post('/:id/run', (req, res) => {
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const pipeline = db.prepare('SELECT * FROM pipeline_configs WHERE id = ? AND project_id = ?').get(req.params.id, req.params.projectId);
  if (!pipeline) return res.status(404).json({ error: 'Pipeline not found' });
  const steps = JSON.parse(pipeline.steps || '[]');
  const stepsResult = steps.map(s => ({ suite_id: s.suite_id, name: s.name, status: 'pending' }));
  const result = db.prepare(
    'INSERT INTO pipeline_runs (pipeline_id, project_id, status, steps_result) VALUES (?,?,?,?)'
  ).run(pipeline.id, req.params.projectId, 'running', JSON.stringify(stepsResult));
  const run = db.prepare('SELECT * FROM pipeline_runs WHERE id = ?').get(result.lastInsertRowid);
  res.json({ run, message: 'Pipeline run started' });
});

module.exports = router;
