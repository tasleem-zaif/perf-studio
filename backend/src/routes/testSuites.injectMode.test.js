// Verifies header "inject" mode (value: null) end-to-end through full script generation —
// the case that motivated it: extract a session token from Login's cookie, then inject it
// as a header into an endpoint that was NEVER recorded with that header at all (unlike
// ordinary correlation, which only ever replaces an existing literal).
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildJmxTemplate, buildK6Template } = require('./testSuites');

const endpoints = [
  { name: 'Login', method: 'POST', url: 'https://api.example.com/auth/login', headers: {}, body: '{}', queryParams: {} },
  // Deliberately has NO Authorization/session header recorded at all.
  { name: 'Get Catalog', method: 'GET', url: 'https://api.example.com/catalog', headers: {}, body: '', queryParams: {} },
];
const preRunData = [
  { body: {}, responseHeaders: { 'set-cookie': 'sessionId=sess_9f8e7d6c5b; Path=/; HttpOnly' } },
  { body: {} },
];
const injectRule = {
  id: '1:header:X-Session-Token', sourceEndpointIndex: 0, sourceJsonPath: 'sessionId', sourceLocation: 'cookie',
  targetEndpointIndex: 1, targetLocation: 'header', targetKey: 'X-Session-Token', value: null,
  varName: 'sessionId', confidence: 'manual', status: 'confirmed',
};
const suite = { name: 'Inject Mode Test', iter_mode: 'duration', vusers: 5, rampup: 5, duration: 30 };
const baseCfg = { protocol: 'https', url: 'api.example.com', port: '443', variables: {} };

test('JMX: an injected header appears on an endpoint that never recorded it, sourced from a cookie', () => {
  const xml = buildJmxTemplate(suite, null, [], { ...baseCfg, correlationRules: [injectRule] }, endpoints, preRunData);
  assert.ok(xml.includes('<RegexExtractor '), 'expected the cookie extractor after Login');
  assert.ok(xml.includes('X-Session-Token') && xml.includes('${sessionId}'), 'Get Catalog must carry the injected header');
});

test('k6: an injected header appears on an endpoint that never recorded it, sourced from a cookie', () => {
  const script = buildK6Template(suite, null, null, { ...baseCfg, correlationRules: [injectRule] }, endpoints, [], preRunData, 'load');
  assert.ok(script.includes("res0.cookies['sessionId']?.[0]?.value"));
  assert.ok(script.includes("'X-Session-Token': `${sessionId}`") || (script.includes('X-Session-Token') && script.includes('${sessionId}')));
});

test('with no inject rule at all, the never-recorded header stays absent (backward compatible)', () => {
  const xml = buildJmxTemplate(suite, null, [], { ...baseCfg, correlationRules: [] }, endpoints, preRunData);
  assert.ok(!xml.includes('X-Session-Token'));
});

// The exact multi-target scenario this fan-out was built for: one session token, extracted
// once from Login's cookie, injected as a header into SEVERAL other APIs in one pass —
// proving the multi-target manual-rule endpoint's output (N rules sharing one source/
// varName) actually threads through to real generated JMX/k6, not just the API response.
const fanOutEndpoints = [
  { name: 'Login', method: 'POST', url: 'https://api.example.com/auth/login', headers: {}, body: '{}', queryParams: {} },
  { name: 'Get Catalog', method: 'GET', url: 'https://api.example.com/catalog', headers: {}, body: '', queryParams: {} },
  { name: 'Get Profile', method: 'GET', url: 'https://api.example.com/me', headers: {}, body: '', queryParams: {} },
  { name: 'Get Orders', method: 'GET', url: 'https://api.example.com/orders', headers: {}, body: '', queryParams: {} },
];
const fanOutRules = [1, 2, 3].map(targetEndpointIndex => ({
  id: `${targetEndpointIndex}:header:X-Session-Token`, sourceEndpointIndex: 0, sourceJsonPath: 'sessionId', sourceLocation: 'cookie',
  targetEndpointIndex, targetLocation: 'header', targetKey: 'X-Session-Token', value: null,
  varName: 'sessionId', confidence: 'manual', status: 'confirmed',
}));

test('JMX: one source rule fanned out across 3 target endpoints injects the header into all three', () => {
  const xml = buildJmxTemplate(suite, null, [], { ...baseCfg, correlationRules: fanOutRules }, fanOutEndpoints, preRunData);
  // Each Header element renders the name twice (the elementProp's own "name" attribute,
  // plus its "Header.name" stringProp value) — so 3 target endpoints means 6 occurrences.
  const occurrences = xml.split('X-Session-Token').length - 1;
  assert.equal(occurrences, 6, 'the header must appear on all three target endpoints (Catalog, Profile, Orders)');
  assert.ok(xml.includes('${sessionId}'));
  // Only one extractor should exist — the source-side extraction is deduped across targets,
  // even though 3 separate rules point at it (scriptCorrelation.js's groupRulesBySource).
  const extractorCount = (xml.match(/<RegexExtractor /g) || []).length;
  assert.equal(extractorCount, 1, 'the cookie extractor after Login must be declared once, not once per target');
});

test('k6: one source rule fanned out across 3 target endpoints injects the header into all three', () => {
  const script = buildK6Template(suite, null, null, { ...baseCfg, correlationRules: fanOutRules }, fanOutEndpoints, [], preRunData, 'load');
  const occurrences = script.split('X-Session-Token').length - 1;
  assert.equal(occurrences, 3);
  assert.ok(script.includes("res0.cookies['sessionId']?.[0]?.value"));
  const cookieReadCount = (script.match(/res0\.cookies\['sessionId'\]/g) || []).length;
  assert.equal(cookieReadCount, 1, 'the cookie must be read into a variable once, then reused by all 3 requests');
});
