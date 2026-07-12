// Integration test for POST /api/projects/:projectId/collections/:id/endpoints/delete —
// pruning garbage/noise traffic (static asset requests, framework prefetch calls) that
// got swept up during recording, with the accompanying reindex of correlationRules/
// fieldGenerators/endpointOverrides across every env config row for the collection.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const jwt = require('jsonwebtoken');

const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const collectionsRouter = require('./collections');

const JWT_SECRET = process.env.JWT_SECRET || 'perf_studio_secret_change_in_prod';

let server, baseUrl, userId, projectId, collectionId, token;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/projects/:projectId/collections', collectionsRouter);
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;

  const email = `endpoint-delete-test-${Date.now()}@example.com`;
  const u = await db.prepare(
    "INSERT INTO users (email, name, password_hash, role, status) VALUES (?, ?, ?, 'user', 'active')"
  ).run(email, 'Endpoint Delete Test User', 'x');
  userId = u.lastInsertRowid;

  const jti = `test-jti-${Date.now()}`;
  await db.prepare("INSERT INTO user_sessions (user_id, jti, expires_at) VALUES (?, ?, NOW() + interval '1 hour')").run(userId, jti);
  token = jwt.sign({ userId, jti }, JWT_SECRET);

  const p = await db.prepare('INSERT INTO projects (user_id, name, environment) VALUES (?, ?, ?)').run(userId, 'Endpoint Delete Test Project', 'Default');
  projectId = p.lastInsertRowid;

  const endpoints = [
    { name: 'Login', method: 'POST', url: 'https://api.example.com/auth/login', headers: {}, body: '{}', queryParams: {} },
    { name: 'GET static.js', method: 'GET', url: 'https://api.example.com/_next/static/chunks/x.js', headers: {}, body: '', queryParams: {} }, // garbage — index 1
    { name: 'Get Profile', method: 'GET', url: 'https://api.example.com/me', headers: { 'X-Session-Token': 'sess_STALE' }, body: '', queryParams: {} },
  ];
  const c = await db.prepare('INSERT INTO collections (project_id, name, json_content, environment) VALUES (?, ?, ?, ?)')
    .run(projectId, 'Endpoint Delete Test Collection', JSON.stringify(endpoints), 'Default');
  collectionId = c.lastInsertRowid;

  const rule = {
    id: '2:header:X-Session-Token', sourceEndpointIndex: 0, sourceJsonPath: 'sessionId', sourceLocation: 'cookie',
    targetEndpointIndex: 2, targetLocation: 'header', targetKey: 'X-Session-Token', value: 'sess_STALE', varName: 'sessionId',
    confidence: 'manual', status: 'confirmed',
  };
  const generator = { id: '2:body:$.uuid', targetEndpointIndex: 2, targetLocation: 'body', targetKey: '$.uuid', value: 'x', generator: 'uuid' };
  const override = { 2: { method: 'GET', name: 'Get Profile', headers: { 'X-Session-Token': 'fixed' } } };
  await db.prepare('INSERT INTO collection_env_config (collection_id, env, config_json) VALUES (?, ?, ?)').run(
    collectionId, 'Default',
    JSON.stringify({ correlationRules: [rule], fieldGenerators: [generator], endpointOverrides: override }),
  );
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  await db.prepare('DELETE FROM collection_env_config WHERE collection_id = ?').run(collectionId);
  await db.prepare('DELETE FROM collections WHERE id = ?').run(collectionId);
  await db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
  await db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(userId);
  await db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  await db.pool.end();
  // The route under test writes a real workspace config.json snapshot as a side effect
  // (same as production behavior) — clean up the folder it created.
  const workspaceDir = path.join(__dirname, '..', '..', '..', 'git-workspaces', 'Endpoint_Delete_Test_Project');
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

test('POST .../endpoints/delete removes the garbage endpoint and reindexes correlationRules/fieldGenerators/endpointOverrides across it', async () => {
  const res = await fetch(`${baseUrl}/api/projects/${projectId}/collections/${collectionId}/endpoints/delete`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ index: 1 }), // the garbage static-asset endpoint
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.deletedCount, 1);

  const endpoints = JSON.parse(data.collection.json_content);
  assert.equal(endpoints.length, 2);
  assert.equal(endpoints[0].name, 'Login');
  assert.equal(endpoints[1].name, 'Get Profile', 'Get Profile must now be at index 1, shifted down from 2');

  const envRow = await db.prepare('SELECT config_json FROM collection_env_config WHERE collection_id = ?').get(collectionId);
  const cfg = JSON.parse(envRow.config_json);

  assert.equal(cfg.correlationRules.length, 1);
  assert.equal(cfg.correlationRules[0].targetEndpointIndex, 1, 'the rule that pointed at old index 2 must now point at 1');
  assert.equal(cfg.correlationRules[0].id, '1:header:X-Session-Token');

  assert.equal(cfg.fieldGenerators.length, 1);
  assert.equal(cfg.fieldGenerators[0].targetEndpointIndex, 1);

  assert.deepEqual(Object.keys(cfg.endpointOverrides), ['1']);
});

test('POST .../endpoints/delete rejects an out-of-range index', async () => {
  const res = await fetch(`${baseUrl}/api/projects/${projectId}/collections/${collectionId}/endpoints/delete`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ index: 999 }),
  });
  assert.equal(res.status, 400);
});

test('POST .../endpoints/delete without a token is rejected', async () => {
  const res = await fetch(`${baseUrl}/api/projects/${projectId}/collections/${collectionId}/endpoints/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ index: 0 }),
  });
  assert.equal(res.status, 401);
});
