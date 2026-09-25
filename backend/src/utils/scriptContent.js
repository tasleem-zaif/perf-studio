/**
 * scriptContent.js — read/back up a test suite's own plaintext script content
 *
 * Extracted out of autoHealer.js so both auto-heal and the CI decrypt-serving endpoint
 * (ciPipeline.js's POST /api/ci/scripts/decrypt) share one read path instead of duplicating
 * the PAT/SSH branching. This always resolves to Peako's own internal working copy — never the
 * encrypted copy that gets pushed into a customer's git repo (see scriptEncryption.js for that
 * separate, write-only path).
 *
 * SSH-mode's plaintext copy already lives on real disk (+ S3 mirror), separate from whatever
 * gets pushed to git, so reading it back is a plain file read. PAT-mode has no such separation —
 * the git session IS the only place the script lives, and that session is exactly what gets
 * pushed externally — so ciPipeline.js's /trigger route calls backupPatScriptPlaintext() to save
 * a copy here (S3, keyed by suite id) at the same moment it encrypts the session's copy for
 * pushing. readScriptContent() below checks this backup first for PAT-mode suites, falling back
 * to the (now possibly-encrypted) git session only for suites pushed before this backup existed.
 */

const fs = require('fs');
const path = require('path');
const db = require('../db');
const { resolveOrgSlugForProject } = require('./projectFolders');
const gitEngine = require('./gitEngine');
const s3Sync = require('./s3Sync');

function patBackupKey(orgSlug, suiteId, scriptPath) {
  const ext = (scriptPath || '').split('.').pop() || 'jmx';
  const cleanSlug = (orgSlug || 'unassigned').replace(/[^a-zA-Z0-9_-]/g, '_');
  return `peako-script-backups/${cleanSlug}/${suiteId}.${ext}`;
}

/** Save a PAT-mode suite's plaintext content to its S3 backup, ahead of encrypting the copy that gets pushed to git. */
async function backupPatScriptPlaintext(suiteId, projectId, plaintext, scriptPath) {
  const orgSlug = await resolveOrgSlugForProject(projectId);
  const key = patBackupKey(orgSlug, suiteId, scriptPath);
  const result = await s3Sync.putBuffer(key, Buffer.from(plaintext, 'utf8'));
  if (!result.ok && !result.skipped) console.error('[ScriptContent] PAT plaintext backup failed for', key, ':', result.error?.message);
  return result;
}

// scriptPath (test_suites.jmx_path/js_path) is only a real disk path for SSH-mode
// workspaces. PAT-mode workspaces (the normal setup for a CI-triggered run — see
// ciPipeline.js's pushJmxAndTriggerGitHub for the identical fix) store it as a path
// RELATIVE to the project's gitEngine session root instead, so fs.existsSync(scriptPath)
// always returned false there and the AI diagnosis was handed "(script file not found)"
// regardless of engine — this was never actually about JMeter vs k6.
async function readScriptContent(run, suite, scriptPath) {
  if (!scriptPath) return '';
  const identity = await db.prepare('SELECT auth_method FROM user_git_configs WHERE user_id = ? AND project_id = ?').get(suite.user_id, run.project_id);
  const isSSH = (identity?.auth_method || 'pat') === 'ssh';

  if (isSSH) {
    return fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, 'utf8') : '';
  }

  // PAT-mode: prefer the plaintext S3 backup (written at the same moment the git-pushed copy
  // was encrypted) over the git session, which now holds ciphertext for any suite that's ever
  // been pushed through the encrypted /trigger path.
  try {
    const orgSlug = await resolveOrgSlugForProject(run.project_id);
    const backup = await s3Sync.getBuffer(patBackupKey(orgSlug, suite.id, scriptPath));
    if (backup.ok) return backup.data.toString('utf8');
  } catch (e) {
    console.warn('[ScriptContent] PAT plaintext backup read failed, falling back to git session:', e.message);
  }

  // Fallback — suites pushed before this backup existed, or S3 unavailable/disabled. Reads
  // whatever's actually in the git session, which is plaintext only for such pre-existing suites.
  try {
    const gitCfg  = await db.prepare('SELECT git_root FROM git_configs WHERE project_id = ?').get(run.project_id);
    const projRow = await db.prepare('SELECT folder_path FROM projects WHERE id = ?').get(run.project_id);
    const root    = gitCfg?.git_root || projRow?.folder_path;
    if (!root) return '';
    const orgSlug = await resolveOrgSlugForProject(run.project_id);
    const session = await gitEngine.openSession(root, orgSlug);
    const full    = path.posix.join(session.dir, scriptPath.replace(/\\/g, '/'));
    return session.fs.existsSync(full) ? session.fs.readFileSync(full, 'utf8') : '';
  } catch (e) {
    console.warn('[ScriptContent] Could not read script from PAT-mode session:', e.message);
    return '';
  }
}

module.exports = { readScriptContent, backupPatScriptPlaintext };
