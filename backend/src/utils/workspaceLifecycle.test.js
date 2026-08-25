const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  ensureWorkspaceHydrated,
  markWorkspaceSyncedAfterPush,
  sweepStaleWorkspaces,
  markerPathFor,
} = require('./workspaceLifecycle');

// ── Test helpers ──────────────────────────────────────────────────────────────
// Real git (a bare repo standing in for the remote provider) + real filesystem, so these
// prove the actual lock/hydrate/mark/sweep behavior, not a mocked-away approximation. Only
// the S3 side is a double — a real bucket needs credentials this environment doesn't have —
// but it round-trips real file bytes through an in-memory store, not just recorded calls.
// `markersDir` is scoped per-test under the same temp root as the workspace (never the real
// repo's git-workspaces/_sync-markers/), so tests can't leak state into or out of each other.

function sh(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} (cwd=${cwd}) failed: ${r.stderr || r.stdout}`);
  return (r.stdout || '').trim();
}

function currentHead(dir) {
  return sh(['rev-parse', 'HEAD'], dir);
}

/** Bare repo (stand-in remote) + a clone with one committed+pushed file, plus an isolated markersDir. */
function makeRemoteAndWorkspace() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-test-'));
  const remoteDir = path.join(base, 'remote.git');
  const gitDir = path.join(base, 'workspace');
  const markersDir = path.join(base, '_sync-markers');
  sh(['init', '--bare', remoteDir], base);
  sh(['clone', remoteDir, gitDir], base);
  sh(['config', 'user.name', 'Test User'], gitDir);
  sh(['config', 'user.email', 'test@example.com'], gitDir);
  fs.writeFileSync(path.join(gitDir, 'README.md'), 'hello\n');
  sh(['add', '.'], gitDir);
  sh(['commit', '-m', 'init'], gitDir);
  const branch = sh(['branch', '--show-current'], gitDir) || 'master';
  sh(['push', '-u', 'origin', branch], gitDir);
  return { base, remoteDir, gitDir, branch, markersDir };
}

function cleanup(base) {
  try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) {}
}

/** In-memory S3 double — genuinely copies file bytes so upload→delete→download round-trips. */
function makeFakeS3({ enabled = true } = {}) {
  const store = new Map(); // `${orgSlug}/${relPath}` -> Buffer
  return {
    isEnabled: () => enabled,
    async uploadWorkingTree(gitDir, orgSlug) {
      const uploaded = [];
      const failed = [];
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.name === '.git') continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) { walk(full); continue; }
          try {
            const rel = path.relative(gitDir, full).split(path.sep).join('/');
            store.set(`${orgSlug}/${rel}`, fs.readFileSync(full));
            uploaded.push(full);
          } catch (error) { failed.push({ file: full, error }); }
        }
      };
      walk(gitDir);
      return { ok: failed.length === 0, uploaded, failed };
    },
    async downloadDir(localDir, orgSlug) {
      const downloaded = [];
      const failed = [];
      const prefix = `${orgSlug}/`;
      for (const [key, buf] of store) {
        if (!key.startsWith(prefix)) continue;
        const rel = key.slice(prefix.length);
        const localPath = path.join(localDir, ...rel.split('/'));
        try {
          fs.mkdirSync(path.dirname(localPath), { recursive: true });
          fs.writeFileSync(localPath, buf);
          downloaded.push(localPath);
        } catch (error) { failed.push({ file: localPath, error }); }
      }
      return { ok: failed.length === 0, downloaded, failed };
    },
    seed(orgSlug, rel, contents) {
      store.set(`${orgSlug}/${rel}`, Buffer.from(contents));
    },
  };
}

// ── markWorkspaceSyncedAfterPush ──────────────────────────────────────────────

test('markWorkspaceSyncedAfterPush writes a marker only when upload fully succeeds', async () => {
  const { base, gitDir, markersDir } = makeRemoteAndWorkspace();
  try {
    const s3 = makeFakeS3();
    const result = await markWorkspaceSyncedAfterPush({ gitDir, orgSlug: 'orgA', s3, markersDir });
    assert.equal(result.ok, true);
    assert.equal(result.headHash, currentHead(gitDir));
    const markerPath = markerPathFor(gitDir, markersDir);
    assert.ok(fs.existsSync(markerPath), 'marker should exist after a successful upload');
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    assert.equal(marker.headHash, currentHead(gitDir));
  } finally {
    cleanup(base);
  }
});

test('markWorkspaceSyncedAfterPush writes no marker when the upload fails', async () => {
  const { base, gitDir, markersDir } = makeRemoteAndWorkspace();
  try {
    const failingS3 = {
      isEnabled: () => true,
      uploadWorkingTree: async () => ({ ok: false, uploaded: [], failed: [{ file: 'x', error: new Error('boom') }] }),
    };
    const result = await markWorkspaceSyncedAfterPush({ gitDir, orgSlug: 'orgA', s3: failingS3, markersDir });
    assert.equal(result.ok, false);
    assert.ok(!fs.existsSync(markerPathFor(gitDir, markersDir)), 'no marker should be written on a failed upload');
  } finally {
    cleanup(base);
  }
});

// ── ensureWorkspaceHydrated ────────────────────────────────────────────────────

test('ensureWorkspaceHydrated no-ops when the workspace is already warm', async () => {
  const { base, gitDir, markersDir } = makeRemoteAndWorkspace();
  try {
    let restoreCalls = 0;
    const result = await ensureWorkspaceHydrated({
      gitDir,
      orgSlug: 'orgA',
      restoreGitContent: async () => { restoreCalls++; },
      s3: makeFakeS3(),
      markersDir,
    });
    assert.deepEqual(result, { hydrated: false, alreadyWarm: true });
    assert.equal(restoreCalls, 0, 'restoreGitContent must not run when already warm');
  } finally {
    cleanup(base);
  }
});

test('ensureWorkspaceHydrated restores git content and S3-only content when cold', async () => {
  const { base, remoteDir, gitDir, branch, markersDir } = makeRemoteAndWorkspace();
  try {
    const s3 = makeFakeS3();
    // Seed S3 with a file git never tracked (stand-in for results/), namespaced exactly how
    // the real workspace would see it once restored.
    s3.seed('orgA', 'results/Run_1/results.jtl', 'timeStamp,elapsed\n1,42\n');

    // Simulate the sweep having reclaimed this workspace.
    fs.rmSync(gitDir, { recursive: true, force: true });
    assert.ok(!fs.existsSync(gitDir));

    let restoreCalls = 0;
    const result = await ensureWorkspaceHydrated({
      gitDir,
      orgSlug: 'orgA',
      restoreGitContent: async () => {
        restoreCalls++;
        fs.mkdirSync(path.dirname(gitDir), { recursive: true });
        sh(['clone', '--branch', branch, remoteDir, gitDir], path.dirname(gitDir));
      },
      s3,
      markersDir,
    });

    assert.equal(result.hydrated, true);
    assert.equal(restoreCalls, 1);
    assert.ok(fs.existsSync(path.join(gitDir, '.git')), 'git content should be restored via clone');
    assert.ok(fs.existsSync(path.join(gitDir, 'README.md')), 'tracked file should be restored via clone');
    assert.ok(fs.existsSync(path.join(gitDir, 'results', 'Run_1', 'results.jtl')), 'untracked S3-only content should be restored');
    assert.equal(fs.readFileSync(path.join(gitDir, 'results', 'Run_1', 'results.jtl'), 'utf8'), 'timeStamp,elapsed\n1,42\n');
  } finally {
    cleanup(base);
  }
});

test('ensureWorkspaceHydrated only restores once under concurrent callers racing a cold workspace', async () => {
  const { base, remoteDir, gitDir, branch, markersDir } = makeRemoteAndWorkspace();
  try {
    fs.rmSync(gitDir, { recursive: true, force: true });

    let restoreCalls = 0;
    const restoreGitContent = async () => {
      restoreCalls++;
      await new Promise(r => setTimeout(r, 50)); // widen the race window
      fs.mkdirSync(path.dirname(gitDir), { recursive: true });
      sh(['clone', '--branch', branch, remoteDir, gitDir], path.dirname(gitDir));
    };

    const [a, b] = await Promise.all([
      ensureWorkspaceHydrated({ gitDir, orgSlug: 'orgA', restoreGitContent, s3: makeFakeS3(), markersDir }),
      ensureWorkspaceHydrated({ gitDir, orgSlug: 'orgA', restoreGitContent, s3: makeFakeS3(), markersDir }),
    ]);

    assert.equal(restoreCalls, 1, 'only one caller should actually perform the restore');
    assert.ok(a.hydrated || b.hydrated);
  } finally {
    cleanup(base);
  }
});

// ── sweepStaleWorkspaces ───────────────────────────────────────────────────────

test('sweepStaleWorkspaces does not delete before the cooldown elapses', async () => {
  const { base, gitDir, markersDir } = makeRemoteAndWorkspace();
  try {
    await markWorkspaceSyncedAfterPush({ gitDir, orgSlug: 'orgA', s3: makeFakeS3(), markersDir });
    const { swept, skipped } = await sweepStaleWorkspaces({ cooldownMs: 1_000_000, markersDir });
    assert.ok(!swept.includes(gitDir));
    assert.ok(fs.existsSync(gitDir), 'workspace should still be on disk within the cooldown window');
    assert.ok(skipped.some(s => s.gitDir === gitDir && s.reason === 'cooldown'));
  } finally {
    cleanup(base);
  }
});

test('sweepStaleWorkspaces deletes a clean, unchanged workspace once past the cooldown', async () => {
  const { base, gitDir, markersDir } = makeRemoteAndWorkspace();
  try {
    await markWorkspaceSyncedAfterPush({ gitDir, orgSlug: 'orgA', s3: makeFakeS3(), markersDir });
    const { swept } = await sweepStaleWorkspaces({ cooldownMs: 0, markersDir });
    assert.ok(swept.includes(gitDir));
    assert.ok(!fs.existsSync(gitDir), 'workspace should be removed once past cooldown');
    assert.ok(!fs.existsSync(markerPathFor(gitDir, markersDir)), 'marker should be removed alongside the workspace');
  } finally {
    cleanup(base);
  }
});

test('sweepStaleWorkspaces refuses to delete a workspace with uncommitted changes since the marker', async () => {
  const { base, gitDir, markersDir } = makeRemoteAndWorkspace();
  try {
    await markWorkspaceSyncedAfterPush({ gitDir, orgSlug: 'orgA', s3: makeFakeS3(), markersDir });
    fs.writeFileSync(path.join(gitDir, 'README.md'), 'edited locally, not committed\n');

    const { swept, skipped } = await sweepStaleWorkspaces({ cooldownMs: 0, markersDir });
    assert.ok(!swept.includes(gitDir));
    assert.ok(fs.existsSync(gitDir), 'dirty workspace must never be deleted');
    assert.ok(skipped.some(s => s.gitDir === gitDir && s.reason === 'dirty'));
  } finally {
    cleanup(base);
  }
});

test('sweepStaleWorkspaces refuses to delete a workspace committed to since the marker', async () => {
  const { base, gitDir, markersDir } = makeRemoteAndWorkspace();
  try {
    await markWorkspaceSyncedAfterPush({ gitDir, orgSlug: 'orgA', s3: makeFakeS3(), markersDir });
    fs.writeFileSync(path.join(gitDir, 'NEWFILE.txt'), 'new committed content\n');
    sh(['add', '.'], gitDir);
    sh(['commit', '-m', 'a new local commit after the marker was written'], gitDir);

    const { swept, skipped } = await sweepStaleWorkspaces({ cooldownMs: 0, markersDir });
    assert.ok(!swept.includes(gitDir));
    assert.ok(fs.existsSync(gitDir), 'workspace with a newer HEAD than the marker must never be deleted');
    assert.ok(skipped.some(s => s.gitDir === gitDir && s.reason === 'changed-since-sync'));
  } finally {
    cleanup(base);
  }
});
