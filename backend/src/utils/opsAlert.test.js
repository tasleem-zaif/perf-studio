require('dotenv').config();
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

// Short rate-limit window so the "suppressed then resumes" case doesn't need a real 5-minute
// wait — must be set before opsAlert.js is required, since it reads this once at module load.
process.env.OPS_ALERT_RATE_LIMIT_MS = '50';
process.env.OPS_ALERT_WEBHOOK_URL = 'https://example.invalid/ops-webhook';

const { alertOpsFailure } = require('./opsAlert');
const db = require('../db');

function withFakeFetch(fn) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true };
  };
  return fn(calls).finally(() => { global.fetch = original; });
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// alertOpsFailure is deliberately fire-and-forget, so its DB write lands on its own
// schedule — poll instead of guessing a fixed delay for the real Postgres round-trip.
async function waitForNotification(kind, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await db.prepare('SELECT * FROM notifications WHERE kind = ?').get(kind);
    if (row) return row;
    await wait(25);
  }
  return null;
}

test('alertOpsFailure sends once per kind and rate-limits repeats within the window', async () => {
  await withFakeFetch(async (calls) => {
    alertOpsFailure('test_kind_a', 'First failure', 'details 1');
    alertOpsFailure('test_kind_a', 'Second failure', 'details 2'); // same kind, immediate repeat — suppressed
    await wait(20);
    assert.equal(calls.length, 1, 'second call within the rate-limit window should be suppressed');
    assert.equal(calls[0].body.subject, 'First failure');
  });
});

test('alertOpsFailure treats different kinds independently', async () => {
  await withFakeFetch(async (calls) => {
    alertOpsFailure('test_kind_b1', 'B1 failure', 'details');
    alertOpsFailure('test_kind_b2', 'B2 failure', 'details');
    await wait(20);
    assert.equal(calls.length, 2, 'different kinds should not rate-limit each other');
  });
});

test('alertOpsFailure resumes after the rate-limit window and reports suppressed count', async () => {
  await withFakeFetch(async (calls) => {
    alertOpsFailure('test_kind_c', 'C first', 'd1');
    alertOpsFailure('test_kind_c', 'C suppressed 1', 'd2');
    alertOpsFailure('test_kind_c', 'C suppressed 2', 'd3');
    await wait(80); // past the 50ms window configured above
    alertOpsFailure('test_kind_c', 'C resumed', 'd4');
    await wait(20);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].body.subject, 'C resumed');
    assert.match(calls[1].body.details, /2 additional similar failure\(s\) suppressed/);
  });
});

test("alertOpsFailure does not let one org's alert rate-limit a different org's alert of the same kind", async () => {
  await withFakeFetch(async (calls) => {
    alertOpsFailure('test_kind_org_scope', 'Org A failure', 'details a', { orgId: 111111 });
    alertOpsFailure('test_kind_org_scope', 'Org B failure', 'details b', { orgId: 222222 });
    await wait(20);
    assert.equal(calls.length, 2, 'different orgs should not rate-limit each other for the same kind');
  });
});

test('alertOpsFailure with { internal: true } writes an in-app notification instead of emailing', async () => {
  const kind = `test_internal_${Date.now()}`;
  await withFakeFetch(async () => {
    alertOpsFailure(kind, 'Infra failure', 'infra details', { internal: true });
    const row = await waitForNotification(kind);
    assert.ok(row, 'expected a notifications row for an internal alert');
    assert.equal(row.subject, 'Infra failure');
    await db.prepare('DELETE FROM notifications WHERE kind = ?').run(kind);
  });
});

after(async () => {
  // The first three tests never pass an orgId, so under the new routing they count as
  // "internal" too and fire-and-forget an insert into `notifications` — wait for those to
  // land before closing the pool, then sweep up everything this file wrote.
  await wait(300);
  await db.prepare("DELETE FROM notifications WHERE kind LIKE 'test_kind_%'").run();
  await db.pool.end();
});
