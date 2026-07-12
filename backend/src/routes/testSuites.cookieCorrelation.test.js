// Verifies correlation sourced from a COOKIE flows correctly into both generated engines —
// JMeter gets a RegexExtractor matching `cookieName=value` within the Set-Cookie header
// text (cookies arrive as headers, so this reuses the same useHeaders mechanism as
// header-sourced correlation, just with a different pattern); k6 gets a res.cookies lookup.
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildJmxTemplate, buildK6Template } = require('./testSuites');

// Login sets a session cookie; Get Profile needs that exact session id in a custom header.
const endpoints = [
  { name: 'Login', method: 'POST', url: 'https://api.example.com/auth/login', headers: {}, body: '{}', queryParams: {} },
  { name: 'Get Profile', method: 'GET', url: 'https://api.example.com/me', headers: { 'X-Session': 'sess_9f8e7d6c5b' }, body: '', queryParams: {} },
];
const preRunData = [
  { body: {}, responseHeaders: { 'set-cookie': 'sessionId=sess_9f8e7d6c5b; Path=/; HttpOnly' } },
  { body: {} },
];
const rule = {
  id: '1:header:X-Session', sourceEndpointIndex: 0, sourceJsonPath: 'sessionId', sourceLocation: 'cookie',
  targetEndpointIndex: 1, targetLocation: 'header', targetKey: 'X-Session', value: 'sess_9f8e7d6c5b',
  varName: 'sessionId', confidence: 'manual', status: 'confirmed',
};
const suite = { name: 'Cookie Correlation Test', iter_mode: 'duration', vusers: 5, rampup: 5, duration: 30 };
const baseCfg = { protocol: 'https', url: 'api.example.com', port: '443', variables: {} };

test('JMX: a cookie-sourced value gets a RegexExtractor matching cookieName=value and the target header is rewritten', () => {
  const xml = buildJmxTemplate(suite, null, [], { ...baseCfg, correlationRules: [rule] }, endpoints, preRunData);
  assert.ok(xml.includes('<RegexExtractor '));
  assert.ok(xml.includes('<stringProp name="RegexExtractor.useHeaders">true</stringProp>'));
  assert.ok(xml.includes('(?i)sessionId=([^;\\r\\n]+)'), 'expected a pattern matching cookieName=value, not a header-line pattern');
  assert.ok(xml.includes('X-Session') && xml.includes('${sessionId}'));
  assert.ok(!xml.includes('sess_9f8e7d6c5b'), 'the stale recorded cookie value must be gone');
});

test('k6: a cookie-sourced value is extracted via res.cookies and threaded into the target header', () => {
  const script = buildK6Template(suite, null, null, { ...baseCfg, correlationRules: [rule] }, endpoints, [], preRunData, 'load');
  assert.ok(script.includes("res0.cookies['sessionId']?.[0]?.value"));
  assert.ok(script.includes("'X-Session': `${sessionId}`") || script.includes('X-Session') && script.includes('${sessionId}'));
  assert.ok(!script.includes('sess_9f8e7d6c5b'));
});
