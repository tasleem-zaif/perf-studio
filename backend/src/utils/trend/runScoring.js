'use strict';
// Shared per-run scoring/comparison helpers — factored out of routes/trendAnalysis.js
// so the same "6 scores for a run" and "baseline-vs-latest comparison" logic can be
// called both by the Trend Analysis dashboard routes and by emailUtils.js (execution
// report alert's Trend Analysis section), without either duplicating the other.
const db = require('../../db');
const metricsStore = require('./metricsStore');
const scoringEngine = require('./scoringEngine');
const { compareRuns } = require('./comparisonEngine');
const { linearRegression } = require('./statsEngine');

/** The immediately preceding run for the same suite (or same project if suite-less). */
async function getPreviousRun(projectId, run) {
  const clause = run.suite_id
    ? 'project_id = ? AND suite_id = ? AND started_at < ? AND result_dir IS NOT NULL'
    : 'project_id = ? AND suite_id IS NULL AND started_at < ? AND result_dir IS NOT NULL';
  const params = run.suite_id ? [projectId, run.suite_id, run.started_at] : [projectId, run.started_at];
  return db.prepare(`SELECT * FROM execution_runs WHERE ${clause} ORDER BY started_at DESC LIMIT 1`).get(...params);
}

/** {run_vusers, avg, error_rate} for every run of this suite that has a known concurrency level — Scalability Score's input. */
async function getScalabilityHistoryPoints(projectId, run) {
  const clause = run.suite_id
    ? 'project_id = ? AND suite_id = ? AND run_vusers IS NOT NULL AND result_dir IS NOT NULL'
    : 'project_id = ? AND suite_id IS NULL AND run_vusers IS NOT NULL AND result_dir IS NOT NULL';
  const params = run.suite_id ? [projectId, run.suite_id] : [projectId];
  const rows = await db.prepare(`SELECT * FROM execution_runs WHERE ${clause} ORDER BY started_at ASC`).all(...params);

  const points = [];
  for (const r of rows) {
    const parsed = await metricsStore.getOrBuildReportData(r);
    if (!parsed?.summary) continue;
    points.push({ run_vusers: r.run_vusers, avg: parsed.summary.avg_response_time, error_rate: parsed.summary.error_rate, tps: parsed.summary.overall_tps });
  }
  return points;
}

/** Computes all 6 scores for one run and upserts them into trend_scores. */
async function computeScoresForRun(projectId, run) {
  await metricsStore.ensureRunApiMetrics(run);
  const apiMetrics = await metricsStore.getApiMetricsForRun(run.id);
  const reportData = await metricsStore.getOrBuildReportData(run);
  const summary = reportData?.summary || null;

  const apiHealth = scoringEngine.computeApiHealthScore(apiMetrics);
  const appHealth = scoringEngine.computeApplicationHealthScore(apiHealth, summary);

  const prevRun = await getPreviousRun(projectId, run);
  let comparisonResult = null;
  if (prevRun) {
    await metricsStore.ensureRunApiMetrics(prevRun);
    const prevApis = await metricsStore.getApiMetricsForRun(prevRun.id);
    comparisonResult = compareRuns(prevApis, apiMetrics);
  }
  const regression = scoringEngine.computeRegressionScore(comparisonResult);
  const reliability = scoringEngine.computeReliabilityScore(summary);

  const historicalPoints = await getScalabilityHistoryPoints(projectId, run);
  const scalability = scoringEngine.computeScalabilityScore(historicalPoints, linearRegression);

  const overall = scoringEngine.computeOverallScore({ apiHealth, appHealth, regression, reliability, scalability });

  await db.prepare(`
    INSERT INTO trend_scores (run_id, project_id, api_health_score, app_health_score, regression_score, reliability_score, scalability_score, overall_score, formula_version, details_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (run_id) DO UPDATE SET
      api_health_score = EXCLUDED.api_health_score, app_health_score = EXCLUDED.app_health_score,
      regression_score = EXCLUDED.regression_score, reliability_score = EXCLUDED.reliability_score,
      scalability_score = EXCLUDED.scalability_score, overall_score = EXCLUDED.overall_score,
      formula_version = EXCLUDED.formula_version, details_json = EXCLUDED.details_json, computed_at = NOW()
  `).run(
    run.id, projectId, apiHealth.value, appHealth.value, regression.value, reliability.value, scalability.value, overall.value,
    scoringEngine.FORMULA_VERSION, JSON.stringify({ apiHealth, appHealth, regression, reliability, scalability, overall }),
  );

  return { runId: run.id, apiHealth, appHealth, regression, reliability, scalability, overall };
}

/**
 * Fetches execution_runs rows for the given ids, scoped to the project, chronological order.
 */
async function resolveOwnedRuns(projectId, ids) {
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db.prepare(
    `SELECT * FROM execution_runs WHERE project_id = ? AND id IN (${placeholders}) ORDER BY started_at ASC`
  ).all(projectId, ...ids);
}

/**
 * Baseline (chronologically earliest) vs latest (most recent) classification for a
 * set of runs — the shared core of POST /compare, GET /insights, and the email
 * Trend Analysis section. Cached in trend_comparisons keyed on project + sorted
 * run_ids, since a finished run's persisted metrics never change once computed.
 * @returns {Promise<{cached:boolean, comparisonId:number, baselineRunId, latestRunId, comparedRunIds, improved, regressed, new, removed, stable, formula}|null>}
 *   null if fewer than 2 of the given ids resolve to real runs in this project.
 */
async function resolveComparison(projectId, ids, userId) {
  const sortedIds = [...new Set(ids)].sort((a, b) => a - b);
  if (sortedIds.length < 2) return null;

  const cached = await db.prepare(
    'SELECT * FROM trend_comparisons WHERE project_id = ? AND run_ids = ? ORDER BY created_at DESC LIMIT 1'
  ).get(projectId, sortedIds);
  if (cached) return { cached: true, comparisonId: cached.id, ...JSON.parse(cached.summary_json) };

  const runs = await resolveOwnedRuns(projectId, sortedIds);
  if (runs.length < 2) return null;

  const baselineRun = runs[0];
  const latestRun = runs[runs.length - 1];
  await metricsStore.ensureRunApiMetrics(baselineRun);
  await metricsStore.ensureRunApiMetrics(latestRun);
  const baselineApis = await metricsStore.getApiMetricsForRun(baselineRun.id);
  const latestApis = await metricsStore.getApiMetricsForRun(latestRun.id);

  const result = compareRuns(baselineApis, latestApis);
  const summary = { baselineRunId: baselineRun.id, latestRunId: latestRun.id, comparedRunIds: runs.map(r => r.id), ...result };

  const comparisonType = sortedIds.length === 2 ? 'baseline_vs_latest' : 'multi_run';
  const inserted = await db.prepare(
    'INSERT INTO trend_comparisons (project_id, run_ids, comparison_type, summary_json, created_by) VALUES (?, ?, ?, ?, ?)'
  ).run(projectId, sortedIds, comparisonType, JSON.stringify(summary), userId);

  return { cached: false, comparisonId: inserted.lastInsertRowid, ...summary };
}

module.exports = { getPreviousRun, getScalabilityHistoryPoints, computeScoresForRun, resolveOwnedRuns, resolveComparison };
