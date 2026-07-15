'use strict';
// Scoring Engine — six weighted scores (0-100, higher is better) computed for a single
// run. Every score returns {value, formula, inputs} so the UI can show *why* a number is
// what it is (a hover card with the actual formula), not a black box. Pure functions only
// (no DB/network) — the route handler assembles inputs (run_api_metrics rows, report_data
// summary, a prior run's comparison, historical vusers-vs-metric points) and calls these.
//
// v1 constants below are fixed, documented heuristics (no per-project SLA config exists
// in this codebase yet) — tagged with formula_version so a future tuned v2 doesn't
// silently reinterpret historical scores.
const FORMULA_VERSION = 'v1';

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

// A single API (or the whole-run summary) is penalized for high error rate and slow p95 —
// the same two-factor penalty is applied at both API-level and summary-level so "API
// Health" and "Application Health" are directly comparable numbers.
function healthOf({ error_rate = 0, p95 = 0 }) {
  const errorPenalty = clamp(error_rate * 0.7, 0, 70);
  const latencyPenalty = clamp(((p95 - 500) / 500) * 15, 0, 30);
  return clamp(100 - errorPenalty - latencyPenalty, 0, 100);
}

/**
 * Average per-API health across every API observed in the run.
 * @param {Array<{label, error_rate, p95}>} apiMetrics — run_api_metrics rows for one run
 */
function computeApiHealthScore(apiMetrics) {
  const apis = apiMetrics || [];
  if (!apis.length) return { value: null, formula: { version: FORMULA_VERSION, description: 'No API metrics available for this run.' }, inputs: { apiCount: 0 } };

  const perApi = apis.map(a => ({ label: a.label, health: healthOf(a) }));
  const value = clamp(perApi.reduce((s, a) => s + a.health, 0) / perApi.length, 0, 100);

  return {
    value: Math.round(value * 10) / 10,
    formula: {
      version: FORMULA_VERSION,
      description: 'Average of per-API health: 100 − min(70, error_rate×0.7) − min(30, (p95−500)/500×15). Penalizes high error rate and slow p95 relative to a 500ms baseline.',
    },
    inputs: { apiCount: apis.length, perApi },
  };
}

/**
 * Whole-application view: blends the average API health with the run's overall summary
 * metrics (same penalty formula, applied to the aggregate). Distinct from API Health
 * Score because a run can have mostly-healthy APIs but a bad overall summary (or vice
 * versa) — e.g. one catastrophic API dragging down total error rate while most
 * individual APIs look fine in isolation.
 * @param {{value:number}} apiHealthScore — computeApiHealthScore's result
 * @param {{error_rate:number, p95:number}} summary — the run's overall report_data.summary
 */
function computeApplicationHealthScore(apiHealthScore, summary) {
  if (apiHealthScore.value === null || !summary) {
    return { value: apiHealthScore.value, formula: { version: FORMULA_VERSION, description: 'Insufficient data (no API metrics or no run summary).' }, inputs: {} };
  }
  const overallHealth = healthOf(summary);
  const value = clamp(0.7 * apiHealthScore.value + 0.3 * overallHealth, 0, 100);

  return {
    value: Math.round(value * 10) / 10,
    formula: {
      version: FORMULA_VERSION,
      description: '0.70 × API Health Score + 0.30 × (same health formula applied to the run-wide summary metrics).',
    },
    inputs: { apiHealthScore: apiHealthScore.value, overallHealth },
  };
}

/**
 * How much this run regressed vs. the immediately preceding run for the same suite —
 * reuses comparisonEngine's compareRuns() classification/deltas so "regressed" means
 * the same thing here as it does in the Comparison view. No prior run to compare
 * against → neutral 100 (nothing to regress from yet), not a fabricated number.
 * @param {{regressed:Array}|null} comparisonResult — comparisonEngine.compareRuns() output, or null
 */
function computeRegressionScore(comparisonResult) {
  if (!comparisonResult) {
    return { value: 100, formula: { version: FORMULA_VERSION, description: 'No prior run for this suite to compare against — neutral score.' }, inputs: {} };
  }
  const penalty = clamp(
    (comparisonResult.regressed || []).reduce((sum, r) => sum + clamp(r.deltas.badness / 3, 0, 20), 0),
    0, 100,
  );
  const value = clamp(100 - penalty, 0, 100);

  return {
    value: Math.round(value * 10) / 10,
    formula: {
      version: FORMULA_VERSION,
      description: '100 − Σ min(20, badness/3) over every API classified "regressed" vs. the prior run (see comparisonEngine.js).',
    },
    inputs: { regressedCount: (comparisonResult.regressed || []).length, penalty },
  };
}

/**
 * Success rate of the run itself — 100 − overall error rate. Deliberately simple:
 * reliability here means "did requests succeed," not a comparison to history (that's
 * Regression Score's job) or load tolerance (that's Scalability Score's job).
 * @param {{error_rate:number}} summary
 */
function computeReliabilityScore(summary) {
  if (!summary) return { value: null, formula: { version: FORMULA_VERSION, description: 'No run summary available.' }, inputs: {} };
  const value = clamp(100 - (summary.error_rate || 0), 0, 100);
  return {
    value: Math.round(value * 10) / 10,
    formula: { version: FORMULA_VERSION, description: '100 − overall error rate (%). Equivalent to the run\'s overall success rate.' },
    inputs: { errorRate: summary.error_rate || 0 },
  };
}

/**
 * How flat performance stays as concurrency (run_vusers) increases, using this suite's
 * own execution history. Needs ≥2 runs with distinct known vusers levels — with fewer,
 * there's no basis to assess a slope at all, so this returns null rather than a
 * fabricated number (surfaced to the UI as "insufficient data").
 * @param {Array<{run_vusers:number, avg:number, error_rate:number}>} historicalPoints — chronological, one entry per suite run with a known run_vusers
 */
function computeScalabilityScore(historicalPoints, linearRegressionFn) {
  const points = (historicalPoints || []).filter(p => Number.isFinite(p.run_vusers));
  const distinctVusers = new Set(points.map(p => p.run_vusers));
  if (points.length < 2 || distinctVusers.size < 2) {
    return {
      value: null,
      formula: { version: FORMULA_VERSION, description: 'Insufficient data — needs at least 2 runs at different concurrency (run_vusers) levels for this suite.', insufficientData: true },
      inputs: { pointCount: points.length, distinctVusersLevels: distinctVusers.size },
    };
  }

  // Sort by vusers so the regression's "x" axis is concurrency, not run order.
  const sorted = [...points].sort((a, b) => a.run_vusers - b.run_vusers);
  const errorRateReg = linearRegressionFn(sorted.map(p => p.error_rate || 0));
  const avgRtReg = linearRegressionFn(sorted.map(p => p.avg || 0));

  // Slopes here are "per step through the sorted vusers sequence," not "per user" —
  // a coarse but honest proxy given how few distinct load levels most suites will have.
  const errorPenalty = clamp(errorRateReg.slope * 10, 0, 60);
  const rtPenalty = clamp(avgRtReg.slope / 5, 0, 40);
  const value = clamp(100 - errorPenalty - rtPenalty, 0, 100);

  return {
    value: Math.round(value * 10) / 10,
    formula: {
      version: FORMULA_VERSION,
      description: '100 − min(60, errorRateSlope×10) − min(40, avgRtSlope/5), where slopes are linear-regression trend over this suite\'s runs ordered by concurrency (run_vusers).',
    },
    inputs: { pointCount: points.length, distinctVusersLevels: distinctVusers.size, errorRateSlope: errorRateReg.slope, avgRtSlope: avgRtReg.slope },
  };
}

const OVERALL_WEIGHTS = { apiHealth: 0.25, appHealth: 0.20, regression: 0.25, reliability: 0.20, scalability: 0.10 };

/**
 * Weighted overall Performance Score. A score with value:null (e.g. scalability with
 * insufficient data) is excluded and its weight redistributed proportionally among the
 * rest, rather than treating a missing input as a 0.
 * @param {{apiHealth, appHealth, regression, reliability, scalability}} scores — each {value:number|null}
 */
function computeOverallScore(scores) {
  const available = Object.entries(OVERALL_WEIGHTS).filter(([key]) => scores[key]?.value !== null && scores[key]?.value !== undefined);
  if (!available.length) return { value: null, formula: { version: FORMULA_VERSION, description: 'No component scores available.' }, inputs: {} };

  const totalWeight = available.reduce((s, [, w]) => s + w, 0);
  const value = clamp(
    available.reduce((sum, [key, w]) => sum + scores[key].value * (w / totalWeight), 0),
    0, 100,
  );

  return {
    value: Math.round(value * 10) / 10,
    formula: {
      version: FORMULA_VERSION,
      weights: OVERALL_WEIGHTS,
      description: 'Weighted average of API Health (25%), Application Health (20%), Regression (25%), Reliability (20%), and Scalability (10%). Missing components (e.g. scalability with insufficient data) have their weight redistributed proportionally, not treated as 0.',
    },
    inputs: { usedWeights: Object.fromEntries(available) },
  };
}

module.exports = {
  FORMULA_VERSION,
  computeApiHealthScore,
  computeApplicationHealthScore,
  computeRegressionScore,
  computeReliabilityScore,
  computeScalabilityScore,
  computeOverallScore,
};
