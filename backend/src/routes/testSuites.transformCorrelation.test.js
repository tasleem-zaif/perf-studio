// Verifies transform/derived-value correlation rules (utils/transforms.js) end-to-end in
// both generated engines, plus a regression test for a real bug this uncovered: k6's
// query-string builder was percent-encoding query-param values unconditionally, corrupting
// ANY correlation/generator `${...}` placeholder placed there (not just transformed ones) —
// e.g. `${crypto.md5(x, 'hex')}` became `%24%7Bcrypto.md5(x%2C%20'hex')%7D`, sent to the
// server literally instead of k6 evaluating it. Fixed via isPlaceholderRef() in
// testSuites.js; these tests exist so a query-target correlation never silently regresses
// back to being corrupted again.
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildJmxTemplate, buildK6Template } = require('./testSuites');

function assertValidK6Syntax(script) {
  const tmpFile = path.join(os.tmpdir(), `transform-test-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(tmpFile, script);
  try { execFileSync(process.execPath, ['--check', tmpFile], { stdio: 'pipe' }); }
  finally { fs.unlinkSync(tmpFile); }
}

const endpoints = [
  { name: 'Login', method: 'POST', url: 'https://api.example.com/auth/login', headers: {}, body: '{}', queryParams: {} },
  { name: 'Verify', method: 'GET', url: 'https://api.example.com/verify', headers: {}, body: '', queryParams: { checksum: 'abc123hash' } },
];
const preRunData = [{ body: { userId: 'u123' } }, { body: {} }];
const suite = { name: 'Transform Test', iter_mode: 'duration', vusers: 5, rampup: 5, duration: 30 };
const baseCfg = { protocol: 'https', url: 'api.example.com', port: '443', variables: {} };

function transformRule(transform) {
  return [{
    id: '1:query:checksum', sourceEndpointIndex: 0, sourceJsonPath: '$.userId', sourceLocation: 'body',
    targetEndpointIndex: 1, targetLocation: 'query', targetKey: 'checksum', value: 'abc123hash',
    varName: 'userId', transform, confidence: 'manual', status: 'confirmed',
  }];
}

test('JMX: a transform rule wraps the extracted variable in the correct JMeter function call', () => {
  const xml = buildJmxTemplate(suite, null, [], { ...baseCfg, correlationRules: transformRule('md5') }, endpoints, preRunData);
  assert.ok(xml.includes('${__digest(MD5,${userId},,,)}'));
  assert.ok(!xml.includes('abc123hash'), 'the stale literal must be gone');
});

test('k6: a transform rule imports k6/crypto only when needed and produces the correct expression', () => {
  const script = buildK6Template(suite, null, null, { ...baseCfg, correlationRules: transformRule('md5') }, endpoints, [], preRunData, 'load');
  assert.ok(script.includes("import crypto from 'k6/crypto';"));
  assert.ok(script.includes("checksum=${crypto.md5(userId, 'hex')}"), 'the ${...} placeholder must NOT be percent-encoded in the query string');
  assert.ok(!script.includes('%24%7B'), 'regression check: the placeholder must never come out percent-encoded');
  assert.doesNotThrow(() => assertValidK6Syntax(script));
});

test('k6: a non-transform query-target correlation is also not percent-encoded (the broader regression)', () => {
  const rules = [{
    id: '1:query:checksum', sourceEndpointIndex: 0, sourceJsonPath: '$.userId', sourceLocation: 'body',
    targetEndpointIndex: 1, targetLocation: 'query', targetKey: 'checksum', value: 'abc123hash',
    varName: 'userId', confidence: 'manual', status: 'confirmed',
  }];
  const script = buildK6Template(suite, null, null, { ...baseCfg, correlationRules: rules }, endpoints, [], preRunData, 'load');
  assert.ok(script.includes('checksum=${userId}'));
  assert.ok(!script.includes('%24%7B'));
  assert.doesNotThrow(() => assertValidK6Syntax(script));
});

test('k6: crypto is NOT imported when no rule uses a hash transform', () => {
  const script = buildK6Template(suite, null, null, { ...baseCfg, correlationRules: [] }, endpoints, [], preRunData, 'load');
  assert.ok(!script.includes("k6/crypto"));
});

test('k6: urlEncode/upperCase transforms produce the correct plain-JS expressions', () => {
  const urlEncScript = buildK6Template(suite, null, null, { ...baseCfg, correlationRules: transformRule('urlEncode') }, endpoints, [], preRunData, 'load');
  assert.ok(urlEncScript.includes('checksum=${encodeURIComponent(userId)}'));
  const upperScript = buildK6Template(suite, null, null, { ...baseCfg, correlationRules: transformRule('upperCase') }, endpoints, [], preRunData, 'load');
  assert.ok(upperScript.includes('checksum=${userId.toUpperCase()}'));
});
