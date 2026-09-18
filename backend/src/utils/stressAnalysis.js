'use strict';

// Groups a stress run's timeline into "steps" — contiguous windows where the active
// thread/VU count holds roughly steady — and evaluates each step against the project's own
// rules to find a breaking point, falling back to a throughput-plateau check when no rule
// applies. Works purely from OBSERVED timeline data (second/tps/avg_rt/threads/errors/
// error_rate — identical field shape produced by both parseJtl.js and parseK6.js), so it
// doesn't need to know the generator's intended step count/targets and works for any
// staircase shape, not just the 5-step one buildK6Template/buildJmxTemplate currently build.

const METRIC_MAP = {
  'error rate':             'error_rate',
  'response time':          'avg_response_time',
  'avg response time':      'avg_response_time',
  'average response time':  'avg_response_time',
  'throughput':             'throughput',
  'tps':                    'throughput',
  // P90/P95/P99 aren't computable per-step from the current per-second timeline (only an
  // average response time is retained per second, not the raw sample set a real percentile
  // needs) — a rule using one of these metrics is simply not evaluated per-step here; it
  // still applies normally to the whole-run aggregate via ruleEvaluator.js as before.
};

function metricKey(metric) {
  return METRIC_MAP[(metric || '').toLowerCase().trim()] || null;
}

function compare(actual, op, threshold, thresholdMin, thresholdMax) {
  switch (op) {
    case '>':       return actual >  threshold;
    case '>=':      return actual >= threshold;
    case '<':       return actual <  threshold;
    case '<=':      return actual <= threshold;
    case '==':
    case '=':       return actual === threshold;
    case 'between': return actual >= thresholdMin && actual <= thresholdMax;
    default:        return false;
  }
}

// A ramp second (where `threads` is still climbing toward the next plateau) simply starts a
// new step the moment `threads` changes at all — since ramps in the generated staircase are
// short relative to holds, this blends only a few ramp-seconds into the following step's
// average rather than needing precise ramp-vs-hold detection, an acceptable approximation for
// a "which concurrency level" signal.
//
// FALLBACK ONLY — see groupStepsByKnownWindows below for the primary path. Real per-second
// data is never perfectly flat even mid-plateau (JMeter/k6 sampling jitter), so grouping by
// exact thread-count equality is noisy: a genuine 5-step staircase can read back as 80+ tiny
// "steps," including the ramp-DOWN tail (threads finishing one at a time at test end, which
// this function has no concept of and happily groups as if it were more load levels). Used
// only when the caller can't supply the run's actual vusers/duration.
function groupStepsByThreads(timeline) {
  const steps = [];
  let current = null;
  for (const t of (timeline || [])) {
    const threads = t.threads || 0;
    if (!current || current.threads !== threads) {
      current = { threads, seconds: [] };
      steps.push(current);
    }
    current.seconds.push(t);
  }
  return steps.filter(s => s.seconds.length > 0);
}

// PRIMARY path: derive the 5 step windows directly from the SAME formula the script
// generators use (buildUltimateThreadGroupXml / buildK6Template's STEP_S/STEP_RAMP/STEP_HOLD)
// instead of reverse-engineering plateaus from noisy observed thread counts. Since we
// generated the exact schedule, we already know precisely when each step's ramp ends and its
// hold begins — using that directly eliminates both problems groupStepsByThreads has: sampling
// noise mis-splitting a real plateau into many micro-steps (which can spuriously trip the
// throughput-plateau fallback on pure measurement jitter), and the ramp-down tail being
// swept in as if it were more load levels (it falls entirely outside every step's window,
// since the last window ends at `duration`).
function groupStepsByKnownWindows(timeline, vusers, duration) {
  const STRESS_STEPS = 5;
  const stepBudget = duration / STRESS_STEPS;
  const stepRamp = Math.max(5, Math.round(stepBudget * 0.2));

  const steps = [];
  for (let i = 1; i <= STRESS_STEPS; i++) {
    const targetUsers = i === STRESS_STEPS ? vusers : Math.round(vusers * i / STRESS_STEPS);
    // holdStart: just after this step's own ramp finishes. holdEnd: right before the next
    // step's ramp begins (== this step's share of the total budget). Everything in between is
    // this step's clean, ramp-free hold plateau at `targetUsers`.
    const holdStart = Math.round((i - 1) * stepBudget) + stepRamp;
    const holdEnd = Math.round(i * stepBudget);
    const seconds = (timeline || []).filter(t => t.second >= holdStart && t.second < holdEnd);
    if (seconds.length > 0) steps.push({ threads: targetUsers, seconds });
  }
  return steps;
}

function summarizeStep(step) {
  const secs = step.seconds;
  const totalReqs = secs.reduce((a, s) => a + (s.tps || 0), 0);
  const totalErrors = secs.reduce((a, s) => a + (s.errors || 0), 0);
  const avgRt = secs.reduce((a, s) => a + (s.avg_rt || 0), 0) / secs.length;
  const avgTps = totalReqs / secs.length;
  return {
    threads: step.threads,
    duration_s: secs.length,
    total_requests: totalReqs,
    avg_response_time: parseFloat(avgRt.toFixed(1)),
    error_rate: totalReqs > 0 ? parseFloat(((totalErrors / totalReqs) * 100).toFixed(2)) : 0,
    throughput: parseFloat(avgTps.toFixed(2)),
  };
}

/**
 * @param {Array} timeline - parsed run timeline (per-second threads/tps/avg_rt/errors/error_rate)
 * @param {Array} rules - project's rules (same row shape ruleEvaluator.js reads from the `rules` table)
 * @param {{ vusers?: number, duration?: number }} runParams - the ACTUAL VUsers/Duration this
 *   run executed with (the trigger-time values, not necessarily the suite's saved defaults —
 *   overriding at trigger time is a supported, common case). When both are present and valid,
 *   steps are derived from the known 5-step schedule (groupStepsByKnownWindows) instead of
 *   reverse-engineered from noisy observed thread counts — see that function's comment for why
 *   this matters. Falls back to the noisy observed-data path when they're unavailable, so this
 *   remains backward compatible with callers that can't supply them.
 * @returns {{ steps: Array, breakingPoint: object|null }}
 *   steps          - one summarized entry per step, in chronological order
 *   breakingPoint  - null if the run never showed a problem, otherwise:
 *     { reason: 'rule',    step, metric, actual, thresholdLabel }             — a configured
 *       error-severity rule failed when judged on that step's own data alone
 *     { reason: 'plateau', step, previousThroughput, growthPct }              — throughput
 *       didn't meaningfully increase (or fell) despite concurrency increasing, and no
 *       applicable rule caught it first
 */
function analyzeStressRun(timeline, rules, runParams = {}) {
  const { vusers, duration } = runParams;
  const rawSteps = (vusers > 0 && duration > 0)
    ? groupStepsByKnownWindows(timeline, vusers, duration)
    : groupStepsByThreads(timeline);
  const steps = rawSteps.map(summarizeStep);
  const applicableRules = (rules || []).filter(r => metricKey(r.metric));

  let breakingPoint = null;

  // Primary: first step where an error-severity rule would fail on its OWN data — not the
  // whole-run aggregate ruleEvaluator.js checks elsewhere.
  outer:
  for (const step of steps) {
    for (const rule of applicableRules) {
      if (rule.severity !== 'error') continue;
      const key = metricKey(rule.metric);
      const actual = step[key];
      const threshold = parseFloat(rule.value);
      const thresholdMin = parseFloat(rule.value_min);
      const thresholdMax = parseFloat(rule.value_max);
      if (rule.operator === 'between' ? (isNaN(thresholdMin) || isNaN(thresholdMax)) : isNaN(threshold)) continue;
      if (compare(actual, rule.operator, threshold, thresholdMin, thresholdMax)) {
        breakingPoint = {
          reason: 'rule',
          step,
          metric: rule.metric,
          actual,
          thresholdLabel: rule.operator === 'between'
            ? `between ${rule.value_min}-${rule.value_max}${rule.unit}`
            : `${rule.operator} ${rule.value}${rule.unit}`,
        };
        break outer;
      }
    }
  }

  // Fallback: throughput plateau/collapse between consecutive steps — only checked when no
  // rule-based breaking point was found, since a real rule breach is always the more specific,
  // user-meaningful signal. Only compares steps where concurrency genuinely increased (a
  // ramp-down step naturally has lower throughput and must never be flagged as a "plateau").
  if (!breakingPoint) {
    for (let i = 1; i < steps.length; i++) {
      const prev = steps[i - 1];
      const cur = steps[i];
      if (cur.threads <= prev.threads) continue;
      const growth = prev.throughput > 0 ? (cur.throughput - prev.throughput) / prev.throughput : 1;
      if (growth < 0.1) {
        breakingPoint = {
          reason: 'plateau',
          step: cur,
          previousThroughput: prev.throughput,
          growthPct: parseFloat((growth * 100).toFixed(1)),
        };
        break;
      }
    }
  }

  return { steps, breakingPoint };
}

// Collapses `steps` into a compact list of DISPLAY rows for a report — every step doesn't need
// its own row: what matters is "this whole stretch was fine" and "here's exactly where it
// stopped being fine." Consecutive steps that are all NOT the breaking point collapse into one
// summarized range row ("Steps 1-5, 10-50 users: OK, max error rate 0.1%"); the breaking-point
// step (if any) always gets its own individual, highlighted row. This is what keeps the report
// a fixed, small size regardless of how many steps a run actually has (a 500-user stress test
// still only ever has STRESS_STEPS discrete levels today, but this also protects against any
// future generator producing many more, or noisy real-world data slipping past the
// MIN_PLATEAU_SECONDS merge above).
function buildDisplaySteps(steps, breakingPoint) {
  const rows = [];
  let i = 0;
  while (i < steps.length) {
    if (breakingPoint && steps[i] === breakingPoint.step) {
      rows.push({ type: 'single', isBreakingPoint: true, step: steps[i], stepIndex: i });
      i++;
      continue;
    }
    let j = i;
    while (j < steps.length && !(breakingPoint && steps[j] === breakingPoint.step)) j++;
    const range = steps.slice(i, j);
    if (range.length === 1) {
      rows.push({ type: 'single', isBreakingPoint: false, step: range[0], stepIndex: i });
    } else {
      rows.push({
        type: 'range',
        stepIndexFrom: i,
        stepIndexTo: j - 1,
        fromThreads: range[0].threads,
        toThreads: range[range.length - 1].threads,
        maxErrorRate: parseFloat(Math.max(...range.map(s => s.error_rate)).toFixed(2)),
        avgResponseTime: parseFloat((range.reduce((a, s) => a + s.avg_response_time, 0) / range.length).toFixed(1)),
        maxThroughput: parseFloat(Math.max(...range.map(s => s.throughput)).toFixed(2)),
      });
    }
    i = j;
  }
  return rows;
}

module.exports = {
  analyzeStressRun, groupStepsByThreads, groupStepsByKnownWindows, summarizeStep, buildDisplaySteps,
  // Exported for reuse by spikeAnalysis.js — same METRIC_MAP/comparison/aggregation logic,
  // no reason to duplicate it for a different test-type shape.
  metricKey, compare,
};
