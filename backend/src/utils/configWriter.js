/**
 * configWriter.js
 * Writes a single comprehensive config.json per collection/env folder.
 *
 * File location:  projects/ProjectName_ID_UUID/CollectionName_ID/Env/config/config.json
 *
 * Content:
 *   {
 *     project:    { id, name, description, uuid }
 *     collection: { id, name, environments, source_type, endpoints }
 *     rules:      [ { metric, operator, value, unit, severity } ... ]
 *     test_plans: [ { id, name, engine, test_type, vusers, rampup, ... } ... ]
 *     config:     { urls, threads, rampup, duration, loops, ... }
 *   }
 *
 * Updated whenever: project, collection, rules, test suites, or config change.
 */

const fs   = require('fs');
const path = require('path');
const db   = require('../db');

function writeJson(filePath, data) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('[ConfigWriter] Failed to write', filePath, ':', e.message);
  }
}

// ── Core: write comprehensive config.json for one collection + env ────────────

function writeCollectionEnvConfig(collectionId, env) {
  try {
    const col = db.prepare('SELECT * FROM collections WHERE id = ?').get(collectionId);
    if (!col) return;

    const envName = env || col.environment || 'Default';

    // Derive env path from the PROJECT's current folder_path (always up to date)
    // rather than col.folder_path which may point to a stale location after git workspace moves
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(col.project_id);
    let envPath;
    if (project?.folder_path) {
      const colSafeName = `${col.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_${col.id}`;
      envPath = path.join(project.folder_path, colSafeName, envName);
    } else if (col.folder_path) {
      envPath = path.join(col.folder_path, envName);
    } else {
      return; // no path available
    }

    // Project already fetched above for path derivation

    // endpoint count only — full endpoints not stored in config.json
    let endpointCount = 0;
    try { endpointCount = JSON.parse(col.json_content || '[]').length; } catch {}

    // Rules for this project
    const rules = db.prepare('SELECT * FROM rules WHERE project_id = ?').all(col.project_id)
      .map(r => ({
        id: r.id, metric: r.metric, operator: r.operator,
        value: r.value, unit: r.unit, severity: r.severity,
      }));

    // Test plans linked to this collection
    const testPlans = db.prepare('SELECT * FROM test_suites WHERE collection_id = ?').all(collectionId)
      .map(s => ({
        id: s.id, name: s.name, engine: s.engine,
        test_type: s.test_type || 'load',
        vusers: s.vusers, rampup: s.rampup,
        iter_mode: s.iter_mode, loops: s.loops, duration: s.duration,
        status: s.status,
      }));

    // Config (merge global + project)
    const globalRow  = project ? db.prepare('SELECT config_json FROM global_config  WHERE user_id    = ?').get(project.user_id) : null;
    const projectRow = project ? db.prepare('SELECT config_json FROM project_config WHERE project_id = ?').get(project.id)      : null;
    const globalCfg  = globalRow  ? JSON.parse(globalRow.config_json  || '{}') : {};
    const projectCfg = projectRow ? JSON.parse(projectRow.config_json || '{}') : {};
    // Strip deprecated fields — paths handled by Docker, load params stored in test plans
    const stripDeprecated = cfg => {
      const { jmeter_path, k6_path, java_home, threads, rampup, duration, loops, ...clean } = cfg || {};
      return clean;
    };
    const mergedCfg = stripDeprecated({ ...globalCfg, ...projectCfg });

    const snapshot = {
      _generated_at: new Date().toISOString(),
      project: project ? {
        id:          project.id,
        name:        project.name,
        description: project.description || '',
        uuid:        project.uuid || '',
      } : null,
      collection: {
        id:             col.id,
        name:           col.name,
        description:    col.description || '',
        source_type:    col.source_type || 'json',
        environments:   (() => { try { return JSON.parse(col.environments || '[]'); } catch { return []; } })(),
        endpoint_count: endpointCount,
      },
      environment: envName,
      rules,
      test_plans: testPlans,
      config: mergedCfg,
    };

    writeJson(path.join(envPath, 'config', 'config.json'), snapshot);
    console.log(`[ConfigWriter] config.json updated → ${envPath}/config/config.json`);
  } catch (e) {
    console.error('[ConfigWriter] writeCollectionEnvConfig error:', e.message);
  }
}

// ── Update all env folders for a collection ───────────────────────────────────

function updateCollectionConfigs(collectionId) {
  try {
    const col = db.prepare('SELECT * FROM collections WHERE id = ?').get(collectionId);
    if (!col) return;
    let envs = [];
    try { envs = JSON.parse(col.environments || '[]'); } catch {}
    if (!envs.length) envs = col.environment ? [col.environment] : ['Default'];
    for (const env of envs) {
      writeCollectionEnvConfig(collectionId, env);
    }
  } catch (e) {
    console.error('[ConfigWriter] updateCollectionConfigs error:', e.message);
  }
}

// ── Update all collections for a project ─────────────────────────────────────

function updateProjectCollectionConfigs(projectId) {
  try {
    const collections = db.prepare('SELECT id FROM collections WHERE project_id = ?').all(projectId);
    for (const col of collections) {
      updateCollectionConfigs(col.id);
    }
  } catch (e) {
    console.error('[ConfigWriter] updateProjectCollectionConfigs error:', e.message);
  }
}

// ── Project-level metadata files — no longer needed (all data in config.json) ─
function writeProjectConfig() { /* no-op */ }
function writeGlobalConfig()   { /* no-op */ }

// ── Legacy stubs (no-ops kept for backward compat) ───────────────────────────
function writeCollectionConfig(collection) {
  if (collection?.id) updateCollectionConfigs(collection.id);
}
function writeRulesConfig()         { /* no-op: use updateProjectCollectionConfigs */ }
function writeProjectLevelConfig(projectId) {
  if (projectId) updateProjectCollectionConfigs(projectId);
}
function writeProjectSnapshot(project, userId) {
  if (!project?.folder_path) return;
  writeProjectConfig(project);
  writeGlobalConfig(userId, project.folder_path);
  updateProjectCollectionConfigs(project.id);
}

// ── Auto-populate project config from all collections (called on first config load) ─

function autoPopulateFromCollections(projectId) {
  try {
    const cols = db.prepare('SELECT json_content FROM collections WHERE project_id = ?').all(projectId);
    const seen    = new Set();
    const urlSets = [];

    for (const col of cols) {
      let endpoints = [];
      try { endpoints = JSON.parse(col.json_content || '[]'); } catch { continue; }
      for (const ep of endpoints) {
        const rawUrl = ep.url || ep.path || '';
        if (!rawUrl || (rawUrl.startsWith('/') && !rawUrl.includes('://'))) continue;
        try {
          const raw = rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`;
          const u   = new URL(raw);
          const protocol = u.protocol.replace(':', '');
          const hostname  = u.hostname;
          if (!hostname) continue;
          const port = u.port || (protocol === 'https' ? '443' : '80');
          const key  = `${protocol}|${hostname}|${port}`;
          if (!seen.has(key)) { seen.add(key); urlSets.push({ protocol, url: hostname, port }); }
        } catch { continue; }
      }
    }

    if (!urlSets.length) return;

    const existing    = db.prepare('SELECT config_json FROM project_config WHERE project_id = ?').get(projectId);
    const cfg         = existing ? JSON.parse(existing.config_json || '{}') : {};
    const existingKeys = new Set((cfg.urls || []).map(u => `${u.protocol}|${u.url}|${u.port}`));
    const newUrls      = urlSets.filter(u => !existingKeys.has(`${u.protocol}|${u.url}|${u.port}`));
    if (!newUrls.length) return;

    cfg.urls = [...(cfg.urls || []), ...newUrls];
    if (existing) {
      db.prepare('UPDATE project_config SET config_json = ? WHERE project_id = ?').run(JSON.stringify(cfg), projectId);
    } else {
      db.prepare('INSERT INTO project_config (project_id, config_json) VALUES (?, ?)').run(projectId, JSON.stringify(cfg));
    }
  } catch (e) {
    console.error('[ConfigWriter] autoPopulateFromCollections error:', e.message);
  }
}

module.exports = {
  writeProjectConfig,
  writeGlobalConfig,
  writeCollectionConfig,
  writeRulesConfig,
  writeProjectLevelConfig,
  writeProjectSnapshot,
  writeCollectionEnvConfig,
  updateCollectionConfigs,
  updateProjectCollectionConfigs,
  autoPopulateFromCollections,
};
