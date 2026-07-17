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
const git = require('isomorphic-git');
const http = require('isomorphic-git/http/node');
const { Volume, createFsFromVolume } = require('memfs');
const { diffLines, createTwoFilesPatch } = require('diff');
const s3Sync = require('./s3Sync');

const VROOT = '/workspace';

/**
 * Hydrate a fresh in-memory volume from S3 for gitDir (a path-SHAPED naming string — see
 * s3Sync.toKey() — never a real directory). Returns { fs, dir } for use with every other
 * function in this module. If S3 has nothing yet, returns an empty volume (caller must
 * initFromRemote() or initEmpty() before doing anything else).
 */
async function openSession(gitDir, orgSlug) {
  const vfs = createFsFromVolume(new Volume());
  vfs.mkdirSync(VROOT, { recursive: true });
  const baseKey = s3Sync.toKey(gitDir, orgSlug);
  if (baseKey) {
    const keys = await s3Sync.listAllKeys(baseKey);
    await Promise.all(keys.map(async (key) => {
      const rel = key.slice(baseKey.length + 1);
      if (!rel) return;
      const res = await s3Sync.getBuffer(key);
      if (!res.ok) return;
      const fullPath = path.posix.join(VROOT, rel);
      vfs.mkdirSync(path.posix.dirname(fullPath), { recursive: true });
      vfs.writeFileSync(fullPath, res.data);
    }));
  }
  return { fs: vfs, dir: VROOT, hadState: (await s3Sync.listAllKeys(baseKey || '')).length > 0 };
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
 * Flush the ENTIRE in-memory volume (including .git/) back to S3 — mirrors exactly what
 * local disk used to hold, so the next openSession (a different request, possibly a
 * different process) picks up right where this one left off, uncommitted changes included.
 */
async function persistSession({ fs: vfs, dir }, gitDir, orgSlug) {
  const baseKey = s3Sync.toKey(gitDir, orgSlug);
  if (!baseKey) return { ok: false, error: new Error(`gitEngine: could not derive S3 key for ${gitDir}`) };
  const relFiles = listAllFiles(vfs, dir);
  const failed = [];
  await Promise.all(relFiles.map(async (rel) => {
    const data = vfs.readFileSync(path.posix.join(dir, rel));
    const up = await s3Sync.putBuffer(`${baseKey}/${rel}`, data);
    if (!up.ok && !up.skipped) failed.push({ rel, error: up.error });
  }));
  return { ok: failed.length === 0, failed };
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

/** Merge theirRef into the current branch. `allowUnrelated` mirrors --allow-unrelated-histories. */
async function merge({ fs: vfs, dir }, theirRef, authorName, authorEmail, message) {
  return git.merge({
    fs: vfs, dir, ours: await git.currentBranch({ fs: vfs, dir }), theirs: theirRef,
    author: author(authorName, authorEmail), message,
  });
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
  openSession, persistSession,
  cloneFromRemote, initEmpty, setConfig,
  addAll, status, commit, currentBranch, branchLocal, checkout,
  fetchRemote, merge, push, getRemoteInfo, listRemotes, setRemoteUrl, log,
  verifyPushLanded, diffFile, changeStatsSinceHead,
};
