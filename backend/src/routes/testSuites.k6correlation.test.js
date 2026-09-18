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

test('stress test type generates a 5-step staircase up to the VUsers ceiling, not the old ramp-to-half/ramp-to-double shape', () => {
  const script = buildK6Template(suite, null, null, { ...baseCfg, correlationRules: [] }, endpoints, [], preRunData, 'stress');
  assert.ok(script.includes("executor: 'ramping-vus'"), 'stress must use the ramping-vus executor');

  // 5 distinct step targets: THREADS*1/5 .. THREADS*4/5, then THREADS itself for the final step.
  for (let i = 1; i < 5; i++) {
    assert.ok(script.includes(`Math.round(THREADS * ${i} / 5)`), `expected a step targeting THREADS * ${i}/5`);
  }
  assert.ok(script.includes('target: THREADS }'), 'the final step must reach the full THREADS ceiling, not THREADS * 2');
  assert.ok(!script.includes('target: THREADS * 2 }'), 'the old double-the-ceiling stage must be gone');

  // Each step ramps (STEP_RAMP) then holds (STEP_HOLD) — NOT the raw RAMP_UP/DURATION values,
  // which would give each step its own full duration and inflate the total test length by
  // STRESS_STEPS (a real bug this regression test catches: a 300s-configured stress test was
  // actually running for 28 minutes). DURATION must be divided across the steps instead.
  // STEP_RAMP is derived purely from STEP_S, never from RAMP_UP — Ramp-up is blocked/hidden in
  // the UI for stress tests entirely, since "one overall ramp" isn't a meaningful concept for
  // a staircase (see buildUltimateThreadGroupXml's matching JMeter-side comment for why).
  assert.ok(script.includes('const STEP_S    = Math.round(DURATION / 5);'), 'DURATION must be divided by STRESS_STEPS into a per-step budget');
  assert.ok(script.includes('const STEP_RAMP = Math.max(5, Math.round(STEP_S * 0.2));'), 'ramp-up must be a small fraction of the per-step budget, derived from duration alone');
  assert.ok(script.includes('const STEP_HOLD = Math.max(0, STEP_S - STEP_RAMP);'));
  assert.equal((script.match(/duration: STEP_RAMP \+ 's'/g) || []).length, 5, 'expected 5 ramp-up stages (one per step)');
  assert.equal((script.match(/duration: STEP_HOLD \+ 's'/g) || []).length, 5, 'expected 5 hold stages (one per step)');
  assert.ok(!script.includes('duration: RAMP_UP'), 'stages must not use the raw (unclamped, un-divided) RAMP_UP directly');
  assert.ok(!script.includes('duration: DURATION +'), 'stages must not use the raw (un-divided) DURATION directly');
  assert.ok(script.includes("{ duration: '30s', target: 0 }"), 'expected a final ramp-down to 0');

  assert.doesNotThrow(() => assertValidK6Syntax(script));
});

test('stress total staircase time (before the final ramp-down) equals the configured Duration, not Duration * STRESS_STEPS', () => {
  // Reproduces the exact reported case: VUsers=50, Ramp-up=30s, Duration=300s must total
  // ~300s (+ a small fixed ramp-down tail), not 1650s/27.5min.
  const stressSuite = { name: 'Stress', vusers: 50, rampup: 30, duration: 300 };
  const script = buildK6Template(stressSuite, null, null, { ...baseCfg, correlationRules: [] }, endpoints, [], preRunData, 'stress');
  // eslint-disable-next-line no-new-func
  const compute = new Function(`
    const __ENV = {};
    const THREADS = parseInt(__ENV.THREADS || '${stressSuite.vusers}');
    const RAMP_UP = parseInt(__ENV.RAMP_UP || '${stressSuite.rampup}');
    const DURATION = parseInt(__ENV.DURATION || '${stressSuite.duration}');
    const STEP_S = Math.round(DURATION / 5);
    const STEP_RAMP = Math.max(5, Math.round(STEP_S * 0.2));
    const STEP_HOLD = Math.max(0, STEP_S - STEP_RAMP);
    return 5 * (STEP_RAMP + STEP_HOLD);
  `);
  assert.equal(compute(), 300, 'total staircase time before ramp-down must equal Duration exactly');
  assert.doesNotThrow(() => assertValidK6Syntax(script));
});

test('regression: a real-world duration must still leave a real hold plateau, not a zero-hold continuous ramp, regardless of any ramp-up value', () => {
  // Reproduces the exact reported case: VUsers=50, Duration=100s. Before this fix,
  // STEP_RAMP = min(RAMP_UP, STEP_S) let a 30s ramp-up (the old UI default) consume the
  // WHOLE 20s step budget, leaving STEP_HOLD = 0 for every step — a continuous ramp with no
  // plateau to analyze at all. Ramp-up is no longer a factor at all: the UI blocks/hides it
  // for stress tests, and the generator derives the transition purely from duration.
  const stressSuite = { name: 'Degenerate Case', vusers: 50, duration: 100 };
  const script = buildK6Template(stressSuite, null, null, { ...baseCfg, correlationRules: [] }, endpoints, [], preRunData, 'stress');
  const compute = new Function(`
    const DURATION = ${stressSuite.duration};
    const STEP_S = Math.round(DURATION / 5);
    const STEP_RAMP = Math.max(5, Math.round(STEP_S * 0.2));
    const STEP_HOLD = Math.max(0, STEP_S - STEP_RAMP);
    return { STEP_S, STEP_RAMP, STEP_HOLD };
  `);
  const { STEP_S, STEP_RAMP, STEP_HOLD } = compute();
  assert.ok(STEP_HOLD > 0, 'each step must have a genuine, non-zero hold plateau');
  assert.ok(STEP_HOLD / STEP_S >= 0.7, `hold should be the large majority of each step's budget (got ${STEP_HOLD}/${STEP_S})`);
  assert.equal(STEP_RAMP, 5, 'transition should be a small fraction of the 20s-per-step budget');
  assert.doesNotThrow(() => assertValidK6Syntax(script));
});

test('spike test type (short duration, 1 spike tier) generates a ramping-vus baseline/peak/recovery shape, not the old ramping-arrival-rate hardcoded-60s shape', () => {
  const spikeSuite = { name: 'Spike', vusers: 100, duration: 100 }; // < 120s -> 1 spike
  const script = buildK6Template(spikeSuite, null, null, { ...baseCfg, correlationRules: [] }, endpoints, [], preRunData, 'spike');

  assert.ok(script.includes("executor: 'ramping-vus'"), 'spike must use ramping-vus (concurrent users), not ramping-arrival-rate (requests/sec) — THREADS means VUs everywhere else in this app');
  assert.ok(!script.includes('ramping-arrival-rate'), 'the old arrival-rate executor must be gone');
  assert.ok(script.includes('const SPIKE_BASELINE'), 'expected the spike phase-split constants derived from THREADS/DURATION');
  assert.ok(!script.includes("target: THREADS * 5"), 'the old unexplained THREADS * 5 multiplier must be gone');

  // Reproduces the old bug directly: the whole spike shape used to be a hardcoded 60s
  // (10s+10s+30s+10s) regardless of DURATION. Compute the actual generated stage durations at
  // a DURATION the old hardcoded shape would get comically wrong, and confirm they sum to the
  // real configured value.
  const compute = new Function(`
    const THREADS = ${spikeSuite.vusers};
    const DURATION = ${spikeSuite.duration};
    const SPIKE_BASELINE = Math.max(1, Math.round(THREADS * 0.10));
    const SPIKE_BEFORE_S = Math.round(DURATION * 0.20);
    const SPIKE_RAMP_S   = Math.max(5, Math.round(DURATION * 0.03));
    const SPIKE_PEAK_S   = Math.round(DURATION * 0.15);
    const SPIKE_AFTER_S  = Math.max(0, DURATION - SPIKE_BEFORE_S - SPIKE_RAMP_S - SPIKE_PEAK_S - SPIKE_RAMP_S);
    return SPIKE_BEFORE_S + SPIKE_RAMP_S + SPIKE_PEAK_S + SPIKE_RAMP_S + SPIKE_AFTER_S;
  `);
  assert.equal(compute(), spikeSuite.duration, 'the stage durations must sum to exactly the configured Duration, not a hardcoded 60s');
  assert.doesNotThrow(() => assertValidK6Syntax(script));
});

// Multiple spikes catch cumulative degradation a single burst can't — same duration
// thresholds as the JMeter generator (>=300s -> 3, >=120s -> 2, else 1), and both engines
// must land on the identical schedule for the same inputs.
for (const [duration, expectedSpikes] of [[150, 2], [350, 3]]) {
  test(`spike test type at duration=${duration}s generates ${expectedSpikes} ramping-vus cycles, stages summing to the real Duration`, () => {
    const spikeSuite = { name: 'Multi Spike', vusers: 200, duration };
    const script = buildK6Template(spikeSuite, null, null, { ...baseCfg, correlationRules: [] }, endpoints, [], preRunData, 'spike');

    assert.ok(script.includes('const SPIKE_GAP_S'), 'multi-spike tiers use the gap-based formula, not the single-spike SPIKE_BEFORE_S/SPIKE_AFTER_S one');
    // Each cycle emits exactly one peak-HOLD stage (SPIKE_PEAK_S at THREADS) — distinct from
    // the ramp-UP-to-THREADS stage, which also targets THREADS but for SPIKE_RAMP_S.
    const peakHoldCount = (script.match(/SPIKE_PEAK_S \+ 's', target: THREADS \}/g) || []).length;
    assert.equal(peakHoldCount, expectedSpikes, `expected ${expectedSpikes} distinct peak-hold stages`);
    assert.doesNotThrow(() => assertValidK6Syntax(script));
  });
}

// The user can type an explicit spike count in Test Plan creation instead of relying on the
// duration-based suggestion. config_json.spike_count must win over the suggestion, and an
// out-of-range value must fall back to it rather than error or pass through unchecked.
test('spike test type: an explicit config_json.spike_count overrides the duration-based suggestion', () => {
  const duration = 350; // duration tier alone would suggest 3 spikes
  const spikeSuite = { name: 'Spike', vusers: 200, duration, config_json: JSON.stringify({ spike_count: 1 }) };
  const script = buildK6Template(spikeSuite, null, null, { ...baseCfg, correlationRules: [] }, endpoints, [], preRunData, 'spike');
  assert.ok(script.includes('const SPIKE_BEFORE_S'), 'explicit spike_count=1 must use the single-spike formula, ignoring the duration-suggested 3');
  assert.doesNotThrow(() => assertValidK6Syntax(script));
});

test('spike test type: an out-of-range config_json.spike_count falls back to the duration-based suggestion', () => {
  const duration = 100; // duration tier suggests 1 spike
  const spikeSuite = { name: 'Spike', vusers: 200, duration, config_json: JSON.stringify({ spike_count: 99 }) };
  const script = buildK6Template(spikeSuite, null, null, { ...baseCfg, correlationRules: [] }, endpoints, [], preRunData, 'spike');
  assert.ok(script.includes('const SPIKE_BEFORE_S'), 'out-of-range spike_count=99 must fall back to the suggested 1 spike');
  assert.doesNotThrow(() => assertValidK6Syntax(script));
});

test('endurance test type uses constant-vus (concurrent users), not the old constant-arrival-rate (requests/sec) executor', () => {
  const enduranceSuite = { name: 'Endurance', vusers: 50, duration: 6000 };
  const script = buildK6Template(enduranceSuite, null, null, { ...baseCfg, correlationRules: [] }, endpoints, [], preRunData, 'endurance');
  assert.ok(script.includes("executor: 'constant-vus'"), 'endurance must use constant-vus, the same executor Load Test uses');
  assert.ok(!script.includes('constant-arrival-rate'), 'the old arrival-rate executor (which misread THREADS as requests/sec) must be gone');
  assert.ok(script.includes('vus: THREADS'), 'THREADS must mean concurrent virtual users here, consistent with every other test type');
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
