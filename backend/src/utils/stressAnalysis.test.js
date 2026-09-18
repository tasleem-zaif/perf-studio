const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeStressRun, groupStepsByThreads, groupStepsByKnownWindows, summarizeStep, buildDisplaySteps } = require('./stressAnalysis');

// Builds a synthetic timeline entry the same shape parseJtl.js/parseK6.js produce.
function sec(second, threads, tps, avgRt, errors) {
  return { second, threads, tps, avg_rt: avgRt, errors, error_rate: tps > 0 ? (errors / tps) * 100 : 0 };
}

test('groupStepsByThreads splits a timeline into contiguous plateaus by thread count', () => {
  const timeline = [
    sec(0, 10, 5, 50, 0), sec(1, 10, 5, 50, 0), sec(2, 10, 5, 50, 0),
    sec(3, 20, 8, 60, 0), sec(4, 20, 8, 60, 0),
    sec(5, 30, 10, 70, 0),
  ];
  const steps = groupStepsByThreads(timeline);
  assert.equal(steps.length, 3);
  assert.equal(steps[0].threads, 10);
  assert.equal(steps[0].seconds.length, 3);
  assert.equal(steps[1].threads, 20);
  assert.equal(steps[2].threads, 30);
});

test('summarizeStep aggregates total requests, error rate, avg response time, and throughput correctly', () => {
  const step = { threads: 20, seconds: [sec(0, 20, 10, 100, 1), sec(1, 20, 10, 200, 1)] };
  const summary = summarizeStep(step);
  assert.equal(summary.threads, 20);
  assert.equal(summary.duration_s, 2);
  assert.equal(summary.total_requests, 20);
  assert.equal(summary.avg_response_time, 150); // (100+200)/2
  assert.equal(summary.error_rate, 10);          // 2 errors / 20 requests
  assert.equal(summary.throughput, 10);          // 20 requests / 2 seconds
});

test('analyzeStressRun finds the first step that breaches an error-severity rule, ignoring warning-severity ones', () => {
  const timeline = [
    // Step 1: 10 threads, clean.
    sec(0, 10, 10, 100, 0), sec(1, 10, 10, 100, 0),
    // Step 2: 20 threads, error rate spikes to 20% — breaches an error-severity Error Rate rule.
    sec(2, 20, 10, 150, 2), sec(3, 20, 10, 150, 2),
    // Step 3: 30 threads — never reached in terms of "breaking point" since step 2 already broke.
    sec(4, 30, 10, 500, 0),
  ];
  const rules = [
    { metric: 'Error Rate', operator: '>', value: '1', unit: '%', severity: 'warning' },   // more lenient, warning-only — must NOT trigger
    { metric: 'Error Rate', operator: '>', value: '10', unit: '%', severity: 'error' },     // this one should trigger at step 2
  ];
  const { breakingPoint } = analyzeStressRun(timeline, rules);
  assert.ok(breakingPoint, 'expected a breaking point to be found');
  assert.equal(breakingPoint.reason, 'rule');
  assert.equal(breakingPoint.step.threads, 20);
  assert.equal(breakingPoint.metric, 'Error Rate');
});

test('analyzeStressRun falls back to throughput-plateau detection when no rule is configured', () => {
  const timeline = [
    sec(0, 10, 10, 100, 0), sec(1, 10, 10, 100, 0),   // step1: throughput ~10
    sec(2, 20, 20, 100, 0), sec(3, 20, 20, 100, 0),   // step2: throughput ~20 (doubled, healthy growth)
    sec(4, 30, 21, 100, 0), sec(5, 30, 21, 100, 0),   // step3: throughput ~21 — barely moved despite +10 threads
  ];
  const { breakingPoint } = analyzeStressRun(timeline, []);
  assert.ok(breakingPoint, 'expected a plateau-based breaking point');
  assert.equal(breakingPoint.reason, 'plateau');
  assert.equal(breakingPoint.step.threads, 30);
});

test('analyzeStressRun returns no breaking point when the system handles every step cleanly', () => {
  const timeline = [
    sec(0, 10, 10, 50, 0), sec(1, 10, 10, 50, 0),
    sec(2, 20, 20, 55, 0), sec(3, 20, 20, 55, 0),
    sec(4, 30, 30, 60, 0), sec(5, 30, 30, 60, 0),
  ];
  const rules = [{ metric: 'Error Rate', operator: '>', value: '5', unit: '%', severity: 'error' }];
  const { breakingPoint, steps } = analyzeStressRun(timeline, rules);
  assert.equal(breakingPoint, null);
  assert.equal(steps.length, 3);
});

test('buildDisplaySteps collapses a long run of clean steps into a single range row and keeps the breaking point as its own row', () => {
  const steps = [1, 2, 3, 4, 5, 6, 7].map(n => ({ threads: n * 10, error_rate: n === 6 ? 15 : 0, avg_response_time: 50, throughput: n * 5 }));
  const breakingPoint = { reason: 'rule', step: steps[5], metric: 'Error Rate', actual: 15, thresholdLabel: '> 5%' };
  const rows = buildDisplaySteps(steps, breakingPoint);

  // Expect: one range row for steps 1-5 (10-50 users), one single row for the breaking point
  // (step 6, 60 users), one range row for step 7 (70 users) — 3 rows total for 7 raw steps.
  assert.equal(rows.length, 3, `expected 3 display rows (range, breaking point, range), got ${rows.length}`);
  assert.equal(rows[0].type, 'range');
  assert.equal(rows[0].fromThreads, 10);
  assert.equal(rows[0].toThreads, 50);
  assert.equal(rows[1].type, 'single');
  assert.equal(rows[1].isBreakingPoint, true);
  assert.equal(rows[1].step.threads, 60);
  assert.equal(rows[2].type, 'single'); // a lone remaining step renders as its own single row, not a 1-item range
  assert.equal(rows[2].step.threads, 70);
});

test('buildDisplaySteps collapses EVERYTHING into one range row when there is no breaking point at all', () => {
  const steps = [1, 2, 3, 4, 5].map(n => ({ threads: n * 10, error_rate: 0, avg_response_time: 50, throughput: n * 5 }));
  const rows = buildDisplaySteps(steps, null);
  assert.equal(rows.length, 1, 'a clean run with no breaking point should collapse to a single summary row');
  assert.equal(rows[0].type, 'range');
  assert.equal(rows[0].fromThreads, 10);
  assert.equal(rows[0].toThreads, 50);
});

test('analyzeStressRun never flags the final ramp-down step as a plateau (throughput naturally drops as threads decrease)', () => {
  const timeline = [
    sec(0, 10, 10, 50, 0), sec(1, 10, 10, 50, 0),
    sec(2, 20, 20, 50, 0), sec(3, 20, 20, 50, 0),
    sec(4, 0, 1, 50, 0), sec(5, 0, 0, 50, 0), // ramp-down to 0 threads
  ];
  const { breakingPoint } = analyzeStressRun(timeline, []);
  assert.equal(breakingPoint, null, 'a ramp-down (decreasing threads) must never be mistaken for a saturation plateau');
});

test('a P95/P99-only rule is never evaluated per-step (no per-second raw sample data to compute a real percentile from)', () => {
  const timeline = [
    // Throughput scales healthily with threads (10->20 threads, 10->20 req/s) so the
    // plateau fallback stays quiet — isolating that the P95 rule itself is what's not applied.
    sec(0, 10, 10, 100, 0), sec(1, 10, 10, 100, 0),
    sec(2, 20, 20, 5000, 0), sec(3, 20, 20, 5000, 0), // huge avg_rt spike, but rule below is P95-based
  ];
  const rules = [{ metric: 'Latency P95', operator: '>', value: '2000', unit: 'ms', severity: 'error' }];
  const { breakingPoint } = analyzeStressRun(timeline, rules);
  assert.equal(breakingPoint, null, 'P95 rules are not (yet) evaluable per-step, so they must not produce a false breaking point');
});

// Regression for a real production report: a healthy run (0% errors, fast/consistent response
// times) got a false "BREAKING POINT" flagged mid-ramp, and the report showed a nonsensical
// "Steps 9-88: 50-7 users" block — the test's ramp-down (threads finishing one at a time at the
// end) got swept in as if it were more load levels, because groupStepsByThreads has no concept
// of the known schedule and just reacts to noisy observed thread-count changes second by
// second. groupStepsByKnownWindows uses the SAME formula the generators use to know exactly
// when each step's clean hold plateau is, sidestepping both problems.
function buildNoisyStaircaseTimeline({ vusers, duration, stepRamp }) {
  const STRESS_STEPS = 5;
  const stepBudget = duration / STRESS_STEPS;
  const timeline = [];
  let second = 0;
  let cumulative = 0;
  for (let i = 1; i <= STRESS_STEPS; i++) {
    const target = i === STRESS_STEPS ? vusers : Math.round(vusers * i / STRESS_STEPS);
    // Noisy ramp: threads climb one-by-one every second (not a clean jump), exactly the kind
    // of real-world data that makes exact-equality grouping split a single ramp into many
    // "steps."
    for (let t = cumulative + 1; t <= target; t++) {
      timeline.push(sec(second++, t, t * 0.8, 90 + (t % 3), 0)); // tiny natural jitter in avg_rt
    }
    // Clean hold at `target` for the rest of this step's budget, with small tps jitter.
    const holdSeconds = Math.round(i * stepBudget) - second;
    for (let h = 0; h < holdSeconds; h++) {
      const jitter = h % 4 === 0 ? -1 : 0; // occasional tiny dip, never more than ~10% swings
      timeline.push(sec(second++, target, target * 0.8 + jitter, 90 + (h % 3), 0));
    }
    cumulative = target;
  }
  // Ramp-down tail: threads finish one at a time after `duration`, count declining — must
  // never be treated as more step data.
  for (let t = vusers - 1; t >= 0; t--) {
    timeline.push(sec(second++, t, t * 0.8, 90, 0));
  }
  return timeline;
}

test('groupStepsByKnownWindows excludes the ramp-down tail entirely and labels steps by their known target, not a noisy observed range', () => {
  const vusers = 50, duration = 100;
  const timeline = buildNoisyStaircaseTimeline({ vusers, duration });
  const steps = groupStepsByKnownWindows(timeline, vusers, duration);
  assert.equal(steps.length, 5, 'expected exactly 5 known steps, no matter how noisy the raw per-second data is');
  assert.deepEqual(steps.map(s => s.threads), [10, 20, 30, 40, 50], 'each step must be labeled by its known target, not an observed min-max range');
  const maxSecondUsed = Math.max(...steps.flatMap(s => s.seconds.map(sec2 => sec2.second)));
  assert.ok(maxSecondUsed < duration, `no step may include any second at or after the configured duration (${duration}) — that's the ramp-down tail (got up to second ${maxSecondUsed})`);
});

test('regression: a healthy run (0% errors, stable response time) analyzed via known windows must report NO breaking point, even with noisy per-second sampling', () => {
  const vusers = 50, duration = 100;
  const timeline = buildNoisyStaircaseTimeline({ vusers, duration });
  const rules = [
    { metric: 'Error Rate', operator: '>', value: '5', unit: '%', severity: 'error' },
    { metric: 'Response Time', operator: '>', value: '2000', unit: 'ms', severity: 'error' },
  ];
  const { steps, breakingPoint } = analyzeStressRun(timeline, rules, { vusers, duration });
  assert.equal(steps.length, 5, 'expected exactly 5 clean steps from the known-window path');
  assert.equal(breakingPoint, null, 'a run with 0% errors, fast/stable response times, and throughput scaling with concurrency must never be flagged as having a breaking point, regardless of per-second sampling noise');
});

test('analyzeStressRun falls back to the noisy observed-grouping path when vusers/duration are not supplied (backward compatible)', () => {
  const timeline = [
    sec(0, 10, 10, 100, 0), sec(1, 10, 10, 100, 0),
    sec(2, 20, 20, 100, 0), sec(3, 20, 20, 100, 0),
  ];
  const { steps } = analyzeStressRun(timeline, []);
  assert.equal(steps.length, 2, 'with no vusers/duration hint, must fall back to grouping by observed thread-count plateaus');
});
