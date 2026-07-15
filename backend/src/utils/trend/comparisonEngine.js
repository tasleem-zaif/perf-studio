'use strict';
// Comparison Engine — classifies each API as improved/regressed/new/removed/stable
// between a baseline run and a latest run. Pure functions only (no DB/network),
// same philosophy as correlationEngine.js: the route handler fetches run_api_metrics
// rows and passes them in; this module only classifies.
//
// For a Run1/Run2/Run3+ "multi-run comparison" selection, the caller passes the
// chronologically earliest selected run as baseline and the most recent as latest —
// the classification is always a two-point comparison; per-execution trend across
// every run in between is the Trend Charts panel's job (statsEngine.js + /trend),
// not this engine's.

// v1 weighted "badness" formula — positive means the API got worse. Each term is
// normalized to a comparable percent-ish scale before weighting:
//   - avg/p95 response time: relative % change (slower = positive = worse)
//   - error rate: raw percentage-POINT change (already 0-100), scaled up because a
//     2-point error-rate jump (e.g. 1% -> 3%) is a much bigger deal than a 2%
//     response-time change of the same numeric size
//   - throughput (tps): relative % change, inverted (a drop in tps is bad)
const WEIGHTS = { avg: 0.40, p95: 0.25, errorRate: 0.25, tps: 0.10 };
const ERROR_RATE_SCALE = 8; // 1 percentage point of error-rate swing ≈ 8% of "badness"
const REGRESSION_THRESHOLD = 10; // |badness| below this is classified 'stable'
const FORMULA_VERSION = 'v1';

function pctChange(from, to) {
  if (!from || from === 0) return to > 0 ? 100 : 0;
  return ((to - from) / from) * 100;
}

/**
 * @param {object} baseline — one run_api_metrics row (or null if the API is new)
 * @param {object} latest — one run_api_metrics row (or null if the API was removed)
 * @returns {{avgPct:number, p95Pct:number, errorRatePts:number, tpsPct:number, badness:number}}
 */
function computeDeltas(baseline, latest) {
  const avgPct = pctChange(baseline.avg, latest.avg);
  const p95Pct = pctChange(baseline.p95, latest.p95);
  const tpsPct = pctChange(baseline.tps, latest.tps);
  const errorRatePts = (latest.error_rate || 0) - (baseline.error_rate || 0);

  const badness =
    WEIGHTS.avg * avgPct +
    WEIGHTS.p95 * p95Pct +
    WEIGHTS.errorRate * (errorRatePts * ERROR_RATE_SCALE) +
    WEIGHTS.tps * (-tpsPct);

  return { avgPct, p95Pct, errorRatePts, tpsPct, badness };
}

/**
 * Compares two runs' per-API metrics.
 * @param {Array} baselineApis — run_api_metrics rows for the baseline run
 * @param {Array} latestApis — run_api_metrics rows for the latest run
 * @returns {{improved:Array, regressed:Array, new:Array, removed:Array, stable:Array, formula:object}}
 */
function compareRuns(baselineApis, latestApis) {
  const baseByLabel = new Map((baselineApis || []).map(a => [a.label, a]));
  const latestByLabel = new Map((latestApis || []).map(a => [a.label, a]));
  const allLabels = new Set([...baseByLabel.keys(), ...latestByLabel.keys()]);

  const improved = [], regressed = [], newApis = [], removed = [], stable = [];

  for (const label of allLabels) {
    const baseline = baseByLabel.get(label);
    const latest = latestByLabel.get(label);

    if (!baseline && latest) {
      newApis.push({ label, latest });
      continue;
    }
    if (baseline && !latest) {
      removed.push({ label, baseline });
      continue;
    }

    const deltas = computeDeltas(baseline, latest);
    const entry = { label, baseline, latest, deltas };

    if (deltas.badness >= REGRESSION_THRESHOLD) regressed.push(entry);
    else if (deltas.badness <= -REGRESSION_THRESHOLD) improved.push(entry);
    else stable.push(entry);
  }

  // Worst/best first — the whole point of this view is triaging what to look at.
  regressed.sort((a, b) => b.deltas.badness - a.deltas.badness);
  improved.sort((a, b) => a.deltas.badness - b.deltas.badness);

  return {
    improved, regressed, new: newApis, removed, stable,
    formula: {
      version: FORMULA_VERSION,
      weights: WEIGHTS,
      errorRateScale: ERROR_RATE_SCALE,
      regressionThreshold: REGRESSION_THRESHOLD,
      description: 'badness = 0.40*avgRT%Δ + 0.25*p95%Δ + 0.25*(errorRatePtsΔ*8) + 0.10*(-tps%Δ); ≥+10 regressed, ≤-10 improved, else stable',
    },
  };
}

module.exports = { compareRuns, computeDeltas, FORMULA_VERSION };
