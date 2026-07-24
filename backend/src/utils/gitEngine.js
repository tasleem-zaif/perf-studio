'use strict';
// gitEngine.js — S3-backed, in-memory git engine for PAT-mode workspaces.
//
// Replaces simple-git + gitExec (real git binary against a real local directory) for
// PAT-mode users only — SSH-mode keeps using the real git binary (isomorphic-git has no
// SSH transport; see git.js's getAuth()/gitExec() for the unchanged SSH path).
//
// Model: S3 holds each workspace's CURRENT WORKING-TREE STATE (everything a local
// git-workspaces/<...> folder used to hold, including .git/ internals — index, objects,
// refs — not just the working files) — this is the durable store for uncommitted changes
// between requests, matching the app's existing edit -> review diff -> commit -> push flow.
// A session is a per-request in-memory (memfs) volume: hydrated from S3 at the start of an
// operation, mutated via isomorphic-git, and flushed back to S3 at the end. The real git
// remote (GitHub/GitLab/Bitbucket over HTTPS) is only ever touched for clone/fetch/push —
// never for anything else. Nothing in this module ever touches the local filesystem.

const path = require('path');
const crypto = require('crypto');
const git = require('isomorphic-git');
const http = require('isomorphic-git/http/node');
const { Volume, createFsFromVolume } = require('memfs');
const { diffLines, createTwoFilesPatch } = require('diff');
const s3Sync = require('./s3Sync');

const VROOT = '/workspace';

// ── In-process byte cache ───────────────────────────────────────────────────────────
// Caches each workspace's file CONTENTS (not a live memfs Volume) keyed by its S3 base key,
// so a repeat openSession() for the same workspace can populate a fresh, private in-memory
// volume straight from these buffers instead of re-downloading every object from S3. Each
// call still gets its own isolated Volume instance (built fresh from the cached bytes), so
// two concurrent requests against the same workspace never share — and can't corrupt —
// the same live memfs object; they only share read-only source bytes.
//
// Single-process assumption (same as workspaceLifecycle.js's old SSH-mode disk cache) —
// fine for a single backend instance; would need a shared cache to stay correct across
// multiple replicas behind a load balancer.
const SESSION_CACHE_TTL_MS = Number(process.env.GIT_ENGINE_SESSION_CACHE_TTL_MS) || 15 * 60 * 1000;
const sessionByteCache = new Map(); // cacheKey -> { files: Map<relPath, {data: Buffer, hash: string}>, lastAccess }

function hashOf(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

// The AWS SDK's default Node HTTP handler caps concurrent sockets at 50 — a workspace with
// hundreds/thousands of small tracked files (a JMeter HTML report's asset tree is a common
// case) used to fan out one GetObject/PutObject per file via a single unbounded
// `Promise.all(files.map(...))`, instantly queueing far past that cap
// ("@smithy/node-http-handler:WARN - socket usage at capacity=50 and N additional requests
// are enqueued"). Every OTHER request sharing this process's S3 client competes for the same
// 50 sockets, so a large openSession()/persistSession() call could starve a concurrent CI
// trigger's own S3 calls long enough to time out ("socket hang up") — not a bug in the
// trigger itself, just unbounded fan-out here. Chunking to a concurrency well under the
// socket cap keeps this module's own usage bounded and leaves headroom for other callers.
const S3_FANOUT_CONCURRENCY = Number(process.env.GIT_ENGINE_S3_CONCURRENCY) || 16;
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function getCacheEntry(cacheKey) {
  const entry = sessionByteCache.get(cacheKey);
  if (!entry) return null;
  if (Date.now() - entry.lastAccess > SESSION_CACHE_TTL_MS) {
    sessionByteCache.delete(cacheKey);
    return null;
  }
  return entry;
}

// Periodic sweep so an idle workspace's cached bytes actually get freed — getCacheEntry()
// only evicts lazily on the next access to that SAME key, which never happens for a
// workspace nobody touches again. unref() so this timer never keeps the process alive.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of sessionByteCache) {
    if (now - entry.lastAccess > SESSION_CACHE_TTL_MS) sessionByteCache.delete(key);
  }
}, SESSION_CACHE_TTL_MS).unref();

/** Drop any cached bytes for gitDir — call after something outside gitEngine (e.g. a
 * project-delete tombstone) deletes or replaces the workspace's S3 objects directly, so a
 * later openSession() doesn't serve stale cached content instead of the real S3 state. */
function invalidateCache(gitDir, orgSlug) {
  const baseKey = s3Sync.toKey(gitDir, orgSlug);
  if (baseKey) sessionByteCache.delete(baseKey);
}

/**
 * Hydrate a fresh in-memory volume for gitDir (a path-SHAPED naming string — see
 * s3Sync.toKey() — never a real directory). Returns { fs, dir } for use with every other
 * function in this module. If S3 has nothing yet, returns an empty volume (caller must
 * initFromRemote() or initEmpty() before doing anything else).
 *
 * Serves from the in-process byte cache when warm (pure in-memory copy, no S3 calls at
 * all); only re-downloads from S3 on a cold/expired cache. Either way the returned session
 * also carries a private baseline (`_baseline`/`_cacheKey`) that persistSession() uses to
 * upload only what actually changed, not the whole tree.
 */
async function openSession(gitDir, orgSlug) {
  const vfs = createFsFromVolume(new Volume());
  vfs.mkdirSync(VROOT, { recursive: true });
  const baseKey = s3Sync.toKey(gitDir, orgSlug);
  let entry = baseKey ? getCacheEntry(baseKey) : null;

  if (!entry) {
    const files = new Map();
    if (baseKey) {
      const keys = await s3Sync.listAllKeys(baseKey);
      await mapLimit(keys, S3_FANOUT_CONCURRENCY, async (key) => {
        const rel = key.slice(baseKey.length + 1);
        if (!rel) return;
        const res = await s3Sync.getBuffer(key);
        if (!res.ok) return;
        files.set(rel, { data: res.data, hash: hashOf(res.data) });
      });
    }
    entry = { files, lastAccess: Date.now() };
    if (baseKey) sessionByteCache.set(baseKey, entry);
  } else {
    entry.lastAccess = Date.now();
  }

  for (const [rel, { data }] of entry.files) {
    const fullPath = path.posix.join(VROOT, rel);
    vfs.mkdirSync(path.posix.dirname(fullPath), { recursive: true });
    vfs.writeFileSync(fullPath, data);
  }

  const baseline = new Map();
  for (const [rel, { hash }] of entry.files) baseline.set(rel, hash);

  return {
    fs: vfs, dir: VROOT, hadState: entry.files.size > 0,
    _cacheKey: baseKey, _baseline: baseline, _cacheSnapshot: entry.files,
  };
}

/** Recursively collect every file's relative (posix) path under dir in an in-memory volume. */
function listAllFiles(vfs, dir) {
  const out = [];
  const walk = (p) => {
    for (const entry of vfs.readdirSync(p, { withFileTypes: true })) {
      const full = path.posix.join(p, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(dir);
  return out.map(f => path.posix.relative(dir, f));
}

/**
 * Flush ONLY WHAT CHANGED in the in-memory volume (including .git/) back to S3 — diffs the
 * volume's current content against the baseline captured at openSession() time (or, for a
 * session that's already been persisted once this request, against the state left by that
 * prior persist — see below), uploads new/modified files, deletes files that were removed,
 * and leaves everything untouched alone. This is what keeps a single-file config save from
 * costing a whole-workspace re-upload.
 *
 * Mirrors exactly what local disk used to hold, so the next openSession (a different
 * request, possibly after this cache entry expires) picks up right where this one left
 * off, uncommitted changes included.
 */
async function persistSession(session, gitDir, orgSlug) {
  const { fs: vfs, dir } = session;
  const baseKey = s3Sync.toKey(gitDir, orgSlug);
  if (!baseKey) return { ok: false, error: new Error(`gitEngine: could not derive S3 key for ${gitDir}`) };
  const baseline = session._baseline || new Map();
  const prevFiles = session._cacheSnapshot || new Map();

  const relFiles = listAllFiles(vfs, dir);
  const current = new Map(); // rel -> {data, hash}
  for (const rel of relFiles) {
    const data = vfs.readFileSync(path.posix.join(dir, rel));
    current.set(rel, { data, hash: hashOf(data) });
  }

  const toUpload = [];
  for (const [rel, { hash }] of current) {
    if (baseline.get(rel) !== hash) toUpload.push(rel);
  }
  const toDelete = [];
  for (const rel of baseline.keys()) {
    if (!current.has(rel)) toDelete.push(rel);
  }

  const failedUploads = new Set();
  const failedDeletes = new Set();
  const failed = [];
  await mapLimit(toUpload, S3_FANOUT_CONCURRENCY, async (rel) => {
    const up = await s3Sync.putBuffer(`${baseKey}/${rel}`, current.get(rel).data);
    if (!up.ok && !up.skipped) { failedUploads.add(rel); failed.push({ rel, error: up.error }); }
  });
  await mapLimit(toDelete, S3_FANOUT_CONCURRENCY, async (rel) => {
    const del = await s3Sync.deleteKey(`${baseKey}/${rel}`);
    if (!del.ok && !del.skipped) { failedDeletes.add(rel); failed.push({ rel, error: del.error }); }
  });

  // Keep the in-process byte cache reflecting only CONFIRMED-durable S3 state: a file whose
  // upload failed keeps its old cached bytes (still the last known-good copy actually in
  // S3); a file whose delete failed stays in the cache too (it may well still be in S3).
  const newCacheFiles = new Map(prevFiles);
  for (const rel of toUpload) if (!failedUploads.has(rel)) newCacheFiles.set(rel, current.get(rel));
  for (const rel of toDelete) if (!failedDeletes.has(rel)) newCacheFiles.delete(rel);
  if (session._cacheKey) sessionByteCache.set(session._cacheKey, { files: newCacheFiles, lastAccess: Date.now() });

  // Update this session's own baseline/snapshot so a SECOND persistSession() call on the
  // same session object later in the same request (a common pattern in git.js's routes)
  // sees "nothing changed" and does no redundant S3 calls at all.
  const newBaseline = new Map();
  for (const [rel, { hash }] of current) newBaseline.set(rel, hash);
  session._baseline = newBaseline;
  session._cacheSnapshot = current;

  return { ok: failed.length === 0, failed, uploaded: toUpload, deleted: toDelete };
}

/** Author object for isomorphic-git calls. */
function author(name, email) {
  return { name: name || 'Peako', email: email || 'noreply@perfstudio.com' };
}

// ── Auth plumbing for the real remote (PAT only — SSH never reaches this module) ──────
function onAuthFor(token, username) {
  if (!token) return undefined;
  return () => ({ username: username || token, password: username ? token : 'x-oauth-basic' });
}

/** Fresh clone from the real remote into an already-open (empty) session. Used by /init
 * when the remote is empty, and as the seed step before merging when it isn't. */
async function cloneFromRemote({ fs: vfs, dir }, { url, ref, token, username, singleBranch = true }) {
  await git.clone({ fs: vfs, http, dir, url, ref, singleBranch, onAuth: onAuthFor(token, username) });
}

/** git init (brand-new, empty remote case). */
async function initEmpty({ fs: vfs, dir }) {
  await git.init({ fs: vfs, dir, defaultBranch: 'main' });
}

async function setConfig({ fs: vfs, dir }, key, value) {
  await git.setConfig({ fs: vfs, dir, path: key, value });
}

async function addAll({ fs: vfs, dir }) {
  const matrix = await git.statusMatrix({ fs: vfs, dir });
  await Promise.all(matrix
    .filter(([, , worktreeStatus]) => worktreeStatus !== 0) // skip files deleted in worktree AND not present — nothing to add
    .map(([filepath]) => git.add({ fs: vfs, dir, filepath }).catch(() => {})));
  // Stage deletions explicitly — statusMatrix rows with worktreeStatus === 0 (absent from
  // worktree) but headStatus === 1 (existed in HEAD) are removed files that `add` won't touch.
  await Promise.all(matrix
    .filter(([, headStatus, worktreeStatus]) => headStatus === 1 && worktreeStatus === 0)
    .map(([filepath]) => git.remove({ fs: vfs, dir, filepath }).catch(() => {})));
}

/** Full status — mirrors simple-git's git.status() shape closely enough for git.js's routes. */
async function status({ fs: vfs, dir }) {
  const matrix = await git.statusMatrix({ fs: vfs, dir });
  const modified = [], not_added = [], deleted = [], staged = [];
  for (const [filepath, headStatus, worktreeStatus, stageStatus] of matrix) {
    if (headStatus === 1 && worktreeStatus === 1 && stageStatus === 1) continue; // unmodified
    if (headStatus === 0 && worktreeStatus === 2 && stageStatus === 0) { not_added.push(filepath); continue; }
    if (headStatus === 1 && worktreeStatus === 0) { deleted.push(filepath); if (stageStatus === 0) staged.push(filepath); continue; }
    if (headStatus === 1 && worktreeStatus === 2 && stageStatus === 2) { modified.push(filepath); continue; }
    if (stageStatus === 2 || stageStatus === 3) staged.push(filepath);
    else if (worktreeStatus !== stageStatus) modified.push(filepath);
  }
  const current = await git.currentBranch({ fs: vfs, dir }).catch(() => null);
  return {
    current, modified, not_added, deleted, staged,
    isClean: () => !modified.length && !not_added.length && !deleted.length && !staged.length,
  };
}

async function commit({ fs: vfs, dir }, message, authorName, authorEmail) {
  const oid = await git.commit({ fs: vfs, dir, message, author: author(authorName, authorEmail) });
  return { commit: oid };
}

async function currentBranch({ fs: vfs, dir }) {
  return git.currentBranch({ fs: vfs, dir });
}

async function branchLocal({ fs: vfs, dir }) {
  const all = await git.listBranches({ fs: vfs, dir });
  const current = await git.currentBranch({ fs: vfs, dir }).catch(() => null);
  return { all, current };
}

/** Checkout an existing branch, or create+checkout a new one from startRef (defaults to
 * current HEAD if omitted, matching `git checkout -b <new>` with no explicit start point). */
async function checkout({ fs: vfs, dir }, branch, { create = false, startRef } = {}) {
  if (create) {
    await git.branch({ fs: vfs, dir, ref: branch, checkout: true, ...(startRef ? {} : {}) });
    if (startRef) {
      // isomorphic-git's branch() always branches from current HEAD; to start from a
      // different ref, reset the new branch's tip to it before checkout.
      await git.checkout({ fs: vfs, dir, ref: branch });
      const oid = await git.resolveRef({ fs: vfs, dir, ref: startRef });
      await git.writeRef({ fs: vfs, dir, ref: `refs/heads/${branch}`, value: oid, force: true });
      await git.checkout({ fs: vfs, dir, ref: branch, force: true });
    }
  } else {
    await git.checkout({ fs: vfs, dir, ref: branch });
  }
}

async function fetchRemote({ fs: vfs, dir }, { url, ref, token, username, singleBranch = true } = {}) {
  return git.fetch({ fs: vfs, http, dir, url, ref, singleBranch, onAuth: onAuthFor(token, username) });
}

/** Merge theirRef into the current branch. `fastForwardOnly` throws instead of creating a
 * merge commit when the histories have diverged — mirrors `git merge --ff-only`. */
async function merge({ fs: vfs, dir }, theirRef, authorName, authorEmail, message, { fastForwardOnly = false } = {}) {
  return git.merge({
    fs: vfs, dir, ours: await git.currentBranch({ fs: vfs, dir }), theirs: theirRef,
    author: author(authorName, authorEmail), message, fastForwardOnly,
  });
}

/**
 * Force `branch`'s tip to exactly match `ref` (e.g. a remote-tracking ref after a fetch) and
 * sync the working tree to it — the isomorphic-git equivalent of `git reset --hard <ref>`
 * (isomorphic-git has no literal reset-hard porcelain). Used when a fast-forward merge isn't
 * possible (local and remote have diverged) and remote must win, same as the real-git SSH
 * path's `git reset --hard origin/<branch>` fallback. Any local changes the caller wants to
 * keep must be captured and re-applied by the caller AFTER this call — this discards them
 * from the working tree exactly like a real hard reset would.
 */
async function resetHardToRef({ fs: vfs, dir }, branch, ref) {
  const oid = await git.resolveRef({ fs: vfs, dir, ref });
  await git.writeRef({ fs: vfs, dir, ref: `refs/heads/${branch}`, value: oid, force: true });
  await git.checkout({ fs: vfs, dir, ref: branch, force: true });
}

async function push({ fs: vfs, dir }, { url, ref, token, username, force = false } = {}) {
  const result = await git.push({ fs: vfs, http, dir, remote: 'origin', ref, url, force, onAuth: onAuthFor(token, username) });
  if (result.errors && result.errors.length) {
    throw new Error(`Push rejected: ${result.errors.join('; ')}`);
  }
  return result;
}

/** ls-remote equivalent — no session/local state needed at all, pure network call. */
async function getRemoteInfo(url, token, username) {
  return git.getRemoteInfo({ http, url, onAuth: onAuthFor(token, username) });
}

async function listRemotes({ fs: vfs, dir }) {
  return git.listRemotes({ fs: vfs, dir });
}
async function setRemoteUrl({ fs: vfs, dir }, remote, url) {
  try { await git.deleteRemote({ fs: vfs, dir, remote }); } catch {}
  await git.addRemote({ fs: vfs, dir, remote, url });
}

async function log({ fs: vfs, dir }, depth = 20) {
  return git.log({ fs: vfs, dir, depth });
}

/**
 * Confirm a push actually landed on the remote — mirrors git.js's verifyPushLanded(), just
 * via getRemoteInfo() instead of `git ls-remote` + `git rev-parse HEAD`.
 */
async function verifyPushLanded({ fs: vfs, dir }, url, branch, token, username) {
  const localHead = await git.resolveRef({ fs: vfs, dir, ref: 'HEAD' });
  const info = await getRemoteInfo(url, token, username);
  const remoteHead = info.refs?.heads && branch.split('/').reduce((o, seg) => o?.[seg], info.refs.heads);
  if (!remoteHead) throw new Error(`Push verification failed: ${branch} was not found on the remote after pushing.`);
  if (remoteHead !== localHead) {
    throw new Error(`Push verification failed: local HEAD (${localHead.slice(0, 10)}) does not match ${branch} (${remoteHead.slice(0, 10)}) on the remote.`);
  }
  return localHead;
}

/**
 * Unified diff TEXT for one file between two refs (or working-tree-vs-ref) — isomorphic-git
 * has no `git diff` porcelain, so this walks the two trees for the one path and renders a
 * unified diff via the `diff` npm package. `toRef` omitted means "working tree" (reads the
 * live file content in the session's fs instead of a commit's blob).
 */
async function diffFile({ fs: vfs, dir }, filepath, fromRef = 'HEAD', toRef = null) {
  const readBlobAtRef = async (ref) => {
    try {
      const oid = await git.resolveRef({ fs: vfs, dir, ref });
      const commitObj = await git.readCommit({ fs: vfs, dir, oid });
      const { blob } = await git.readBlob({ fs: vfs, dir, oid: commitObj.commit.tree, filepath });
      return Buffer.from(blob).toString('utf8');
    } catch {
      return null; // file didn't exist at this ref
    }
  };
  const fromContent = await readBlobAtRef(fromRef);
  const toContent = toRef
    ? await readBlobAtRef(toRef)
    : (vfs.existsSync(path.posix.join(dir, filepath)) ? vfs.readFileSync(path.posix.join(dir, filepath), 'utf8') : null);

  const isNewFile = fromContent === null && toContent !== null;
  if (fromContent === null && toContent === null) return { diff: '', isNewFile: false };

  const patch = createTwoFilesPatch(
    `a/${filepath}`, `b/${filepath}`,
    fromContent || '', toContent || '',
    '', '', { context: 999999 },
  );
  // createTwoFilesPatch's header differs slightly from `git diff`'s — reformat the first
  // line to match what the existing frontend diff viewer expects (git.js's old `git diff`
  // output always started with a literal "diff --git a/<path> b/<path>" line).
  const body = patch.split('\n').slice(isNewFile ? 2 : 4).join('\n');
  const header = isNewFile
    ? [`diff --git a/${filepath} b/${filepath}`, 'new file mode 100644', '--- /dev/null', `+++ b/${filepath}`].join('\n')
    : [`diff --git a/${filepath} b/${filepath}`, `--- a/${filepath}`, `+++ b/${filepath}`].join('\n');
  return { diff: `${header}\n${body}`, isNewFile };
}

/**
 * Added/deleted LINE counts (not full diff text) for every path touched since HEAD —
 * the numstat equivalent of `git diff HEAD --numstat`, used for the status summary.
 */
async function changeStatsSinceHead({ fs: vfs, dir }, changedPaths) {
  let added = 0, deleted = 0;
  for (const filepath of changedPaths) {
    let fromContent = '';
    try {
      const oid = await git.resolveRef({ fs: vfs, dir, ref: 'HEAD' });
      const commitObj = await git.readCommit({ fs: vfs, dir, oid });
      const { blob } = await git.readBlob({ fs: vfs, dir, oid: commitObj.commit.tree, filepath });
      fromContent = Buffer.from(blob).toString('utf8');
    } catch { /* new file — no HEAD content */ }
    const full = path.posix.join(dir, filepath);
    const toContent = vfs.existsSync(full) ? vfs.readFileSync(full, 'utf8') : '';
    for (const part of diffLines(fromContent, toContent)) {
      const lines = part.value.split('\n').length - (part.value.endsWith('\n') ? 1 : 0);
      if (part.added) added += lines;
      else if (part.removed) deleted += lines;
    }
  }
  return { added, deleted };
}

module.exports = {
  openSession, persistSession, invalidateCache,
  cloneFromRemote, initEmpty, setConfig,
  addAll, status, commit, currentBranch, branchLocal, checkout,
  fetchRemote, merge, resetHardToRef, push, getRemoteInfo, listRemotes, setRemoteUrl, log,
  verifyPushLanded, diffFile, changeStatsSinceHead,
};
