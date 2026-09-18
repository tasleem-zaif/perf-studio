// Regression test for gitEngine's push() — rewritten to shell out to the real `git` binary
// instead of using isomorphic-git's own push(), because isomorphic-git's push implementation
// was found to be reproducibly rejected by GitHub ("pre-receive hook declined") even for a
// single trivial new file with no branch protection or rulesets configured, while a real git
// client pushing the exact same content, same branch, same token succeeded every time. Rather
// than depend on a real GitHub repo (network, credentials, side effects on someone's actual
// repo), this test pushes to a local bare repo on disk — same `git push` binary and protocol
// path, no network dependency — to verify the copy-to-real-disk-then-shell-out mechanism
// itself: does content committed in an in-memory (memfs) session actually land correctly on
// the remote via this implementation.
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const git = require('isomorphic-git');
const { Volume, createFsFromVolume } = require('memfs');
const gitEngine = require('./gitEngine');

const DIR = '/workspace';

test('push() lands a memfs-session commit onto a real remote (local bare repo, real git protocol)', () => {
  // A real bare repo to act as "origin" — exercises the actual git wire protocol/binary,
  // just without needing network access or a real GitHub token.
  const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitengine-push-bare-'));
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bareDir]);

  // The in-memory session: a real isomorphic-git repo, entirely in memfs, mirroring what
  // gitEngine.openSession() hands back to callers.
  const vol = new Volume();
  const vfs = createFsFromVolume(vol);
  vfs.mkdirSync(DIR, { recursive: true });
  const session = { fs: vfs, dir: DIR };

  return (async () => {
    await git.init({ fs: vfs, dir: DIR, defaultBranch: 'main' });
    vfs.writeFileSync(`${DIR}/hello.txt`, 'hello from memfs session');
    await git.add({ fs: vfs, dir: DIR, filepath: 'hello.txt' });
    await git.commit({ fs: vfs, dir: DIR, message: 'first commit', author: { name: 'Test', email: 'test@example.com' } });

    await gitEngine.push(session, { url: `file://${bareDir}`, ref: 'main' });

    // Verify directly against the bare repo with the real git binary — not just "push() didn't
    // throw" — the content must actually be retrievable from the remote.
    const remoteContent = execFileSync('git', ['--git-dir', bareDir, 'show', 'main:hello.txt'], { encoding: 'utf8' });
    assert.equal(remoteContent, 'hello from memfs session', 'the bare repo must actually contain the pushed content');

    // A second push with a new commit must also succeed (fast-forward case, not just initial push).
    vfs.writeFileSync(`${DIR}/hello.txt`, 'updated content');
    await git.add({ fs: vfs, dir: DIR, filepath: 'hello.txt' });
    await git.commit({ fs: vfs, dir: DIR, message: 'second commit', author: { name: 'Test', email: 'test@example.com' } });
    await gitEngine.push(session, { url: `file://${bareDir}`, ref: 'main' });
    const updated = execFileSync('git', ['--git-dir', bareDir, 'show', 'main:hello.txt'], { encoding: 'utf8' });
    assert.equal(updated, 'updated content', 'a second, fast-forward push must also land correctly');
  })().finally(() => {
    fs.rmSync(bareDir, { recursive: true, force: true });
  });
});

test('addAll() skips files over GitHub\'s 100MB push limit, so a committed run result can never permanently block the branch', async () => {
  const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitengine-push-bare-'));
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bareDir]);

  const vol = new Volume();
  const vfs = createFsFromVolume(vol);
  vfs.mkdirSync(DIR, { recursive: true });
  const session = { fs: vfs, dir: DIR };

  try {
    await git.init({ fs: vfs, dir: DIR, defaultBranch: 'main' });
    vfs.writeFileSync(`${DIR}/small.txt`, 'a normal, small file');
    // A sparse (hole-filled) buffer is enough to exercise the size check without actually
    // allocating/writing 91MB of real bytes to the memfs volume.
    vfs.writeFileSync(`${DIR}/results.json`, Buffer.alloc(91 * 1024 * 1024, 'x'));

    await gitEngine.addAll(session);
    const status = await gitEngine.status(session);
    assert.ok(status.not_added.includes('results.json'), 'the oversized file must be left untracked, not silently deleted');
    assert.ok(!status.not_added.includes('small.txt') && !status.modified.includes('small.txt'), 'the small file must have been staged normally');

    await gitEngine.commit(session, 'run results (oversized file excluded)', 'Test', 'test@example.com');
    await gitEngine.push(session, { url: `file://${bareDir}`, ref: 'main' });

    const remoteFiles = execFileSync('git', ['--git-dir', bareDir, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' });
    assert.ok(remoteFiles.includes('small.txt'), 'the small file must have reached the remote');
    assert.ok(!remoteFiles.includes('results.json'), 'the oversized file must never reach the remote at all');
  } finally {
    fs.rmSync(bareDir, { recursive: true, force: true });
  }
});

test('push() surfaces a clear error when the remote rejects (non-fast-forward, no --force)', async () => {
  const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitengine-push-bare-'));
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bareDir]);

  const vol = new Volume();
  const vfs = createFsFromVolume(vol);
  vfs.mkdirSync(DIR, { recursive: true });
  const session = { fs: vfs, dir: DIR };

  try {
    await git.init({ fs: vfs, dir: DIR, defaultBranch: 'main' });
    vfs.writeFileSync(`${DIR}/hello.txt`, 'v1');
    await git.add({ fs: vfs, dir: DIR, filepath: 'hello.txt' });
    await git.commit({ fs: vfs, dir: DIR, message: 'v1', author: { name: 'Test', email: 'test@example.com' } });
    await gitEngine.push(session, { url: `file://${bareDir}`, ref: 'main' });

    // Push a DIFFERENT, non-fast-forward history directly into the bare repo (simulating
    // someone else having pushed in the meantime) so our next push is rejected.
    const otherClone = fs.mkdtempSync(path.join(os.tmpdir(), 'gitengine-push-other-'));
    execFileSync('git', ['clone', '-q', bareDir, otherClone]);
    fs.writeFileSync(path.join(otherClone, 'hello.txt'), 'someone else\'s change');
    execFileSync('git', ['-C', otherClone, '-c', 'user.name=Other', '-c', 'user.email=other@example.com', 'commit', '-q', '-am', 'other change']);
    execFileSync('git', ['-C', otherClone, 'push', '-q', 'origin', 'main']);
    fs.rmSync(otherClone, { recursive: true, force: true });

    // Our session's local history has diverged from the remote now — this push must fail.
    vfs.writeFileSync(`${DIR}/hello.txt`, 'v2 - diverged');
    await git.add({ fs: vfs, dir: DIR, filepath: 'hello.txt' });
    await git.commit({ fs: vfs, dir: DIR, message: 'v2', author: { name: 'Test', email: 'test@example.com' } });

    await assert.rejects(
      () => gitEngine.push(session, { url: `file://${bareDir}`, ref: 'main' }),
      /Push rejected/,
      'a genuinely diverged, non-force push must still fail loudly, not silently succeed or hang'
    );
  } finally {
    fs.rmSync(bareDir, { recursive: true, force: true });
  }
});
