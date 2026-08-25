// Integration test for the correlation review endpoints added to ai.js (GET/POST
// /ai/correlations*). Runs against the real dev Postgres (DATABASE_URL) using a
// throwaway user/project/collection, cleaned up in `after`. Does NOT exercise
// POST /ai/pre-run's live-fire step — preRunEngine.js deliberately blocks
// localhost/private-IP targets (SSRF guard), so there's no safe local URL to fire
// against; this test seeds pre_run/correlation data directly instead, the same
// shape /pre-run itself would have written.
require('dotenv').config(); // db/pg.js reads DATABASE_URL — only src/index.js loads dotenv normally, tests need it too
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const jwt = require('jsonwebtoken');

const db = require('../db');
const aiRouter = require('./ai');
const { detectCorrelations } = require('../utils/correlationEngine');

const JWT_SECRET = process.env.JWT_SECRET || 'perf_studio_secret_change_in_prod';

let server, baseUrl, userId, projectId, collectionId, token;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/ai', aiRouter);
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;

  const email = `correlation-test-${Date.now()}@example.com`;
  const u = await db.prepare(
    "INSERT INTO users (email, name, password_hash, role, status) VALUES (?, ?, ?, 'user', 'active')"
  ).run(email, 'Correlation Test User', 'x');
  userId = u.lastInsertRowid;

  const jti = `test-jti-${Date.now()}`;
  await db.prepare("INSERT INTO user_sessions (user_id, jti, expires_at) VALUES (?, ?, NOW() + interval '1 hour')").run(userId, jti);
  token = jwt.sign({ userId, jti }, JWT_SECRET);

  const p = await db.prepare('INSERT INTO projects (user_id, name, environment) VALUES (?, ?, ?)').run(userId, 'Correlation Test Project', 'Default');
  projectId = p.lastInsertRowid;

  const endpoints = [
    { name: 'Login', method: 'POST', url: 'https://api.example.com/auth/login', headers: {}, body: '{}', queryParams: {} },
    { name: 'Create Order', method: 'POST', url: 'https://api.example.com/orders', headers: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.abc.sig' }, body: '{"item":"widget"}', queryParams: {} },
    { name: 'Get Order', method: 'GET', url: 'https://api.example.com/orders/ord_9f8e7d', headers: {}, body: '', queryParams: {} },
  ];
  const c = await db.prepare('INSERT INTO collections (project_id, user_id, name, json_content, environment) VALUES (?, ?, ?, ?, ?)')
    .run(projectId, userId, 'Correlation Test Collection', JSON.stringify(endpoints), 'Default');
  collectionId = c.lastInsertRowid;

  const preRunData = [
    { body: { accessToken: 'eyJhbGciOiJIUzI1NiJ9.abc.sig' } },
    { body: { id: 'ord_9f8e7d', item: 'widget' } },
    { body: { id: 'ord_9f8e7d' } },
  ];
  const rules = detectCorrelations(endpoints, preRunData);
  await db.prepare('INSERT INTO collection_env_config (collection_id, env, config_json, project_id, user_id) VALUES (?, ?, ?, ?, ?)')
    .run(collectionId, 'Default', JSON.stringify({ correlationRules: rules }), projectId, userId);
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  await db.prepare('DELETE FROM collection_env_config WHERE collection_id = ?').run(collectionId);
  await db.prepare('DELETE FROM collections WHERE id = ?').run(collectionId);
  await db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
  await db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(userId);
  await db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  await db.pool.end();
});

test('GET /ai/correlations returns the seeded detected rules', async () => {
  const res = await fetch(`${baseUrl}/ai/correlations?collection_id=${collectionId}&project_id=${projectId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.correlationRules.length >= 2, 'expected the auth-token and order-id rules seeded in before()');
});

test('GET /ai/correlations without a token is rejected', async () => {
  const res = await fetch(`${baseUrl}/ai/correlations?collection_id=${collectionId}&project_id=${projectId}`);
  assert.equal(res.status, 401);
});

test('POST /ai/correlations/status confirms a rule and the change round-trips through GET', async () => {
  const before1 = await (await fetch(`${baseUrl}/ai/correlations?collection_id=${collectionId}&project_id=${projectId}`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json();
  const target = before1.correlationRules[0];

  const res = await fetch(`${baseUrl}/ai/correlations/status`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ collection_id: collectionId, project_id: projectId, id: target.id, status: 'confirmed' }),
  });
  assert.equal(res.status, 200);

  const after1 = await (await fetch(`${baseUrl}/ai/correlations?collection_id=${collectionId}&project_id=${projectId}`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json();
  assert.equal(after1.correlationRules.find(r => r.id === target.id).status, 'confirmed');
});

test('POST /ai/correlations/manual adds a pre-confirmed rule', async () => {
  const res = await fetch(`${baseUrl}/ai/correlations/manual`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      collection_id: collectionId, project_id: projectId,
      sourceEndpointIndex: 0, sourceJsonPath: '$.accessToken',
      targetEndpointIndex: 1, targetLocation: 'header', targetKey: 'Authorization', varName: 'accessToken',
      // The recorded header is "Bearer <token>" — an explicit value is required to target
      // just the token substring, not the whole "Bearer ..." text (see the route's comment).
      value: 'eyJhbGciOiJIUzI1NiJ9.abc.sig',
    }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  const manual = data.correlationRules.find(r => r.targetLocation === 'header' && r.targetKey === 'Authorization' && r.confidence === 'manual');
  assert.ok(manual, 'expected the manually-added rule to be present');
  assert.equal(manual.status, 'confirmed');
  assert.equal(manual.confidence, 'manual');
  assert.equal(manual.value, 'eyJhbGciOiJIUzI1NiJ9.abc.sig', 'the explicit value (just the token) must be stored, not the whole "Bearer ..." header text');
});

test('POST /ai/correlations/delete removes a rule by id', async () => {
  const list = await (await fetch(`${baseUrl}/ai/correlations?collection_id=${collectionId}&project_id=${projectId}`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json();
  const toDelete = list.correlationRules.find(r => r.targetKey === 'Authorization' && r.confidence === 'manual');
  assert.ok(toDelete, 'precondition: manual rule from the previous test must still exist');

  const res = await fetch(`${baseUrl}/ai/correlations/delete`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ collection_id: collectionId, project_id: projectId, id: toDelete.id }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(!data.correlationRules.some(r => r.id === toDelete.id));
});

test('POST /ai/generators/manual adds a field generator, GET lists it, POST /delete removes it', async () => {
  const addRes = await fetch(`${baseUrl}/ai/generators/manual`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      collection_id: collectionId, project_id: projectId,
      targetEndpointIndex: 1, targetLocation: 'body', targetKey: '$.item', value: 'widget', generator: 'uuid',
    }),
  });
  assert.equal(addRes.status, 200);
  const added = (await addRes.json()).fieldGenerators.find(r => r.targetKey === '$.item');
  assert.ok(added);
  assert.equal(added.generator, 'uuid');

  const listRes = await (await fetch(`${baseUrl}/ai/generators?collection_id=${collectionId}&project_id=${projectId}`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json();
  assert.ok(listRes.fieldGenerators.some(r => r.id === added.id));
  assert.ok(listRes.availableTypes.includes('uuid'));

  const delRes = await fetch(`${baseUrl}/ai/generators/delete`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ collection_id: collectionId, project_id: projectId, id: added.id }),
  });
  const delData = await delRes.json();
  assert.ok(!delData.fieldGenerators.some(r => r.id === added.id));
});

test('POST /ai/pre-run fires sequentially and applies live correlation when confirmed rules exist', async () => {
  // Confirm every rule (including the low-confidence urlPath one) so the sequential
  // correlated path — not just the parallel default — is exercised end to end.
  const list = await (await fetch(`${baseUrl}/ai/correlations?collection_id=${collectionId}&project_id=${projectId}`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json();
  for (const rule of list.correlationRules) {
    await fetch(`${baseUrl}/ai/correlations/status`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ collection_id: collectionId, project_id: projectId, id: rule.id, status: 'confirmed' }),
    });
  }

  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (url === 'https://api.example.com/auth/login') {
      return { status: 200, statusText: 'OK', headers: new Map(), text: async () => JSON.stringify({ accessToken: 'tok_live_abc' }) };
    }
    if (url === 'https://api.example.com/orders') {
      return { status: 201, statusText: 'Created', headers: new Map(), text: async () => JSON.stringify({ id: 'ord_LIVE555', item: 'widget' }) };
    }
    if (url === 'https://api.example.com/orders/ord_LIVE555') {
      return { status: 200, statusText: 'OK', headers: new Map(), text: async () => JSON.stringify({ id: 'ord_LIVE555' }) };
    }
    // Any other URL (in particular the stale recorded id) is a bug in the feature, not a
    // legitimate call this test should let through silently.
    return { status: 404, statusText: 'Not Found', headers: new Map(), text: async () => JSON.stringify({ error: 'unexpected URL: ' + url }) };
  };

  try {
    // Must use the SAVED original fetch for this call — it's this test process reaching
    // its own local Express server, not the server's outbound call to the mocked target;
    // both share the same process-global fetch, so the mock above would otherwise catch it.
    const res = await originalFetch(`${baseUrl}/ai/pre-run`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ collection_id: collectionId, project_id: projectId }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.responses[0].success, true, 'Login must succeed');
    assert.equal(data.responses[1].success, true, 'Create Order must succeed');
    assert.equal(data.responses[2].success, true, 'Get Order must succeed using the LIVE id, not the stale recorded one');
    assert.ok(data.responses[2].url.includes('ord_LIVE555'));
    assert.ok(!data.responses[2].url.includes('ord_9f8e7d'));
  } finally {
    global.fetch = originalFetch;
  }
});

test('POST /ai/generators/manual rejects an unknown generator type', async () => {
  const res = await fetch(`${baseUrl}/ai/generators/manual`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      collection_id: collectionId, project_id: projectId,
      targetEndpointIndex: 1, targetLocation: 'body', targetKey: '$.item', value: 'widget', generator: 'not-a-real-type',
    }),
  });
  assert.equal(res.status, 400);
});

test('POST /ai/correlations/manual rejects a target field that does not exist on the endpoint', async () => {
  const res = await fetch(`${baseUrl}/ai/correlations/manual`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      collection_id: collectionId, project_id: projectId,
      sourceEndpointIndex: 0, sourceJsonPath: '$.accessToken',
      targetEndpointIndex: 1, targetLocation: 'header', targetKey: 'X-Does-Not-Exist', varName: 'accessToken',
    }),
  });
  assert.equal(res.status, 400);
});

test('POST /ai/correlations/manual rejects an explicit value not present in the target field', async () => {
  const res = await fetch(`${baseUrl}/ai/correlations/manual`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      collection_id: collectionId, project_id: projectId,
      sourceEndpointIndex: 0, sourceJsonPath: '$.accessToken',
      targetEndpointIndex: 1, targetLocation: 'header', targetKey: 'Authorization', varName: 'accessToken',
      value: 'this-value-is-not-in-the-header',
    }),
  });
  assert.equal(res.status, 400);
});

test('POST /ai/correlations/manual rejects an invalid transform type', async () => {
  const res = await fetch(`${baseUrl}/ai/correlations/manual`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      collection_id: collectionId, project_id: projectId,
      sourceEndpointIndex: 0, sourceJsonPath: '$.accessToken',
      targetEndpointIndex: 1, targetLocation: 'header', targetKey: 'Authorization', varName: 'accessToken',
      value: 'eyJhbGciOiJIUzI1NiJ9.abc.sig', transform: 'not-a-real-transform',
    }),
  });
  assert.equal(res.status, 400);
});

test('POST /ai/correlations/manual resolves a bare source field name (no jsonPath) against real pre-run data', async () => {
  // Give this collection real pre_run_data so bare-name resolution has something to
  // search — the seeded before() fixture only stores correlationRules, not pre_run_data.
  await db.prepare('UPDATE collections SET pre_run_data = ? WHERE id = ?').run(JSON.stringify([
    { body: { accessToken: 'eyJhbGciOiJIUzI1NiJ9.abc.sig' } },
    { body: { id: 'ord_9f8e7d', item: 'widget' } },
    { body: { id: 'ord_9f8e7d' } },
  ]), collectionId);

  const res = await fetch(`${baseUrl}/ai/correlations/manual`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      collection_id: collectionId, project_id: projectId,
      sourceEndpointIndex: 1, sourceJsonPath: 'id', // bare name, not "$.id"
      targetEndpointIndex: 2, targetLocation: 'urlPath', targetKey: '2',
    }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  const rule = data.correlationRules.find(r => r.targetEndpointIndex === 2 && r.targetLocation === 'urlPath' && r.confidence === 'manual');
  assert.ok(rule, 'expected the rule to be created from a bare field name');
  assert.equal(rule.sourceJsonPath, '$.id', 'the bare name must resolve to a real jsonPath');
});

test('POST /ai/correlations/manual returns a clear error when a bare source field name does not exist in the captured response', async () => {
  const res = await fetch(`${baseUrl}/ai/correlations/manual`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      collection_id: collectionId, project_id: projectId,
      sourceEndpointIndex: 1, sourceJsonPath: 'thisFieldDoesNotExist',
      targetEndpointIndex: 2, targetLocation: 'urlPath', targetKey: '2',
    }),
  });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.ok(/not found/i.test(data.error));
});

test('POST /ai/correlations/manual accepts sourceLocation "cookie"', async () => {
  const endpointsWithCookieTarget = [
    { name: 'Login', method: 'POST', url: 'https://api.example.com/auth/login', headers: {}, body: '{}', queryParams: {} },
    { name: 'Create Order', method: 'POST', url: 'https://api.example.com/orders', headers: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.abc.sig' }, body: '{"item":"widget"}', queryParams: {} },
    { name: 'Get Order', method: 'GET', url: 'https://api.example.com/orders/ord_9f8e7d', headers: {}, body: '', queryParams: {} },
  ];
  const res = await fetch(`${baseUrl}/ai/correlations/manual`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      collection_id: collectionId, project_id: projectId,
      sourceEndpointIndex: 0, sourceJsonPath: 'sessionId', sourceLocation: 'cookie',
      targetEndpointIndex: 2, targetLocation: 'urlPath', targetKey: '2',
    }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  const rule = data.correlationRules.find(r => r.sourceLocation === 'cookie' && r.confidence === 'manual');
  assert.ok(rule, 'expected a cookie-sourced manual rule to be accepted');
  assert.equal(rule.sourceJsonPath, 'sessionId', 'a cookie/header name is used as-is, no jsonPath resolution needed');
});

test('POST /ai/correlations/manual rejects an invalid sourceLocation', async () => {
  const res = await fetch(`${baseUrl}/ai/correlations/manual`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      collection_id: collectionId, project_id: projectId,
      sourceEndpointIndex: 0, sourceJsonPath: 'x', sourceLocation: 'query',
      targetEndpointIndex: 2, targetLocation: 'urlPath', targetKey: '2',
    }),
  });
  assert.equal(res.status, 400);
});

// --- Multi-target manual rule creation (a session token from Login's cookie, fanned out
// into several APIs at once) — its own isolated collection/project so it doesn't disturb
// the shared-state fixture above.
let multiCollectionId;

test('setup: seed a collection for multi-target correlation tests', async () => {
  const endpoints = [
    { name: 'Login', method: 'POST', url: 'https://api.example.com/auth/login', headers: {}, body: '{}', queryParams: {} },
    { name: 'Get Catalog', method: 'GET', url: 'https://api.example.com/catalog', headers: {}, body: '', queryParams: {} }, // never recorded any session header
    { name: 'Get Profile', method: 'GET', url: 'https://api.example.com/me', headers: {}, body: '', queryParams: {} }, // never recorded any session header either
    { name: 'Get Orders', method: 'GET', url: 'https://api.example.com/orders', headers: { 'X-Session-Token': 'sess_STALE_abc' }, body: '', queryParams: {} }, // DOES already carry the header
  ];
  const c = await db.prepare('INSERT INTO collections (project_id, user_id, name, json_content, environment) VALUES (?, ?, ?, ?, ?)')
    .run(projectId, userId, 'Multi-Target Correlation Test Collection', JSON.stringify(endpoints), 'Default');
  multiCollectionId = c.lastInsertRowid;
});

test('POST /ai/correlations/manual with injectIfMissing creates one rule per target endpoint, even where the header was never recorded', async () => {
  const res = await fetch(`${baseUrl}/ai/correlations/manual`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      collection_id: multiCollectionId, project_id: projectId,
      sourceEndpointIndex: 0, sourceJsonPath: 'sessionId', sourceLocation: 'cookie',
      targetEndpointIndex: [1, 2, 3], targetLocation: 'header', targetKey: 'X-Session-Token', varName: 'sessionId',
      injectIfMissing: true,
    }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.created.length, 3, 'all three targets must succeed, including the two that never recorded the header');
  assert.equal(data.skipped.length, 0);

  const rules = data.correlationRules.filter(r => r.targetKey === 'X-Session-Token' && r.confidence === 'manual');
  assert.equal(rules.length, 3);
  for (const idx of [1, 2, 3]) {
    const rule = rules.find(r => r.targetEndpointIndex === idx);
    assert.ok(rule, `expected a rule targeting endpoint #${idx}`);
    assert.equal(rule.value, null, 'inject-mode rules must not require an existing literal');
    assert.equal(rule.varName, 'sessionId');
    assert.equal(rule.sourceLocation, 'cookie');
  }
});

test('POST /ai/correlations/manual without injectIfMissing partially succeeds: replaces where a literal exists, skips where it does not', async () => {
  const res = await fetch(`${baseUrl}/ai/correlations/manual`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      collection_id: multiCollectionId, project_id: projectId,
      sourceEndpointIndex: 0, sourceJsonPath: 'sessionId', sourceLocation: 'cookie',
      targetEndpointIndex: [1, 3], targetLocation: 'header', targetKey: 'X-Session-Token', varName: 'sessionId2',
      // no injectIfMissing this time
    }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.created.length, 1, 'only endpoint #3, which already had the header recorded, should succeed');
  assert.deepEqual(data.created, ['3:header:X-Session-Token']);
  assert.equal(data.skipped.length, 1, 'endpoint #1 never recorded the header, so it must be skipped, not fail the whole request');
  assert.equal(data.skipped[0].targetEndpointIndex, 1);
  assert.ok(/injectIfMissing/.test(data.skipped[0].reason));

  const replacedRule = data.correlationRules.find(r => r.targetEndpointIndex === 3 && r.targetKey === 'X-Session-Token' && r.varName === 'sessionId2');
  assert.ok(replacedRule);
  assert.equal(replacedRule.value, 'sess_STALE_abc', 'a non-inject rule must capture the endpoint\'s real current literal');
});

test('POST /ai/correlations/manual rejects injectIfMissing combined with a non-header targetLocation', async () => {
  const res = await fetch(`${baseUrl}/ai/correlations/manual`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      collection_id: multiCollectionId, project_id: projectId,
      sourceEndpointIndex: 0, sourceJsonPath: 'sessionId', sourceLocation: 'cookie',
      targetEndpointIndex: [1], targetLocation: 'query', targetKey: 'session', injectIfMissing: true,
    }),
  });
  assert.equal(res.status, 400);
});

test('POST /ai/correlations/manual with all-invalid targets returns 400 and reports every skip reason', async () => {
  const res = await fetch(`${baseUrl}/ai/correlations/manual`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      collection_id: multiCollectionId, project_id: projectId,
      sourceEndpointIndex: 0, sourceJsonPath: 'sessionId', sourceLocation: 'cookie',
      targetEndpointIndex: [99, 100], targetLocation: 'header', targetKey: 'X-Session-Token',
    }),
  });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.skipped.length, 2);
});

test('POST /ai/correlations/manual still accepts a single (non-array) targetEndpointIndex, unchanged', async () => {
  const res = await fetch(`${baseUrl}/ai/correlations/manual`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      collection_id: multiCollectionId, project_id: projectId,
      sourceEndpointIndex: 0, sourceJsonPath: 'sessionId', sourceLocation: 'cookie',
      targetEndpointIndex: 2, targetLocation: 'header', targetKey: 'X-Session-Token', varName: 'sessionId3',
      injectIfMissing: true,
    }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data.created, ['2:header:X-Session-Token']);
});

test('teardown: remove the multi-target correlation test collection', async () => {
  await db.prepare('DELETE FROM collection_env_config WHERE collection_id = ?').run(multiCollectionId);
  await db.prepare('DELETE FROM collections WHERE id = ?').run(multiCollectionId);
});
