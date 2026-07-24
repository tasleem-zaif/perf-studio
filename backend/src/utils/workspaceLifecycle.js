const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const s3SyncDefault = require('./s3Sync');
const { GIT_WORKSPACES_ROOT } = require('./projectFolders');

// How long a workspace sits on local disk, confirmed-synced-but-untouched, before the sweep
// is allowed to actually delete it. Keeps a push immediately followed by another action on
// the same project (run a test, edit a collection) from ever paying a rehydration cost —
// only genuinely dormant workspaces get reclaimed.
const COOLDOWN_MS = Number(process.env.S3_WORKSPACE_COOLDOWN_MS) || 24 * 60 * 60 * 1000;

// Markers live outside every gitDir (not inside it) so they're never picked up by
// `git add .`, never uploaded as part of the working tree, and never need a .gitignore entry.
const DEFAULT_MARKERS_DIR = path.join(GIT_WORKSPACES_ROOT, '_sync-markers');

function markerPathFor(gitDir, markersDir = DEFAULT_MARKERS_DIR) {
  // Sanitize the absolute path directly (not path.relative to GIT_WORKSPACES_ROOT) so this
  // works for any gitDir, including ones outside the usual root (e.g. in tests).
  const safe = path.resolve(gitDir).replace(/[:\\/]+/g, '_');
  return path.join(markersDir, `${safe}.json`);
}

// Per-gitDir async lock — two concurrent requests hitting the same cold (or about-to-be-swept)
// workspace must never both clone/download, or one delete while another reads, at once.
const locks = new Map();
async function withWorkspaceLock(key, fn) {
  while (locks.has(key)) {
    await locks.get(key).catch(() => {});
  }
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  locks.set(key, held);
  try {
    return await fn();
  } finally {
    locks.delete(key);
    release();
  }
}

function runGit(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 15000 });
}

function gitStatusClean(gitDir) {
  const r = runGit(['status', '--porcelain'], gitDir);
  return r.status === 0 && (r.stdout || '').trim() === '';
}

function currentHead(gitDir) {
  const r = runGit(['rev-parse', 'HEAD'], gitDir);
  return r.status === 0 ? (r.stdout || '').trim() : null;
}

/**
 * Call right after a push has been *confirmed* to land on the remote (e.g. git.js's
 * verifyPushLanded) — never on a bare "push didn't throw." Uploads the working tree to S3
 * and, only if that upload is fully successful, records a marker (confirmed HEAD + time) that
 * makes this workspace eligible for later reclaim. Never deletes anything itself, and never
 * writes a marker on a partial/failed upload — a subsequent push gets another chance.
 */
async function markWorkspaceSyncedAfterPush({ gitDir, orgSlug, s3 = s3SyncDefault, markersDir = DEFAULT_MARKERS_DIR }) {
  if (!s3.isEnabled()) return { ok: false, skipped: true };
  const upload = await s3.uploadWorkingTree(gitDir, orgSlug);
  if (!upload.ok) return upload; // leave local untouched — no marker, nothing eligible for reclaim

  const head = currentHead(gitDir);
  if (!head) return { ok: false, error: new Error('markWorkspaceSyncedAfterPush: could not resolve local HEAD') };

  try {
    fs.mkdirSync(markersDir, { recursive: true });
    fs.writeFileSync(markerPathFor(gitDir, markersDir), JSON.stringify({ gitDir, orgSlug, headHash: head, uploadedAt: Date.now() }), 'utf8');
  } catch (error) {
    return { ok: false, error };
  }
  return { ok: true, headHash: head, uploaded: upload.uploaded };
}

/**
 * The retrieval-side gate: call before any route touches a git workspace's local files.
 * Fast path (workspace already on disk) returns immediately — zero S3/git calls, zero added
 * latency, which is the common case as long as the cooldown above is tuned sensibly.
 * Cold path (workspace missing/empty, e.g. reclaimed by the sweep) locks, restores git-tracked
 * content via the caller-supplied `restoreGitContent` (git.js already owns clone/checkout/auth
 * logic via `ensureUserWorkspace` — this module has no opinion on git auth, only on lifecycle),
 * then downloads anything else from S3 (results/, which git never tracked). Clears any stale
 * marker once warm again, since the workspace is no longer in a "confirmed synced" state.
 */
async function ensureWorkspaceHydrated({ gitDir, orgSlug, restoreGitContent, s3 = s3SyncDefault, markersDir = DEFAULT_MARKERS_DIR }) {
  const isWarm = () => fs.existsSync(gitDir) && fs.existsSync(path.join(gitDir, '.git'));
  if (isWarm()) return { hydrated: false, alreadyWarm: true };

  return withWorkspaceLock(gitDir, async () => {
    if (isWarm()) return { hydrated: false, alreadyWarm: true }; // another request won the race

    const restoreResult = await restoreGitContent();

    let s3Result = { ok: true, skipped: true };
    if (s3.isEnabled()) {
      s3Result = await s3.downloadDir(gitDir, orgSlug);
      if (!s3Result.ok && !s3Result.skipped) {
        console.error('[WorkspaceLifecycle] S3 hydrate failed for', gitDir, ':', s3Result.failed?.length, 'file(s)');
      }
    }

    try { fs.unlinkSync(markerPathFor(gitDir, markersDir)); } catch (_) {}

    return { hydrated: true, restoreResult, s3Result };
  });
}

/**
 * The only place that actually deletes a workspace's local copy. Deliberately decoupled in
 * time from the push that made it eligible (see COOLDOWN_MS) and re-verifies, at delete time,
 * that nothing has changed since the marker was written — same HEAD, clean working tree — so
 * it never deletes local work that was never confirmed uploaded. Intended to run on an
 * interval (see index.js), not per-request.
 */
async function sweepStaleWorkspaces({ cooldownMs = COOLDOWN_MS, markersDir = DEFAULT_MARKERS_DIR } = {}) {
  const swept = [];
  const skipped = [];
  if (!fs.existsSync(markersDir)) return { swept, skipped };

  for (const file of safeReaddir(markersDir)) {
    if (!file.endsWith('.json')) continue;
    const markerFile = path.join(markersDir, file);
    let marker;
    try { marker = JSON.parse(fs.readFileSync(markerFile, 'utf8')); } catch { continue; }
    const { gitDir, uploadedAt, headHash } = marker || {};
    if (!gitDir) { try { fs.unlinkSync(markerFile); } catch (_) {} continue; }

    if (!fs.existsSync(gitDir)) { try { fs.unlinkSync(markerFile); } catch (_) {} continue; } // already gone
    if (Date.now() - uploadedAt < cooldownMs) { skipped.push({ gitDir, reason: 'cooldown' }); continue; }

    await withWorkspaceLock(gitDir, async () => {
      if (!fs.existsSync(gitDir)) { try { fs.unlinkSync(markerFile); } catch (_) {} return; }
      if (currentHead(gitDir) !== headHash) { skipped.push({ gitDir, reason: 'changed-since-sync' }); return; }
      if (!gitStatusClean(gitDir)) { skipped.push({ gitDir, reason: 'dirty' }); return; }
      try {
        fs.rmSync(gitDir, { recursive: true, force: true });
        fs.unlinkSync(markerFile);
        swept.push(gitDir);
      } catch (error) {
        skipped.push({ gitDir, reason: 'delete-failed', error: error.message });
      }
    });
  }
  return { swept, skipped };
}

function safeReaddir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

module.exports = {
  withWorkspaceLock,
  markWorkspaceSyncedAfterPush,
  ensureWorkspaceHydrated,
  sweepStaleWorkspaces,
  markerPathFor,
  COOLDOWN_MS,
};
