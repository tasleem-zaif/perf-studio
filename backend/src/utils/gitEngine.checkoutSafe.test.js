// Regression test for checkoutSafe() — the fix for the recurring "branch already exists" /
// "Failed to create user branch" bug. Root cause: PAT-mode has exactly ONE persisted git
// session per (workspace, user), shared by every request that touches that workspace. Any
// request that switches it to a different branch (e.g. committing CI config to main) and
// forgets to switch back leaves the NEXT request's plain checkout() facing an untracked file
// isomorphic-git refuses to silently overwrite (CheckoutConflictError) — every call site used
// to catch that, misread it as "branch doesn't exist yet", and try to CREATE the branch,
// colliding with the real one and surfacing a confusing error instead of the actual problem.
//
// Builds a real isomorphic-git repo in memory (memfs) — no S3/network dependency — so this
// exercises the actual git library behavior, not a mocked approximation of it.
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const git = require('isomorphic-git');
const { Volume, createFsFromVolume } = require('memfs');
const { checkoutSafe, checkout: rawCheckout } = require('./gitEngine');

const DIR = '/repo';

async function makeRepo() {
  const vol = new Volume();
  const fs = createFsFromVolume(vol);
  fs.mkdirSync(DIR, { recursive: true });
  await git.init({ fs, dir: DIR, defaultBranch: 'main' });
  const author = { name: 'Test', email: 'test@example.com' };
  fs.writeFileSync(`${DIR}/script.js`, 'main-version');
  await git.add({ fs, dir: DIR, filepath: 'script.js' });
  await git.commit({ fs, dir: DIR, message: 'init main', author });

  await git.branch({ fs, dir: DIR, ref: 'feature/x', checkout: true });
  fs.writeFileSync(`${DIR}/script.js`, 'feature-version');
  await git.add({ fs, dir: DIR, filepath: 'script.js' });
  await git.commit({ fs, dir: DIR, message: 'feature change', author });

  await git.checkout({ fs, dir: DIR, ref: 'main' });
  return { fs, dir: DIR };
}

test('checkoutSafe recovers from a stray untracked file blocking the switch, and replays it onto the target branch', async () => {
  const session = await makeRepo();
  // Simulate the actual bug: some other request wrote fresh, uncommitted content onto
  // `script.js` while the session was parked on `main` (it's untracked here since main's
  // committed tree never had this exact content).
  session.fs.writeFileSync(`${DIR}/script.js`, 'STRAY-freshly-generated-content');

  // A plain checkout must genuinely fail here — this assertion documents the bug this test
  // guards against actually reproducing, not just asserting the fix works in isolation.
  await assert.rejects(
    () => rawCheckout(session, 'feature/x'),
    /CheckoutConflictError|overwritten by checkout/,
    'sanity check: plain checkout must hit the real conflict this fix recovers from'
  );

  await checkoutSafe(session, 'feature/x');

  const currentBranch = await git.currentBranch({ fs: session.fs, dir: DIR });
  assert.equal(currentBranch, 'feature/x', 'checkoutSafe must land on the target branch despite the conflict');

  const finalContent = session.fs.readFileSync(`${DIR}/script.js`, 'utf8');
  assert.equal(finalContent, 'STRAY-freshly-generated-content', 'the stray content must be REPLAYED onto the target branch, not silently discarded');
});

test('checkoutSafe behaves exactly like checkout when there is no conflict', async () => {
  const session = await makeRepo();
  await checkoutSafe(session, 'feature/x');
  const currentBranch = await git.currentBranch({ fs: session.fs, dir: DIR });
  assert.equal(currentBranch, 'feature/x');
  assert.equal(session.fs.readFileSync(`${DIR}/script.js`, 'utf8'), 'feature-version', 'clean checkout must land on the branch\'s own committed content, unmodified');
});

test('checkoutSafe re-throws non-conflict errors unchanged (e.g. a genuinely nonexistent branch)', async () => {
  const session = await makeRepo();
  await assert.rejects(() => checkoutSafe(session, 'does/not/exist'), /Failed to get ref|not found|NotFoundError/i);
});
