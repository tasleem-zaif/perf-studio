const router = require('express').Router({ mergeParams: true });
const db     = require('../db');
const auth   = require('../middleware/auth');
const ownsProject = require('../utils/ownsProject');
const resetSequence = require('../utils/resetSequence');

router.use(auth);

async function syncRules(projectId, userId) {
  setImmediate(async () => {
    try {
      const { getUserProjectPath, resolveOrgSlugForProject } = require('../utils/projectFolders');
      const { updateCollectionConfigs } = require('../utils/configWriter');
      const gitEngine = require('../utils/gitEngine');
      const fs = require('fs');

      const projRow  = await db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId);
      const projName = projRow?.name || '';
      const cols     = await db.prepare('SELECT id FROM collections WHERE project_id = ?').all(projectId);
      const orgSlug  = await resolveOrgSlugForProject(projectId);

      // Regenerate config for ALL users who have a workspace for this project
      const { isAdminWorkspace } = require('../utils/projectFolders');
      const allUsers = await db.prepare('SELECT id, role FROM users').all();
      for (const user of allUsers) {
        try {
          const userProjPath = await getUserProjectPath(user.id, user.role, projName, projectId);
          if (isAdminWorkspace(userProjPath)) continue; // admin workspace holds no files
          const identity = await db.prepare('SELECT auth_method FROM user_git_configs WHERE user_id = ? AND project_id = ?').get(user.id, projectId);
          const isSSH = (identity?.auth_method || 'pat') === 'ssh';
          if (isSSH) {
            if (!fs.existsSync(userProjPath)) continue;  // skip if workspace not initialised
          } else {
            const gitDir = require('path').dirname(userProjPath);
            const session = await gitEngine.openSession(gitDir, orgSlug);
            if (!session.hadState) continue; // skip if this user has never interacted with the workspace yet
          }
          cols.forEach(async c => await updateCollectionConfigs(c.id, userProjPath, user.id));
        } catch (_) {}
      }
    } catch (_) {}
  });
}

router.get('/', async (req, res) => {
  if (!await ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const rows = await db.prepare('SELECT * FROM rules WHERE project_id = ? ORDER BY created_at ASC').all(req.params.projectId);
  res.json({ rules: rows });
});

router.post('/', async (req, res) => {
  if (!await ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const { metric, operator, value, value_min, value_max, unit, severity } = req.body;
  if (!metric || !operator || !unit) return res.status(400).json({ error: 'Metric, operator and unit are required' });
  // For 'between', require value_min and value_max; otherwise require value
  if (operator === 'between') {
    if (!value_min || !value_max) return res.status(400).json({ error: 'value_min and value_max required for between operator' });
  } else {
    if (value === undefined || value === '') return res.status(400).json({ error: 'Value is required' });
  }
  const result = await db.prepare(
    'INSERT INTO rules (project_id, metric, operator, value, value_min, value_max, unit, severity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(req.params.projectId, metric, operator, value || '', value_min || null, value_max || null, unit, severity || 'error');
  syncRules(req.params.projectId, req.userId);
  res.json({ rule: await db.prepare('SELECT * FROM rules WHERE id = ?').get(result.lastInsertRowid) });
});

router.put('/:id', async (req, res) => {
  if (!await ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const rule = await db.prepare('SELECT * FROM rules WHERE id = ? AND project_id = ?').get(req.params.id, req.params.projectId);
  if (!rule) return res.status(404).json({ error: 'Performance rule not found — it may have been deleted by another user.' });
  const { metric, operator, value, value_min, value_max, unit, severity } = req.body;
  await db.prepare('UPDATE rules SET metric=?, operator=?, value=?, value_min=?, value_max=?, unit=?, severity=? WHERE id=?')
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
  res.json({ rule: await db.prepare('SELECT * FROM rules WHERE id = ?').get(req.params.id) });
});

router.delete('/:id', async (req, res) => {
  if (!await ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const rule = await db.prepare('SELECT * FROM rules WHERE id = ? AND project_id = ?').get(req.params.id, req.params.projectId);
  if (!rule) return res.status(404).json({ error: 'Performance rule not found — it may have already been deleted.' });
  await db.prepare('DELETE FROM rules WHERE id = ?').run(req.params.id);
  resetSequence('rules');
  syncRules(req.params.projectId, req.userId);
  res.json({ ok: true });
});

module.exports = router;
