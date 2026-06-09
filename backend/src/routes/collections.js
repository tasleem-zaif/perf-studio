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
const { parseCollection } = require('../utils/parseCollection');
const { ensureCollectionFolders, ensureAllEnvFolders, getUserProjectPath } = require('../utils/projectFolders');

/**
 * Auto-populate project config URLs from a collection's parsed endpoints.
 * Extracts unique protocol+hostname+port combinations and merges them into
 * the project_config without overwriting existing manual entries.
 */
function autoPopulateProjectConfig(projectId, jsonContent, collectionId) {
  try {
    const endpoints = JSON.parse(jsonContent || '[]');
    if (!endpoints.length) return;

    const urlSets = [];
    const seen = new Set();

    for (const ep of endpoints) {
      const rawUrl = ep.url || ep.path || '';
      if (!rawUrl) continue;
      try {
        if (rawUrl.startsWith('/') && !rawUrl.includes('://')) continue;
        const raw = rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`;
        const u = new URL(raw);
        const protocol = u.protocol.replace(':', '');
        const hostname  = u.hostname;
        if (!hostname) continue;
        const port = u.port || (protocol === 'https' ? '443' : '80');
        const key  = `${protocol}|${hostname}|${port}`;
        if (!seen.has(key)) { seen.add(key); urlSets.push({ protocol, url: hostname, port }); }
      } catch { continue; }
    }

    if (!urlSets.length) return;

    // Only populate project_config as a general reference/default.
    // Each environment's config (collection_env_config) must be set MANUALLY
    // by the user because QA, Staging, UAT each point to different servers.
    const existing = db.prepare('SELECT config_json FROM project_config WHERE project_id = ?').get(projectId);
    const cfg      = existing ? JSON.parse(existing.config_json || '{}') : {};
    const existingKeys = new Set((cfg.urls || []).map(u => `${u.protocol}|${u.url}|${u.port}`));
    const newUrls      = urlSets.filter(u => !existingKeys.has(`${u.protocol}|${u.url}|${u.port}`));
    if (newUrls.length) {
      cfg.urls = [...(cfg.urls || []), ...newUrls];
      if (existing) {
        db.prepare('UPDATE project_config SET config_json = ? WHERE project_id = ?').run(JSON.stringify(cfg), projectId);
      } else {
        db.prepare('INSERT INTO project_config (project_id, config_json) VALUES (?, ?)').run(projectId, JSON.stringify(cfg));
      }
      console.log(`[Collections] Auto-populated ${newUrls.length} URL(s) into project ${projectId} config (reference only)`);
    }
    // ── Also populate collection_env_config for each env (same URL as starting point) ──
    // User can then edit each env to point to their specific server.
    // Only sets URL if the env config doesn't already have one (never overwrites user edits).
    if (collectionId) {
      const col = db.prepare('SELECT environments, environment FROM collections WHERE id = ?').get(collectionId);
      let envs = [];
      try { envs = JSON.parse(col?.environments || '[]'); } catch {}
      if (!envs.length && col?.environment) envs = [col.environment];

      for (const env of envs) {
        const envRow = db.prepare(
          'SELECT config_json FROM collection_env_config WHERE collection_id = ? AND env = ?'
        ).get(collectionId, env);
        const envCfg  = envRow ? JSON.parse(envRow.config_json || '{}') : {};
        const hasUrls = (envCfg.urls || []).some(u => u.url); // has user-set URLs already

        if (!hasUrls) {
          // No user URLs yet — auto-fill as starting point
          envCfg.urls = urlSets;
          if (envRow) {
            db.prepare('UPDATE collection_env_config SET config_json = ? WHERE collection_id = ? AND env = ?')
              .run(JSON.stringify(envCfg), collectionId, env);
          } else {
            db.prepare('INSERT INTO collection_env_config (collection_id, env, config_json) VALUES (?, ?, ?)')
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
function setupCollectionFolder(proj, colId, colName, env, sourceContent, sourceType, originalFilename, userId, userRole) {
  const caller = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
  const role   = caller?.role || userRole;
  const userProjectPath = getUserProjectPath(userId, role, proj.name);
  if (!userProjectPath) return null;

  // Admin workspace holds only empty folders — skip all file writes for admin
  const { isAdminWorkspace } = require('../utils/projectFolders');
  if (isAdminWorkspace(userProjectPath)) {
    // Still create the empty folder structure but write nothing inside
    try { require('../utils/projectFolders').ensureCollectionFolders(userProjectPath, colName, env); } catch (_) {}
    return null;
  }

  // Ensure the workspace is a proper git repo (clone if .git missing)
  const { GIT_WORKSPACES_ROOT } = require('../utils/projectFolders');
  const userFolder = (role === 'org_admin' || role === 'super_admin') ? 'admin' : `user-${userId}`;
  const gitRoot    = path.join(GIT_WORKSPACES_ROOT, userFolder);
  const gitDotDir  = path.join(gitRoot, '.git');

  if (!fs.existsSync(gitDotDir)) {
    // No .git yet — try to clone from remote so git can track files
    try {
      const gitCfg = db.prepare('SELECT * FROM git_configs WHERE project_id = ?').get(proj.id);
      if (gitCfg?.remote_url && gitCfg?.is_initialized) {
        const { decrypt } = require('../utils/encryption');
        const identity    = db.prepare('SELECT auth_token FROM user_git_configs WHERE user_id = ? AND project_id = ?').get(userId, proj.id);
        const rawToken    = identity?.auth_token ? decrypt(identity.auth_token)
          : gitCfg.auth_token ? decrypt(gitCfg.auth_token) : '';
        if (rawToken) {
          const u = new URL(gitCfg.remote_url);
          u.username = rawToken;
          u.password = rawToken;
          const remoteWithAuth = u.toString();
          fs.mkdirSync(gitRoot, { recursive: true });
          require('simple-git')().clone(remoteWithAuth, gitRoot).catch(() => {});
        }
      }
    } catch (_) {}
  }

  try {
    const base = ensureCollectionFolders(userProjectPath, colName, env);
    // Save original source file to testData/
    if (sourceContent) {
      const ext  = sourceType === 'swagger' ? (originalFilename?.endsWith('.yaml') || originalFilename?.endsWith('.yml') ? '.yaml' : '.json') : '.json';
      const safeName = (colName || 'collection').replace(/[^a-zA-Z0-9_-]/g, '_');
      const dest = path.join(base, 'testData', `${safeName}_source${ext}`);
      fs.writeFileSync(dest, sourceContent, 'utf8');
    }
    return base;
  } catch (e) {
    console.error('[Collections] Folder setup failed:', e.message);
    return null;
  }
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.use(auth);

router.get('/', (req, res) => {
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const collections = db.prepare('SELECT * FROM collections WHERE project_id = ? ORDER BY created_at DESC').all(req.params.projectId);
  res.json({ collections });
});

router.post('/parse-curl', (req, res) => {
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

router.post('/', upload.single('file'), (req, res) => {
  const proj = ownsProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  const { name, description, source_type, tool_target } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });

  const envsArr   = parseEnvs(req);         // ["QA", "Staging", ...]
  const envFirst  = envsArr[0] || 'Default'; // backward-compat single env

  let json_content = '[]';
  let source_content = req.body.source_content || '';
  const originalFilename = req.file?.originalname || '';
  if (req.file) source_content = req.file.buffer.toString('utf8');

  const stype = source_type || 'json';

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

  const result = db.prepare(
    `INSERT INTO collections (project_id, name, description, json_content, source_type, source_content, tool_target, environment, environments)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(req.params.projectId, name, description || '', json_content, stype, source_content,
        tool_target || 'jmeter', envFirst, JSON.stringify(envsArr));

  const colId = result.lastInsertRowid;

  // Create folder structure for EACH selected environment
  let firstFolderPath = null;
  for (const env of envsArr) {
    const fp = setupCollectionFolder(proj, colId, name, env, source_content, stype, originalFilename, req.userId);
    if (fp && !firstFolderPath) firstFolderPath = fp;
  }
  // Store the collection base path (parent of all env folders)
  if (firstFolderPath) {
    const basePath = require('path').dirname(firstFolderPath); // CollectionName_ID/
    db.prepare('UPDATE collections SET folder_path = ? WHERE id = ?').run(basePath, colId);
  }

  const savedCol = db.prepare('SELECT * FROM collections WHERE id = ?').get(colId);
  const callerRow = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId);
  const userProjPath = getUserProjectPath(req.userId, callerRow?.role, savedCol.name ? db.prepare('SELECT name FROM projects WHERE id = ?').get(req.params.projectId)?.name : '');
  // Pass user's workspace path so config.json is written to the right location
  const projForConfig = db.prepare('SELECT name FROM projects WHERE id = ?').get(req.params.projectId);
  const userProjectPath = getUserProjectPath(req.userId, callerRow?.role, projForConfig?.name || '');
  writeCollectionConfig(savedCol, userProjectPath);
  // Auto-populate project config with URLs from this collection (non-blocking)
  setImmediate(() => autoPopulateProjectConfig(req.params.projectId, savedCol.json_content, colId));

  // Create folder structure in git-workspaces for all environments
  try {
    const { ensureCollectionFolders, ensureAllEnvFolders, getUserProjectPath } = require('../utils/projectFolders');
    const proj = db.prepare('SELECT folder_path FROM projects WHERE id = ?').get(req.params.projectId);
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

router.put('/:id', upload.single('file'), (req, res) => {
  const proj = ownsProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  const col = db.prepare('SELECT * FROM collections WHERE id = ? AND project_id = ?').get(req.params.id, req.params.projectId);
  if (!col) return res.status(404).json({ error: 'Not found' });

  const { name, description, source_type, tool_target } = req.body;
  const originalFilename = req.file?.originalname || '';
  let source_content = req.file ? req.file.buffer.toString('utf8') : (req.body.source_content || col.source_content);
  const stype    = source_type || col.source_type;
  const newName  = name || col.name;

  // Parse new environments
  let envsArr;
  if (req.body.environments !== undefined) {
    try { envsArr = JSON.parse(req.body.environments); } catch { envsArr = [req.body.environments]; }
  } else {
    try { envsArr = JSON.parse(col.environments || '[]'); } catch { envsArr = col.environment ? [col.environment] : ['Default']; }
  }
  const envFirst = envsArr[0] || 'Default';

  let json_content = col.json_content;
  if (req.file || req.body.source_content) {
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
    const fp = setupCollectionFolder(proj, col.id, newName, env, source_content, stype, originalFilename, req.userId);
    if (fp && !colBasePath) colBasePath = require('path').dirname(fp);
  }

  db.prepare(
    `UPDATE collections SET name=?, description=?, json_content=?, source_type=?, source_content=?, tool_target=?, environment=?, environments=?, folder_path=? WHERE id=?`
  ).run(newName, description ?? col.description, json_content, stype, source_content,
        tool_target || col.tool_target, envFirst, JSON.stringify(envsArr),
        colBasePath, req.params.id);

  const updatedCol = db.prepare('SELECT * FROM collections WHERE id = ?').get(req.params.id);
  // Re-populate project config if endpoints changed
  setImmediate(() => autoPopulateProjectConfig(req.params.projectId, updatedCol.json_content, updatedCol.id));

  // Sync folder structure + config.json in current user's workspace
  try {
    const { ensureAllEnvFolders, getUserProjectPath, cleanName } = require('../utils/projectFolders');
    const callerRole = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId)?.role;
    const projRow    = db.prepare('SELECT name FROM projects WHERE id = ?').get(req.params.projectId);
    const userProjPath = getUserProjectPath(req.userId, callerRole, projRow?.name || '');
    if (userProjPath) {
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
      writeCollectionConfig(updatedCol, userProjPath);
    }
  } catch (e) {
    console.warn('[Collections] Folder sync on edit failed:', e.message);
  }

  res.json({ collection: updatedCol });
});

router.delete('/:id', (req, res) => {
  const proj = ownsProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  const col = db.prepare('SELECT * FROM collections WHERE id = ? AND project_id = ?').get(req.params.id, req.params.projectId);
  if (!col) return res.status(404).json({ error: 'Not found' });

  // Delete the collection's folder from the current user's git workspace
  try {
    const callerRole = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId)?.role;
    const { getUserProjectPath, cleanName } = require('../utils/projectFolders');
    const userProjPath = getUserProjectPath(req.userId, callerRole, proj.name);
    if (userProjPath) {
      const colDir = path.join(userProjPath, cleanName(col.name));
      if (fs.existsSync(colDir)) {
        fs.rmSync(colDir, { recursive: true, force: true });
        console.log(`[Collections] Deleted folder: ${colDir}`);
      }
    }
  } catch (e) {
    console.warn('[Collections] Folder delete failed:', e.message);
  }

  db.prepare('DELETE FROM collections WHERE id = ?').run(req.params.id);
  resetSequence('collections');
  res.json({ ok: true });
});

module.exports = router;
module.exports.autoPopulateProjectConfig = autoPopulateProjectConfig;
