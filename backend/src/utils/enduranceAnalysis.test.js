const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeEnduranceRun, MIN_ENDURANCE_DURATION_S } = require('./enduranceAnalysis');

function buildTimeline(vusers, duration, { earlyRt = 100, lateRt = 100, earlyErr = 0, lateErr = 0 } = {}) {
  const timeline = [];
  const early20 = duration * 0.2;
  const late80 = duration * 0.8;
  for (let second = 0; second < duration; second++) {
    const rt = second < early20 ? earlyRt : second >= late80 ? lateRt : (earlyRt + lateRt) / 2;
    const errorRate = second < early20 ? earlyErr : second >= late80 ? lateErr : (earlyErr + lateErr) / 2;
    const tps = vusers;
    timeline.push({ second, threads: vusers, tps, avg_rt: rt, errors: Math.round(tps * errorRate / 100), error_rate: errorRate });
  }
  return timeline;
}

test('a run shorter than 1h40m is not applicable — treated as effectively a Load Test', () => {
  const result = analyzeEnduranceRun(buildTimeline(50, 3600), [], { vusers: 50, duration: 3600 }); // 1 hour
  assert.equal(result.applicable, false);
  assert.equal(result.overall.level, 'unknown');
  assert.match(result.overall.message, /Load Test/);
});

test('a run at exactly the 1h40m minimum IS applicable', () => {
  const duration = MIN_ENDURANCE_DURATION_S;
  const result = analyzeEnduranceRun(buildTimeline(50, duration), [], { vusers: 50, duration });
  assert.equal(result.applicable, true);
});

test('stable performance across a long run gets a "good" verdict', () => {
  const duration = 6000; // 100 min
  const timeline = buildTimeline(50, duration, { earlyRt: 100, lateRt: 105 }); // trivial noise only
  const result = analyzeEnduranceRun(timeline, [], { vusers: 50, duration });
  assert.equal(result.applicable, true);
  assert.equal(result.overall.level, 'good');
  assert.equal(result.drift.level, 'ok');
});

test('response time doubling over the run (leak-shaped) gets a "critical" verdict naming the drift', () => {
  const duration = 6000;
  const timeline = buildTimeline(50, duration, { earlyRt: 100, lateRt: 250 }); // 150% growth
  const result = analyzeEnduranceRun(timeline, [], { vusers: 50, duration });
  assert.equal(result.drift.level, 'error');
  assert.equal(result.overall.level, 'critical');
  assert.match(result.overall.message, /response time grew/);
});

test('moderate response time growth (not yet severe) gets a "warning", not "critical" or "good"', () => {
  const duration = 6000;
  const timeline = buildTimeline(50, duration, { earlyRt: 100, lateRt: 170 }); // 70% growth: > warning ratio, < critical ratio
  const result = analyzeEnduranceRun(timeline, [], { vusers: 50, duration });
  assert.equal(result.drift.level, 'warning');
  assert.equal(result.overall.level, 'warning');
});

test('error rate creeping up over the run is caught even when response time stays flat', () => {
  const duration = 6000;
  const timeline = buildTimeline(50, duration, { earlyErr: 0, lateErr: 12 }); // +12 points, above critical margin
  const result = analyzeEnduranceRun(timeline, [], { vusers: 50, duration });
  assert.equal(result.drift.level, 'error');
  assert.equal(result.overall.level, 'critical');
  assert.match(result.overall.message, /error rate rose/);
});

test('explicit project rules are used over the built-in fallback for the late window', () => {
  const duration = 6000;
  const timeline = buildTimeline(50, duration, { earlyErr: 0, lateErr: 3 }); // would pass the lenient 5% fallback
  const rules = [{ metric: 'Error Rate', operator: '>', value: '2', unit: '%', severity: 'error' }];
  const result = analyzeEnduranceRun(timeline, rules, { vusers: 50, duration });
  assert.equal(result.usedFallbackRules, false);
  assert.equal(result.lateVerdict.level, 'error');
});

test('returns "unknown" instead of crashing when vusers/duration are not supplied', () => {
  const result = analyzeEnduranceRun([{ second: 0, threads: 10, tps: 10, avg_rt: 100, errors: 0, error_rate: 0 }], []);
  assert.equal(result.applicable, false);
  assert.equal(result.overall.level, 'unknown');
});
