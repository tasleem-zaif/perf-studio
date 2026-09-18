'use strict';

// Endurance (soak) test analysis: constant load held for a LONG time, checking whether
// performance stays flat or quietly degrades (memory leak, connection-pool exhaustion, disk
// filling from logs, etc.). Unlike Stress (find the breaking point) or Spike (survive +
// recover from a burst), the load SHAPE here is deliberately simple and identical to Load
// Test — the only thing that makes a run an endurance test is running it long enough to
// observe a trend, which is what this module actually checks for.

const { metricKey, compare, summarizeStep } = require('./stressAnalysis');

// Below this, there isn't enough sustained runtime to observe a meaningful degradation
// trend — the run is, for analysis purposes, indistinguishable from a Load Test. Not
// enforced at generation time (the script itself doesn't change), only at analysis time: a
// short "endurance" run still executes fine, it just doesn't get an endurance verdict.
const MIN_ENDURANCE_DURATION_S = 100 * 60; // 1h40m

// Built-in fallback thresholds for the LATE window, used only when the project has no
// applicable Error Rate/Response Time rule configured. Stricter than Spike's peak fallback —
// this is steady-state constant load, not a burst, so elevated errors/latency here are a
// real regression, not expected transient behavior.
const FALLBACK_LATE_RULES = [
  { metric: 'Error Rate', operator: '>', value: '5', unit: '%', severity: 'warning' },
  { metric: 'Error Rate', operator: '>', value: '15', unit: '%', severity: 'error' },
  { metric: 'Response Time', operator: '>', value: '2000', unit: 'ms', severity: 'warning' },
];

// Drift tolerances — comparative, never a fixed-threshold Rule Engine concept, same
// reasoning as Spike's recovery check.
const RESPONSE_TIME_WARNING_RATIO = 1.5;  // late avg_response_time > 150% of early -> warning
const RESPONSE_TIME_CRITICAL_RATIO = 2.0; // > 200% of early -> critical (leak-shaped)
const ERROR_RATE_WARNING_MARGIN = 3;      // percentage points
const ERROR_RATE_CRITICAL_MARGIN = 10;    // percentage points
const THROUGHPUT_WARNING_RATIO = 0.7;     // late throughput < 70% of early despite constant concurrency

function filterWindow(timeline, start, end) {
  return (timeline || []).filter(t => t.second >= start && t.second < end);
}

function evaluateLateWindow(lateSummary, rules) {
  const applicableRules = (rules || []).filter(r => metricKey(r.metric));
  const usedFallbackRules = applicableRules.length === 0;
  const rulesToUse = usedFallbackRules ? FALLBACK_LATE_RULES : applicableRules;

  let verdict = { level: 'ok' };
  outer:
  for (const severity of ['error', 'warning']) {
    for (const rule of rulesToUse) {
      if (rule.severity !== severity) continue;
      const key = metricKey(rule.metric);
      const actual = lateSummary[key];
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

function evaluateDrift(early, late) {
  const responseTimeRatio = early.avg_response_time > 0 ? late.avg_response_time / early.avg_response_time : 1;
  const errorRateDelta = late.error_rate - early.error_rate;
  const throughputRatio = early.throughput > 0 ? late.throughput / early.throughput : 1;

  let level = 'ok';
  const reasons = [];
  if (responseTimeRatio >= RESPONSE_TIME_CRITICAL_RATIO) { level = 'error'; reasons.push(`response time grew ${((responseTimeRatio - 1) * 100).toFixed(0)}%`); }
  else if (responseTimeRatio >= RESPONSE_TIME_WARNING_RATIO) { level = level === 'error' ? level : 'warning'; reasons.push(`response time grew ${((responseTimeRatio - 1) * 100).toFixed(0)}%`); }

  if (errorRateDelta >= ERROR_RATE_CRITICAL_MARGIN) { level = 'error'; reasons.push(`error rate rose ${errorRateDelta.toFixed(1)} points`); }
  else if (errorRateDelta >= ERROR_RATE_WARNING_MARGIN) { level = level === 'error' ? level : 'warning'; reasons.push(`error rate rose ${errorRateDelta.toFixed(1)} points`); }

  if (throughputRatio <= THROUGHPUT_WARNING_RATIO) { level = level === 'error' ? level : 'warning'; reasons.push(`throughput dropped ${((1 - throughputRatio) * 100).toFixed(0)}% despite steady concurrency`); }

  return { level, reasons, responseTimeRatio, errorRateDelta, throughputRatio };
}

/**
 * @param {Array} timeline - parsed run timeline (per-second threads/tps/avg_rt/errors/error_rate)
 * @param {Array} rules - project's rules (same row shape ruleEvaluator.js reads from the `rules` table)
 * @param {{ vusers: number, duration: number }} runParams - the ACTUAL VUsers/Duration this
 *   run executed with (trigger-time values, not necessarily the suite's saved defaults).
 * @returns {{
 *   applicable: boolean,
 *   minDurationS?: number,
 *   early?: object, late?: object,
 *   lateVerdict?: object, drift?: object, usedFallbackRules?: boolean,
 *   overall: { level: 'good'|'warning'|'critical'|'unknown', message: string }
 * }}
 */
function analyzeEnduranceRun(timeline, rules, runParams = {}) {
  const { vusers, duration } = runParams;
  if (!(vusers > 0) || !(duration > 0)) {
    return { applicable: false, overall: { level: 'unknown', message: 'Not enough data to analyze this run.' } };
  }

  if (duration < MIN_ENDURANCE_DURATION_S) {
    const mins = Math.round(duration / 60);
    return {
      applicable: false,
      minDurationS: MIN_ENDURANCE_DURATION_S,
      overall: {
        level: 'unknown',
        message: `Duration (${mins}m) is below the 1h40m minimum for a meaningful endurance/soak signal — this ran effectively as a Load Test. No degradation-over-time analysis applies; run for 1h40m or longer to get a real endurance verdict.`,
      },
    };
  }

  // Early/late windows: 20% of the run each, with a short settle period after ramp-up so the
  // "early" window reflects steady state, not the initial ramp.
  const windowSpan = Math.round(duration * 0.20);
  const settle = Math.min(30, Math.round(windowSpan * 0.1));
  const earlySecs = filterWindow(timeline, settle, settle + windowSpan);
  const lateStart = duration - windowSpan;
  const lateSecs = filterWindow(timeline, lateStart, duration);

  if (!earlySecs.length || !lateSecs.length) {
    return { applicable: false, overall: { level: 'unknown', message: 'Could not isolate distinct early/late windows from this run\'s timeline.' } };
  }

  const early = summarizeStep({ threads: vusers, seconds: earlySecs });
  const late = summarizeStep({ threads: vusers, seconds: lateSecs });

  const { verdict: lateVerdict, usedFallbackRules } = evaluateLateWindow(late, rules);
  const drift = evaluateDrift(early, late);

  const worstLevel = lateVerdict.level === 'error' || drift.level === 'error' ? 'error'
    : lateVerdict.level === 'warning' || drift.level === 'warning' ? 'warning' : 'ok';

  let overall;
  if (worstLevel === 'ok') {
    overall = { level: 'good', message: 'Performance stayed consistent throughout the endurance run — no meaningful drift between the early and late windows.' };
  } else if (worstLevel === 'warning') {
    const reasonText = drift.reasons.length ? drift.reasons.join(', ') : `${lateVerdict.metric} ${lateVerdict.thresholdLabel} in the late window (actual ${lateVerdict.actual})`;
    overall = { level: 'warning', message: `Some degradation over time detected (${reasonText}) — worth watching, not yet severe.` };
  } else {
    const reasonText = drift.reasons.length ? drift.reasons.join(', ') : `${lateVerdict.metric} ${lateVerdict.thresholdLabel} in the late window (actual ${lateVerdict.actual})`;
    overall = { level: 'critical', message: `Significant degradation over time (${reasonText}) — this is the leak/exhaustion pattern an endurance test exists to catch.` };
  }

  return { applicable: true, early, late, lateVerdict, drift, usedFallbackRules, overall };
}

module.exports = { analyzeEnduranceRun, MIN_ENDURANCE_DURATION_S };
