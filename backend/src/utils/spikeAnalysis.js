'use strict';

// Spike test analysis: baseline -> peak -> recovery, repeated computeSpikeCount(duration)
// times, NOT a staircase (see stressAnalysis.js for that). A spike test's real question isn't
// "where's the breaking point" — it's "did the system survive EVERY burst, and did it come
// back to normal EVERY time" — a single cycle only proves it survives once; repeating it
// catches cumulative degradation (a leak that only shows up after the 2nd/3rd burst) a single
// cycle never could. Phase windows are derived from the SAME formula the generators use
// (buildSpikeThreadGroupXml / buildK6Template's spike executor / the CI patcher's
// patch_spike_thread_group) so this always matches the schedule that actually ran.

const { metricKey, compare, summarizeStep } = require('./stressAnalysis');

// Mirrors computeSpikeCount() in testSuites.js EXACTLY — duplicated rather than imported
// since that lives in a route file (bad direction to import utils from). Both must stay in
// lockstep: a change to one without the other would silently misalign the analysis windows
// from the schedule that actually ran.
function computeSpikeCount(duration) {
  if (duration >= 300) return Math.min(10, 3 + Math.floor((duration - 300) / 600));
  if (duration >= 120) return 2;
  return 1;
}

// Same phase-split formula as buildSpikeThreadGroupXml (JMeter) and buildK6Template's spike
// executor — all must stay in lockstep. Returns one window per cycle plus the initial
// baseline-before window.
function computeSpikeWindows(vusers, duration, spikeCountOverride) {
  const baselineUsers = Math.max(1, Math.round(vusers * 0.10));
  // The user can explicitly choose the spike count at generation time (testSuites.js's
  // resolveSpikeCount, stored in the suite's config_json) — the analysis MUST use whatever
  // count actually ran, not re-derive its own guess from duration, or the windows would no
  // longer line up with the real schedule.
  const spikeCount = (Number.isInteger(spikeCountOverride) && spikeCountOverride >= 1)
    ? spikeCountOverride
    : computeSpikeCount(duration);

  if (spikeCount === 1) {
    const beforeS = Math.round(duration * 0.20);
    const rampS = Math.max(5, Math.round(duration * 0.03));
    const peakS = Math.round(duration * 0.15);
    const peakStart = beforeS + rampS;
    const peakEnd = peakStart + peakS;
    const recoveryStart = peakEnd + rampS;
    return {
      baselineUsers, spikeCount,
      baselineBefore: { start: 0, end: beforeS },
      cycles: [{ peak: { start: peakStart, end: peakEnd }, recovery: { start: recoveryStart, end: duration } }],
    };
  }

  const rampS = Math.max(5, Math.round(duration * 0.03));
  const peakS = Math.max(5, Math.round(duration * 0.08));
  const nonBaselinePerCycle = 2 * rampS + peakS;
  const totalBaseline = Math.max(0, duration - spikeCount * nonBaselinePerCycle);
  const gapS = Math.round(totalBaseline / (spikeCount + 1));

  const cycles = [];
  let t = 0;
  for (let i = 0; i < spikeCount; i++) {
    t += gapS;
    const peakStart = t + rampS;
    const peakEnd = peakStart + peakS;
    const recoveryStart = peakEnd + rampS;
    const recoveryEnd = Math.min(duration, recoveryStart + gapS);
    cycles.push({ peak: { start: peakStart, end: peakEnd }, recovery: { start: recoveryStart, end: recoveryEnd } });
    t = peakEnd + rampS;
  }
  return { baselineUsers, spikeCount, baselineBefore: { start: 0, end: gapS }, cycles };
}

// Built-in fallback thresholds for a PEAK phase, used only when the project has no
// applicable Error Rate/Response Time rule configured — a spike test should never require
// manual rule setup to produce a meaningful verdict. More lenient than Stress Test's defaults
// (5%/2000ms): a brief burst causing some transient degradation is normal and often by
// design — the real pass/fail signal here is recovery, not whether every peak looked clean.
const FALLBACK_PEAK_RULES = [
  { metric: 'Error Rate', operator: '>', value: '10', unit: '%', severity: 'warning' },
  { metric: 'Error Rate', operator: '>', value: '25', unit: '%', severity: 'error' },
  { metric: 'Response Time', operator: '>', value: '3000', unit: 'ms', severity: 'warning' },
];

// How far a recovery window's metrics may drift from baseline-before and still count as
// "recovered." Response time checked proportionally (absolute ms doesn't generalize across
// endpoints); error rate checked as a small absolute margin.
const RECOVERY_RESPONSE_TIME_TOLERANCE = 1.3; // recovery avg_response_time <= 130% of baseline
const RECOVERY_ERROR_RATE_MARGIN = 2; // percentage points

function filterWindow(timeline, start, end) {
  return (timeline || []).filter(t => t.second >= start && t.second < end);
}

function evaluatePeak(peakSummary, rules) {
  const applicableRules = (rules || []).filter(r => metricKey(r.metric));
  const usedFallbackRules = applicableRules.length === 0;
  const rulesToUse = usedFallbackRules ? FALLBACK_PEAK_RULES : applicableRules;

  let verdict = { level: 'ok' };
  outer:
  for (const severity of ['error', 'warning']) {
    for (const rule of rulesToUse) {
      if (rule.severity !== severity) continue;
      const key = metricKey(rule.metric);
      const actual = peakSummary[key];
      const threshold = parseFloat(rule.value);
      const thresholdMin = parseFloat(rule.value_min);
      const thresholdMax = parseFloat(rule.value_max);
      if (rule.operator === 'between' ? (isNaN(thresholdMin) || isNaN(thresholdMax)) : isNaN(threshold)) continue;
      if (compare(actual, rule.operator, threshold, thresholdMin, thresholdMax)) {
        verdict = {
          level: severity, metric: rule.metric, actual,
          thresholdLabel: rule.operator === 'between'
            ? `between ${rule.value_min}-${rule.value_max}${rule.unit}`
            : `${rule.operator} ${rule.value}${rule.unit}`,
        };
        break outer;
      }
    }
  }
  return { verdict, usedFallbackRules };
}

function evaluateRecovery(recoverySummary, baselineBefore) {
  const responseTimeOk = baselineBefore.avg_response_time <= 0
    ? recoverySummary.avg_response_time <= 50 // baseline itself was ~instant; small absolute floor
    : recoverySummary.avg_response_time <= baselineBefore.avg_response_time * RECOVERY_RESPONSE_TIME_TOLERANCE;
  const errorRateOk = recoverySummary.error_rate <= baselineBefore.error_rate + RECOVERY_ERROR_RATE_MARGIN;
  return { recovered: responseTimeOk && errorRateOk, responseTimeOk, errorRateOk };
}

const LEVEL_RANK = { ok: 0, warning: 1, error: 2 };

/**
 * @param {Array} timeline - parsed run timeline (per-second threads/tps/avg_rt/errors/error_rate)
 * @param {Array} rules - project's rules (same row shape ruleEvaluator.js reads from the `rules` table)
 * @param {{ vusers: number, duration: number }} runParams - the ACTUAL VUsers/Duration this
 *   run executed with (trigger-time values, not necessarily the suite's saved defaults).
 * @returns {{
 *   spikeCount: number,
 *   baseline_before: object,
 *   cycles: Array<{ index, peak, recovery, peakVerdict, recoveryCheck }>,
 *   usedFallbackRules: boolean,
 *   overall: { level: 'good'|'warning'|'critical'|'unknown', message: string }
 * }}
 */
function analyzeSpikeRun(timeline, rules, runParams = {}) {
  const { vusers, duration, spikeCount } = runParams;
  if (!(vusers > 0) || !(duration > 0)) {
    return { cycles: null, overall: { level: 'unknown', message: 'Not enough data to analyze the baseline/peak/recovery phases for this run.' } };
  }

  const windows = computeSpikeWindows(vusers, duration, spikeCount);
  const settle = (start, end) => {
    const span = end - start;
    const s = Math.min(3, Math.max(1, Math.floor(span / 4)));
    return { start: start + s, end };
  };

  const bb = settle(windows.baselineBefore.start, windows.baselineBefore.end);
  const baselineBeforeSecs = filterWindow(timeline, bb.start, bb.end);
  if (!baselineBeforeSecs.length) {
    return { cycles: null, overall: { level: 'unknown', message: 'Duration too short to isolate distinct baseline, peak, and recovery windows for this run.' } };
  }
  const baselineBefore = summarizeStep({ threads: windows.baselineUsers, seconds: baselineBeforeSecs });

  const cycles = [];
  let usedFallbackRules = false;
  for (let i = 0; i < windows.cycles.length; i++) {
    const cycle = windows.cycles[i];
    const peakWindow = settle(cycle.peak.start, cycle.peak.end);
    const recoveryWindow = settle(cycle.recovery.start, cycle.recovery.end);
    const peakSecs = filterWindow(timeline, peakWindow.start, peakWindow.end);
    const recoverySecs = filterWindow(timeline, recoveryWindow.start, recoveryWindow.end);
    if (!peakSecs.length || !recoverySecs.length) {
      return { cycles: null, overall: { level: 'unknown', message: 'Duration too short to isolate distinct baseline, peak, and recovery windows for this run.' } };
    }
    const peak = summarizeStep({ threads: vusers, seconds: peakSecs });
    const recovery = summarizeStep({ threads: windows.baselineUsers, seconds: recoverySecs });
    const { verdict: peakVerdict, usedFallbackRules: usedFallback } = evaluatePeak(peak, rules);
    usedFallbackRules = usedFallbackRules || usedFallback;
    // Always compared against the ORIGINAL baseline-before, not the previous cycle — that's
    // what actually answers "did it come all the way back," and is what surfaces cumulative
    // drift across repeated cycles (cycle 1 recovers fine, cycle 3 doesn't).
    const recoveryCheck = evaluateRecovery(recovery, baselineBefore);
    cycles.push({ index: i + 1, peak, recovery, peakVerdict, recoveryCheck });
  }

  const worstPeakLevel = cycles.reduce((worst, c) => LEVEL_RANK[c.peakVerdict.level] > LEVEL_RANK[worst] ? c.peakVerdict.level : worst, 'ok');
  const worstPeakCycle = cycles.find(c => c.peakVerdict.level === worstPeakLevel && worstPeakLevel !== 'ok');
  const allRecovered = cycles.every(c => c.recoveryCheck.recovered);
  const firstUnrecovered = cycles.find(c => !c.recoveryCheck.recovered);
  const multi = cycles.length > 1;

  let overall;
  if (worstPeakLevel === 'ok' && allRecovered) {
    overall = {
      level: 'good',
      message: multi
        ? `System handled all ${cycles.length} spikes well — performance stayed consistent across the baseline, every peak, and every recovery window.`
        : 'System handled the spike well — performance stayed consistent across the baseline, peak, and recovery phases.',
    };
  } else if (worstPeakLevel !== 'error' && allRecovered) {
    overall = {
      level: 'warning',
      message: `Spike${multi ? ` #${worstPeakCycle.index}` : ''} caused some temporary degradation (${worstPeakCycle.peakVerdict.metric} ${worstPeakCycle.peakVerdict.thresholdLabel}, actual ${worstPeakCycle.peakVerdict.actual}), but the system recovered fully every time.`,
    };
  } else if (worstPeakLevel === 'ok' && !allRecovered) {
    overall = {
      level: 'warning',
      message: multi
        ? `Every peak was handled fine, but the system did not return to baseline after spike #${firstUnrecovered.index} — worth checking for a resource leak or lingering connection/thread buildup that builds up across repeated bursts.`
        : 'Peak load was handled fine, but performance did not return to baseline afterward — worth checking for a resource leak or lingering connection/thread buildup.',
    };
  } else {
    const parts = [];
    if (worstPeakLevel === 'error') parts.push(`spike${multi ? ` #${worstPeakCycle.index}` : ''} breached ${worstPeakCycle.peakVerdict.metric} ${worstPeakCycle.peakVerdict.thresholdLabel} (actual ${worstPeakCycle.peakVerdict.actual})`);
    if (!allRecovered) parts.push(`did not recover after spike${multi ? ` #${firstUnrecovered.index}` : ''}`);
    overall = {
      level: 'critical',
      message: `System struggled under the spike test — ${parts.join(', and ')}.`,
    };
  }

  return {
    spikeCount: windows.spikeCount,
    baseline_before: baselineBefore,
    cycles,
    usedFallbackRules,
    overall,
  };
}

module.exports = { analyzeSpikeRun, computeSpikeWindows, computeSpikeCount, FALLBACK_PEAK_RULES };
