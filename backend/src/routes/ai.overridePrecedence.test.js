// Regression test for a real bug: a stale saved "Fix with AI" override
// (envCfg.endpointOverrides) used to be re-applied on EVERY /pre-run unconditionally,
// even when Phase 1 (which now includes deterministic correlation-rule firing) already
// succeeded on its own. If the override references a field that was never resolvable
// (e.g. a cookie-sourced {{captured:KEY}} — cookies are never fed into the capturedTokens
// map used to resolve {{captured:KEY}}, only body/header TOKEN_KEYS values are), the
// override silently clobbers an already-working result with a broken one, producing a
// 401 for an endpoint a confirmed correlation rule had already fixed correctly.
// Fix: ai.js's /pre-run Phase 2 now only applies a saved override when Phase 1 didn't
// already succeed.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const jwt = require('jsonwebtoken');

const db = require('../db');
const aiRouter = require('./ai');

const JWT_SECRET = process.env.JWT_SECRET || 'perf_studio_secret_change_in_prod';

let server, baseUrl, userId, projectId, collectionId, token;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/ai', aiRouter);
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;

  const email = `override-precedence-test-${Date.now()}@example.com`;
  const u = await db.prepare(
    "INSERT INTO users (email, name, password_hash, role, status) VALUES (?, ?, ?, 'user', 'active')"
  ).run(email, 'Override Precedence Test User', 'x');
  userId = u.lastInsertRowid;

  const jti = `test-jti-${Date.now()}`;
  await db.prepare("INSERT INTO user_sessions (user_id, jti, expires_at) VALUES (?, ?, NOW() + interval '1 hour')").run(userId, jti);
  token = jwt.sign({ userId, jti }, JWT_SECRET);

  const p = await db.prepare('INSERT INTO projects (user_id, name, environment) VALUES (?, ?, ?)').run(userId, 'Override Precedence Test Project', 'Default');
  projectId = p.lastInsertRowid;

  const endpoints = [
    { name: 'Login', method: 'POST', url: 'https://api.example.com/auth/login', headers: {}, body: '{}', queryParams: {} },
    // Recorded with a stale session value — the correlation rule below replaces it.
    { name: 'Get Profile', method: 'GET', url: 'https://api.example.com/me', headers: { 'X-Session': 'sess_9f8e7d6c5b' }, body: '', queryParams: {} },
  ];
  const c = await db.prepare('INSERT INTO collections (project_id, user_id, name, json_content, environment) VALUES (?, ?, ?, ?, ?)')
    .run(projectId, userId, 'Override Precedence Test Collection', JSON.stringify(endpoints), 'Default');
  collectionId = c.lastInsertRowid;

  const confirmedRule = {
    id: '1:header:X-Session', sourceEndpointIndex: 0, sourceJsonPath: 'sessionId', sourceLocation: 'cookie',
    targetEndpointIndex: 1, targetLocation: 'header', targetKey: 'X-Session', value: 'sess_9f8e7d6c5b', varName: 'sessionId',
    confidence: 'manual', status: 'confirmed',
  };
  // A stale AI-authored override, from BEFORE the correlation rule above existed — its
  // {{captured:staleSessionKey}} placeholder can never resolve (no such captured field),
  // so applying it sends the literal unresolved text and breaks the request.
  const staleOverride = {
    method: 'GET', name: 'Get Profile',
    headers: { 'X-Session': '{{captured:staleSessionKey}}' },
    issue: 'stale pre-correlation fix', fix: 'stale', updatedAt: new Date(0).toISOString(),
  };
  await db.prepare('INSERT INTO collection_env_config (collection_id, env, config_json, project_id, user_id) VALUES (?, ?, ?, ?, ?)')
    .run(collectionId, 'Default', JSON.stringify({ correlationRules: [confirmedRule], endpointOverrides: { 1: staleOverride } }), projectId, userId);
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

test('POST /ai/pre-run: a confirmed correlation rule that already succeeds is NOT clobbered by a stale saved override', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (url === 'https://api.example.com/auth/login') {
      return { status: 200, statusText: 'OK', headers: new Map([['set-cookie', 'sessionId=sess_LIVE999; Path=/; HttpOnly']]), text: async () => '{}' };
    }
    if (url === 'https://api.example.com/me') {
      const sent = opts?.headers?.['X-Session'];
      if (sent === 'sess_LIVE999') {
        return { status: 200, statusText: 'OK', headers: new Map(), text: async () => JSON.stringify({ ok: true }) };
      }
      // The stale override's unresolved placeholder, or anything else, gets 401 — proves
      // the correlation-corrected header is what actually needs to reach the server.
      return { status: 401, statusText: 'Unauthorized', headers: new Map(), text: async () => JSON.stringify({ error: 'bad session: ' + sent }) };
    }
    return { status: 404, statusText: 'Not Found', headers: new Map(), text: async () => '{}' };
  };

  try {
    const res = await originalFetch(`${baseUrl}/ai/pre-run`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ collection_id: collectionId, project_id: projectId }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.responses[0].success, true, 'Login must succeed');
    assert.equal(data.responses[1].success, true, 'Get Profile must succeed using the correlation-corrected session, not the stale override');
    assert.ok(!data.responses[1].aiFixed, 'the stale override must not have been re-applied over an already-successful Phase 1 result');
    assert.equal(data.responses[1].requestHeaders['X-Session'], 'sess_LIVE999');
  } finally {
    global.fetch = originalFetch;
  }
});
