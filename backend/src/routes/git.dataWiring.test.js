// Tests wireOwnerDataIntoCaller() — the DB-layer half of POST /pull ('full' mode) and
// POST /sync ('additive' mode). Runs against the real dev Postgres (DATABASE_URL) using
// throwaway users/project/rows, cleaned up in `after`. Calls the exported function directly
// rather than the HTTP routes, since the git network operations (fetch/merge against a real
// remote) are orthogonal to this — this test is purely about what lands in Postgres.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../db');
const { wireOwnerDataIntoCaller } = require('./git');

let ownerId, pullerId, projectId;
let ownerCollectionId, ownerRuleId, ownerTestDataId, ownerSuiteId;

before(async () => {
  const owner = await db.prepare(
    "INSERT INTO users (email, name, password_hash, role, status) VALUES (?, ?, ?, 'user', 'active')"
  ).run(`data-wiring-owner-${Date.now()}@example.com`, 'Data Wiring Owner', 'x');
  ownerId = owner.lastInsertRowid;

  const puller = await db.prepare(
    "INSERT INTO users (email, name, password_hash, role, status) VALUES (?, ?, ?, 'user', 'active')"
  ).run(`data-wiring-puller-${Date.now()}@example.com`, 'Data Wiring Puller', 'x');
  pullerId = puller.lastInsertRowid;

  const p = await db.prepare('INSERT INTO projects (user_id, name, environment) VALUES (?, ?, ?)')
    .run(ownerId, 'Data Wiring Test Project', 'Default');
  projectId = p.lastInsertRowid;

  const endpoints = [{ name: 'Login', method: 'POST', url: 'https://api.example.com/auth/login', headers: {}, body: '{}', queryParams: {} }];
  const col = await db.prepare(`INSERT INTO collections (project_id, user_id, name, description, json_content, source_type, environment)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(projectId, ownerId, 'Login Flow', '', JSON.stringify(endpoints), 'json', 'Default');
  ownerCollectionId = col.lastInsertRowid;

  await db.prepare(`INSERT INTO collection_env_config (collection_id, env, config_json, project_id, user_id)
    VALUES (?, ?, ?, ?, ?)`)
    .run(ownerCollectionId, 'Default', JSON.stringify({ variables: { baseUrl: 'https://api.example.com' } }), projectId, ownerId);

  const rule = await db.prepare(`INSERT INTO rules (project_id, user_id, metric, operator, value, unit, severity)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(projectId, ownerId, 'response_time', '<', '2000', 'ms', 'error');
  ownerRuleId = rule.lastInsertRowid;

  const td = await db.prepare(`INSERT INTO test_data_files (project_id, user_id, filename, original_name, path, columns, collection_id, env)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(projectId, ownerId, 'users_123.csv', 'users.csv', 'DataWiringTestProject/LoginFlow/Default/testData/users_123.csv', '["email","password"]', ownerCollectionId, 'Default');
  ownerTestDataId = td.lastInsertRowid;

  const suite = await db.prepare(`INSERT INTO test_suites
    (project_id, user_id, name, test_type, collection_id, test_data_id, engine, config_json, env)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(projectId, ownerId, 'Load Test 1', 'load', ownerCollectionId, ownerTestDataId, 'jmeter', '{}', 'Default');
  ownerSuiteId = suite.lastInsertRowid;
});

after(async () => {
  await db.prepare('DELETE FROM test_suites WHERE project_id = ?').run(projectId);
  await db.prepare('DELETE FROM collection_env_config WHERE project_id = ?').run(projectId);
  await db.prepare('DELETE FROM test_data_files WHERE project_id = ?').run(projectId);
  await db.prepare('DELETE FROM rules WHERE project_id = ?').run(projectId);
  await db.prepare('DELETE FROM collections WHERE project_id = ?').run(projectId);
  await db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
  await db.prepare('DELETE FROM users WHERE id IN (?, ?)').run(ownerId, pullerId);
});

test('mode "full": a puller with nothing gets a full copy of the owner\'s data, attributed to them', async () => {
  const result = await wireOwnerDataIntoCaller(projectId, pullerId, false, 'full');
  assert.equal(result.collectionsAdded, 1);
  assert.equal(result.rulesAdded, 1);
  assert.equal(result.testDataAdded, 1);
  assert.equal(result.suitesAdded, 1);
  assert.equal(result.envConfigsAdded, 1);

  const pullerCol = await db.prepare('SELECT * FROM collections WHERE project_id = ? AND user_id = ?').get(projectId, pullerId);
  assert.ok(pullerCol, 'puller should have their own copy of the collection');
  assert.equal(pullerCol.name, 'Login Flow');
  assert.notEqual(pullerCol.id, ownerCollectionId, 'must be a NEW row, not a shared reference to the owner\'s');

  const pullerRule = await db.prepare('SELECT * FROM rules WHERE project_id = ? AND user_id = ?').get(projectId, pullerId);
  assert.equal(pullerRule.metric, 'response_time');

  const pullerSuite = await db.prepare('SELECT * FROM test_suites WHERE project_id = ? AND user_id = ?').get(projectId, pullerId);
  assert.equal(pullerSuite.name, 'Load Test 1');
  assert.equal(pullerSuite.collection_id, pullerCol.id, 'suite must reference the PULLER\'s own collection id, not the owner\'s');

  const pullerTd = await db.prepare('SELECT * FROM test_data_files WHERE project_id = ? AND user_id = ?').get(projectId, pullerId);
  assert.equal(pullerSuite.test_data_id, pullerTd.id, 'suite must reference the PULLER\'s own test-data id, not the owner\'s');

  const pullerEnvCfg = await db.prepare('SELECT * FROM collection_env_config WHERE collection_id = ? AND user_id = ?').get(pullerCol.id, pullerId);
  assert.ok(pullerEnvCfg, 'env config must follow the remapped collection id');
});

test('mode "additive": re-running does not duplicate what already matches, and leaves the puller\'s own separately-added work untouched', async () => {
  // Simulate the puller having since done their own work, unrelated to the owner's data.
  const ownWork = await db.prepare(`INSERT INTO collections (project_id, user_id, name, json_content, environment)
    VALUES (?, ?, ?, ?, ?)`)
    .run(projectId, pullerId, 'My Own Collection', '[]', 'Default');
  const ownCollectionId = ownWork.lastInsertRowid;

  // Owner adds a second, genuinely new collection + rule the puller has never seen.
  const ownerCol2 = await db.prepare(`INSERT INTO collections (project_id, user_id, name, json_content, environment)
    VALUES (?, ?, ?, ?, ?)`)
    .run(projectId, ownerId, 'API v2', '[]', 'Default');
  await db.prepare(`INSERT INTO rules (project_id, user_id, metric, operator, value, unit, severity)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(projectId, ownerId, 'error_rate', '<', '1', '%', 'error');

  const result = await wireOwnerDataIntoCaller(projectId, pullerId, false, 'additive');
  // "Login Flow" already matches (from the previous test) — not duplicated. "API v2" is new.
  assert.equal(result.collectionsAdded, 1);
  // The original "response_time" rule already matches — not duplicated. "error_rate" is new.
  assert.equal(result.rulesAdded, 1);
  // No new suites/test-data on the owner's side this round.
  assert.equal(result.suitesAdded, 0);
  assert.equal(result.testDataAdded, 0);

  const pullerCollections = await db.prepare('SELECT * FROM collections WHERE project_id = ? AND user_id = ?').all(projectId, pullerId);
  assert.equal(pullerCollections.length, 3, 'Login Flow (from before) + My Own Collection (untouched) + API v2 (newly added)');

  const stillOwn = await db.prepare('SELECT * FROM collections WHERE id = ?').get(ownCollectionId);
  assert.equal(stillOwn.user_id, pullerId);
  assert.equal(stillOwn.name, 'My Own Collection', 'the puller\'s own unrelated work must be completely untouched');

  const pullerRules = await db.prepare('SELECT * FROM rules WHERE project_id = ? AND user_id = ?').all(projectId, pullerId);
  assert.equal(pullerRules.length, 2, 'response_time (already had) + error_rate (newly added)');
});

test('mode "full": no-op (returns null) when the caller IS the canonical owner', async () => {
  const result = await wireOwnerDataIntoCaller(projectId, ownerId, false, 'full');
  assert.equal(result, null);
});
