'use strict';
// Prediction Engine — capacity planning (max stable/recommended/breaking-point users,
// projected RT/TPS/error-rate at a target load) and forecast-next-execution. Pure
// functions only — the route handler supplies historical points/series; this module
// only does the math (same philosophy as statsEngine.js, which it builds directly on).
const FORMULA_VERSION = 'v1';

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function round1(n) { return n === null || n === undefined ? null : Math.round(n * 10) / 10; }
// R² is a 0-1 fraction, not a metric value — round1 (1 decimal place) makes anything
// ≥0.95 display as a misleading "1" (implying a perfect fit). 2 decimals here instead.
function round2(n) { return n === null || n === undefined ? null : Math.round(n * 100) / 100; }

/**
 * Estimates capacity limits for a suite from its own execution history at different
 * concurrency (run_vusers) levels. Needs ≥2 distinct levels — with fewer, there's no
 * basis for a slope at all, so this returns insufficientData:true rather than a
 * fabricated number (same honesty policy as scoringEngine's Scalability Score).
 * @param {Array<{run_vusers:number, avg:number, error_rate:number, tps:number}>} historicalPoints
 * @param {{linearRegressionXY:Function}} stats — statsEngine, injected to avoid a require cycle risk and ease testing
 * @param {object} [opts]
 * @param {number} [opts.stableErrorThreshold=2] — max error rate (%) still considered "stable"
 * @param {number} [opts.breakingErrorThreshold=10] — error rate (%) considered "broken"
 * @param {number} [opts.breakingRtMultiplier=3] — response time this many times the lowest-load baseline is considered "broken"
 * @param {number} [opts.recommendedSafetyMargin=0.8] — recommended users = maxStableUsers × this
 */
function estimateCapacity(historicalPoints, stats, opts = {}) {
  const {
    stableErrorThreshold = 2, breakingErrorThreshold = 10,
    breakingRtMultiplier = 3, recommendedSafetyMargin = 0.8,
  } = opts;

  const points = (historicalPoints || []).filter(p => Number.isFinite(p.run_vusers));
  // Average multiple runs at the same concurrency level into one point — a cleaner
  // signal than regressing over noisy repeated observations at identical x values.
  const byLevel = new Map();
  for (const p of points) {
    if (!byLevel.has(p.run_vusers)) byLevel.set(p.run_vusers, []);
    byLevel.get(p.run_vusers).push(p);
  }
  const levels = [...byLevel.entries()]
    .map(([vusers, group]) => ({
      run_vusers: vusers,
      avg: group.reduce((s, g) => s + (g.avg || 0), 0) / group.length,
      error_rate: group.reduce((s, g) => s + (g.error_rate || 0), 0) / group.length,
      tps: group.reduce((s, g) => s + (g.tps || 0), 0) / group.length,
    }))
    .sort((a, b) => a.run_vusers - b.run_vusers);

  if (levels.length < 2) {
    return {
      insufficientData: true, distinctLoadLevelsTested: levels.length,
      formula: { version: FORMULA_VERSION, description: 'Insufficient data — needs at least 2 runs at different concurrency (run_vusers) levels for this suite.' },
    };
  }

  const stableLevels = levels.filter(l => l.error_rate <= stableErrorThreshold);
  const maxStableUsers = stableLevels.length ? stableLevels[stableLevels.length - 1].run_vusers : null;
  const recommendedUsers = maxStableUsers !== null ? Math.round(maxStableUsers * recommendedSafetyMargin) : null;

  const vusersArr = levels.map(l => l.run_vusers);
  const errorReg = stats.linearRegressionXY(vusersArr, levels.map(l => l.error_rate));
  const avgReg = stats.linearRegressionXY(vusersArr, levels.map(l => l.avg));
  const tpsReg = stats.linearRegressionXY(vusersArr, levels.map(l => l.tps));

  const breakingByError = errorReg.slope > 0 ? (breakingErrorThreshold - errorReg.intercept) / errorReg.slope : null;
  const baselineAvg = levels[0].avg;
  const breakingByRt = avgReg.slope > 0 ? ((baselineAvg * breakingRtMultiplier) - avgReg.intercept) / avgReg.slope : null;

  const candidates = [
    { users: breakingByError, driver: 'error_rate' },
    { users: breakingByRt, driver: 'response_time' },
  ].filter(c => Number.isFinite(c.users) && c.users > 0);

  let breakingPointUsers = null, breakingPointDriver = null;
  if (candidates.length) {
    const worst = candidates.reduce((a, b) => (b.users < a.users ? b : a));
    breakingPointUsers = Math.round(worst.users);
    breakingPointDriver = worst.driver;
  }

  function projectAt(vusers) {
    if (vusers === null || vusers === undefined) return null;
    return {
      users: vusers,
      avg: round1(Math.max(0, avgReg.predict(vusers))),
      tps: round1(Math.max(0, tpsReg.predict(vusers))),
      error_rate: round1(clamp(errorReg.predict(vusers), 0, 100)),
    };
  }

  // A 2-point regression fits perfectly (R²=1) by construction — that's a mathematical
  // fact, not evidence the trend is real. Discount confidence when few load levels were
  // actually tested, on top of the regressions' own average R².
  const rSquaredAvg = (errorReg.rSquared + avgReg.rSquared + tpsReg.rSquared) / 3;
  const dataSufficiencyFactor = clamp(levels.length / 5, 0.3, 1);
  const confidencePct = Math.round(rSquaredAvg * dataSufficiencyFactor * 100);

  return {
    insufficientData: false,
    distinctLoadLevelsTested: levels.length,
    maxStableUsers, recommendedUsers, breakingPointUsers, breakingPointDriver,
    // Precomputed at the 3 headline load levels — callers (the API response is JSON,
    // which drops the regressions' `predict` functions) never need to call predict()
    // themselves.
    projectedAtRecommended: projectAt(recommendedUsers),
    projectedAtMaxStable: projectAt(maxStableUsers),
    projectedAtBreakingPoint: projectAt(breakingPointUsers),
    confidencePct,
    regressions: { error_rate: errorReg, avg: avgReg, tps: tpsReg },
    formula: {
      version: FORMULA_VERSION,
      description: `Max stable users = highest tested concurrency with error rate ≤${stableErrorThreshold}%. Recommended = ${Math.round(recommendedSafetyMargin * 100)}% of max stable. Breaking point = concurrency where linear-regressed error rate reaches ${breakingErrorThreshold}% or avg RT reaches ${breakingRtMultiplier}× the lowest-load baseline, whichever comes first. Confidence blends regression fit (R²) with how many distinct load levels were actually tested.`,
    },
  };
}

/**
 * One-step-ahead forecast for the next execution, via both linear-regression
 * extrapolation and exponential smoothing — reported side by side since they can
 * diverge (smoothing tracks recent shifts faster; regression assumes the whole
 * trend continues linearly). Confidence is the regression's own R², since that's
 * the method with a defined goodness-of-fit; smoothing has no equivalent measure.
 * @param {number[]} series — chronological metric values (e.g. avg RT per execution)
 * @param {{linearRegression:Function, exponentialSmoothing:Function}} stats
 * @param {{alpha?:number}} [opts]
 */
function forecastNextExecution(series, stats, opts = {}) {
  const values = series || [];
  if (values.length < 2) {
    return { insufficientData: true, formula: { version: FORMULA_VERSION, description: 'Needs at least 2 executions to forecast the next one.' } };
  }
  const alpha = opts.alpha ?? 0.3;
  const reg = stats.linearRegression(values);
  const smoothing = stats.exponentialSmoothing(values, alpha);
  const confidencePct = clamp(Math.round(reg.rSquared * 100), 10, 95);

  return {
    insufficientData: false,
    linearForecast: round1(reg.predict(values.length)),
    exponentialSmoothingForecast: round1(smoothing.forecastNext),
    confidencePct,
    trendDirection: reg.direction,
    regression: reg,
    formula: {
      version: FORMULA_VERSION,
      description: `Linear forecast extrapolates the OLS trend line one step past the last execution (R²=${round2(reg.rSquared)}). Exponential smoothing (α=${alpha}) weights recent executions more heavily without assuming the trend is linear. Confidence is the linear model's R².`,
    },
  };
}

/**
 * Failure signatures (API + response code) that recur across a meaningful share of
 * the given runs — a single bad run's errors aren't "recurring," a signature that
 * shows up in most runs likely reflects a persistent, not transient, problem.
 * @param {Array<Array<{label, response_code}>>} runsErrorLists — one array per run, from report_data.errors
 * @param {number} [minRecurrenceRatio=0.6]
 */
function detectRecurringFailures(runsErrorLists, minRecurrenceRatio = 0.6) {
  const totalRuns = (runsErrorLists || []).length;
  if (totalRuns < 3) return [];

  const bySignature = new Map();
  runsErrorLists.forEach((errors, runIndex) => {
    for (const e of errors || []) {
      const sig = `${e.label}||${e.response_code}`;
      if (!bySignature.has(sig)) bySignature.set(sig, { label: e.label, response_code: e.response_code, runIndices: new Set(), totalCount: 0 });
      const entry = bySignature.get(sig);
      entry.runIndices.add(runIndex);
      entry.totalCount += e.count || 1;
    }
  });

  return [...bySignature.values()]
    .filter(e => e.runIndices.size / totalRuns >= minRecurrenceRatio)
    .map(e => ({ label: e.label, response_code: e.response_code, recurrenceRatio: round1((e.runIndices.size / totalRuns) * 100), runsAffected: e.runIndices.size, totalRuns, totalOccurrences: e.totalCount }))
    .sort((a, b) => b.recurrenceRatio - a.recurrenceRatio);
}

module.exports = { estimateCapacity, forecastNextExecution, detectRecurringFailures, FORMULA_VERSION };
