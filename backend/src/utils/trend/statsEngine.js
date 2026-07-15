'use strict';
// Shared time-series math for Trend Analysis. Pure functions only (no DB/network) —
// same "detection only" philosophy as correlationEngine.js — so trend/prediction/
// scoring code all builds on one tested implementation instead of each reinventing it.

/**
 * Trailing simple moving average — the average of the last `window` points ending
 * at each index. The first `window - 1` points don't have a full window yet, so
 * they average whatever is available (still useful for a chart overlay; never null).
 * @param {number[]} series
 * @param {number} window
 * @returns {number[]} same length as series
 */
function movingAverage(series, window = 3) {
  if (!Array.isArray(series) || !series.length) return [];
  const w = Math.max(1, window);
  return series.map((_, i) => {
    const start = Math.max(0, i - w + 1);
    const slice = series.slice(start, i + 1);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  });
}

/**
 * Expanding (cumulative) rolling average — the average of every point from the
 * start up to each index. Distinct from movingAverage's fixed trailing window:
 * this one only ever smooths out, never "forgets" old data, so it converges toward
 * the series' overall mean rather than tracking recent local shifts.
 * @param {number[]} series
 * @returns {number[]} same length as series
 */
function rollingAverage(series) {
  if (!Array.isArray(series) || !series.length) return [];
  let sum = 0;
  return series.map((v, i) => {
    sum += v;
    return sum / (i + 1);
  });
}

/**
 * Ordinary least-squares linear regression over arbitrary (x, y) points, plus R²
 * (coefficient of determination, 0-1) so a caller can judge how much to trust the
 * trend line — a low R² means the slope is a poor fit and shouldn't be used as a
 * confident forecast basis. Also returns `predict(x)` so a caller (predictionEngine.js's
 * capacity planning, which regresses against real concurrency values rather than
 * a 0,1,2... index) can evaluate the fitted line at any x, including extrapolated ones.
 * @param {number[]} xs
 * @param {number[]} ys
 * @returns {{slope:number, intercept:number, rSquared:number, direction:'up'|'down'|'flat', predict:(x:number)=>number}}
 */
function linearRegressionXY(xs, ys) {
  const n = Array.isArray(ys) ? ys.length : 0;
  if (n < 2) {
    const flat = n ? ys[0] : 0;
    return { slope: 0, intercept: flat, rSquared: 0, direction: 'flat', predict: () => flat };
  }

  const xMean = xs.reduce((a, b) => a + b, 0) / n;
  const yMean = ys.reduce((a, b) => a + b, 0) / n;

  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - xMean) * (ys[i] - yMean);
    den += (xs[i] - xMean) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const intercept = yMean - slope * xMean;

  let ssTot = 0, ssRes = 0;
  for (let i = 0; i < n; i++) {
    const predicted = slope * xs[i] + intercept;
    ssRes += (ys[i] - predicted) ** 2;
    ssTot += (ys[i] - yMean) ** 2;
  }
  const rSquared = ssTot === 0 ? (ssRes === 0 ? 1 : 0) : Math.max(0, 1 - ssRes / ssTot);

  // "Flat" is judged on the TOTAL predicted change across the observed x-range, not
  // the raw per-unit slope — a per-unit-x threshold would misclassify a real trend
  // as flat whenever x isn't spaced 1 apart (e.g. run_vusers 100/250/500/750/1000:
  // a slope of ~0.02 error-rate-points-per-user looks tiny per unit, but multiplied
  // across a 900-user range it's a genuine ~20-point swing). Threshold is 5% of the
  // series' own mean magnitude (floor 0.01 to handle a near-zero mean without
  // dividing by ~0).
  const xRange = Math.max(...xs) - Math.min(...xs) || 1;
  const totalChange = slope * xRange;
  const flatBand = Math.max(0.01, Math.abs(yMean) * 0.05);
  const direction = Math.abs(totalChange) < flatBand ? 'flat' : (slope > 0 ? 'up' : 'down');

  return { slope, intercept, rSquared, direction, predict: x => slope * x + intercept };
}

/**
 * Convenience wrapper over linearRegressionXY for a plain series (x = index 0,1,2,...) —
 * the common case for trend charts across a run sequence, where "x" is just "which
 * execution in order," not a real independent variable.
 * @param {number[]} ys
 */
function linearRegression(ys) {
  return linearRegressionXY((ys || []).map((_, i) => i), ys);
}

/**
 * Simple exponential smoothing — each smoothed point blends the raw value with the
 * previous smoothed point (weight `alpha` on the new observation). Unlike moving/
 * rolling average, this naturally weights recent points more without a hard window
 * cutoff, and its last smoothed value is the standard one-step-ahead forecast.
 * @param {number[]} series
 * @param {number} [alpha=0.3] — 0-1, higher = more weight on recent points
 * @returns {{smoothed:number[], forecastNext:number}}
 */
function exponentialSmoothing(series, alpha = 0.3) {
  if (!Array.isArray(series) || !series.length) return { smoothed: [], forecastNext: null };
  const a = Math.max(0.01, Math.min(1, alpha));
  const smoothed = [series[0]];
  for (let i = 1; i < series.length; i++) {
    smoothed.push(a * series[i] + (1 - a) * smoothed[i - 1]);
  }
  return { smoothed, forecastNext: smoothed[smoothed.length - 1] };
}

/**
 * Flags points more than `threshold` standard deviations from the series mean.
 * Sensitive to the mean/stdev themselves being skewed by the very outliers it's
 * looking for — fine for a quick anomaly flag, not a robust estimator (iqrOutliers
 * is the more robust alternative for skewed/heavy-tailed series).
 * @param {number[]} series
 * @param {number} [threshold=2]
 * @returns {Array<{index:number, value:number, zScore:number, isOutlier:boolean}>}
 */
function zScoreOutliers(series, threshold = 2) {
  if (!Array.isArray(series) || series.length < 2) return (series || []).map((v, i) => ({ index: i, value: v, zScore: 0, isOutlier: false }));
  const mean = series.reduce((a, b) => a + b, 0) / series.length;
  const variance = series.reduce((s, v) => s + (v - mean) ** 2, 0) / series.length;
  const stdev = Math.sqrt(variance);
  return series.map((v, i) => {
    const zScore = stdev === 0 ? 0 : (v - mean) / stdev;
    return { index: i, value: v, zScore: Math.round(zScore * 100) / 100, isOutlier: Math.abs(zScore) >= threshold };
  });
}

/**
 * Flags points outside [Q1 − 1.5·IQR, Q3 + 1.5·IQR] (Tukey's fences) — robust to a
 * few extreme values skewing the mean/stdev the way zScoreOutliers can be.
 * @param {number[]} series
 * @returns {Array<{index:number, value:number, isOutlier:boolean}>}
 */
function iqrOutliers(series) {
  if (!Array.isArray(series) || series.length < 4) return (series || []).map((v, i) => ({ index: i, value: v, isOutlier: false }));
  const sorted = [...series].sort((a, b) => a - b);
  const q = p => sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1))];
  const q1 = q(0.25), q3 = q(0.75);
  const iqr = q3 - q1;
  const lower = q1 - 1.5 * iqr, upper = q3 + 1.5 * iqr;
  return series.map((v, i) => ({ index: i, value: v, isOutlier: v < lower || v > upper }));
}

/**
 * Lightweight autocorrelation-based seasonality heuristic — checks whether the
 * series correlates with a lagged copy of itself at any lag from 2 up to n/2, which
 * is what a repeating pattern (e.g. "every 4th execution regresses") looks like.
 * Not a full spectral/FFT analysis — a lag with correlation ≥ 0.6 is reported as
 * the likely period; below that, nothing is confidently periodic.
 * @param {number[]} series
 * @param {number} [maxLag=10]
 * @returns {{detected:boolean, period:number|null, correlation:number}}
 */
function detectSeasonality(series, maxLag = 10) {
  const n = Array.isArray(series) ? series.length : 0;
  const upperLag = Math.min(maxLag, Math.floor(n / 2));
  if (n < 6 || upperLag < 2) return { detected: false, period: null, correlation: 0 };

  const mean = series.reduce((a, b) => a + b, 0) / n;
  const variance = series.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  if (variance === 0) return { detected: false, period: null, correlation: 0 };

  let bestLag = null, bestCorr = 0;
  for (let lag = 2; lag <= upperLag; lag++) {
    let cov = 0;
    for (let i = lag; i < n; i++) cov += (series[i] - mean) * (series[i - lag] - mean);
    cov /= (n - lag);
    const corr = cov / variance;
    if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
  }

  return { detected: bestCorr >= 0.6, period: bestCorr >= 0.6 ? bestLag : null, correlation: Math.round(bestCorr * 100) / 100 };
}

module.exports = {
  movingAverage, rollingAverage,
  linearRegression, linearRegressionXY,
  exponentialSmoothing, zScoreOutliers, iqrOutliers, detectSeasonality,
};
