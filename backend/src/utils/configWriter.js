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
const { resolveUrlSet } = require('./preRunEngine');

function writeJson(filePath, data) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const newContent = JSON.stringify(data, null, 2);
    // Skip write if file content is identical — avoids unnecessary git modifications
    if (fs.existsSync(filePath)) {
      try {
        const existing = fs.readFileSync(filePath, 'utf8');
        if (existing === newContent) return; // nothing changed — don't touch the file
      } catch (_) {}
    }
    fs.writeFileSync(filePath, newContent, 'utf8');
  } catch (e) {
    console.error('[ConfigWriter] Failed to write', filePath, ':', e.message);
  }
}

// ── Core: write comprehensive config.json for one collection + env ────────────

async function writeCollectionEnvConfig(collectionId, env, projectFolderPath) {
  try {
    const col = await db.prepare('SELECT * FROM collections WHERE id = ?').get(collectionId);
    if (!col) return;

    const envName = env || col.environment || 'Default';
    const { cleanName } = require('./projectFolders');

    const project = await db.prepare('SELECT * FROM projects WHERE id = ?').get(col.project_id);
    let envPath;

    // Use explicitly passed folder path (user's workspace). Do NOT fall back to
    // project.folder_path — that may point to the wrong (e.g. admin) workspace.
    const basePath = projectFolderPath;
    if (!basePath) return; // no user workspace path supplied — skip write

    // Admin workspace holds only empty folders — never write config.json there
    const { isAdminWorkspace } = require('./projectFolders');
    if (isAdminWorkspace(basePath)) return;
    // New clean-name format: CollectionName/Env/
    envPath = path.join(basePath, cleanName(col.name), cleanName(envName));

    // Project already fetched above for path derivation

    // endpoint count only — full endpoints not stored in config.json
    let endpointCount = 0;
    try { endpointCount = JSON.parse(col.json_content || '[]').length; } catch {}

    // Rules for this project
    const rules = (await db.prepare('SELECT * FROM rules WHERE project_id = ?').all(col.project_id))
      .map(r => {
        const rule = {
          id: r.id, metric: r.metric, operator: r.operator,
          unit: r.unit, severity: r.severity,
        };
        if (r.operator === 'between') {
          rule.value_min = r.value_min;
          rule.value_max = r.value_max;
        } else {
          rule.value = r.value;
        }
        return rule;
      });

    // Test plans linked to this collection
    const testPlans = (await db.prepare('SELECT * FROM test_suites WHERE collection_id = ?').all(collectionId))
      .map(s => ({
        id: s.id, name: s.name, engine: s.engine,
        test_type: s.test_type || 'load',
        vusers: s.vusers, rampup: s.rampup,
        iter_mode: s.iter_mode, loops: s.loops, duration: s.duration,
        status: s.status,
      }));

    // Config (merge global + project)
    const globalRow  = project ? await db.prepare('SELECT config_json FROM global_config  WHERE user_id    = ?').get(project.user_id) : null;
    const projectRow = project ? await db.prepare('SELECT config_json FROM project_config WHERE project_id = ?').get(project.id)      : null;
    const globalCfg  = globalRow  ? JSON.parse(globalRow.config_json  || '{}') : {};
    const projectCfg = projectRow ? JSON.parse(projectRow.config_json || '{}') : {};
    // Strip deprecated fields — paths handled by Docker, load params stored in test plans
    const stripDeprecated = cfg => {
      const { jmeter_path, k6_path, java_home, threads, rampup, duration, loops, ...clean } = cfg || {};
      return clean;
    };
    const mergedCfg = stripDeprecated({ ...globalCfg, ...projectCfg });

    const snapshot = {
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

async function updateCollectionConfigs(collectionId, projectFolderPath) {
  try {
    const col = await db.prepare('SELECT * FROM collections WHERE id = ?').get(collectionId);
    if (!col) return;
    let envs = [];
    try { envs = JSON.parse(col.environments || '[]'); } catch {}
    if (!envs.length) envs = col.environment ? [col.environment] : ['Default'];
    for (const env of envs) {
      await writeCollectionEnvConfig(collectionId, env, projectFolderPath);
    }
  } catch (e) {
    console.error('[ConfigWriter] updateCollectionConfigs error:', e.message);
  }
}

// ── Update all collections for a project ─────────────────────────────────────

async function updateProjectCollectionConfigs(projectId, projectFolderPath) {
  // When no explicit user workspace path is provided, skip writing to avoid
  // accidentally writing to the wrong (e.g. admin) workspace.
  if (!projectFolderPath) return;
  try {
    const collections = await db.prepare('SELECT id FROM collections WHERE project_id = ?').all(projectId);
    for (const col of collections) {
      await updateCollectionConfigs(col.id, projectFolderPath);
    }
  } catch (e) {
    console.error('[ConfigWriter] updateProjectCollectionConfigs error:', e.message);
  }
}

// ── Project-level metadata files — no longer needed (all data in config.json) ─
function writeProjectConfig() { /* no-op */ }
function writeGlobalConfig()   { /* no-op */ }

// ── Legacy stubs (no-ops kept for backward compat) ───────────────────────────
async function writeCollectionConfig(collection, projectFolderPath) {
  if (collection?.id) await updateCollectionConfigs(collection.id, projectFolderPath);
}
function writeRulesConfig()         { /* no-op: use updateProjectCollectionConfigs */ }
async function writeProjectLevelConfig(projectId) {
  if (projectId) await updateProjectCollectionConfigs(projectId);
}
async function writeProjectSnapshot(project, userId) {
  if (!project?.folder_path) return;
  writeProjectConfig(project);
  writeGlobalConfig(userId, project.folder_path);
  await updateProjectCollectionConfigs(project.id);
}

// ── Auto-populate project config from all collections (called on first config load) ─

async function autoPopulateFromCollections(projectId) {
  try {
    const cols = await db.prepare('SELECT id, environment, json_content FROM collections WHERE project_id = ?').all(projectId);
    const seen    = new Set();
    const urlSets = [];

    for (const col of cols) {
      let endpoints = [];
      try { endpoints = JSON.parse(col.json_content || '[]'); } catch { continue; }
      // A collection's endpoints commonly reference {{var}} templates (including ones
      // whose own value is itself a template, e.g. baseUrl = "{{protocol}}://{{host}}") —
      // resolve against this collection's own default-env variables via the same shared
      // resolveUrlSet() script generation and collection import use, so this project-wide
      // reference value doesn't silently stay empty for a {{var}}-only collection.
      let variables = {};
      if (col.environment) {
        const envRow = await db.prepare('SELECT config_json FROM collection_env_config WHERE collection_id = ? AND env = ?').get(col.id, col.environment);
        try { variables = JSON.parse(envRow?.config_json || '{}').variables || {}; } catch {}
      }
      for (const ep of endpoints) {
        const rawUrl = ep.url || ep.path || '';
        if (!rawUrl) continue;
        const resolved = resolveUrlSet(rawUrl, variables);
        if (!resolved) continue;
        const key = `${resolved.protocol}|${resolved.url}|${resolved.port}`;
        if (!seen.has(key)) { seen.add(key); urlSets.push(resolved); }
      }
    }

    if (!urlSets.length) return;

    const existing    = await db.prepare('SELECT config_json FROM project_config WHERE project_id = ?').get(projectId);
    const cfg         = existing ? JSON.parse(existing.config_json || '{}') : {};
    const existingKeys = new Set((cfg.urls || []).map(u => `${u.protocol}|${u.url}|${u.port}`));
    const newUrls      = urlSets.filter(u => !existingKeys.has(`${u.protocol}|${u.url}|${u.port}`));
    if (!newUrls.length) return;

    cfg.urls = [...(cfg.urls || []), ...newUrls];
    if (existing) {
      await db.prepare('UPDATE project_config SET config_json = ? WHERE project_id = ?').run(JSON.stringify(cfg), projectId);
    } else {
      await db.prepare('INSERT INTO project_config (project_id, config_json) VALUES (?, ?)').run(projectId, JSON.stringify(cfg));
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
