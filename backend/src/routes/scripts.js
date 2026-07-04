const router = require('express').Router({ mergeParams: true });
const db = require('../db');
const auth = require('../middleware/auth');

async function ownsProject(userId, projectId) {
  return db.prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').get(projectId, userId);
}

router.use(auth);

router.get('/', async (req, res) => {
  if (!await ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const rows = await db.prepare('SELECT * FROM scripts WHERE project_id = ? ORDER BY created_at DESC').all(req.params.projectId);
  res.json({ scripts: rows });
});

router.post('/', async (req, res) => {
  if (!await ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const { name, type, description, target, vusers, duration, rampup } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const result = await db.prepare(
    `INSERT INTO scripts (project_id, name, type, description, target, vusers, duration, rampup)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(req.params.projectId, name, type || 'K6', description || '', target || '', vusers || 50, duration || 300, rampup || 30);
  res.json({ script: await db.prepare('SELECT * FROM scripts WHERE id = ?').get(result.lastInsertRowid) });
});

router.put('/:id', async (req, res) => {
  if (!await ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const script = await db.prepare('SELECT * FROM scripts WHERE id = ? AND project_id = ?').get(req.params.id, req.params.projectId);
  if (!script) return res.status(404).json({ error: 'Not found' });
  const { name, type, description, target, vusers, duration, rampup } = req.body;
  await db.prepare(
    `UPDATE scripts SET name=?, type=?, description=?, target=?, vusers=?, duration=?, rampup=? WHERE id=?`
  ).run(name || script.name, type || script.type, description ?? script.description,
        target ?? script.target, vusers ?? script.vusers, duration ?? script.duration,
        rampup ?? script.rampup, req.params.id);
  res.json({ script: await db.prepare('SELECT * FROM scripts WHERE id = ?').get(req.params.id) });
});

router.delete('/:id', async (req, res) => {
  if (!await ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const script = await db.prepare('SELECT * FROM scripts WHERE id = ? AND project_id = ?').get(req.params.id, req.params.projectId);
  if (!script) return res.status(404).json({ error: 'Not found' });
  await db.prepare('DELETE FROM scripts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
