const path   = require('path');
const { mkdirSync, rmSync, existsSync } = require('fs');
const { execSync } = require('child_process');

const PROJECTS_ROOT = process.env.PROJECTS_ROOT || path.join(__dirname, '..', '..', '..', 'projects');
const BACKUPS_ROOT  = process.env.BACKUPS_ROOT  || path.join(__dirname, '..', '..', '..', 'backups');

/**
 * Build the project folder path.
 * New format: PROJECTS_ROOT / ProjectName_ID_UUIDshort
 * Legacy format (env-based) is preserved for existing projects via stored folder_path.
 */
function getProjectPath(projectName, projectId, uuidOrEnv) {
  const safe = projectName.replace(/[^a-zA-Z0-9_-]/g, '_');

  // Numeric uuid = new format: ProjectName_ID_123456 (flat, no env subfolder)
  // Non-numeric = legacy env-based format (backward compat with existing projects)
  const isNumericUuid = uuidOrEnv && /^\d{4,}$/.test(String(uuidOrEnv));
  if (isNumericUuid) {
    return path.join(PROJECTS_ROOT, `${safe}_${projectId}_${uuidOrEnv}`);
  }
  // Legacy env-based format
  const safeEnv = (uuidOrEnv || 'Default').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(PROJECTS_ROOT, safeEnv, `${safe}_${projectId}`);
}

function ensureProjectFolders(projectName, projectId, uuidOrEnv) {
  const base = getProjectPath(projectName, projectId, uuidOrEnv);
  mkdirSync(base, { recursive: true }); // project root only — subfolders live under collections
  return base;
}

/**
 * Build and create the folder for a collection inside a project.
 * Structure: projectPath / CollectionName_colId / Env / config|testData|script|results
 */
function getCollectionPath(projectFolderPath, collectionName, collectionId, env) {
  const safeName = (collectionName || 'Collection').replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeEnv  = (env || 'Default').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(projectFolderPath, `${safeName}_${collectionId}`, safeEnv);
}

function ensureCollectionFolders(projectFolderPath, collectionName, collectionId, env) {
  const base = getCollectionPath(projectFolderPath, collectionName, collectionId, env);
  ['config', 'testData', 'script', 'results'].forEach(sub =>
    mkdirSync(path.join(base, sub), { recursive: true })
  );
  return base;
}

function deleteProjectFolder(folderPath) {
  if (folderPath && existsSync(folderPath)) {
    try { rmSync(folderPath, { recursive: true, force: true }); } catch (_) {}
  }
}

// Zips the project folder to backups/ using platform-native commands, then deletes original.
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
    } catch (_) {
      // Backup failed — continue with deletion
    }

    try { rmSync(folderPath, { recursive: true, force: true }); } catch (_) {}
    resolve(existsSync(zipPath) ? zipPath : null);
  });
}

module.exports = {
  getProjectPath,
  ensureProjectFolders,
  getCollectionPath,
  ensureCollectionFolders,
  deleteProjectFolder,
  backupAndDeleteProjectFolder,
  PROJECTS_ROOT,
  BACKUPS_ROOT,
};
