// Confirms ruleEvaluator.js's new `engine` parameter (added for k6 support) picks the right
// parser and stays backward compatible for existing JMeter callers that don't pass it at all.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../db');
const { evaluateRulesFromContent } = require('./ruleEvaluator');

let userId, projectId, ruleId, p95RuleId, p99RuleId;

before(async () => {
  const email = `ruleeval-k6-test-${Date.now()}@example.com`;
  const u = await db.prepare(
    "INSERT INTO users (email, name, password_hash, role, status) VALUES (?, ?, ?, 'user', 'active')"
  ).run(email, 'RuleEvaluator k6 Test User', 'x');
  userId = u.lastInsertRowid;

  const p = await db.prepare('INSERT INTO projects (user_id, name, environment) VALUES (?, ?, ?)').run(userId, 'RuleEvaluator k6 Test Project', 'Default');
  projectId = p.lastInsertRowid;

  // Error rate > 10% is a breach — the fixtures below have a 25% error rate for both engines.
  const r = await db.prepare(
    "INSERT INTO rules (project_id, user_id, metric, operator, value, unit, severity) VALUES (?, ?, 'Error Rate', '>', '10', '%', 'error')"
  ).run(projectId, userId);
  ruleId = r.lastInsertRowid;

  // Exact metric label Rules.jsx's UI creates (METRIC_CONFIG key 'Latency P95') — regression
  // coverage for the bug where this label had no METRIC_MAP entry and was silently skipped.
  const r2 = await db.prepare(
    "INSERT INTO rules (project_id, user_id, metric, operator, value, unit, severity) VALUES (?, ?, 'Latency P95', '>', '2000', 'ms', 'error')"
  ).run(projectId, userId);
  p95RuleId = r2.lastInsertRowid;

  // Same label-mapping regression, for 'Latency P99' — Rules.jsx's METRIC_CONFIG offers this
  // too (frontend/src/pages/Rules.jsx:14), and it had the identical missing-METRIC_MAP-entry
  // bug (worse, even: parseJtlMetricsFromContent/parseK6MetricsFromContent never computed a
  // p99 value at all until this fix).
  const r3 = await db.prepare(
    "INSERT INTO rules (project_id, user_id, metric, operator, value, unit, severity) VALUES (?, ?, 'Latency P99', '>', '2000', 'ms', 'error')"
  ).run(projectId, userId);
  p99RuleId = r3.lastInsertRowid;
});

after(async () => {
  await db.prepare('DELETE FROM rules WHERE id IN (?, ?, ?)').run(ruleId, p95RuleId, p99RuleId);
  await db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
  await db.prepare('DELETE FROM users WHERE id = ?').run(userId);
});

function k6Line(metric, time, value, tags) {
  return JSON.stringify({ type: 'Point', metric, data: { time, value, tags } });
}

const k6Fixture = [
  k6Line('http_req_duration', '2024-01-01T00:00:00.000Z', 120, { name: '/login', status: '200', expected_response: 'true' }),
  k6Line('http_req_duration', '2024-01-01T00:00:01.000Z', 340, { name: '/login', status: '500', expected_response: 'false' }),
  k6Line('http_req_duration', '2024-01-01T00:00:00.000Z', 80,  { name: '/profile', status: '200', expected_response: 'true' }),
  k6Line('http_req_duration', '2024-01-01T00:00:01.000Z', 100, { name: '/profile', status: '200', expected_response: 'true' }),
].join('\n');

const jtlFixture = [
  'timeStamp,elapsed,label,responseCode,success,latency',
  '1700000000000,120,/login,200,true,120',
  '1700000001000,340,/login,500,false,340',
  '1700000000000,80,/profile,200,true,80',
  '1700000001000,100,/profile,200,true,100',
].join('\n');

test('evaluateRulesFromContent(engine="k6") parses k6 JSON and flags the error-rate breach', async () => {
  const result = await evaluateRulesFromContent(projectId, k6Fixture, userId, 'k6');
  assert.equal(result.noRules, false);
  assert.equal(result.passed, false);
  assert.ok(result.violations.some(v => v.rule.metric === 'Error Rate'));
});

test('evaluateRulesFromContent defaults to jmeter (engine omitted) — unchanged behavior for existing callers', async () => {
  const result = await evaluateRulesFromContent(projectId, jtlFixture, userId);
  assert.equal(result.noRules, false);
  assert.equal(result.passed, false);
  assert.ok(result.violations.some(v => v.rule.metric === 'Error Rate'));
});

test('evaluateRulesFromContent(engine="jmeter") explicit matches the default', async () => {
  const result = await evaluateRulesFromContent(projectId, jtlFixture, userId, 'jmeter');
  assert.equal(result.passed, false);
});

test('a "Latency P95" rule (the exact label the Rule Engine UI creates) is actually evaluated, not silently skipped', async () => {
  const result = await evaluateRulesFromContent(projectId, k6Fixture, userId, 'k6');
  const p95Result = result.results.find(r => r.rule.metric === 'Latency P95');
  assert.ok(p95Result, 'expected a "Latency P95" rule to appear in results — it must not be dropped by an unrecognized metric name');
  // All k6Fixture latencies are well under the 2000ms threshold, so it should show as met.
  assert.equal(p95Result.status, 'met');
});

test('a "Latency P99" rule (also offered by the Rule Engine UI) is actually evaluated, not silently skipped', async () => {
  const result = await evaluateRulesFromContent(projectId, k6Fixture, userId, 'k6');
  const p99Result = result.results.find(r => r.rule.metric === 'Latency P99');
  assert.ok(p99Result, 'expected a "Latency P99" rule to appear in results — it must not be dropped by an unrecognized metric name');
  assert.equal(p99Result.status, 'met');
});
