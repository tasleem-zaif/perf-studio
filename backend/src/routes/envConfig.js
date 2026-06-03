/**
 * envConfig.js — per-collection, per-environment configuration
 * Each collection+env combination has its own config (URLs, port, protocol).
 *
 * GET  /api/projects/:projectId/collections/:collectionId/env-config/:env
 * PUT  /api/projects/:projectId/collections/:collectionId/env-config/:env
 */
const router = require('express').Router({ mergeParams: true });
const db     = require('../db');
const auth   = require('../middleware/auth');
const ownsProject = require('../utils/ownsProject');
const { updateCollectionConfigs } = require('../utils/configWriter');

const DEFAULT_ENV_CONFIG = {
  urls: [{ protocol: 'https', url: '', port: '443' }],
};

router.use(auth);

router.get('/:env', (req, res) => {
  const proj = ownsProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  const { collectionId, env } = req.params;
  const row = db.prepare(
    'SELECT config_json FROM collection_env_config WHERE collection_id = ? AND env = ?'
  ).get(collectionId, env);

  // Strict env isolation: each env only sees what was explicitly saved for it.
  // UAT never inherits QA URLs. Empty = this env has no config yet.
  const envCfg = row ? JSON.parse(row.config_json || '{}') : null;

  // Global + project kept for execution-time merging inside the test runner only
  const globalRow  = db.prepare('SELECT config_json FROM global_config WHERE user_id = ?').get(req.userId);
  const projectRow = db.prepare('SELECT config_json FROM project_config WHERE project_id = ?').get(req.params.projectId);
  const globalCfg  = globalRow  ? JSON.parse(globalRow.config_json  || '{}') : {};
  const projectCfg = projectRow ? JSON.parse(projectRow.config_json || '{}') : {};

  res.json({
    global:  globalCfg,
    project: projectCfg,
    env:     envCfg,       // null = no config saved for this env yet → show empty state in UI
    effective: {           // used by test runner at execution time
      ...globalCfg,
      ...projectCfg,
      ...(envCfg || {}),
    },
  });
});

router.put('/:env', (req, res) => {
  const proj = ownsProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  const { collectionId, env } = req.params;
  const cfg = req.body.config || req.body;

  const existing = db.prepare(
    'SELECT id FROM collection_env_config WHERE collection_id = ? AND env = ?'
  ).get(collectionId, env);

  if (existing) {
    db.prepare(
      'UPDATE collection_env_config SET config_json = ? WHERE collection_id = ? AND env = ?'
    ).run(JSON.stringify(cfg), collectionId, env);
  } else {
    db.prepare(
      'INSERT INTO collection_env_config (collection_id, env, config_json) VALUES (?, ?, ?)'
    ).run(collectionId, env, JSON.stringify(cfg));
  }

  // Refresh config.json on disk
  setImmediate(() => updateCollectionConfigs(collectionId));

  res.json({ ok: true });
});

module.exports = router;
