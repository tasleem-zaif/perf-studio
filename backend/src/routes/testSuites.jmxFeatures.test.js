// Verifies the JMeter-parity additions: a per-request ResponseAssertion (status code
// matches 2xx/3xx, mirroring k6's check()) and a single Thread-Group-scoped ConstantTimer
// for request pacing (mirroring k6's sleep(1)). The exact property keys/values below were
// verified against JMeter's own ResponseAssertion.java / ConstantTimer.java source —
// including the real "Asserion.test_strings" typo baked into JMeter itself — not guessed,
// since a wrong constant here would silently produce a no-op assertion.
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildJmxTemplate } = require('./testSuites');

const endpoints = [
  { name: 'Login', method: 'POST', url: 'https://api.example.com/auth/login', headers: {}, body: '{}', queryParams: {} },
  { name: 'Get Profile', method: 'GET', url: 'https://api.example.com/me', headers: {}, body: '', queryParams: {} },
];
const suite = { name: 'Feature Test', iter_mode: 'duration', vusers: 5, rampup: 5, duration: 30 };
const cfg = { protocol: 'https', url: 'api.example.com', port: '443', variables: {} };

function generate() {
  return buildJmxTemplate(suite, null, [], cfg, endpoints, null);
}

test('every sampler gets a ResponseAssertion with the exact JMeter property keys', () => {
  const xml = generate();
  const count = (xml.match(/<ResponseAssertion /g) || []).length;
  assert.equal(count, endpoints.length, 'expected one ResponseAssertion per endpoint');
  assert.ok(xml.includes('<collectionProp name="Asserion.test_strings">'), 'must use JMeter\'s real (typo\'d) property name, not the "corrected" spelling');
  assert.ok(xml.includes('<stringProp name="Assertion.test_field">Assertion.response_code</stringProp>'));
  assert.ok(xml.includes('<intProp name="Assertion.test_type">1</intProp>'), 'test_type 1 = MATCH');
  assert.ok(xml.includes('[23]\\d\\d'));
});

test('the response assertion for each sampler sits inside that sampler\'s own hashTree', () => {
  const xml = generate();
  const loginPos = xml.indexOf('testname="Login"');
  const loginAssertionPos = xml.indexOf('ResponseAssertion', loginPos);
  const profilePos = xml.indexOf('testname="Get Profile"');
  assert.ok(loginAssertionPos > loginPos && loginAssertionPos < profilePos, 'Login\'s assertion must appear between Login and the next sampler');
});

// A stress test plan (testType 'stress') must generate a 5-step UltimateThreadGroup
// staircase (jpgc-casutg — already bundled in the JMeter Docker image) instead of the flat
// ThreadGroup every other test type gets. Row values verified against UltimateThreadGroup's
// documented column semantics (start count / initial delay / startup / hold / shutdown), not
// guessed — a wrong row shape would silently produce a nonsensical load profile.
test('stress test type emits a 5-step UltimateThreadGroup staircase up to vusers, not the flat ThreadGroup', () => {
  const stressSuite = { name: 'Stress Test', vusers: 100, duration: 300 };
  const xml = buildJmxTemplate(stressSuite, null, [], cfg, endpoints, null, 'stress');

  assert.ok(xml.includes('<kg.apc.jmeter.threads.UltimateThreadGroup '), 'expected an UltimateThreadGroup element');
  assert.ok(!xml.includes('<ThreadGroup guiclass="ThreadGroupGui"'), 'must not ALSO emit the flat ThreadGroup');

  const rows = [...xml.matchAll(/<collectionProp name="\d">\s*<stringProp name="0">(\d+)<\/stringProp>\s*<stringProp name="1">(\d+)<\/stringProp>\s*<stringProp name="2">(\d+)<\/stringProp>\s*<stringProp name="3">(\d+)<\/stringProp>\s*<stringProp name="4">(\d+)<\/stringProp>/g)]
    .map(m => ({ startCount: +m[1], delay: +m[2], startup: +m[3], hold: +m[4], shutdown: +m[5] }));
  assert.equal(rows.length, 5, 'expected exactly 5 staircase rows');

  // Cumulative thread count after each row's ramp must be 20/40/60/80/100 (vusers=100, 5 steps).
  // startup is a small fraction of the 60s-per-step budget (20% = 12s) — there's no rampup
  // input for stress tests at all anymore (blocked/hidden in the UI); see the regression test
  // below for why that distinction matters.
  let cumulative = 0;
  const expectedTargets = [20, 40, 60, 80, 100];
  rows.forEach((r, i) => {
    cumulative += r.startCount;
    assert.equal(cumulative, expectedTargets[i], `row ${i} should bring the cumulative total to ${expectedTargets[i]}`);
    assert.equal(r.startup, 12, 'each row ramps over a fraction of its own step budget, derived from duration alone');
    assert.equal(r.shutdown, 30, 'each row shares the same final ramp-down window');
  });

  // Every row's (delay + startup + hold) must land on the SAME end time, so all rows ramp
  // down together instead of tearing down mid-staircase — and that end time must equal the
  // configured Duration (300s), NOT Duration * STRESS_STEPS (a real bug this test catches: a
  // 300s-configured stress test was actually running for 28 minutes before this fix, because
  // every one of the 5 steps got its own full 300s hold on top of its own full ramp-up).
  const endTimes = new Set(rows.map(r => r.delay + r.startup + r.hold));
  assert.equal(endTimes.size, 1, 'every row must converge on the same end time');
  assert.equal([...endTimes][0], stressSuite.duration, 'end time must equal the configured Duration exactly, not Duration * STRESS_STEPS');

  // load (and every other type) must be completely unaffected — still the flat ThreadGroup.
  const loadXml = generate();
  assert.ok(loadXml.includes('<ThreadGroup guiclass="ThreadGroupGui"'));
  assert.ok(!loadXml.includes('UltimateThreadGroup'));
});

test('regression: a real-world duration must still leave a real hold plateau, not a zero-hold continuous ramp, regardless of any ramp-up value', () => {
  // Reproduces the exact reported real-world case: VUsers=50, Duration=100s. Before this fix,
  // startup = min(rampup, stepBudget) let a 30s ramp-up (the old UI default) consume the
  // WHOLE 20s step budget, leaving hold = 0 for every row — a continuous ramp with no plateau
  // at all, which then produced a per-second-granularity report table with dozens of
  // near-duplicate rows instead of 5 clean steps. Ramp-up is no longer a factor at all: the UI
  // blocks/hides it for stress tests, and the generator derives the transition purely from
  // duration.
  const stressSuite = { name: 'Degenerate Case', vusers: 50, duration: 100 };
  const xml = buildJmxTemplate(stressSuite, null, [], cfg, endpoints, null, 'stress');
  const rows = [...xml.matchAll(/<collectionProp name="\d">\s*<stringProp name="0">(\d+)<\/stringProp>\s*<stringProp name="1">(\d+)<\/stringProp>\s*<stringProp name="2">(\d+)<\/stringProp>\s*<stringProp name="3">(\d+)<\/stringProp>\s*<stringProp name="4">(\d+)<\/stringProp>/g)]
    .map(m => ({ startup: +m[3], hold: +m[4] }));
  assert.equal(rows.length, 5);
  for (const r of rows) {
    assert.ok(r.hold > 0, 'each row must have a genuine, non-zero hold plateau');
    assert.ok(r.hold / (r.startup + r.hold) >= 0.7, `hold should be the large majority of each step's budget (got ${r.hold}/${r.startup + r.hold})`);
    assert.equal(r.startup, 5, 'transition should be a small fraction of the 20s-per-step budget');
  }
});

test('exactly one ConstantTimer is declared at Thread Group scope (not per-sampler)', () => {
  const xml = generate();
  const count = (xml.match(/<ConstantTimer /g) || []).length;
  assert.equal(count, 1, 'a single Timer at Thread Group scope applies to every sampler beneath it — one copy is correct, not one per endpoint');
  assert.ok(xml.includes('<stringProp name="ConstantTimer.delay">1000</stringProp>'));
  // Must be declared before any HTTPSamplerProxy (thread-group level, sibling to CSVDataSet/
  // HTTP Request Defaults), not nested inside one.
  const timerPos = xml.indexOf('<ConstantTimer');
  const firstSamplerPos = xml.indexOf('<HTTPSamplerProxy');
  assert.ok(timerPos < firstSamplerPos, 'the timer must be declared before the first sampler, at Thread Group scope');
});

// Spike test: baseline -> sudden burst -> recovery, NOT a staircase (that's Stress). Reuses
// UltimateThreadGroup with just 2 rows (baseline + spike), distinguished by testname since
// both test types share the same plugin element.
test('spike test type (short duration, 1 spike tier) emits a 2-row UltimateThreadGroup (baseline + spike), not the 5-row stress staircase or flat ThreadGroup', () => {
  const spikeSuite = { name: 'Spike Test', vusers: 100, duration: 100 }; // < 120s -> 1 spike
  const xml = buildJmxTemplate(spikeSuite, null, [], cfg, endpoints, null, 'spike');

  assert.ok(xml.includes('<kg.apc.jmeter.threads.UltimateThreadGroup '), 'expected an UltimateThreadGroup element');
  assert.ok(xml.includes('testname="Spike Thread Group"'), 'must be distinguishable from the stress staircase by testname');
  assert.ok(!xml.includes('<ThreadGroup guiclass="ThreadGroupGui"'), 'must not ALSO emit the flat ThreadGroup');

  const rows = [...xml.matchAll(/<collectionProp name="\d">\s*<stringProp name="0">(\d+)<\/stringProp>\s*<stringProp name="1">(\d+)<\/stringProp>\s*<stringProp name="2">(\d+)<\/stringProp>\s*<stringProp name="3">(\d+)<\/stringProp>\s*<stringProp name="4">(\d+)<\/stringProp>/g)]
    .map(m => ({ startCount: +m[1], delay: +m[2], startup: +m[3], hold: +m[4], shutdown: +m[5] }));
  assert.equal(rows.length, 2, 'expected exactly 2 rows: baseline + spike, not a 5-step staircase');

  const [baseline, spike] = rows;
  assert.equal(baseline.startCount, 10, 'baseline should be 10% of VUsers');
  assert.equal(baseline.delay, 0, 'baseline must start at t=0');
  assert.equal(baseline.delay + baseline.startup + baseline.hold, spikeSuite.duration, 'baseline must span the full configured Duration, not Duration * anything');
  assert.equal(baseline.startCount + spike.startCount, spikeSuite.vusers, 'cumulative peak concurrency must equal the full configured VUsers exactly');
  assert.ok(spike.delay > 0, 'the spike must start partway through the run (after a baseline period), not immediately');
  const spikeEnd = spike.delay + spike.startup + spike.hold + spike.shutdown;
  assert.ok(spikeEnd < spikeSuite.duration, `the spike must fully finish well before the test ends, leaving a real recovery window (spike ended at ${spikeEnd}, duration ${spikeSuite.duration})`);
  assert.ok((spikeSuite.duration - spikeEnd) / spikeSuite.duration > 0.3, 'the recovery window should be a substantial fraction of the test — that\'s the part that actually shows whether the system bounced back');
});

// Multiple spikes catch cumulative degradation a single burst can't (a leak that only shows
// up after the 2nd/3rd cycle) — the number of cycles is fixed at generation time from
// Duration, per the agreed thresholds: >=300s -> 3, >=120s -> 2, else 1.
for (const [duration, expectedSpikes] of [[150, 2], [350, 3]]) {
  test(`spike test type at duration=${duration}s emits ${expectedSpikes} evenly-spaced spike cycles`, () => {
    const spikeSuite = { name: 'Multi Spike Test', vusers: 200, duration };
    const xml = buildJmxTemplate(spikeSuite, null, [], cfg, endpoints, null, 'spike');
    const rows = [...xml.matchAll(/<collectionProp name="\d">\s*<stringProp name="0">(\d+)<\/stringProp>\s*<stringProp name="1">(\d+)<\/stringProp>\s*<stringProp name="2">(\d+)<\/stringProp>\s*<stringProp name="3">(\d+)<\/stringProp>\s*<stringProp name="4">(\d+)<\/stringProp>/g)]
      .map(m => ({ startCount: +m[1], delay: +m[2], startup: +m[3], hold: +m[4], shutdown: +m[5] }));
    assert.equal(rows.length, expectedSpikes + 1, `expected 1 baseline row + ${expectedSpikes} spike rows`);

    const [baseline, ...spikes] = rows;
    assert.equal(spikes.length, expectedSpikes);
    assert.ok(spikes.every(s => baseline.startCount + s.startCount === spikeSuite.vusers), 'every spike must reach the exact same peak concurrency (baseline + spike = VUsers)');

    // Spikes must be non-overlapping and roughly evenly spaced (each new spike starts only
    // after the previous one has fully shut down).
    const ends = spikes.map(s => s.delay + s.startup + s.hold + s.shutdown);
    for (let i = 1; i < spikes.length; i++) {
      assert.ok(spikes[i].delay >= ends[i - 1], `spike #${i + 1} must not start before spike #${i} has fully finished`);
    }
    const gaps = [spikes[0].delay, ...spikes.slice(1).map((s, i) => s.delay - ends[i]), duration - ends[ends.length - 1]];
    const maxGap = Math.max(...gaps), minGap = Math.min(...gaps);
    assert.ok(maxGap - minGap <= 1, `baseline/recovery gaps should be evenly spaced (got ${JSON.stringify(gaps)})`);
  });
}

// The user can now type an explicit spike count in Test Plan creation instead of relying on
// the duration-based suggestion. When set, config_json.spike_count must always win — even
// when it deliberately contradicts what the duration tier would have suggested.
test('spike test type: an explicit config_json.spike_count overrides the duration-based suggestion', () => {
  const duration = 350; // duration tier alone would suggest 3 spikes
  const spikeSuite = { name: 'Spike Test', vusers: 200, duration, config_json: JSON.stringify({ spike_count: 1 }) };
  const xml = buildJmxTemplate(spikeSuite, null, [], cfg, endpoints, null, 'spike');
  const rows = [...xml.matchAll(/<collectionProp name="\d">\s*<stringProp name="0">(\d+)<\/stringProp>\s*<stringProp name="1">(\d+)<\/stringProp>\s*<stringProp name="2">(\d+)<\/stringProp>\s*<stringProp name="3">(\d+)<\/stringProp>\s*<stringProp name="4">(\d+)<\/stringProp>/g)];
  assert.equal(rows.length, 2, 'explicit spike_count=1 must produce 1 baseline + 1 spike row, ignoring the duration-suggested 3');
});

test('spike test type: an out-of-range config_json.spike_count falls back to the duration-based suggestion', () => {
  const duration = 100; // duration tier suggests 1 spike
  const spikeSuite = { name: 'Spike Test', vusers: 200, duration, config_json: JSON.stringify({ spike_count: 99 }) };
  const xml = buildJmxTemplate(spikeSuite, null, [], cfg, endpoints, null, 'spike');
  const rows = [...xml.matchAll(/<collectionProp name="\d">\s*<stringProp name="0">(\d+)<\/stringProp>\s*<stringProp name="1">(\d+)<\/stringProp>\s*<stringProp name="2">(\d+)<\/stringProp>\s*<stringProp name="3">(\d+)<\/stringProp>\s*<stringProp name="4">(\d+)<\/stringProp>/g)];
  assert.equal(rows.length, 2, 'out-of-range spike_count=99 must fall back to the suggested 1 spike, not error or pass through unchecked');
});

// Endurance's load SHAPE is deliberately identical to Load Test (ramp to Users, hold for
// Duration) — the flat ThreadGroup already does exactly this correctly; there's no separate
// thread-group implementation to build, only a long Duration and analysis-side degradation
// checking (enduranceAnalysis.js) make it an "endurance" test.
test('endurance test type reuses the flat ThreadGroup (Ramp-up meaningful, same as Load Test), not a dedicated thread group', () => {
  const enduranceSuite = { name: 'Endurance Test', vusers: 50, rampup: 30, duration: 6000 };
  const xml = buildJmxTemplate(enduranceSuite, null, [], cfg, endpoints, null, 'endurance');
  assert.ok(xml.includes('<ThreadGroup guiclass="ThreadGroupGui"'), 'endurance must use the flat ThreadGroup, same as Load Test');
  assert.ok(!xml.includes('UltimateThreadGroup'), 'must not use the stress/spike staircase thread group');
  assert.ok(xml.includes('<stringProp name="ThreadGroup.ramp_time">${RAMP_UP}</stringProp>'), 'Ramp-up must stay a real, functional field for endurance (unlike stress/spike)');
});

test('assertions and timer do not break hashTree pairing (every opening tag closed)', () => {
  const xml = generate();
  const opens = (xml.match(/<hashTree>/g) || []).length;
  const closes = (xml.match(/<\/hashTree>/g) || []).length;
  const selfClosed = (xml.match(/<hashTree\/>/g) || []).length;
  // Every <hashTree> open must have a matching </hashTree>; self-closed <hashTree/> tags
  // are independent leaf markers and don't need a pair.
  assert.equal(opens, closes, `mismatched hashTree open/close tags (${opens} opens vs ${closes} closes) — likely from the new assertion/timer blocks`);
  assert.ok(selfClosed > 0);
});
