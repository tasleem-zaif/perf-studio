// Regression test for a real bug reported against a live-generated JMX: a saved per-
// endpoint override ("Fix with AI", predating a later confirmed correlation rule for the
// SAME header) unconditionally clobbered the header in buildSamplerXml/buildK6Request,
// even when the rule already produced a correct ${varName} substitution. The override's
// {{captured:staleKey}} placeholder can never resolve (capturedFields — built from
// detectCapturedFields — never covers cookie-sourced values), so the generated script
// ended up with literal, unsupported {{captured:...}} text baked into a header instead of
// the correlation rule's correct ${sessionId} reference.
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildJmxTemplate, buildK6Template } = require('./testSuites');

const endpoints = [
  { name: 'Login', method: 'POST', url: 'https://api.example.com/auth/login', headers: {}, body: '{}', queryParams: {} },
  { name: 'Get Profile', method: 'GET', url: 'https://api.example.com/me', headers: {}, body: '', queryParams: {} },
];
const preRunData = [
  { body: {}, responseHeaders: { 'set-cookie': 'sessionId=sess_9f8e7d6c5b; Path=/; HttpOnly' } },
  { body: {} },
];
// A confirmed correlation rule already correctly handles the "cookie" header on Get Profile.
const confirmedRule = {
  id: '1:header:cookie', sourceEndpointIndex: 0, sourceJsonPath: 'sessionId', sourceLocation: 'cookie',
  targetEndpointIndex: 1, targetLocation: 'header', targetKey: 'cookie', value: null, varName: 'sessionId',
  confidence: 'manual', status: 'confirmed',
};
// A stale override saved BEFORE that rule existed, still referencing an unresolvable
// {{captured:X}} placeholder for a field capturedFields (token/body-based) never covers.
const staleOverride = {
  method: 'GET', name: 'Get Profile',
  headers: { cookie: 'sessionId={{captured:staleSessionKey}}' },
  issue: 'stale pre-correlation fix', fix: 'stale', updatedAt: new Date(0).toISOString(),
};
const suite = { name: 'Override Precedence Test', iter_mode: 'duration', vusers: 5, rampup: 5, duration: 30 };
const baseCfg = {
  protocol: 'https', url: 'api.example.com', port: '443', variables: {},
  correlationRules: [confirmedRule], endpointOverrides: { 1: staleOverride },
};

test('JMX: a confirmed correlation rule wins over a stale override targeting the same header', () => {
  const xml = buildJmxTemplate(suite, null, [], baseCfg, endpoints, preRunData);
  assert.ok(!xml.includes('{{captured:'), 'no unresolved {{captured:...}} placeholder should ever reach the generated script');
  assert.ok(xml.includes('${sessionId}'), 'the confirmed rule\'s own varName must be used instead');
});

test('k6: a confirmed correlation rule wins over a stale override targeting the same header', () => {
  const script = buildK6Template(suite, null, null, baseCfg, endpoints, [], preRunData, 'load');
  assert.ok(!script.includes('{{captured:'));
  assert.ok(script.includes('${sessionId}'));
});

test('JMX: an override for a DIFFERENT header (no competing rule) still applies normally', () => {
  const cfg = {
    ...baseCfg,
    endpointOverrides: { 1: { method: 'GET', name: 'Get Profile', headers: { 'X-Debug': '{{captured:staleSessionKey}}' } } },
  };
  const xml = buildJmxTemplate(suite, null, [], cfg, endpoints, preRunData);
  // capturedFields has no entry for staleSessionKey either, so this is expected to stay
  // literal — proving the fix is scoped to correlation-covered headers, not a blanket
  // "overrides never apply" regression.
  assert.ok(xml.includes('X-Debug'));
});
