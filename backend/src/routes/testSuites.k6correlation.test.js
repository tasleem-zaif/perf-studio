// Fixture-driven test for the deterministic k6 generator (buildK6Request/buildK6Template),
// mirroring testSuites.correlation.test.js's JMX coverage against the same login ->
// create-order -> get-order -> update-order flow, plus a CSV substitution case k6 didn't
// have a deterministic path for before this phase.
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { detectCorrelations } = require('../utils/correlationEngine');
const { buildK6Template } = require('./testSuites');

// k6 scripts are ES modules (import/export) — `new Function()` can't parse that syntax at
// all, so real syntax validation means asking node itself, via `--check` against a real
// .mjs file (syntax-only, doesn't execute — no need to resolve k6-specific imports).
function assertValidK6Syntax(script) {
  const tmpFile = path.join(os.tmpdir(), `k6-correlation-test-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(tmpFile, script);
  try {
    execFileSync(process.execPath, ['--check', tmpFile], { stdio: 'pipe' });
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

const endpoints = [
  { name: 'Login', method: 'POST', url: 'https://api.example.com/auth/login', headers: {}, body: '{}', queryParams: {} },
  { name: 'Create Order', method: 'POST', url: 'https://api.example.com/orders', headers: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.abc.sig' }, body: '{"item":"widget"}', queryParams: {} },
  { name: 'Get Order', method: 'GET', url: 'https://api.example.com/orders/ord_9f8e7d', headers: {}, body: '', queryParams: {} },
  { name: 'Update Order', method: 'PUT', url: 'https://api.example.com/orders', headers: {}, body: '{"orderId":"ord_9f8e7d","status":"shipped"}', queryParams: {} },
];
const preRunData = [
  { body: { accessToken: 'eyJhbGciOiJIUzI1NiJ9.abc.sig' } },
  { body: { id: 'ord_9f8e7d', item: 'widget' } },
  { body: { id: 'ord_9f8e7d', item: 'widget', status: 'pending' } },
  { body: { id: 'ord_9f8e7d', status: 'shipped' } },
];

const suite = { name: 'Order Flow', vusers: 10, rampup: 5, duration: 60 };
const baseCfg = { protocol: 'https', url: 'api.example.com', port: '443', variables: {} };

function generate(correlationRules, testDataFile, fieldGenerators) {
  return buildK6Template(suite, null, testDataFile || null, { ...baseCfg, correlationRules, fieldGenerators }, endpoints, [], preRunData, 'load');
}

test('generated script is syntactically valid JavaScript', () => {
  const rules = detectCorrelations(endpoints, preRunData);
  const script = generate(rules);
  assert.doesNotThrow(() => assertValidK6Syntax(script), 'buildK6Template output must parse as valid JS');
});

test('high-confidence rules are applied: token header + body field rewritten, extractors placed in source order', () => {
  const rules = detectCorrelations(endpoints, preRunData);
  const script = generate(rules);

  assert.ok(script.includes('Bearer ${accessToken}'), 'Authorization header should interpolate ${accessToken}');
  assert.ok(!script.includes('eyJhbGciOiJIUzI1NiJ9.abc.sig'), 'the raw recorded token must not appear literally anymore');
  assert.ok(script.includes('const accessToken = res0.json()?.accessToken;'), 'expected an accessToken extractor sourced from res0 (Login)');
  assert.ok(script.includes('const id = res1.json()?.id;'), 'expected an id extractor sourced from res1 (Create Order)');

  const extractorPos = script.indexOf('const accessToken = res0.json()');
  const usagePos = script.indexOf('Bearer ${accessToken}');
  assert.ok(extractorPos < usagePos, 'the extractor must be declared before it is used in a later request');

  assert.ok(script.includes('"orderId": "${id}"') || script.includes('${id}'), 'Update Order body should reference ${id}');
});

test('a low-confidence unconfirmed rule (path segment) is not applied', () => {
  const rules = detectCorrelations(endpoints, preRunData);
  const script = generate(rules);
  assert.ok(script.includes('ord_9f8e7d'), 'unconfirmed low-confidence rule must leave the literal path segment untouched');
});

test('confirming the low-confidence rule makes the path segment resolve to the variable', () => {
  const rules = detectCorrelations(endpoints, preRunData);
  const confirmed = rules.map(r => r.targetLocation === 'urlPath' ? { ...r, status: 'confirmed' } : r);
  const script = generate(confirmed);
  assert.ok(script.includes('/orders/${id}'), 'confirmed path-segment rule should interpolate ${id}');
  assert.ok(!script.includes('/orders/ord_9f8e7d'));
});

test('rejecting a high-confidence rule keeps the literal', () => {
  const rules = detectCorrelations(endpoints, preRunData);
  const rejected = rules.map(r => r.targetLocation === 'body' ? { ...r, status: 'rejected' } : r);
  const script = generate(rejected);
  assert.ok(script.includes('ord_9f8e7d'), 'a rejected rule must never be applied');
  assert.ok(!script.includes('"orderId": "${id}"'));
});

test('CSV columns are destructured and substituted into the request body via the shared column-name pipeline', () => {
  const testDataFile = { path: '/nonexistent/testdata.csv', columns: '["username"]' };
  const epsWithCsvField = [
    { name: 'Login', method: 'POST', url: 'https://api.example.com/auth/login', headers: {}, body: '{"username":"admin"}', queryParams: {} },
  ];
  const script = buildK6Template(suite, null, testDataFile, { ...baseCfg, correlationRules: [] }, epsWithCsvField, [], null, 'load');
  assert.ok(script.includes("const { username } = row;"), 'expected the CSV row to be destructured into a bare `username` variable');
  assert.ok(script.includes('"username": "${username}"') || script.includes('${username}'), 'body should reference ${username} instead of the recorded literal');
  assert.doesNotThrow(() => assertValidK6Syntax(script));
});

test('with no correlationRules and no CSV, generation still succeeds (backward compatible baseline)', () => {
  const script = generate([]);
  assert.ok(script.includes("import http from 'k6/http';"));
  assert.ok(script.includes('ord_9f8e7d'));
  assert.doesNotThrow(() => assertValidK6Syntax(script));
});

test('login endpoint with no confirmed correlation rules yet still gets a default accessToken extractor (regression: was a ReferenceError at k6 runtime — node --check cannot catch it since the bad reference sits inside a reachable function body, so this needs a value-level assertion)', () => {
  const script = generate([]); // baseline: no correlationRules confirmed at all
  const extractorPos = script.indexOf('const accessToken = res0.json()');
  const usagePos = script.indexOf('Bearer ${accessToken}');
  assert.ok(extractorPos !== -1, 'expected a default accessToken extractor even with zero correlation rules');
  assert.ok(usagePos !== -1 && extractorPos < usagePos, 'the extractor must be declared before Authorization header interpolates it');
});

test('BASE_URL resolves from cfg.urls[] even when the legacy bare protocol/url/port fields are empty (regression: was an empty host, e.g. https://:443/...)', () => {
  const cfgWithUrlsArray = {
    protocol: '', url: '', port: '', variables: {},
    urls: [{ protocol: 'https', url: 'api.qa.example.com', port: '443' }],
    correlationRules: [],
  };
  const script = buildK6Template(suite, null, null, cfgWithUrlsArray, endpoints, [], preRunData, 'load');
  assert.ok(script.includes("const URL      = __ENV.URL      || 'api.qa.example.com';"), 'expected the host resolved from cfg.urls[0].url, not the empty bare cfg.url field');
});

test('k6 thresholds cover Latency P95/P99 (not just Response Time/Error Rate/Throughput) and merge onto one http_req_duration array instead of colliding object keys', () => {
  const rules = [
    { metric: 'Response Time', operator: '<', value: '500', unit: 'ms', severity: 'error' },
    { metric: 'Latency P95', operator: '>', value: '2000', unit: 'ms', severity: 'error' },
    { metric: 'Latency P99', operator: '>', value: '3000', unit: 'ms', severity: 'error' },
    { metric: 'Error Rate', operator: '>', value: '1', unit: '%', severity: 'error' },
    { metric: 'Throughput', operator: '<', value: '50', unit: 'req/s', severity: 'error' },
    { metric: 'CPU Usage', operator: '>', value: '80', unit: '%', severity: 'error' },
  ];
  const script = buildK6Template(suite, null, null, { ...baseCfg, correlationRules: [] }, endpoints, rules, preRunData, 'load');

  // One merged http_req_duration array with all three duration-based expressions — not three
  // separate (colliding, last-wins) object keys.
  const durationLineMatch = script.match(/http_req_duration:\s*\[([^\]]*)\]/);
  assert.ok(durationLineMatch, 'expected a single http_req_duration thresholds array');
  assert.ok(durationLineMatch[1].includes('avg<500'), 'Response Time should produce an avg<N expression');
  assert.ok(durationLineMatch[1].includes('p(95)<2000'), 'Latency P95 must be included');
  assert.ok(durationLineMatch[1].includes('p(99)<3000'), 'Latency P99 must be included');
  assert.equal((script.match(/http_req_duration:/g) || []).length, 1, 'http_req_duration must appear exactly once, not once per rule');

  assert.ok(script.includes("http_req_failed: ['rate<0.01']"));
  assert.ok(script.includes("http_reqs: ['rate>50']"));
  // CPU Usage has no k6 metric equivalent — silently omitted, not a crash.
  assert.doesNotThrow(() => assertValidK6Syntax(script));
});

test('a field generator rewrites a recorded literal with no correlation source into a k6 expression', () => {
  const generatorRules = [{
    targetEndpointIndex: 1, targetLocation: 'body', targetKey: '$.item', value: 'widget', generator: 'timestamp',
  }];
  const script = generate([], null, generatorRules);
  assert.ok(script.includes('"item":"${Date.now()}"'), 'expected the k6 Date.now() expression in place of the literal');
  assert.ok(!script.includes('"item":"widget"'), 'the recorded literal must be gone');
  assert.doesNotThrow(() => assertValidK6Syntax(script));
});
