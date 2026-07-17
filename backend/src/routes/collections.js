const router = require('express').Router({ mergeParams: true });
const multer = require('multer');
const path   = require('path');
const fs     = require('fs');
const db     = require('../db');
const resetSequence = require('../utils/resetSequence');
const { writeCollectionConfig } = require('../utils/configWriter');
const auth   = require('../middleware/auth');
const ownsProject = require('../utils/ownsProject');
const { parseCurl } = require('../utils/parseCurl');
const { parseCollection, parsePostmanEnvironment, extractCollectionVariables } = require('../utils/parseCollection');
const { ensureCollectionFolders, ensureAllEnvFolders, getUserProjectPath } = require('../utils/projectFolders');
const { resolveUrlSet } = require('../utils/preRunEngine');
const { reindexAfterEndpointRemoval } = require('../utils/correlationEngine');
const s3Sync = require('../utils/s3Sync');

/**
 * Auto-populate project config URLs from a collection's parsed endpoints.
 * Extracts unique protocol+hostname+port combinations and merges them into
 * the project_config without overwriting existing manual entries.
 *
 * `variables` (the collection's own `variable` defaults, overridden by an uploaded
 * Postman environment file — same map seedEnvVariables() stores) is used to resolve
 * {{var}}-templated base URLs (e.g. {{alpha_url}}, or one whose own value is itself a
 * template like baseUrl = "{{protocol}}://{{host}}") into a real hostname/port via the
 * single shared resolveUrlSet() (preRunEngine.js — also used by script generation), so
 * collections that only ever reference their host/port via variables still get a usable
 * env config instead of none at all.
 */
async function autoPopulateProjectConfig(projectId, jsonContent, collectionId, variables = {}) {
  try {
    const endpoints = JSON.parse(jsonContent || '[]');
    if (!endpoints.length) return;

    const urlSets = [];
    const seen = new Set();

    for (const ep of endpoints) {
      const rawUrl = ep.url || ep.path || '';
      if (!rawUrl) continue;
      const resolved = resolveUrlSet(rawUrl, variables);
      if (!resolved) continue;
      const key = `${resolved.protocol}|${resolved.url}|${resolved.port}`;
      if (!seen.has(key)) { seen.add(key); urlSets.push(resolved); }
    }

    if (!urlSets.length) return;

    // Only populate project_config as a general reference/default.
    // Each environment's config (collection_env_config) must be set MANUALLY
    // by the user because QA, Staging, UAT each point to different servers.
    const existing = await db.prepare('SELECT config_json FROM project_config WHERE project_id = ?').get(projectId);
    const cfg      = existing ? JSON.parse(existing.config_json || '{}') : {};
    const existingKeys = new Set((cfg.urls || []).map(u => `${u.protocol}|${u.url}|${u.port}`));
    const newUrls      = urlSets.filter(u => !existingKeys.has(`${u.protocol}|${u.url}|${u.port}`));
    if (newUrls.length) {
      cfg.urls = [...(cfg.urls || []), ...newUrls];
      if (existing) {
        await db.prepare('UPDATE project_config SET config_json = ? WHERE project_id = ?').run(JSON.stringify(cfg), projectId);
      } else {
        await db.prepare('INSERT INTO project_config (project_id, config_json) VALUES (?, ?)').run(projectId, JSON.stringify(cfg));
      }
      console.log(`[Collections] Auto-populated ${newUrls.length} URL(s) into project ${projectId} config (reference only)`);
    }
    // ── Also populate collection_env_config for each env (same URL as starting point) ──
    // User can then edit each env to point to their specific server.
    // Only sets URL if the env config doesn't already have one (never overwrites user edits).
    if (collectionId) {
      const col = await db.prepare('SELECT environments, environment FROM collections WHERE id = ?').get(collectionId);
      let envs = [];
      try { envs = JSON.parse(col?.environments || '[]'); } catch {}
      if (!envs.length && col?.environment) envs = [col.environment];

      for (const env of envs) {
        const envRow = await db.prepare(
          'SELECT config_json FROM collection_env_config WHERE collection_id = ? AND env = ?'
        ).get(collectionId, env);
        const envCfg  = envRow ? JSON.parse(envRow.config_json || '{}') : {};
        const hasUrls = (envCfg.urls || []).some(u => u.url); // has user-set URLs already

        if (!hasUrls) {
          // No user URLs yet — auto-fill as starting point
          envCfg.urls = urlSets;
          if (envRow) {
            await db.prepare('UPDATE collection_env_config SET config_json = ? WHERE collection_id = ? AND env = ?')
              .run(JSON.stringify(envCfg), collectionId, env);
          } else {
            await db.prepare('INSERT INTO collection_env_config (collection_id, env, config_json) VALUES (?, ?, ?)')
              .run(collectionId, env, JSON.stringify(envCfg));
          }
          console.log(`[Collections] Auto-populated ${env} env config for collection ${collectionId}`);
        }
      }
    }
  } catch (e) {
    console.error('[Collections] autoPopulateProjectConfig error:', e.message);
  }
}

/** Create collection folder in the CURRENT USER's workspace and save source file. */
async function setupCollectionFolder(proj, colId, colName, env, sourceContent, sourceType, originalFilename, userId, userRole, environmentFileContent) {
  const caller = await db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
  const role   = caller?.role || userRole;

  // userProjectPath is: git-workspaces/[<Organization>/]<ProjectName>/<userName>/<ProjectName>/
  const userProjectPath = await getUserProjectPath(userId, role, proj.name, proj.id);
  if (!userProjectPath) return null;

  // gitRoot is one level up from userProjectPath — where .git lives. Derived via dirname
  // (not recomputed independently) so it can never disagree with userProjectPath about
  // whether this project+actor uses the org-prefixed structure or the pre-existing one.
  const gitRoot = path.dirname(userProjectPath);

  // Restore the workspace first if the S3 sweep reclaimed it since the last access (or if
  // .git was never cloned into this folder at all yet) — properly awaited and also restores
  // anything S3-only (results/), unlike the old fire-and-forget clone this replaces.
  try {
    await require('./git').ensureGitWorkspaceHydrated(gitRoot, proj.id, userId);
  } catch (e) { console.error('[Collections] Workspace hydrate failed:', e.message); }

  try {
    const base = ensureCollectionFolders(userProjectPath, colName, env);
    const safeName = (colName || 'collection').replace(/[^a-zA-Z0-9_-]/g, '_');
    // Save original source file to testData/
    if (sourceContent) {
      const ext  = sourceType === 'swagger' ? (originalFilename?.endsWith('.yaml') || originalFilename?.endsWith('.yml') ? '.yaml' : '.json') : '.json';
      const dest = path.join(base, 'testData', `${safeName}_source${ext}`);
      fs.writeFileSync(dest, sourceContent, 'utf8');
    }
    // Save the companion Postman environment file (if uploaded) alongside it, same folder.
    if (environmentFileContent) {
      const envDest = path.join(base, 'testData', `${safeName}_environment.json`);
      fs.writeFileSync(envDest, environmentFileContent, 'utf8');
    }
    return base;
  } catch (e) {
    console.error('[Collections] Folder setup failed:', e.message);
    return null;
  }
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const uploadWithEnv = upload.fields([{ name: 'file', maxCount: 1 }, { name: 'environment_file', maxCount: 1 }]);

/**
 * Seeds {{var}} values into each environment's collection_env_config so pre-run
 * (and script generation) can resolve them, without ever overwriting a value the
 * user already set for that env — existing keys always win over freshly harvested ones.
 */
async function seedEnvVariables(collectionId, envs, variables) {
  if (!variables || !Object.keys(variables).length) return;
  for (const env of envs) {
    const row = await db.prepare('SELECT config_json FROM collection_env_config WHERE collection_id = ? AND env = ?').get(collectionId, env);
    const cfg = row ? JSON.parse(row.config_json || '{}') : {};
    cfg.variables = { ...variables, ...(cfg.variables || {}) };
    if (row) {
      await db.prepare('UPDATE collection_env_config SET config_json = ? WHERE collection_id = ? AND env = ?').run(JSON.stringify(cfg), collectionId, env);
    } else {
      await db.prepare('INSERT INTO collection_env_config (collection_id, env, config_json) VALUES (?, ?, ?)').run(collectionId, env, JSON.stringify(cfg));
    }
  }
}

router.use(auth);

router.get('/', async (req, res) => {
  if (!await ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const collections = await db.prepare('SELECT * FROM collections WHERE project_id = ? ORDER BY created_at DESC').all(req.params.projectId);
  res.json({ collections });
});

router.post('/parse-curl', async (req, res) => {
  const { curl } = req.body;
  if (!curl) return res.status(400).json({ error: 'curl string required' });
  try {
    res.json({ parsed: parseCurl(curl) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/** Parse environments from request — supports both array and single string */
function parseEnvs(req) {
  if (req.body.environments) {
    try { return JSON.parse(req.body.environments); } catch { return [req.body.environments]; }
  }
  return req.body.environment ? [req.body.environment] : ['Default'];
}

router.post('/', uploadWithEnv, async (req, res) => {
  const proj = await ownsProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  const { name, description, source_type, tool_target } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });

  const envsArr   = parseEnvs(req);         // ["QA", "Staging", ...]
  const envFirst  = envsArr[0] || 'Default'; // backward-compat single env

  let json_content = '[]';
  let source_content = req.body.source_content || '';
  const collectionFile = req.files?.file?.[0];
  const originalFilename = collectionFile?.originalname || '';
  if (collectionFile) source_content = collectionFile.buffer.toString('utf8');

  const stype = source_type || 'json';

  // {{var}} values: collection-level `variable` defaults, overridden by an uploaded
  // Postman environment file if one was provided.
  let collectionVariables = extractCollectionVariables(source_content, stype);
  const environmentFile = req.files?.environment_file?.[0];
  if (environmentFile) {
    try {
      const envVars = parsePostmanEnvironment(environmentFile.buffer.toString('utf8'));
      collectionVariables = { ...collectionVariables, ...envVars };
    } catch (e) {
      return res.status(400).json({ error: `Failed to parse environment file: ${e.message}` });
    }
  }

  if (stype === 'postman' || stype === 'swagger') {
    try { json_content = JSON.stringify(parseCollection(source_content, stype)); }
    catch (e) { return res.status(400).json({ error: `Failed to parse collection: ${e.message}` }); }
  } else if (stype === 'curl') {
    try { json_content = JSON.stringify([{ name: 'cURL Request', ...parseCurl(source_content) }]); }
    catch (e) { return res.status(400).json({ error: `Failed to parse cURL: ${e.message}` }); }
  } else {
    const raw = req.body.json_content || source_content || '[]';
    try { const p = JSON.parse(raw); json_content = Array.isArray(p) ? raw : JSON.stringify([p]); }
    catch (e) { return res.status(400).json({ error: 'Invalid JSON content' }); }
  }

  const result = await db.prepare(
    `INSERT INTO collections (project_id, name, description, json_content, source_type, source_content, tool_target, environment, environments)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(req.params.projectId, name, description || '', json_content, stype, source_content,
        tool_target || 'jmeter', envFirst, JSON.stringify(envsArr));

  const colId = result.lastInsertRowid;

  // Create folder structure for EACH selected environment
  let firstFolderPath = null;
  for (const env of envsArr) {
    const fp = await setupCollectionFolder(proj, colId, name, env, source_content, stype, originalFilename, req.userId, undefined, environmentFile?.buffer?.toString('utf8'));
    if (fp && !firstFolderPath) firstFolderPath = fp;
  }
  // Store the collection base path (parent of all env folders)
  if (firstFolderPath) {
    const basePath = require('path').dirname(firstFolderPath); // CollectionName_ID/
    await db.prepare('UPDATE collections SET folder_path = ? WHERE id = ?').run(basePath, colId);
  }

  const savedCol = await db.prepare('SELECT * FROM collections WHERE id = ?').get(colId);
  const callerRow = await db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId);
  // Pass user's workspace path so config.json is written to the right location
  const projForConfig = await db.prepare('SELECT name FROM projects WHERE id = ?').get(req.params.projectId);
  const userProjectPath = await getUserProjectPath(req.userId, callerRow?.role, projForConfig?.name || '', req.params.projectId);
  writeCollectionConfig(savedCol, userProjectPath, req.userId);
  // Auto-populate project config with URLs from this collection (non-blocking) —
  // pass the resolved {{var}} values so a template-only collection (e.g. {{alpha_url}})
  // still resolves to a real host when an environment file provided one.
  setImmediate(() => autoPopulateProjectConfig(req.params.projectId, savedCol.json_content, colId, collectionVariables));
  // Seed {{var}} values (from the collection and/or uploaded environment file) into each env
  setImmediate(() => seedEnvVariables(colId, envsArr, collectionVariables));

  // Create folder structure in git-workspaces for all environments
  try {
    const { ensureCollectionFolders, ensureAllEnvFolders, getUserProjectPath } = require('../utils/projectFolders');
    const proj = await db.prepare('SELECT folder_path FROM projects WHERE id = ?').get(req.params.projectId);
    if (proj?.folder_path) {
      let envs = [];
      try { envs = JSON.parse(req.body.environments || '[]'); } catch {}
      if (!envs.length && req.body.environment) envs = [req.body.environment];
      if (!envs.length) envs = ['Default'];
      ensureCollectionFolders(proj.folder_path, req.body.name || '', envs);
    }
  } catch (_) {}

  res.json({ collection: savedCol });
});

router.put('/:id', uploadWithEnv, async (req, res) => {
  const proj = await ownsProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  const col = await db.prepare('SELECT * FROM collections WHERE id = ? AND project_id = ?').get(req.params.id, req.params.projectId);
  if (!col) return res.status(404).json({ error: 'Collection not found — it may have been deleted in another session.' });

  const { name, description, source_type, tool_target } = req.body;
  const collectionFile = req.files?.file?.[0];
  const originalFilename = collectionFile?.originalname || '';
  let source_content = collectionFile ? collectionFile.buffer.toString('utf8') : (req.body.source_content || col.source_content);
  const stype    = source_type || col.source_type;
  const newName  = name || col.name;

  // {{var}} values: collection-level `variable` defaults, overridden by an uploaded
  // Postman environment file if one was provided. Existing per-env values always win (seedEnvVariables never clobbers).
  let collectionVariables = extractCollectionVariables(source_content, stype);
  const environmentFile = req.files?.environment_file?.[0];
  if (environmentFile) {
    try {
      const envVars = parsePostmanEnvironment(environmentFile.buffer.toString('utf8'));
      collectionVariables = { ...collectionVariables, ...envVars };
    } catch (e) {
      return res.status(400).json({ error: `Failed to parse environment file: ${e.message}` });
    }
  }

  // Parse new environments
  let envsArr;
  if (req.body.environments !== undefined) {
    try { envsArr = JSON.parse(req.body.environments); } catch { envsArr = [req.body.environments]; }
  } else {
    try { envsArr = JSON.parse(col.environments || '[]'); } catch { envsArr = col.environment ? [col.environment] : ['Default']; }
  }
  const envFirst = envsArr[0] || 'Default';

  let json_content = col.json_content;
  if (collectionFile || req.body.source_content) {
    if (stype === 'postman' || stype === 'swagger') {
      try { json_content = JSON.stringify(parseCollection(source_content, stype)); }
      catch (e) { return res.status(400).json({ error: `Parse failed: ${e.message}` }); }
    } else if (stype === 'curl') {
      try { json_content = JSON.stringify([{ name: 'cURL Request', ...parseCurl(source_content) }]); }
      catch (e) { return res.status(400).json({ error: `cURL parse failed: ${e.message}` }); }
    } else {
      const raw = req.body.json_content || source_content;
      try { const p = JSON.parse(raw); json_content = Array.isArray(p) ? raw : JSON.stringify([p]); }
      catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }
    }
  } else if (req.body.json_content) {
    try { const p = JSON.parse(req.body.json_content); json_content = Array.isArray(p) ? req.body.json_content : JSON.stringify([p]); }
    catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }
  }

  // Create/update folder for EACH environment
  let colBasePath = col.folder_path || '';
  for (const env of envsArr) {
    const fp = await setupCollectionFolder(proj, col.id, newName, env, source_content, stype, originalFilename, req.userId, undefined, environmentFile?.buffer?.toString('utf8'));
    if (fp && !colBasePath) colBasePath = require('path').dirname(fp);
  }

  await db.prepare(
    `UPDATE collections SET name=?, description=?, json_content=?, source_type=?, source_content=?, tool_target=?, environment=?, environments=?, folder_path=? WHERE id=?`
  ).run(newName, description ?? col.description, json_content, stype, source_content,
        tool_target || col.tool_target, envFirst, JSON.stringify(envsArr),
        colBasePath, req.params.id);

  const updatedCol = await db.prepare('SELECT * FROM collections WHERE id = ?').get(req.params.id);
  // Re-populate project config if endpoints changed
  setImmediate(() => autoPopulateProjectConfig(req.params.projectId, updatedCol.json_content, updatedCol.id, collectionVariables));
  // Seed any newly-discovered {{var}} values into each env (never overwrites existing values)
  setImmediate(() => seedEnvVariables(updatedCol.id, envsArr, collectionVariables));

  // Sync folder structure + config.json in current user's workspace
  try {
    const { ensureAllEnvFolders, getUserProjectPath, isAdminWorkspace, cleanName } = require('../utils/projectFolders');
    const callerUser = await db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId);
    const callerRole = callerUser?.role;
    const projRow    = await db.prepare('SELECT name FROM projects WHERE id = ?').get(req.params.projectId);
    const userProjPath = await getUserProjectPath(req.userId, callerRole, projRow?.name || '', req.params.projectId);
    if (userProjPath) await require('./git').ensureGitWorkspaceHydrated(path.dirname(userProjPath), req.params.projectId, req.userId);
    if (userProjPath && !isAdminWorkspace(userProjPath)) {
      let newEnvs = [];
      try { newEnvs = JSON.parse(req.body.environments || '[]'); } catch {}
      if (!newEnvs.length && req.body.environment) newEnvs = [req.body.environment];
      if (!newEnvs.length) newEnvs = ['Default'];

      // If collection was renamed, rename the folder
      if (col.name !== newName) {
        const oldDir = path.join(userProjPath, cleanName(col.name));
        const newDir = path.join(userProjPath, cleanName(newName));
        if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) {
          fs.renameSync(oldDir, newDir);
        }
      }

      // Ensure all env folders exist (creates new ones, keeps existing)
      ensureAllEnvFolders(userProjPath, newName || col.name, newEnvs);

      // Update config.json for all envs
      writeCollectionConfig(updatedCol, userProjPath, req.userId);
    }
  } catch (e) {
    console.warn('[Collections] Folder sync on edit failed:', e.message);
  }

  res.json({ collection: updatedCol });
});

router.delete('/:id', async (req, res) => {
  const proj = await ownsProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  const col = await db.prepare('SELECT * FROM collections WHERE id = ? AND project_id = ?').get(req.params.id, req.params.projectId);
  if (!col) return res.status(404).json({ error: 'Collection not found — it may have already been deleted.' });

  // Delete the collection's folder from the current user's git workspace
  try {
    const callerUser2 = await db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId);
    const callerRole = callerUser2?.role;
    const { getUserProjectPath, cleanName, resolveOrgSlugForProject } = require('../utils/projectFolders');
    const userProjPath = await getUserProjectPath(req.userId, callerRole, proj.name, proj.id);
    if (userProjPath) {
      const colDir = path.join(userProjPath, cleanName(col.name));
      if (fs.existsSync(colDir)) {
        fs.rmSync(colDir, { recursive: true, force: true });
        console.log(`[Collections] Deleted folder: ${colDir}`);
      }
      const orgSlug = await resolveOrgSlugForProject(req.params.projectId);
      const del = await s3Sync.deleteDir(colDir, orgSlug);
      if (!del.ok && !del.skipped) console.error('[Collections] S3 delete failed for', colDir, ':', del.failed?.length, 'object(s)');
    }
  } catch (e) {
    console.warn('[Collections] Folder delete failed:', e.message);
  }

  // collection_env_config and test_data_files reference collection_id with no FK/cascade —
  // clean them up explicitly, otherwise resetSequence() below can hand this collection's id
  // to a brand new collection, which would silently "inherit" the deleted one's env config
  // (urls/variables) and test data file associations.
  //
  // test_suites.collection_id DOES have an FK (ON DELETE SET NULL), but that only orphans
  // the test plan (keeps it around with collection_id=NULL, still generatable/runnable
  // against a now-nonexistent collection) rather than removing it — explicitly delete
  // instead so a collection's test plans go away with it, same as its test data files.
  await db.prepare('DELETE FROM test_suites WHERE collection_id = ?').run(req.params.id);
  await db.prepare('DELETE FROM collection_env_config WHERE collection_id = ?').run(req.params.id);
  await db.prepare('DELETE FROM test_data_files WHERE collection_id = ?').run(req.params.id);
  await db.prepare('DELETE FROM collections WHERE id = ?').run(req.params.id);
  resetSequence('test_suites');
  resetSequence('collections');
  res.json({ ok: true });
});

// Deletes one or more recorded endpoints (by array index into json_content) from a
// collection — the fallback for pruning garbage/noise traffic (static asset requests,
// framework prefetch calls, etc.) that got swept up during recording, with no dedicated
// per-endpoint edit UI otherwise. Every endpoint reference elsewhere (correlationRules,
// fieldGenerators, endpointOverrides — all in collection_env_config, keyed by array INDEX
// not a stable id) must be reindexed in lockstep across EVERY env for this collection, or
// deleting index 5 out of 41 would silently misdirect every rule/generator/override that
// pointed at index 6+ toward the wrong (shifted) endpoint.
router.post('/:id/endpoints/delete', async (req, res) => {
  const proj = await ownsProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  const col = await db.prepare('SELECT * FROM collections WHERE id = ? AND project_id = ?').get(req.params.id, req.params.projectId);
  if (!col) return res.status(404).json({ error: 'Collection not found — it may have been deleted in another session.' });

  const rawIndices = Array.isArray(req.body.indices) ? req.body.indices : [req.body.index];
  const indices = rawIndices.map(Number);
  if (!indices.length || indices.some(i => Number.isNaN(i))) {
    return res.status(400).json({ error: 'indices (array of endpoint indices) or index (single) is required' });
  }

  let endpoints = [];
  try { endpoints = JSON.parse(col.json_content || '[]'); } catch { return res.status(400).json({ error: 'Invalid collection data' }); }
  const toDelete = [...new Set(indices)].filter(i => i >= 0 && i < endpoints.length);
  if (!toDelete.length) return res.status(400).json({ error: 'No valid endpoint indices to delete' });

  const remaining = endpoints.filter((_, i) => !toDelete.includes(i));
  await db.prepare('UPDATE collections SET json_content = ? WHERE id = ?').run(JSON.stringify(remaining), req.params.id);

  const envRows = await db.prepare('SELECT id, config_json FROM collection_env_config WHERE collection_id = ?').all(req.params.id);
  for (const row of envRows) {
    let cfg = {};
    try { cfg = JSON.parse(row.config_json || '{}'); } catch {}
    const reindexed = reindexAfterEndpointRemoval(cfg, toDelete);
    await db.prepare('UPDATE collection_env_config SET config_json = ? WHERE id = ?').run(JSON.stringify(reindexed), row.id);
  }

  const updatedCol = await db.prepare('SELECT * FROM collections WHERE id = ?').get(req.params.id);

  // Sync the workspace's config.json snapshot, same as the PUT route above — otherwise it
  // keeps listing endpoints that no longer exist until some unrelated edit refreshes it.
  try {
    const { getUserProjectPath, isAdminWorkspace } = require('../utils/projectFolders');
    const callerUser = await db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId);
    const projRow = await db.prepare('SELECT name FROM projects WHERE id = ?').get(req.params.projectId);
    const userProjPath = await getUserProjectPath(req.userId, callerUser?.role, projRow?.name || '', req.params.projectId);
    if (userProjPath) await require('./git').ensureGitWorkspaceHydrated(path.dirname(userProjPath), req.params.projectId, req.userId);
    if (userProjPath && !isAdminWorkspace(userProjPath)) writeCollectionConfig(updatedCol, userProjPath, req.userId);
  } catch (e) {
    console.warn('[Collections] Config sync after endpoint delete failed:', e.message);
  }

  res.json({ collection: updatedCol, deletedCount: toDelete.length });
});

module.exports = router;
module.exports.autoPopulateProjectConfig = autoPopulateProjectConfig;
