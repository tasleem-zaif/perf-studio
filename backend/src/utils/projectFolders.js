const path   = require('path');
const { mkdirSync, writeFileSync, existsSync, rmSync, readdirSync } = require('fs');
const { execSync } = require('child_process');
const db = require('../db');

// Each project has its own isolated workspace under git-workspaces/<ProjectName>/admin/
const GIT_WORKSPACES_ROOT = process.env.GIT_WORKSPACES_ROOT
  || path.join(__dirname, '..', '..', '..', 'git-workspaces');

// Legacy path — kept for backward compat with projects initialized before per-project workspaces
const ADMIN_PROJECTS_ROOT = path.join(GIT_WORKSPACES_ROOT, 'admin', 'projects');

// PROJECTS_ROOT points to the workspaces root so all per-project workspaces are accessible
const PROJECTS_ROOT = process.env.PROJECTS_ROOT || GIT_WORKSPACES_ROOT;
// Backups live inside git-workspaces/_backups/ so org admins can find them
// alongside their project workspaces — not buried in the app root.
const BACKUPS_ROOT  = process.env.BACKUPS_ROOT  || path.join(GIT_WORKSPACES_ROOT, '_backups');

/** Sanitise a name for use as a folder name */
function cleanName(name) {
  return (name || 'unnamed')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '') || 'unnamed';
}

/** Convert a user's display name to a safe folder slug, e.g. "Jane Doe" → "jane-doe" */
function userNameSlug(name) {
  return (name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || null;
}

/** Resolve the folder name for a given user: their display-name slug, falling back to user-{id} */
async function resolveUserFolder(userId) {
  try {
    const row = await db.prepare('SELECT name FROM users WHERE id = ?').get(userId);
    const slug = userNameSlug(row?.name);
    return slug || `user-${userId}`;
  } catch {
    return `user-${userId}`;
  }
}

/**
 * Resolve the organization slug that owns a given project — used as the top-level
 * grouping segment in S3 (the bucket is shared across every org/project, unlike local
 * disk which is already segregated by directory tree per deployment).
 * Falls back to 'unassigned' for projects owned by an org-less super_admin, or if the
 * project/lookup can't be resolved (e.g. project already deleted) — this keeps the S3
 * key derivation total (never throws) so a sync call never fails purely because org
 * lookup came up empty.
 */
async function resolveOrgSlugForProject(projectId) {
  try {
    const row = await db.prepare(`
      SELECT o.slug FROM projects p
      JOIN users u ON u.id = p.user_id
      LEFT JOIN organizations o ON o.id = u.org_id
      WHERE p.id = ?
    `).get(projectId);
    return row?.slug || 'unassigned';
  } catch {
    return 'unassigned';
  }
}

/** Add a .gitkeep to every directory in the tree so git tracks empty folders */
function addGitkeepAll(dir) {
  if (!existsSync(dir)) return;
  const gk = path.join(dir, '.gitkeep');
  if (!existsSync(gk)) writeFileSync(gk, '');
  const { readdirSync, statSync } = require('fs');
  for (const entry of readdirSync(dir)) {
    if (entry === '.git' || entry === '.gitkeep') continue;
    const full = path.join(dir, entry);
    try { if (statSync(full).isDirectory()) addGitkeepAll(full); } catch {}
  }
}

/**
 * Resolves the workspace ROOT for a given project+actor — the directory that either
 * already contains (or will contain) that actor's `.git`. Backward-compatible by design,
 * added when an `<Organization>` segment was introduced as the parent of `<Project>`:
 * if this exact project+actor already has real content at the pre-org location
 * (`git-workspaces/<Project>/<actor>/`), that location is returned UNCHANGED, forever —
 * nothing is ever migrated or moved, and no existing project is affected by this at all.
 * Only a project+actor with NOTHING created yet at the old location gets the new
 * `git-workspaces/<Organization>/<Project>/<actor>/` structure, and only if an org slug
 * was actually resolvable — if not, it falls back to the old (org-less) location rather
 * than guess, so a caller that can't resolve org never produces a wrong/inconsistent path.
 */
function resolveWorkspaceRoot(cleanProjectName, actorFolder, orgSlug) {
  const oldRoot = path.join(GIT_WORKSPACES_ROOT, cleanProjectName, actorFolder);
  let hasOldContent = false;
  try { hasOldContent = existsSync(oldRoot) && readdirSync(oldRoot).length > 0; } catch (_) {}
  if (hasOldContent || !orgSlug) return oldRoot;
  return path.join(GIT_WORKSPACES_ROOT, cleanName(orgSlug), cleanProjectName, actorFolder);
}

/**
 * Build the project folder path for the admin workspace.
 * git-workspaces/<Organization>/<ProjectName>/admin/ for a brand-new project, or the
 * pre-existing git-workspaces/<ProjectName>/admin/ if that already has content — see
 * resolveWorkspaceRoot().
 */
function getProjectPath(projectName, orgSlug) {
  return resolveWorkspaceRoot(cleanName(projectName), 'admin', orgSlug);
}

/**
 * Create the project folder in git-workspaces/[<Organization>/]<ProjectName>/admin/
 * Adds .gitkeep so the empty folder is tracked by git.
 */
async function ensureProjectFolders(projectName, projectId) {
  const orgSlug = projectId ? await resolveOrgSlugForProject(projectId) : null;
  const base = getProjectPath(projectName, orgSlug);
  mkdirSync(base, { recursive: true });
  addGitkeepAll(base);
  return base;
}

/**
 * Build the collection env path inside a project folder.
 * Structure: projectPath / CollectionName / Env
 */
/** Get path to a specific collection + env folder */
function getCollectionPath(projectFolderPath, collectionName, env) {
  return path.join(projectFolderPath, cleanName(collectionName), cleanName(env || 'Default'));
}

/**
 * Resolves the env a collection-scoped test suite's results/scripts should live under,
 * even when `suite.env` itself is blank — falls back to the collection's own default
 * env instead of leaving the caller to fall back all the way to a bare project-level
 * folder. A suite with a collection should always land under <Collection>/<Env>/...;
 * the project-level fallback is only legitimate for a suite with NO collection at all.
 */
function resolveSuiteEnv(collection, suite) {
  if (suite?.env) return suite.env;
  if (!collection) return null;
  try {
    const envs = JSON.parse(collection.environments || '[]');
    if (envs.length) return envs[0];
  } catch (_) {}
  return collection.environment || 'Default';
}

/**
 * Create folder structure for ONE environment and return the env path.
 * Used by collection save/update per environment.
 * Returns: projectPath/CollectionName/Env/
 */
function ensureCollectionFolders(projectFolderPath, collectionName, env) {
  const envDir = path.join(projectFolderPath, cleanName(collectionName), cleanName(env || 'Default'));
  for (const sub of ['config', 'testData', 'script', 'results']) {
    mkdirSync(path.join(envDir, sub), { recursive: true });
  }
  addGitkeepAll(envDir);
  // Also add .gitkeep to collection root
  const colDir = path.join(projectFolderPath, cleanName(collectionName));
  const gk = path.join(colDir, '.gitkeep');
  if (!existsSync(gk)) writeFileSync(gk, '');
  return envDir; // returns the env-specific path
}

/**
 * Create folder structure for ALL environments at once.
 * Used during git init and when creating collection with multiple envs.
 */
function ensureAllEnvFolders(projectFolderPath, collectionName, environments) {
  const colDir = path.join(projectFolderPath, cleanName(collectionName));
  const envList = Array.isArray(environments) && environments.length ? environments : ['Default'];
  for (const env of envList) {
    ensureCollectionFolders(projectFolderPath, collectionName, env);
  }
  addGitkeepAll(colDir);
  return colDir;
}

function deleteProjectFolder(folderPath) {
  if (folderPath && existsSync(folderPath)) {
    try { rmSync(folderPath, { recursive: true, force: true }); } catch (_) {}
  }
}

function buildBackupZipName(projectName, projectId) {
  const safe = (projectName || 'project').replace(/[^a-zA-Z0-9_-]/g, '_');
  const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${safe}_${projectId}_${ts}.zip`;
}

/**
 * PAT-mode backup: folderPath has no real local directory at all — build the zip directly
 * from whatever's currently in S3 under that workspace's prefix (which already holds the
 * full working-tree state, .git internals included, per gitEngine.js's session model — the
 * exact equivalent of "the local folder" in the old disk-based design), stream it straight
 * into an S3 multipart upload, then tombstone the workspace's S3 objects now that they're
 * captured in the backup. Never touches local disk.
 */
async function backupS3Workspace(folderPath, projectName, projectId, orgSlug) {
  const s3Sync = require('./s3Sync');
  const archiver = require('archiver');
  const baseKey = s3Sync.toKey(folderPath, orgSlug);
  if (!baseKey) return null;
  const keys = await s3Sync.listAllKeys(baseKey);
  if (!keys.length) return null;

  const zipName = buildBackupZipName(projectName, projectId);
  const backupKey = s3Sync.toKey(path.join(BACKUPS_ROOT, zipName), orgSlug);
  if (!backupKey) return null;

  const archive = archiver('zip', { zlib: { level: 6 } });
  const chunks = [];
  archive.on('data', c => chunks.push(c));
  const done = new Promise((resolve, reject) => { archive.on('end', resolve); archive.on('error', reject); });
  for (const key of keys) {
    const res = await s3Sync.getBuffer(key);
    if (res.ok) archive.append(res.data, { name: key.slice(baseKey.length + 1) });
  }
  archive.finalize();
  await done;

  const upload = await s3Sync.putBuffer(backupKey, Buffer.concat(chunks));
  if (!upload.ok) return null;
  await s3Sync.deleteAllUnderPrefix(baseKey); // tombstone — now durably captured in the backup
  return backupKey;
}

/**
 * folderPath is a real local directory (SSH-mode workspace) or a path-SHAPED naming string
 * with no local presence at all (PAT-mode, S3-only) — ownerUserId (the project owner, whose
 * workspace this backs up) determines which. Returns the local zip path (SSH) or the S3
 * backup key (PAT), or null if there was nothing to back up.
 */
async function backupAndDeleteProjectFolder(folderPath, projectName, projectId, orgSlug, ownerUserId) {
  if (ownerUserId) {
    const identity = await db.prepare('SELECT auth_method FROM user_git_configs WHERE user_id = ? AND project_id = ?').get(ownerUserId, projectId);
    if ((identity?.auth_method || 'pat') !== 'ssh') {
      return backupS3Workspace(folderPath, projectName, projectId, orgSlug);
    }
  }

  return new Promise((resolve) => {
    if (!folderPath || !existsSync(folderPath)) { resolve(null); return; }
    mkdirSync(BACKUPS_ROOT, { recursive: true });
    const zipName = buildBackupZipName(projectName, projectId);
    const zipPath = path.join(BACKUPS_ROOT, zipName);
    try {
      if (process.platform === 'win32') {
        const src  = folderPath.replace(/'/g, "''");
        const dest = zipPath.replace(/'/g, "''");
        execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${src}' -DestinationPath '${dest}' -Force"`, { timeout: 120000 });
      } else {
        execSync(`zip -r "${zipPath}" "${folderPath}"`, { timeout: 120000 });
      }
    } catch (_) {}
    try { rmSync(folderPath, { recursive: true, force: true }); } catch (_) {}
    const zipExists = existsSync(zipPath);
    if (zipExists) {
      // Mirror the backup zip to S3 too — lazy require avoids a circular dependency
      // (s3Sync.js itself requires this module for the root path constants).
      require('./s3Sync').uploadFile(zipPath, orgSlug).then(up => {
        if (!up.ok && !up.skipped) console.error('[ProjectFolders] S3 sync failed for', zipPath, ':', up.error?.message);
      });
    }
    resolve(zipExists ? zipPath : null);
  });
}

/**
 * Get the project path inside a specific user's git workspace.
 * Admin   → git-workspaces/ProjectName/admin/
 * User-3  → git-workspaces/ProjectName/user-3/
 */
/**
 * Returns the project content path inside a user's git workspace.
 * Structure: git-workspaces/[<Organization>/]<ProjectName>/<userName>/<ProjectName>/
 * The outer <ProjectName> is the workspace bucket; <userName> is the git repo root;
 * the inner <ProjectName> is the content subfolder where collections/scripts live.
 * `projectId` is optional (4th arg) — pass it whenever available so a brand-new project
 * gets the org-prefixed structure; omitting it is safe (falls back to the pre-org
 * location) but means this specific call site won't see the new structure for a project
 * that only ever gets touched through it — see resolveWorkspaceRoot().
 */
async function getUserProjectPath(userId, userRole, projectName, projectId) {
  const userFolder = await resolveUserFolder(userId);
  const orgSlug = projectId ? await resolveOrgSlugForProject(projectId) : null;
  const root = resolveWorkspaceRoot(cleanName(projectName), userFolder, orgSlug);
  return path.join(root, cleanName(projectName));
}

/**
 * Returns true if the user is an org_admin or super_admin.
 * Replaces the old path-based /admin check now that workspace folders use real user names.
 */
function isAdminWorkspace(workspacePath) {
  // workspacePath is kept for backward-compat signature — we now check by user role via DB.
  // Callers that have the userId should prefer isAdminUser(userId) directly.
  return false; // deprecated path-based check — always return false; callers use role check
}

module.exports = {
  isAdminWorkspace,
  getProjectPath,
  ensureProjectFolders,
  getCollectionPath,
  resolveSuiteEnv,
  ensureCollectionFolders,
  ensureAllEnvFolders,
  getUserProjectPath,
  resolveUserFolder,
  resolveOrgSlugForProject,
  resolveWorkspaceRoot,
  deleteProjectFolder,
  backupAndDeleteProjectFolder,
  PROJECTS_ROOT,
  ADMIN_PROJECTS_ROOT,
  GIT_WORKSPACES_ROOT,
  BACKUPS_ROOT,
  cleanName,
};
