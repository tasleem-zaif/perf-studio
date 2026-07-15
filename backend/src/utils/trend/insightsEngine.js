'use strict';
// Insights Engine — deterministic, threshold-based plain-English bullets (same
// philosophy as script generation: no AI involved, so results are reproducible and
// free). Pure functions only — the route handler assembles the historical/comparison
// data and calls generateInsights(). Every insight is {type, severity, message,
// metric, delta_pct, scope} so the UI can filter/icon them without re-parsing text.

const SIGNIFICANT_PCT = 10;       // a metric change below this is noise, not an insight
const CRITICAL_PCT = 30;          // above this, severity escalates to 'critical'
const ERROR_RATE_PTS_THRESHOLD = 2; // percentage-POINT change in error rate worth flagging
const STREAK_MIN = 3;             // minimum consecutive same-direction runs to call it a streak

function pctChange(from, to) {
  if (!from || from === 0) return to > 0 ? 100 : 0;
  return ((to - from) / from) * 100;
}
function severityForPct(absPct) { return absPct >= CRITICAL_PCT ? 'critical' : 'warn'; }
function round1(n) { return Math.round(n * 10) / 10; }

/** Overall (whole-run) baseline-vs-latest deltas — avg RT, P95, TPS, error rate. */
function generateOverallDeltaInsights(baselineSummary, latestSummary) {
  if (!baselineSummary || !latestSummary) return [];
  const insights = [];

  const avgPct = pctChange(baselineSummary.avg_response_time, latestSummary.avg_response_time);
  if (Math.abs(avgPct) >= SIGNIFICANT_PCT) {
    insights.push({
      type: 'overall_metric_delta', metric: 'avg_response_time', scope: 'overall',
      delta_pct: round1(avgPct), severity: avgPct > 0 ? severityForPct(Math.abs(avgPct)) : 'good',
      message: `Average response time ${avgPct > 0 ? 'increased' : 'decreased'} by ${Math.abs(round1(avgPct))}%`,
    });
  }

  const p95Pct = pctChange(baselineSummary.p95, latestSummary.p95);
  if (Math.abs(p95Pct) >= SIGNIFICANT_PCT) {
    insights.push({
      type: 'overall_metric_delta', metric: 'p95', scope: 'overall',
      delta_pct: round1(p95Pct), severity: p95Pct > 0 ? severityForPct(Math.abs(p95Pct)) : 'good',
      message: `95th percentile ${p95Pct > 0 ? 'increased' : 'decreased'} by ${Math.abs(round1(p95Pct))}%`,
    });
  }

  const tpsPct = pctChange(baselineSummary.overall_tps, latestSummary.overall_tps);
  if (Math.abs(tpsPct) >= SIGNIFICANT_PCT) {
    insights.push({
      type: 'overall_metric_delta', metric: 'tps', scope: 'overall',
      delta_pct: round1(tpsPct), severity: tpsPct < 0 ? severityForPct(Math.abs(tpsPct)) : 'good',
      message: `TPS ${tpsPct > 0 ? 'increased' : 'reduced'} by ${Math.abs(round1(tpsPct))}%`,
    });
  }

  const errorPts = (latestSummary.error_rate || 0) - (baselineSummary.error_rate || 0);
  if (Math.abs(errorPts) >= ERROR_RATE_PTS_THRESHOLD) {
    insights.push({
      type: 'overall_metric_delta', metric: 'error_rate', scope: 'overall',
      delta_pct: round1(errorPts), severity: errorPts > 0 ? severityForPct(Math.abs(errorPts) * 5) : 'good',
      message: `Error rate ${errorPts > 0 ? 'increased' : 'decreased'} by ${Math.abs(round1(errorPts))} points (${round1(baselineSummary.error_rate || 0)}% → ${round1(latestSummary.error_rate || 0)}%)`,
    });
  }

  return insights;
}

/** Worst-regressed / best-improved individual APIs, from comparisonEngine's output. */
function generateApiDeltaInsights(comparisonResult, { topN = 3 } = {}) {
  if (!comparisonResult) return [];
  const insights = [];

  for (const entry of (comparisonResult.regressed || []).slice(0, topN)) {
    insights.push({
      type: 'api_regression', metric: 'composite', scope: entry.label,
      delta_pct: round1(entry.deltas.badness), severity: severityForPct(entry.deltas.badness),
      message: `${entry.label} API regressed — avg RT ${entry.deltas.avgPct > 0 ? '+' : ''}${round1(entry.deltas.avgPct)}%, error rate ${entry.deltas.errorRatePts > 0 ? '+' : ''}${round1(entry.deltas.errorRatePts)} pts`,
    });
  }
  for (const entry of (comparisonResult.improved || []).slice(0, topN)) {
    insights.push({
      type: 'api_improvement', metric: 'composite', scope: entry.label,
      delta_pct: round1(entry.deltas.badness), severity: 'good',
      message: `${entry.label} API improved — avg RT ${round1(entry.deltas.avgPct)}%`,
    });
  }
  for (const entry of (comparisonResult.new || [])) {
    insights.push({ type: 'api_new', metric: null, scope: entry.label, delta_pct: null, severity: 'info', message: `${entry.label} is a new API in the latest run` });
  }
  for (const entry of (comparisonResult.removed || [])) {
    insights.push({ type: 'api_removed', metric: null, scope: entry.label, delta_pct: null, severity: 'info', message: `${entry.label} no longer appears in the latest run` });
  }

  return insights;
}

/**
 * Consecutive degradation/improvement streaks per API — "Login API has degraded
 * continuously for 5 executions." A streak is 3+ consecutive runs where avg response
 * time kept moving the same direction (any increase/decrease counts as a step;
 * ties break the streak).
 * @param {Map<string, Array<{avg:number}>>} perApiHistory — chronological per-API avg RT series
 */
function generateConsecutiveTrendInsights(perApiHistory) {
  const insights = [];
  for (const [label, history] of perApiHistory.entries()) {
    if (!history || history.length < STREAK_MIN + 1) continue;

    // Trailing streak ending at the most recent run.
    let degradingStreak = 1, improvingStreak = 1;
    for (let i = history.length - 1; i > 0; i--) {
      if (history[i].avg > history[i - 1].avg) degradingStreak++; else break;
    }
    for (let i = history.length - 1; i > 0; i--) {
      if (history[i].avg < history[i - 1].avg) improvingStreak++; else break;
    }

    if (degradingStreak >= STREAK_MIN + 1) {
      insights.push({
        type: 'consecutive_degradation', metric: 'avg_response_time', scope: label,
        delta_pct: null, severity: degradingStreak >= STREAK_MIN + 2 ? 'critical' : 'warn',
        message: `${label} API has degraded continuously for ${degradingStreak} executions`,
      });
    } else if (improvingStreak >= STREAK_MIN + 1) {
      insights.push({
        type: 'consecutive_improvement', metric: 'avg_response_time', scope: label,
        delta_pct: null, severity: 'good',
        message: `${label} API has improved continuously for ${improvingStreak} executions`,
      });
    }
  }
  return insights;
}

/** Finds every point where a chronological, tag-labeled history's tag value changes. */
function detectBoundaryShifts(history) {
  const tagged = history.filter(h => h.tagValue !== null && h.tagValue !== undefined && h.tagValue !== '');
  const shifts = [];
  for (let i = 1; i < tagged.length; i++) {
    if (tagged[i].tagValue !== tagged[i - 1].tagValue) shifts.push({ before: tagged[i - 1], after: tagged[i] });
  }
  return shifts;
}

/**
 * Overall metric shifts at build/release boundaries — "Failures increased after
 * Build 241." Compares the last run of the previous tag value against the first run
 * of the new one (nearest neighbors across the boundary).
 * @param {Array<{tagValue, avg, error_rate}>} taggedHistory — chronological, tagValue = build_number or release_tag
 * @param {string} tagLabel — 'Build' or 'Release', used in the message text
 */
function generateBoundaryInsights(taggedHistory, tagLabel, scope = 'overall') {
  const insights = [];
  for (const { before, after } of detectBoundaryShifts(taggedHistory)) {
    const errorPts = (after.error_rate || 0) - (before.error_rate || 0);
    const avgPct = pctChange(before.avg, after.avg);

    if (Math.abs(errorPts) >= ERROR_RATE_PTS_THRESHOLD) {
      insights.push({
        type: 'boundary_shift', metric: 'error_rate', scope,
        delta_pct: round1(errorPts), severity: errorPts > 0 ? severityForPct(Math.abs(errorPts) * 5) : 'good',
        message: scope === 'overall'
          ? `Failures ${errorPts > 0 ? 'increased' : 'decreased'} after ${tagLabel} ${after.tagValue}`
          : `${scope} API failures ${errorPts > 0 ? 'increased' : 'decreased'} after ${tagLabel} ${after.tagValue}`,
      });
    }
    if (Math.abs(avgPct) >= SIGNIFICANT_PCT) {
      insights.push({
        type: 'boundary_shift', metric: 'avg_response_time', scope,
        delta_pct: round1(avgPct), severity: avgPct > 0 ? severityForPct(Math.abs(avgPct)) : 'good',
        message: scope === 'overall'
          ? `Response time ${avgPct > 0 ? 'increased' : 'improved'} after ${tagLabel} ${after.tagValue}`
          : `${scope} API ${avgPct > 0 ? 'degraded' : 'improved'} after ${tagLabel} ${after.tagValue}`,
      });
    }
  }
  return insights;
}

const SEVERITY_ORDER = { critical: 0, warn: 1, good: 2, info: 3 };

/**
 * Combines every insight type into one flat, severity-sorted list.
 * @param {object} context
 * @param {object|null} context.overallBaseline — earliest run's report_data.summary
 * @param {object|null} context.overallLatest — latest run's report_data.summary
 * @param {object|null} context.comparison — comparisonEngine.compareRuns() output
 * @param {Array} context.overallHistory — chronological [{avg, error_rate, build_number, release_tag}]
 * @param {Map<string, Array>} context.perApiHistory — label → chronological [{avg, error_rate, build_number, release_tag}]
 */
function generateInsights(context) {
  const { overallBaseline, overallLatest, comparison, overallHistory = [], perApiHistory = new Map() } = context;

  const insights = [
    ...generateOverallDeltaInsights(overallBaseline, overallLatest),
    ...generateApiDeltaInsights(comparison),
    ...generateConsecutiveTrendInsights(perApiHistory),
    ...generateBoundaryInsights(overallHistory.map(h => ({ ...h, tagValue: h.build_number })), 'Build', 'overall'),
    ...generateBoundaryInsights(overallHistory.map(h => ({ ...h, tagValue: h.release_tag })), 'Release', 'overall'),
  ];

  for (const [label, history] of perApiHistory.entries()) {
    insights.push(...generateBoundaryInsights(history.map(h => ({ ...h, tagValue: h.release_tag })), 'Release', label));
  }

  return insights.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3));
}

module.exports = {
  generateOverallDeltaInsights,
  generateApiDeltaInsights,
  generateConsecutiveTrendInsights,
  generateBoundaryInsights,
  generateInsights,
};
