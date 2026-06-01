const router = require('express').Router({ mergeParams: true });
const db = require('../db');
const auth = require('../middleware/auth');
const ownsProject = require('../utils/ownsProject');
const { writeFileSync } = require('fs');
const path = require('path');
const { writeProjectLevelConfig, writeGlobalConfig, updateProjectCollectionConfigs } = require('../utils/configWriter');

const DEFAULT_CONFIG = {
  urls: [{ protocol: 'https', url: '', port: '443' }],
};

function getGlobal(userId) {
  const row = db.prepare('SELECT config_json FROM global_config WHERE user_id = ?').get(userId);
  return row ? JSON.parse(row.config_json) : {};
}

function getProject(projectId) {
  const row = db.prepare('SELECT config_json FROM project_config WHERE project_id = ?').get(projectId);
  return row ? JSON.parse(row.config_json) : {};
}

router.use(auth);

router.get('/', (req, res) => {
  const proj = ownsProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  const global = getGlobal(req.userId);
  let project = getProject(req.params.projectId);

  // If project config has no URLs yet, auto-populate from existing collections
  const projectUrls = project ? JSON.parse(project.urls ? JSON.stringify(project.urls) : '[]') : [];
  if (!projectUrls.length || !projectUrls.some(u => u.url)) {
    const { autoPopulateFromCollections } = require('../utils/configWriter');
    if (autoPopulateFromCollections) {
      autoPopulateFromCollections(req.params.projectId);
      project = getProject(req.params.projectId);
    }
  }

  res.json({ global, project, config: project || global || DEFAULT_CONFIG });
});

router.put('/', (req, res) => {
  const proj = ownsProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  const cfg = req.body.config || req.body;
  const existing = db.prepare('SELECT id FROM project_config WHERE project_id = ?').get(req.params.projectId);
  if (existing) {
    db.prepare('UPDATE project_config SET config_json = ? WHERE project_id = ?')
      .run(JSON.stringify(cfg), req.params.projectId);
  } else {
    db.prepare('INSERT INTO project_config (project_id, config_json) VALUES (?, ?)')
      .run(req.params.projectId, JSON.stringify(cfg));
  }

  // Trigger comprehensive config.json update for all collection/env folders
  setImmediate(() => updateProjectCollectionConfigs(req.params.projectId));
  res.json({ ok: true });
});

module.exports = router;
