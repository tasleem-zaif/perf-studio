const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// GIT_WORKSPACES_ROOT is a top-level const computed at module load — must be set before
// the first require() of projectFolders.js in this process, so tests never touch the real
// git-workspaces/ folder.
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-test-'));
process.env.GIT_WORKSPACES_ROOT = TEST_ROOT;

const { resolveWorkspaceRoot } = require('./projectFolders');

test.after(() => { try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }); } catch (_) {} });

// ── resolveWorkspaceRoot — the crux of "add <Organization> as parent of <Project>
// without breaking any existing project." ─────────────────────────────────────────

test('an existing project (real content at the pre-org path) keeps using that exact path, org or not', () => {
  const oldRoot = path.join(TEST_ROOT, 'ExistingProject', 'quarks-admin');
  fs.mkdirSync(path.join(oldRoot, '.git'), { recursive: true });

  assert.equal(resolveWorkspaceRoot('ExistingProject', 'quarks-admin', 'quarks'), oldRoot);
  assert.equal(resolveWorkspaceRoot('ExistingProject', 'quarks-admin', null), oldRoot);
  assert.equal(resolveWorkspaceRoot('ExistingProject', 'quarks-admin', 'some-other-org'), oldRoot);
});

test('a brand-new project (nothing at the old path yet) gets the org-prefixed structure when org is known', () => {
  const root = resolveWorkspaceRoot('BrandNewProject', 'quarks-admin', 'quarks');
  assert.equal(root, path.join(TEST_ROOT, 'quarks', 'BrandNewProject', 'quarks-admin'));
  // and the old-style path was never created as a side effect
  assert.ok(!fs.existsSync(path.join(TEST_ROOT, 'BrandNewProject')));
});

test('a brand-new project falls back to the old-style path when org cannot be resolved, never guesses', () => {
  const root = resolveWorkspaceRoot('AnotherNewProject', 'quarks-admin', null);
  assert.equal(root, path.join(TEST_ROOT, 'AnotherNewProject', 'quarks-admin'));
});

test('an old-style path that exists but is empty is treated as "nothing yet" — org-prefixed still applies', () => {
  const emptyOldRoot = path.join(TEST_ROOT, 'EmptyDirProject', 'quarks-admin');
  fs.mkdirSync(emptyOldRoot, { recursive: true }); // dir exists, but has zero entries

  const root = resolveWorkspaceRoot('EmptyDirProject', 'quarks-admin', 'quarks');
  assert.equal(root, path.join(TEST_ROOT, 'quarks', 'EmptyDirProject', 'quarks-admin'));
});

test('once a project has been assigned the org-prefixed structure, a later call with the same inputs is stable', () => {
  const first = resolveWorkspaceRoot('StableProject', 'quarks-user', 'quarks');
  fs.mkdirSync(path.join(first, '.git'), { recursive: true }); // simulate git init happening there

  const second = resolveWorkspaceRoot('StableProject', 'quarks-user', 'quarks');
  assert.equal(second, first);
});

test('two different actors of the SAME project are resolved independently — one pre-existing, one brand new', () => {
  const adminOld = path.join(TEST_ROOT, 'MixedProject', 'quarks-admin');
  fs.mkdirSync(path.join(adminOld, '.git'), { recursive: true }); // admin's workspace predates this change

  const adminResolved = resolveWorkspaceRoot('MixedProject', 'quarks-admin', 'quarks');
  assert.equal(adminResolved, adminOld, "admin's existing workspace must never move");

  const newUserResolved = resolveWorkspaceRoot('MixedProject', 'brand-new-user', 'quarks');
  assert.equal(newUserResolved, path.join(TEST_ROOT, 'quarks', 'MixedProject', 'brand-new-user'),
    "a user who's never touched this project before gets the org-prefixed structure, independent of admin's location");
});

test('local S3-key derivation does not double-nest the org segment for an org-prefixed local path', () => {
  // toKey() must produce the same S3 key shape regardless of whether the local path is
  // old-style or org-prefixed — see s3Sync.js's fix for this.
  process.env.S3_SYNC_ENABLED = 'false'; // isEnabled() itself isn't under test here
  const s3Sync = require('./s3Sync');

  const oldStyleLocal = path.join(TEST_ROOT, 'KeyTestProject', 'quarks-admin', 'file.txt');
  const newStyleLocal = path.join(TEST_ROOT, 'quarks', 'KeyTestProject', 'quarks-admin', 'file.txt');

  const oldKey = s3Sync.toKey(oldStyleLocal, 'quarks');
  const newKey = s3Sync.toKey(newStyleLocal, 'quarks');

  assert.equal(oldKey, newKey, 'the same logical file must map to the same S3 key regardless of local path style');
  // Count "quarks" as an exact PATH SEGMENT, not a substring — the actor folder itself is
  // legitimately named "quarks-admin", which also contains the substring "quarks".
  const orgSegmentCount = newKey.split('/').filter(seg => seg === 'quarks').length;
  assert.equal(orgSegmentCount, 1, 'org must appear as its own path segment exactly once, not doubled');
});
