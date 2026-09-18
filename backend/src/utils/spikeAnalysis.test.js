const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeSpikeRun, computeSpikeWindows, computeSpikeCount } = require('./spikeAnalysis');

// Builds a synthetic timeline matching buildSpikeThreadGroupXml/buildK6Template's exact
// baseline -> (ramp -> peak -> ramp -> gap) x N shape, so tests exercise the real window math.
// `perCycle` lets a test override error rate / response time for specific spike indices
// (1-based) to simulate a problem on only one cycle.
function buildSpikeTimeline({ vusers, duration, perCycle = {} }) {
  const { baselineUsers, cycles } = computeSpikeWindows(vusers, duration);
  const baselineRt = 100;
  const timeline = [];
  for (let second = 0; second < duration; second++) {
    const cycleIdx = cycles.findIndex(c => second >= c.peak.start && second < c.recovery.end);
    let threads = baselineUsers, rt = baselineRt, errorRate = 0;
    if (cycleIdx >= 0) {
      const c = cycles[cycleIdx];
      const override = perCycle[cycleIdx + 1] || {};
      if (second >= c.peak.start && second < c.peak.end) {
        threads = vusers; rt = baselineRt * (override.peakRtMultiplier ?? 1); errorRate = override.peakErrorRate ?? 0;
      } else {
        threads = baselineUsers; rt = baselineRt * (override.recoveryRtMultiplier ?? 1); errorRate = override.recoveryErrorRate ?? 0;
      }
    }
    const tps = threads;
    const errors = Math.round(tps * (errorRate / 100));
    timeline.push({ second, threads, tps, avg_rt: rt, errors, error_rate: errorRate });
  }
  return timeline;
}

test('computeSpikeCount: duration tiers match the agreed thresholds', () => {
  assert.equal(computeSpikeCount(400), 3);
  assert.equal(computeSpikeCount(300), 3);
  assert.equal(computeSpikeCount(299), 2);
  assert.equal(computeSpikeCount(120), 2);
  assert.equal(computeSpikeCount(119), 1);
  assert.equal(computeSpikeCount(60), 1);
});

// Past the initial 300s->3 tier, the suggestion keeps growing (+1 spike per additional 10
// minutes) so a long soak-length spike test isn't stuck suggesting only 3 — capped at 10
// (the input's max) so individual recovery windows never get squeezed to meaninglessness.
test('computeSpikeCount: keeps scaling with duration past 300s instead of capping at 3', () => {
  assert.equal(computeSpikeCount(600), 3, '5 more minutes (still under one full 10-min step) stays at 3');
  assert.equal(computeSpikeCount(900), 4, '10 minutes past the 300s mark adds one spike');
  assert.equal(computeSpikeCount(1800), 5);
  assert.equal(computeSpikeCount(3600), 8, '1 hour suggests 8, not the old flat 3');
  assert.equal(computeSpikeCount(4500), 10, 'reaches the cap of 10 at 4500s');
  assert.equal(computeSpikeCount(7200), 10, 'never exceeds the cap of 10, even for very long durations');
});

test('a healthy multi-spike run (3 clean cycles, full recovery every time) gets a "good" verdict mentioning all spikes', () => {
  const vusers = 200, duration = 400; // 3 spikes
  const timeline = buildSpikeTimeline({ vusers, duration });
  const result = analyzeSpikeRun(timeline, [], { vusers, duration });
  assert.equal(result.spikeCount, 3);
  assert.equal(result.cycles.length, 3);
  assert.ok(result.cycles.every(c => c.peakVerdict.level === 'ok'));
  assert.ok(result.cycles.every(c => c.recoveryCheck.recovered));
  assert.equal(result.overall.level, 'good');
  assert.match(result.overall.message, /all 3 spikes/i);
});

test('validation checks EVERY peak and EVERY recovery — a problem only on spike #2 must still be caught, not averaged away', () => {
  const vusers = 200, duration = 400; // 3 spikes
  const timeline = buildSpikeTimeline({ vusers, duration, perCycle: { 2: { peakErrorRate: 40 } } });
  const result = analyzeSpikeRun(timeline, [], { vusers, duration });
  assert.equal(result.cycles[0].peakVerdict.level, 'ok', 'spike #1 was clean and must not be flagged');
  assert.equal(result.cycles[1].peakVerdict.level, 'error', 'spike #2\'s own breach must be caught');
  assert.equal(result.cycles[2].peakVerdict.level, 'ok', 'spike #3 was clean and must not be flagged');
  assert.equal(result.overall.level, 'critical');
  assert.match(result.overall.message, /#2/, 'the message must identify WHICH spike had the problem');
});

test('cumulative degradation: recovery holds after spike #1 but fails after spike #3 — the exact scenario multi-spike testing exists to catch', () => {
  const vusers = 200, duration = 400; // 3 spikes
  const timeline = buildSpikeTimeline({ vusers, duration, perCycle: { 3: { recoveryRtMultiplier: 4 } } });
  const result = analyzeSpikeRun(timeline, [], { vusers, duration });
  assert.equal(result.cycles[0].recoveryCheck.recovered, true);
  assert.equal(result.cycles[1].recoveryCheck.recovered, true);
  assert.equal(result.cycles[2].recoveryCheck.recovered, false, 'a single-spike test would never have observed this — recovery only degraded on the 3rd cycle');
  assert.equal(result.overall.level, 'warning');
  assert.match(result.overall.message, /#3/);
});

test('a single-spike run (short duration) still works exactly as before — backward compatible shape', () => {
  const vusers = 100, duration = 100; // 1 spike
  const timeline = buildSpikeTimeline({ vusers, duration });
  const result = analyzeSpikeRun(timeline, [], { vusers, duration });
  assert.equal(result.spikeCount, 1);
  assert.equal(result.cycles.length, 1);
  assert.equal(result.overall.level, 'good');
  assert.doesNotMatch(result.overall.message, /#1/, 'a single-cycle run should read naturally, without an unnecessary "#1" label');
});

test('an explicit spikeCount override wins over the duration-implied tier — user-chosen spike count, not auto-calculated', () => {
  const vusers = 200, duration = 400; // duration tier alone implies 3
  const windows = computeSpikeWindows(vusers, duration, 1);
  assert.equal(windows.cycles.length, 1, 'explicit override of 1 must be honored even though duration=400 implies 3');

  const timeline = buildSpikeTimeline({ vusers, duration: 100 }); // built assuming 1 spike (short duration)
  // Reuse the short-duration timeline but tell analyzeSpikeRun the real duration was 400 with
  // an explicit override of 1 — this proves the override, not the duration, drives cycle count.
  const result = analyzeSpikeRun(timeline, [], { vusers, duration: 100, spikeCount: 1 });
  assert.equal(result.spikeCount, 1);
  assert.equal(result.cycles.length, 1);

  const result3 = analyzeSpikeRun(buildSpikeTimeline({ vusers, duration: 400 }), [], { vusers, duration: 400, spikeCount: 3 });
  assert.equal(result3.spikeCount, 3, 'an explicit override of 3 must be honored');
});

test('an out-of-range spikeCount override falls back to the duration-based suggestion', () => {
  const windows = computeSpikeWindows(200, 400, 0); // 0 is invalid — not >= 1
  assert.equal(windows.cycles.length, 3, 'invalid override must fall back to the duration-implied 3 for duration=400');
});

test('explicit project rules are used over the built-in fallback for every cycle', () => {
  const vusers = 200, duration = 400;
  const timeline = buildSpikeTimeline({ vusers, duration, perCycle: { 1: { peakErrorRate: 6 } } });
  const rules = [{ metric: 'Error Rate', operator: '>', value: '5', unit: '%', severity: 'error' }];
  const result = analyzeSpikeRun(timeline, rules, { vusers, duration });
  assert.equal(result.usedFallbackRules, false);
  assert.equal(result.cycles[0].peakVerdict.level, 'error', '6% must fail a strict 5% project rule even though it would pass the lenient 10% fallback');
});

test('returns an "unknown" verdict instead of crashing when vusers/duration are not supplied', () => {
  const result = analyzeSpikeRun([{ second: 0, threads: 10, tps: 10, avg_rt: 100, errors: 0, error_rate: 0 }], []);
  assert.equal(result.overall.level, 'unknown');
  assert.equal(result.cycles, null);
});
