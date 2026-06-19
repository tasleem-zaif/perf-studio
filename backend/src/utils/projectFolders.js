const path   = require('path');
const { mkdirSync, writeFileSync, existsSync, rmSync } = require('fs');
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
function resolveUserFolder(userId) {
  try {
    const row = db.prepare('SELECT name FROM users WHERE id = ?').get(userId);
    const slug = userNameSlug(row?.name);
    return slug || `user-${userId}`;
  } catch {
    return `user-${userId}`;
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
 * Build the project folder path for the admin workspace.
 * Each project has its own isolated workspace: git-workspaces/<ProjectName>/admin/
 */
function getProjectPath(projectName) {
  return path.join(GIT_WORKSPACES_ROOT, cleanName(projectName), 'admin');
}

/**
 * Create the project folder in git-workspaces/admin/projects/<ProjectName>/
 * Adds .gitkeep so the empty folder is tracked by git.
 */
function ensureProjectFolders(projectName) {
  const base = getProjectPath(projectName);
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

function backupAndDeleteProjectFolder(folderPath, projectName, projectId) {
  return new Promise((resolve) => {
    if (!folderPath || !existsSync(folderPath)) { resolve(null); return; }
    mkdirSync(BACKUPS_ROOT, { recursive: true });
    const safe    = (projectName || 'project').replace(/[^a-zA-Z0-9_-]/g, '_');
    const ts      = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const zipName = `${safe}_${projectId}_${ts}.zip`;
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
    resolve(existsSync(zipPath) ? zipPath : null);
  });
}

/**
 * Get the project path inside a specific user's git workspace.
 * Admin   → git-workspaces/ProjectName/admin/
 * User-3  → git-workspaces/ProjectName/user-3/
 */
/**
 * Returns the project content path inside a user's git workspace.
 * Structure: git-workspaces/<ProjectName>/<userName>/<ProjectName>/
 * The outer <ProjectName> is the workspace bucket; <userName> is the git repo root;
 * the inner <ProjectName> is the content subfolder where collections/scripts live.
 */
function getUserProjectPath(userId, userRole, projectName) {
  const userFolder = resolveUserFolder(userId);
  return path.join(GIT_WORKSPACES_ROOT, cleanName(projectName), userFolder, cleanName(projectName));
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
  ensureCollectionFolders,
  ensureAllEnvFolders,
  getUserProjectPath,
  resolveUserFolder,
  deleteProjectFolder,
  backupAndDeleteProjectFolder,
  PROJECTS_ROOT,
  ADMIN_PROJECTS_ROOT,
  GIT_WORKSPACES_ROOT,
  BACKUPS_ROOT,
  cleanName,
};
