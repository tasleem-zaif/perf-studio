// Verifies /ai/pre-run/heal's prompt now exposes the FULL captured-field pool (any body
// field or response header across prior results), not just the fixed TOKEN_KEYS list
// extractAllTokens() was restricted to — and that a {{captured:KEY}} the AI writes for one
// of those broader fields actually resolves when the endpoint is re-fired to verify the fix.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const jwt = require('jsonwebtoken');

const db = require('../db');
const aiClient = require('../utils/aiClient');

// Must mutate the mock BEFORE ai.js is required anywhere in this process — ai.js
// destructures `callAi` off this module at require time, so requiring ai.js first would
// freeze it to the real implementation.
let lastUserPrompt = null;
aiClient.callAi = async (userId, systemPrompt, userPrompt) => {
  lastUserPrompt = userPrompt;
  return JSON.stringify({
    issue: 'Get Order needs the id Create Order returned, not the recorded literal.',
    fix: 'Use {{captured:id}} in the URL.',
    fix_type: 'url_override',
    url: 'https://api.example.com/orders/{{captured:id}}',
  });
};

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

  const email = `heal-fields-test-${Date.now()}@example.com`;
  const u = await db.prepare(
    "INSERT INTO users (email, name, password_hash, role, status) VALUES (?, ?, ?, 'user', 'active')"
  ).run(email, 'Heal Fields Test User', 'x');
  userId = u.lastInsertRowid;

  const jti = `test-jti-${Date.now()}`;
  await db.prepare("INSERT INTO user_sessions (user_id, jti, expires_at) VALUES (?, ?, NOW() + interval '1 hour')").run(userId, jti);
  token = jwt.sign({ userId, jti }, JWT_SECRET);

  const p = await db.prepare('INSERT INTO projects (user_id, name, environment) VALUES (?, ?, ?)').run(userId, 'Heal Fields Test Project', 'Default');
  projectId = p.lastInsertRowid;

  const endpoints = [
    { name: 'Create Order', method: 'POST', url: 'https://api.example.com/orders', headers: {}, body: '{"item":"widget"}', queryParams: {} },
    { name: 'Get Order', method: 'GET', url: 'https://api.example.com/orders/ord_9f8e7d', headers: {}, body: '', queryParams: {} },
  ];
  const c = await db.prepare('INSERT INTO collections (project_id, user_id, name, json_content, environment) VALUES (?, ?, ?, ?, ?)')
    .run(projectId, userId, 'Heal Fields Test Collection', JSON.stringify(endpoints), 'Default');
  collectionId = c.lastInsertRowid;

  // Create Order succeeded and returned a fresh "id" — Get Order (index 1) failed using
  // the stale recorded literal. "id" is not a TOKEN_KEYS name, so the OLD extractAllTokens
  // path would never have surfaced it to the AI at all.
  const priorResults = [
    { success: true, status: 201, body: { id: 'ord_LIVE555', item: 'widget' } },
    { success: false, status: 404, url: 'https://api.example.com/orders/ord_9f8e7d', requestHeaders: {}, requestBody: null, body: { error: 'not found' } },
  ];
  await db.prepare('UPDATE collections SET pre_run_data = ? WHERE id = ?').run(JSON.stringify(priorResults), collectionId);
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  await db.prepare('DELETE FROM collections WHERE id = ?').run(collectionId);
  await db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
  await db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(userId);
  await db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  await db.pool.end();
});

test('POST /ai/pre-run/heal exposes a non-token field ("id") in its captured-fields prompt section', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (url === 'https://api.example.com/orders/ord_LIVE555') {
      return { status: 200, statusText: 'OK', headers: new Map(), text: async () => JSON.stringify({ id: 'ord_LIVE555' }) };
    }
    return { status: 404, statusText: 'Not Found', headers: new Map(), text: async () => '{}' };
  };

  try {
    const res = await originalFetch(`${baseUrl}/ai/pre-run/heal`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: projectId, collection_id: collectionId, index: 1,
        instruction: 'Use the id Create Order returned instead of the hardcoded one',
      }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();

    assert.ok(lastUserPrompt.includes('id (from Create Order, body)'), 'the "id" field must be listed with its source endpoint, proving the broader field pool reached the prompt');

    assert.equal(data.diagnosis.fix_type, 'url_override');
    assert.equal(data.result.success, true, 'the re-fire must succeed once {{captured:id}} resolves to the live id');
    assert.ok(data.result.url.includes('ord_LIVE555'));
    assert.ok(!data.result.url.includes('ord_9f8e7d'));
  } finally {
    global.fetch = originalFetch;
  }
});
