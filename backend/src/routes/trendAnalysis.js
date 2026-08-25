'use strict';
// Trend Analysis Dashboard — Phase 1: run discovery/filtering/selection + run metadata
// tagging. Mounted at /api/projects/:projectId/trend-analysis (index.js), following the
// same project-scoped router convention as rules.js/execution.js.
//
// Later phases add comparison/trend/scoring/insights/RCA/recommendations/capacity/export
// endpoints on this same router — see PROJECT_MAP.md / the Trend Analysis plan for the
// full roadmap. Phase 1 deliberately ships only run selection, since every later phase
// operates on a set of run ids this endpoint produces.

const router = require('express').Router({ mergeParams: true });
const db = require('../db');
const auth = require('../middleware/auth');
const ownsProject = require('../utils/ownsProject');
const metricsStore = require('../utils/trend/metricsStore');
const statsEngine = require('../utils/trend/statsEngine');
const { movingAverage, rollingAverage, linearRegression } = statsEngine;
const { getScalabilityHistoryPoints, computeScoresForRun, resolveOwnedRuns, resolveComparison } = require('../utils/trend/runScoring');
const { generateInsights } = require('../utils/trend/insightsEngine');
const { diagnoseRootCause, buildRecommendations, narrateWithAi } = require('../utils/trend/recommendationEngine');
const { generateExecutiveSummary } = require('../utils/trend/aiSummaryEngine');
const predictionEngine = require('../utils/trend/predictionEngine');
const { generateTrendAnalysisPdf } = require('../utils/trend/exportEngine');

router.use(auth);

// NOTE: 'environment' is deliberately NOT one of these. The app already has a real,
// always-populated environment concept — test_suites.env (QA/UAT/Staging/Production,
// the same one EnvBar/Analytics.jsx use) — so "Environment" filters on `suite_env`
// below, not a separate manually-tagged column. Tagging a second, always-empty
// "environment" field here would silently diverge from what every other page in the
// app means by "environment" (this was a real bug: switching QA/UAT in EnvBar used
// to filter on the untagged column and zero real runs ever matched).
const METADATA_FIELDS = ['build_number', 'release_tag', 'browser', 'load_profile'];

// Builds a `WHERE ...` fragment (without the leading WHERE) + matching param array for the
// optional run-metadata filters shared by every selector mode below. Always scoped to the
// project and to non-archived runs (mirrors execution.js's /runs default).
function buildFilters(projectId, query, { includeArchived }) {
  const clauses = ['r.project_id = ?'];
  const params = [projectId];

  if (!includeArchived) clauses.push('(r.archived = 0 OR r.archived IS NULL)');

  for (const field of METADATA_FIELDS) {
    if (query[field]) {
      clauses.push(`r.${field} = ?`);
      params.push(query[field]);
    }
  }
  if (query.suite_env) {
    clauses.push('s.env = ?');
    params.push(query.suite_env);
  }
  if (query.suite_id) {
    clauses.push('r.suite_id = ?');
    params.push(query.suite_id);
  }
  if (query.collection_id) {
    clauses.push('s.collection_id = ?');
    params.push(query.collection_id);
  }
  if (query.date_from) {
    clauses.push('r.started_at >= ?');
    params.push(query.date_from);
  }
  if (query.date_to) {
    clauses.push('r.started_at <= ?');
    params.push(query.date_to);
  }
  // Only runs that actually finished with results are meaningful for trend analysis —
  // a still-running or errored-before-any-JTL run has nothing to compare.
  clauses.push("r.result_dir IS NOT NULL");

  return { where: clauses.join(' AND '), params };
}

const RUN_SELECT = `
  SELECT r.*, s.name as suite_name, s.env as suite_env, s.collection_id as collection_id
  FROM execution_runs r
  LEFT JOIN test_suites s ON s.id = r.suite_id
`;

function serializeRun(r) {
  const { logs, report_data, ...rest } = r;
  return rest; // report_data/logs are large and irrelevant to run selection — trimmed from the list payload
}

/**
 * GET /runs — list/select runs for Trend Analysis.
 *
 * Filters (all optional, combinable): suite_env (Environment — test_suites.env, same
 * concept as EnvBar/Analytics.jsx), build_number, release_tag, browser, load_profile,
 * suite_id (Test Plan), collection_id, date_from, date_to, include_archived.
 *
 * Selector modes (mutually exclusive, inferred from which params are present):
 *   - run_ids=1,2,3         → exactly those runs (still subject to the filters above)
 *   - baseline=true          → { baseline: earliest match, latest: most recent match }
 *   - last_n=10              → the N most recent matches
 *   - (default)              → paginated list (page, limit; limit capped at 200)
 */
router.get('/runs', async (req, res) => {
  const projectId = req.params.projectId;
  if (!await ownsProject(req.userId, projectId)) return res.status(404).json({ error: 'Project not found' });

  const includeArchived = req.query.include_archived === 'true';
  const { where, params } = buildFilters(projectId, req.query, { includeArchived });

  try {
    if (req.query.run_ids) {
      const ids = req.query.run_ids.split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite);
      if (!ids.length) return res.json({ mode: 'run_ids', runs: [], total: 0 });
      const placeholders = ids.map(() => '?').join(',');
      const rows = await db.prepare(
        `${RUN_SELECT} WHERE ${where} AND r.id IN (${placeholders}) ORDER BY r.started_at ASC`
      ).all(...params, ...ids);
      return res.json({ mode: 'run_ids', runs: rows.map(serializeRun), total: rows.length });
    }

    if (req.query.baseline === 'true') {
      const earliest = await db.prepare(`${RUN_SELECT} WHERE ${where} ORDER BY r.started_at ASC LIMIT 1`).get(...params);
      const latest = await db.prepare(`${RUN_SELECT} WHERE ${where} ORDER BY r.started_at DESC LIMIT 1`).get(...params);
      const runs = [earliest, latest].filter(Boolean).filter((r, i, arr) => arr.findIndex(x => x.id === r.id) === i);
      return res.json({
        mode: 'baseline_vs_latest',
        baseline: earliest ? serializeRun(earliest) : null,
        latest: latest ? serializeRun(latest) : null,
        runs: runs.map(serializeRun),
        total: runs.length,
      });
    }

    if (req.query.last_n) {
      const n = Math.max(1, Math.min(1000, parseInt(req.query.last_n, 10) || 10));
      const rows = await db.prepare(`${RUN_SELECT} WHERE ${where} ORDER BY r.started_at DESC LIMIT ?`).all(...params, n);
      return res.json({ mode: 'last_n', runs: rows.map(serializeRun), total: rows.length });
    }

    // Default: paginated custom-range / plain filtered list.
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const offset = (page - 1) * limit;

    const countRow = await db.prepare(
      `SELECT COUNT(*) as total FROM execution_runs r LEFT JOIN test_suites s ON s.id = r.suite_id WHERE ${where}`
    ).get(...params);
    const rows = await db.prepare(
      `${RUN_SELECT} WHERE ${where} ORDER BY r.started_at DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset);

    res.json({
      mode: req.query.date_from || req.query.date_to ? 'custom_range' : 'list',
      runs: rows.map(serializeRun),
      total: parseInt(countRow?.total, 10) || 0,
      page,
      limit,
    });
  } catch (err) {
    console.error('[trend-analysis] GET /runs failed:', err.message);
    res.status(500).json({ error: 'Failed to list runs for trend analysis' });
  }
});

/**
 * GET /runs/filter-options — distinct values currently in use for each metadata filter,
 * scoped to the project, so the frontend's filter dropdowns only ever show real options
 * instead of a hardcoded guess list.
 */
router.get('/runs/filter-options', async (req, res) => {
  const projectId = req.params.projectId;
  if (!await ownsProject(req.userId, projectId)) return res.status(404).json({ error: 'Project not found' });

  try {
    const options = {};
    for (const field of METADATA_FIELDS) {
      const rows = await db.prepare(
        `SELECT DISTINCT ${field} as value FROM execution_runs WHERE project_id = ? AND ${field} IS NOT NULL ORDER BY ${field}`
      ).all(projectId);
      options[field] = rows.map(r => r.value);
    }
    // "environment" options come from test_suites.env (the real, always-populated
    // environment concept — see the METADATA_FIELDS comment above), not a tagged column.
    const envRows = await db.prepare(
      "SELECT DISTINCT env as value FROM test_suites WHERE project_id = ? AND user_id = ? AND env IS NOT NULL AND env != '' ORDER BY env"
    ).all(projectId, req.userId);
    options.environment = envRows.map(r => r.value);

    const suites = await db.prepare(
      'SELECT id, name FROM test_suites WHERE project_id = ? AND user_id = ? ORDER BY name'
    ).all(projectId, req.userId);
    options.test_plans = suites;
    res.json(options);
  } catch (err) {
    console.error('[trend-analysis] GET /runs/filter-options failed:', err.message);
    res.status(500).json({ error: 'Failed to load filter options' });
  }
});

/**
 * PATCH /runs/:id/metadata — tag a run with build_number/release_tag/browser/load_profile.
 * ("environment" is not taggable here — it's test_suites.env, already set when the run's
 * suite/collection env was chosen.) Nothing else in the app sets these fields; this is
 * the only write path. Accepts a partial body — only provided fields are updated.
 */
router.patch('/runs/:id/metadata', async (req, res) => {
  const projectId = req.params.projectId;
  if (!await ownsProject(req.userId, projectId)) return res.status(404).json({ error: 'Project not found' });

  const run = await db.prepare('SELECT id FROM execution_runs WHERE id = ? AND project_id = ?').get(req.params.id, projectId);
  if (!run) return res.status(404).json({ error: 'Run not found' });

  const updates = [];
  const params = [];
  for (const field of METADATA_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, field)) {
      updates.push(`${field} = ?`);
      params.push(req.body[field] === '' ? null : req.body[field]);
    }
  }
  if (!updates.length) return res.status(400).json({ error: `No recognized field provided. Expected one or more of: ${METADATA_FIELDS.join(', ')}` });

  params.push(req.params.id);
  try {
    await db.prepare(`UPDATE execution_runs SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    const updated = await db.prepare('SELECT * FROM execution_runs WHERE id = ?').get(req.params.id);
    res.json({ run: serializeRun(updated) });
  } catch (err) {
    console.error('[trend-analysis] PATCH /runs/:id/metadata failed:', err.message);
    res.status(500).json({ error: 'Failed to update run metadata' });
  }
});

// ── Phase 2: Comparison Engine + Trend Charts ────────────────────────────────────

function parseIds(csv) {
  if (!csv) return [];
  return String(csv).split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite);
}

/**
 * GET /apis?run_ids=1,2,3 — distinct API labels seen across the given runs, for
 * populating a "scope" dropdown (trend drill-down, comparison context).
 */
router.get('/apis', async (req, res) => {
  const projectId = req.params.projectId;
  if (!await ownsProject(req.userId, projectId)) return res.status(404).json({ error: 'Project not found' });

  const ids = parseIds(req.query.run_ids);
  if (!ids.length) return res.status(400).json({ error: 'run_ids is required' });

  try {
    const runs = await resolveOwnedRuns(projectId, ids);
    if (!runs.length) return res.json({ labels: [] });
    for (const run of runs) await metricsStore.ensureRunApiMetrics(run);
    const metrics = await metricsStore.getApiMetricsAcrossRuns(runs.map(r => r.id));
    res.json({ labels: [...new Set(metrics.map(m => m.label))].sort() });
  } catch (err) {
    console.error('[trend-analysis] GET /apis failed:', err.message);
    res.status(500).json({ error: 'Failed to list APIs for the selected runs' });
  }
});

/**
 * Chronological {run_id, started_at, avg, p90, p95, tps, error_rate} points for a
 * scope ('__overall__' or one API label) across the given (already time-ordered)
 * runs — the shared data assembly behind both GET /trend and GET /forecast, so
 * "what's this metric's value per run for this scope" is computed in one place.
 */
async function buildMetricSeriesPoints(runs, scope) {
  const points = [];
  if (scope === '__overall__') {
    for (const run of runs) {
      const parsed = await metricsStore.getOrBuildReportData(run);
      if (!parsed?.summary) continue;
      points.push({
        run_id: run.id, started_at: run.started_at,
        avg: parsed.summary.avg_response_time, p90: parsed.summary.p90, p95: parsed.summary.p95,
        tps: parsed.summary.overall_tps, error_rate: parsed.summary.error_rate,
      });
    }
  } else {
    for (const run of runs) await metricsStore.ensureRunApiMetrics(run);
    const metrics = await metricsStore.getApiMetricsAcrossRuns(runs.map(r => r.id));
    const byRun = new Map(metrics.filter(m => m.label === scope).map(m => [m.run_id, m]));
    for (const run of runs) {
      const m = byRun.get(run.id);
      if (!m) continue;
      points.push({ run_id: run.id, started_at: run.started_at, avg: m.avg, p90: m.p90, p95: m.p95, tps: m.tps, error_rate: m.error_rate });
    }
  }
  return points;
}

/**
 * GET /trend?run_ids=1,2,3&scope=__overall__|<api label>&window=3
 * Time series across the given runs (chronological), plus a moving average (trailing
 * fixed window), a rolling average (expanding/cumulative), and a linear-regression
 * trend slope per metric — see statsEngine.js.
 */
router.get('/trend', async (req, res) => {
  const projectId = req.params.projectId;
  if (!await ownsProject(req.userId, projectId)) return res.status(404).json({ error: 'Project not found' });

  const ids = parseIds(req.query.run_ids);
  if (ids.length < 2) return res.status(400).json({ error: 'At least 2 run_ids are required to plot a trend' });
  const scope = req.query.scope || '__overall__';
  const window = Math.max(1, Math.min(20, parseInt(req.query.window, 10) || 3));

  try {
    const runs = await resolveOwnedRuns(projectId, ids);
    if (runs.length < 2) return res.status(404).json({ error: 'One or more runs were not found in this project' });

    const points = await buildMetricSeriesPoints(runs, scope);

    if (!points.length) {
      return res.status(404).json({
        error: scope === '__overall__'
          ? 'No report data available for the selected runs'
          : `No metrics found for API "${scope}" in the selected runs`,
      });
    }

    const metricKeys = ['avg', 'p90', 'p95', 'tps', 'error_rate'];
    const series = {}, movingAvg = {}, rollingAvg = {}, regression = {};
    for (const key of metricKeys) {
      const values = points.map(p => p[key] ?? 0);
      series[key] = values;
      movingAvg[key] = movingAverage(values, window);
      rollingAvg[key] = rollingAverage(values);
      regression[key] = linearRegression(values);
    }

    res.json({
      scope,
      runs: points.map(p => ({ run_id: p.run_id, started_at: p.started_at })),
      series, movingAverage: movingAvg, rollingAverage: rollingAvg, regression,
      window,
    });
  } catch (err) {
    console.error('[trend-analysis] GET /trend failed:', err.message);
    res.status(500).json({ error: 'Failed to compute trend' });
  }
});

/**
 * POST /compare — { runIds: [...] } → improved/regressed/new/removed/stable
 * classification between the chronologically earliest (baseline) and most recent
 * (latest) of the selected runs (see comparisonEngine.js for the formula).
 */
router.post('/compare', async (req, res) => {
  const projectId = req.params.projectId;
  if (!await ownsProject(req.userId, projectId)) return res.status(404).json({ error: 'Project not found' });

  const ids = Array.isArray(req.body?.runIds) ? req.body.runIds.map(Number).filter(Number.isFinite) : [];
  if (ids.length < 2) return res.status(400).json({ error: 'At least 2 runIds are required to compare' });

  try {
    const result = await resolveComparison(projectId, ids, req.userId);
    if (!result) return res.status(404).json({ error: 'One or more runs were not found in this project' });
    res.json(result);
  } catch (err) {
    console.error('[trend-analysis] POST /compare failed:', err.message);
    res.status(500).json({ error: 'Failed to compare runs' });
  }
});

// ── Phase 3: Scoring + Insights ───────────────────────────────────────────────────
// getPreviousRun/getScalabilityHistoryPoints/computeScoresForRun/resolveComparison
// now live in utils/trend/runScoring.js (shared with emailUtils.js's Trend Analysis
// email section) — imported above.

/**
 * GET /scores?run_ids=1,2,3 — computes (and persists to trend_scores) the six
 * weighted scores for each given run. See scoringEngine.js for every formula.
 */
router.get('/scores', async (req, res) => {
  const projectId = req.params.projectId;
  if (!await ownsProject(req.userId, projectId)) return res.status(404).json({ error: 'Project not found' });

  const ids = parseIds(req.query.run_ids);
  if (!ids.length) return res.status(400).json({ error: 'run_ids is required' });

  try {
    const runs = await resolveOwnedRuns(projectId, ids);
    if (!runs.length) return res.status(404).json({ error: 'No matching runs found in this project' });

    const scores = [];
    for (const run of runs) scores.push(await computeScoresForRun(projectId, run));
    res.json({ scores });
  } catch (err) {
    console.error('[trend-analysis] GET /scores failed:', err.message);
    res.status(500).json({ error: 'Failed to compute scores' });
  }
});

/**
 * Assembles everything GET /insights (and GET /export-pdf) need beyond the
 * comparison itself: baseline/latest overall summaries, and full-history series
 * (per-API and overall) tagged with build/release for boundary-shift detection.
 * Factored out so the PDF export doesn't duplicate this data assembly.
 */
async function assembleInsightsContext(projectId, runs, userId) {
  const baseline = runs[0];
  const latest = runs[runs.length - 1];
  const baselineSummary = (await metricsStore.getOrBuildReportData(baseline))?.summary || null;
  const latestSummary = (await metricsStore.getOrBuildReportData(latest))?.summary || null;

  const comparisonResult = await resolveComparison(projectId, runs.map(r => r.id), userId);

  for (const run of runs) await metricsStore.ensureRunApiMetrics(run);
  const allApiMetrics = await metricsStore.getApiMetricsAcrossRuns(runs.map(r => r.id));

  const perApiHistory = new Map();
  const overallHistory = [];
  for (const run of runs) {
    for (const m of allApiMetrics.filter(a => a.run_id === run.id)) {
      if (!perApiHistory.has(m.label)) perApiHistory.set(m.label, []);
      perApiHistory.get(m.label).push({ avg: m.avg, error_rate: m.error_rate, build_number: run.build_number, release_tag: run.release_tag });
    }
    const parsed = await metricsStore.getOrBuildReportData(run);
    if (parsed?.summary) {
      overallHistory.push({ avg: parsed.summary.avg_response_time, error_rate: parsed.summary.error_rate, build_number: run.build_number, release_tag: run.release_tag });
    }
  }

  return { baseline, latest, baselineSummary, latestSummary, comparisonResult, perApiHistory, overallHistory };
}

/**
 * GET /insights?run_ids=1,2,3,4,5 — deterministic, threshold-based plain-English
 * bullets for the given (chronologically ordered) run set: overall/per-API metric
 * deltas, consecutive degradation/improvement streaks, and build/release boundary
 * shifts. Persisted to trend_insights, scoped to the underlying comparison (or the
 * latest run if fewer than 2 runs resolve to a cacheable comparison).
 */
router.get('/insights', async (req, res) => {
  const projectId = req.params.projectId;
  if (!await ownsProject(req.userId, projectId)) return res.status(404).json({ error: 'Project not found' });

  const ids = parseIds(req.query.run_ids);
  if (ids.length < 2) return res.json({ insights: [] });

  try {
    const runs = await resolveOwnedRuns(projectId, ids);
    if (runs.length < 2) return res.status(404).json({ error: 'One or more runs were not found in this project' });

    const ctx = await assembleInsightsContext(projectId, runs, req.userId);
    const { latest, baselineSummary, latestSummary, comparisonResult, perApiHistory, overallHistory } = ctx;

    const insights = generateInsights({
      overallBaseline: baselineSummary, overallLatest: latestSummary,
      comparison: comparisonResult, overallHistory, perApiHistory,
    });

    const scopeType = comparisonResult?.comparisonId ? 'comparison' : 'run';
    const scopeId = comparisonResult?.comparisonId ?? latest.id;
    await db.prepare('DELETE FROM trend_insights WHERE project_id = ? AND scope_type = ? AND scope_id = ?').run(projectId, scopeType, scopeId);
    for (const insight of insights) {
      await db.prepare(
        'INSERT INTO trend_insights (project_id, scope_type, scope_id, insight_type, severity, message, metric, delta_pct) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(projectId, scopeType, scopeId, insight.type, insight.severity, insight.message, insight.metric, insight.delta_pct);
    }

    res.json({ scopeType, scopeId, insights });
  } catch (err) {
    console.error('[trend-analysis] GET /insights failed:', err.message);
    res.status(500).json({ error: 'Failed to generate insights' });
  }
});

// ── Phase 4: RCA + AI Recommendations + AI Executive Summary ─────────────────────

/**
 * GET /rca?run_ids=1,2,3 — per-API root-cause breakdown for every API classified
 * "regressed" between the earliest and most recent of the given runs (see
 * recommendationEngine.js's diagnoseRootCause — connect/processing/transfer/
 * error-rate component analysis, no AI involved).
 */
router.get('/rca', async (req, res) => {
  const projectId = req.params.projectId;
  if (!await ownsProject(req.userId, projectId)) return res.status(404).json({ error: 'Project not found' });

  const ids = parseIds(req.query.run_ids);
  if (ids.length < 2) return res.status(400).json({ error: 'At least 2 run_ids are required' });

  try {
    const comparisonResult = await resolveComparison(projectId, ids, req.userId);
    if (!comparisonResult) return res.status(404).json({ error: 'One or more runs were not found in this project' });

    const rca = (comparisonResult.regressed || []).map(entry => ({
      scope: entry.label,
      deltas: entry.deltas,
      ...diagnoseRootCause(entry.baseline, entry.latest),
    }));

    res.json({ comparisonId: comparisonResult.comparisonId, baselineRunId: comparisonResult.baselineRunId, latestRunId: comparisonResult.latestRunId, rca });
  } catch (err) {
    console.error('[trend-analysis] GET /rca failed:', err.message);
    res.status(500).json({ error: 'Failed to compute root-cause analysis' });
  }
});

/**
 * GET /recommendations?run_ids=1,2,3 — ranked, actionable recommendations built
 * from the regressed APIs' RCA plus a capacity-planning note when Scalability Score
 * is low. Rule-based by default; automatically AI-narrated (wording only, never new
 * facts) when an AI provider is configured — falls back silently otherwise.
 * Persisted to trend_recommendations, scoped to the underlying comparison.
 */
router.get('/recommendations', async (req, res) => {
  const projectId = req.params.projectId;
  if (!await ownsProject(req.userId, projectId)) return res.status(404).json({ error: 'Project not found' });

  const ids = parseIds(req.query.run_ids);
  if (ids.length < 2) return res.status(400).json({ error: 'At least 2 run_ids are required' });

  try {
    const runs = await resolveOwnedRuns(projectId, ids);
    if (runs.length < 2) return res.status(404).json({ error: 'One or more runs were not found in this project' });

    const comparisonResult = await resolveComparison(projectId, ids, req.userId);
    if (!comparisonResult) return res.status(404).json({ error: 'One or more runs were not found in this project' });

    const latestRun = runs[runs.length - 1];
    const latestScores = await computeScoresForRun(projectId, latestRun);

    const { recommendations, truncated, totalCount, formulaVersion } = buildRecommendations(comparisonResult, latestScores);
    const narrated = await narrateWithAi(req.userId, recommendations);

    const scopeType = 'comparison';
    const scopeId = comparisonResult.comparisonId;
    await db.prepare('DELETE FROM trend_recommendations WHERE project_id = ? AND scope_type = ? AND scope_id = ?').run(projectId, scopeType, scopeId);
    for (const rec of narrated) {
      await db.prepare(`
        INSERT INTO trend_recommendations (project_id, scope_type, scope_id, category, priority, title, description, root_cause, confidence_pct, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(projectId, scopeType, scopeId, rec.category, rec.priority, rec.title, rec.description, rec.root_cause, rec.confidence_pct, rec.source);
    }

    res.json({ scopeType, scopeId, recommendations: narrated, truncated, totalCount, formulaVersion });
  } catch (err) {
    console.error('[trend-analysis] GET /recommendations failed:', err.message);
    res.status(500).json({ error: 'Failed to build recommendations' });
  }
});

/**
 * GET /ai-summary?run_ids=1,2,3 — plain-English executive summary of the
 * baseline-vs-latest comparison (see aiSummaryEngine.js). Cached as a trend_insights
 * row (insight_type='ai_executive_summary') scoped to the comparison, so repeat
 * views don't re-spend an AI call for identical input.
 */
router.get('/ai-summary', async (req, res) => {
  const projectId = req.params.projectId;
  if (!await ownsProject(req.userId, projectId)) return res.status(404).json({ error: 'Project not found' });

  const ids = parseIds(req.query.run_ids);
  if (ids.length < 2) return res.status(400).json({ error: 'At least 2 run_ids are required' });

  try {
    const runs = await resolveOwnedRuns(projectId, ids);
    if (runs.length < 2) return res.status(404).json({ error: 'One or more runs were not found in this project' });

    const comparisonResult = await resolveComparison(projectId, ids, req.userId);
    if (!comparisonResult) return res.status(404).json({ error: 'One or more runs were not found in this project' });

    const scopeType = 'comparison';
    const scopeId = comparisonResult.comparisonId;

    const cached = await db.prepare(
      "SELECT * FROM trend_insights WHERE project_id = ? AND scope_type = ? AND scope_id = ? AND insight_type = 'ai_executive_summary' LIMIT 1"
    ).get(projectId, scopeType, scopeId);
    if (cached) {
      // Older cached rows (before bullets were introduced) stored a plain string —
      // fall back to wrapping it as a single bullet rather than failing to parse.
      let parsedCache;
      try { parsedCache = JSON.parse(cached.message); } catch { parsedCache = { bullets: [cached.message], source: 'rule' }; }
      return res.json({ scopeType, scopeId, bullets: parsedCache.bullets, source: parsedCache.source, cached: true });
    }

    const baselineRun = runs.find(r => r.id === comparisonResult.baselineRunId) || runs[0];
    const latestRun = runs.find(r => r.id === comparisonResult.latestRunId) || runs[runs.length - 1];
    const baselineSummary = (await metricsStore.getOrBuildReportData(baselineRun))?.summary || null;
    const latestSummary = (await metricsStore.getOrBuildReportData(latestRun))?.summary || null;
    const baselineScores = await computeScoresForRun(projectId, baselineRun);
    const latestScores = await computeScoresForRun(projectId, latestRun);

    const healthyApis = [...(comparisonResult.stable || []), ...(comparisonResult.improved || [])]
      .filter(e => (e.latest?.error_rate || 0) < 5)
      .map(e => e.label);

    const worstRegression = (comparisonResult.regressed || [])[0];
    const topRegression = worstRegression
      ? { label: worstRegression.label, ...diagnoseRootCause(worstRegression.baseline, worstRegression.latest) }
      : null;

    const summary = await generateExecutiveSummary(req.userId, {
      avgBaselineMs: baselineSummary?.avg_response_time, avgLatestMs: latestSummary?.avg_response_time,
      scoreBaseline: baselineScores.overall.value, scoreLatest: latestScores.overall.value,
      healthyApis, topRegression,
    });

    await db.prepare(
      "INSERT INTO trend_insights (project_id, scope_type, scope_id, insight_type, severity, message) VALUES (?, ?, ?, 'ai_executive_summary', 'info', ?)"
    ).run(projectId, scopeType, scopeId, JSON.stringify({ bullets: summary.bullets, source: summary.source }));

    res.json({ scopeType, scopeId, bullets: summary.bullets, source: summary.source, cached: false });
  } catch (err) {
    console.error('[trend-analysis] GET /ai-summary failed:', err.message);
    res.status(500).json({ error: 'Failed to generate executive summary' });
  }
});

// ── Phase 5: Capacity Planning + Forecasting ──────────────────────────────────────

/**
 * GET /capacity-planning?run_id=34 — estimates max stable/recommended/breaking-point
 * users and projected RT/TPS/error-rate at those loads, from this run's suite's own
 * execution history at different concurrency levels (see predictionEngine.js's
 * estimateCapacity). Persists each estimate as a row in trend_predictions
 * (scope=`suite:<id>`) so the estimate's evolution over time is itself queryable.
 */
router.get('/capacity-planning', async (req, res) => {
  const projectId = req.params.projectId;
  if (!await ownsProject(req.userId, projectId)) return res.status(404).json({ error: 'Project not found' });

  const runId = parseInt(req.query.run_id, 10);
  if (!Number.isFinite(runId)) return res.status(400).json({ error: 'run_id is required' });

  try {
    const run = await db.prepare('SELECT * FROM execution_runs WHERE id = ? AND project_id = ?').get(runId, projectId);
    if (!run) return res.status(404).json({ error: 'Run not found' });

    const historicalPoints = await getScalabilityHistoryPoints(projectId, run);
    const capacity = predictionEngine.estimateCapacity(historicalPoints, statsEngine);

    if (!capacity.insufficientData) {
      const scope = `suite:${run.suite_id ?? 'none'}`;
      const metrics = [
        ['max_stable_users', capacity.maxStableUsers],
        ['recommended_users', capacity.recommendedUsers],
        ['breaking_point_users', capacity.breakingPointUsers],
      ];
      await db.prepare("DELETE FROM trend_predictions WHERE project_id = ? AND scope = ? AND algorithm = 'capacity_estimate'").run(projectId, scope);
      for (const [predicted_metric, predicted_value] of metrics) {
        if (predicted_value === null || predicted_value === undefined) continue;
        await db.prepare(`
          INSERT INTO trend_predictions (project_id, scope, algorithm, horizon, predicted_metric, predicted_value, confidence_pct)
          VALUES (?, ?, 'capacity_estimate', NULL, ?, ?, ?)
        `).run(projectId, scope, predicted_metric, predicted_value, capacity.confidencePct);
      }
    }

    res.json({ runId, suiteId: run.suite_id, capacity });
  } catch (err) {
    console.error('[trend-analysis] GET /capacity-planning failed:', err.message);
    res.status(500).json({ error: 'Failed to estimate capacity' });
  }
});

/**
 * GET /forecast?run_ids=1,2,3&scope=__overall__|<api label>&metric=avg&alpha=0.3
 * Forecasts the next execution's value for one metric (linear regression +
 * exponential smoothing, see predictionEngine.js), plus anomaly/outlier flags
 * (z-score and IQR) and a lightweight seasonality check over the same series.
 * The two forecast values are persisted to trend_predictions (scope + metric +
 * algorithm), replacing any prior forecast for the same scope/metric.
 */
router.get('/forecast', async (req, res) => {
  const projectId = req.params.projectId;
  if (!await ownsProject(req.userId, projectId)) return res.status(404).json({ error: 'Project not found' });

  const ids = parseIds(req.query.run_ids);
  if (ids.length < 2) return res.status(400).json({ error: 'At least 2 run_ids are required to forecast' });
  const scope = req.query.scope || '__overall__';
  const metric = ['avg', 'p90', 'p95', 'tps', 'error_rate'].includes(req.query.metric) ? req.query.metric : 'avg';
  const alpha = req.query.alpha ? Math.max(0.05, Math.min(1, parseFloat(req.query.alpha))) : undefined;

  try {
    const runs = await resolveOwnedRuns(projectId, ids);
    if (runs.length < 2) return res.status(404).json({ error: 'One or more runs were not found in this project' });

    const points = await buildMetricSeriesPoints(runs, scope);
    if (points.length < 2) {
      return res.status(404).json({
        error: scope === '__overall__' ? 'No report data available for the selected runs' : `No metrics found for API "${scope}" in the selected runs`,
      });
    }

    const values = points.map(p => p[metric] ?? 0);
    const forecast = predictionEngine.forecastNextExecution(values, statsEngine, { alpha });
    const anomalies = {
      zScore: statsEngine.zScoreOutliers(values).filter(a => a.isOutlier),
      iqr: statsEngine.iqrOutliers(values).filter(a => a.isOutlier),
    };
    const seasonality = statsEngine.detectSeasonality(values);

    if (!forecast.insufficientData) {
      await db.prepare("DELETE FROM trend_predictions WHERE project_id = ? AND scope = ? AND predicted_metric = ? AND horizon = 'next_execution'").run(projectId, scope, metric);
      await db.prepare(`
        INSERT INTO trend_predictions (project_id, scope, algorithm, horizon, predicted_metric, predicted_value, confidence_pct)
        VALUES (?, ?, 'linear_regression', 'next_execution', ?, ?, ?)
      `).run(projectId, scope, metric, forecast.linearForecast, forecast.confidencePct);
      await db.prepare(`
        INSERT INTO trend_predictions (project_id, scope, algorithm, horizon, predicted_metric, predicted_value, confidence_pct)
        VALUES (?, ?, 'exponential_smoothing', 'next_execution', ?, ?, ?)
      `).run(projectId, scope, metric, forecast.exponentialSmoothingForecast, forecast.confidencePct);
    }

    res.json({
      scope, metric,
      runs: points.map(p => ({ run_id: p.run_id, started_at: p.started_at })),
      series: values,
      forecast, anomalies, seasonality,
    });
  } catch (err) {
    console.error('[trend-analysis] GET /forecast failed:', err.message);
    res.status(500).json({ error: 'Failed to compute forecast' });
  }
});

// ── Phase 6: PDF Export ───────────────────────────────────────────────────────────

function pctChangeLocal(from, to) {
  if (!from || from === 0) return to > 0 ? 100 : 0;
  return ((to - from) / from) * 100;
}
function getRunLabelServer(run) {
  const base = run.result_dir ? run.result_dir.split(/[\\/]/).pop() : null;
  return base || `Run_${run.id}`;
}

/**
 * GET /export-pdf?run_ids=1,2,3,4 — a multi-page Trend Analysis report (executive
 * summary, scores, comparison, insights/recommendations, trend charts, capacity
 * planning) covering the baseline (earliest) through latest of the given runs.
 * Assembles the exact same data every other endpoint on this router computes —
 * nothing new is calculated here, this just packages it as a PDF (exportEngine.js).
 */
router.get('/export-pdf', async (req, res) => {
  const projectId = req.params.projectId;
  if (!await ownsProject(req.userId, projectId)) return res.status(404).json({ error: 'Project not found' });

  const ids = parseIds(req.query.run_ids);
  if (ids.length < 2) return res.status(400).json({ error: 'At least 2 run_ids are required to export a trend report' });

  try {
    const runs = await resolveOwnedRuns(projectId, ids);
    if (runs.length < 2) return res.status(404).json({ error: 'One or more runs were not found in this project' });

    const baselineRun = runs[0];
    const latestRun = runs[runs.length - 1];

    const ctx = await assembleInsightsContext(projectId, runs, req.userId);
    const comparisonResult = ctx.comparisonResult;
    const insights = generateInsights({
      overallBaseline: ctx.baselineSummary, overallLatest: ctx.latestSummary,
      comparison: comparisonResult, overallHistory: ctx.overallHistory, perApiHistory: ctx.perApiHistory,
    });

    const baselineScores = await computeScoresForRun(projectId, baselineRun);
    const latestScores = await computeScoresForRun(projectId, latestRun);

    const built = buildRecommendations(comparisonResult, latestScores);
    const narratedRecommendations = await narrateWithAi(req.userId, built.recommendations);

    const healthyApis = [...(comparisonResult.stable || []), ...(comparisonResult.improved || [])]
      .filter(e => (e.latest?.error_rate || 0) < 5).map(e => e.label);
    const worstRegression = (comparisonResult.regressed || [])[0];
    const topRegression = worstRegression
      ? { label: worstRegression.label, ...diagnoseRootCause(worstRegression.baseline, worstRegression.latest) }
      : null;
    const aiSummary = await generateExecutiveSummary(req.userId, {
      avgBaselineMs: ctx.baselineSummary?.avg_response_time, avgLatestMs: ctx.latestSummary?.avg_response_time,
      scoreBaseline: baselineScores.overall.value, scoreLatest: latestScores.overall.value,
      healthyApis, topRegression,
    });

    const capacityHistory = await getScalabilityHistoryPoints(projectId, latestRun);
    const capacity = predictionEngine.estimateCapacity(capacityHistory, statsEngine);

    const trendPoints = await buildMetricSeriesPoints(runs, '__overall__');
    const trendSeries = {}, trendRegression = {};
    for (const key of ['avg', 'p90', 'p95', 'tps', 'error_rate']) {
      const values = trendPoints.map(p => p[key] ?? 0);
      trendSeries[key] = values;
      trendRegression[key] = linearRegression(values);
    }

    const scoreDelta = (latestScores.overall.value !== null && baselineScores.overall.value !== null)
      ? latestScores.overall.value - baselineScores.overall.value : null;
    const avgPctDelta = ctx.baselineSummary && ctx.latestSummary ? pctChangeLocal(ctx.baselineSummary.avg_response_time, ctx.latestSummary.avg_response_time) : null;
    const errPtsDelta = ctx.baselineSummary && ctx.latestSummary ? (ctx.latestSummary.error_rate || 0) - (ctx.baselineSummary.error_rate || 0) : null;
    const tpsPctDelta = ctx.baselineSummary && ctx.latestSummary ? pctChangeLocal(ctx.baselineSummary.overall_tps, ctx.latestSummary.overall_tps) : null;

    const kpis = [
      { label: 'Overall Performance Score', value: latestScores.overall.value ?? 'N/A', color: '#49CC3D' },
      { label: 'Score Change', value: scoreDelta === null ? 'N/A' : `${scoreDelta >= 0 ? '+' : ''}${scoreDelta.toFixed(1)}`, color: (scoreDelta ?? 0) >= 0 ? '#22c55e' : '#ef4444' },
      { label: 'Avg Response Time', value: avgPctDelta === null ? 'N/A' : `${avgPctDelta > 0 ? '+' : ''}${avgPctDelta.toFixed(1)}%`, color: (avgPctDelta ?? 0) > 0 ? '#ef4444' : '#22c55e' },
      { label: 'Error Rate', value: errPtsDelta === null ? 'N/A' : `${errPtsDelta > 0 ? '+' : ''}${errPtsDelta.toFixed(1)} pts`, color: (errPtsDelta ?? 0) > 0 ? '#ef4444' : '#22c55e' },
      { label: 'Throughput (TPS)', value: tpsPctDelta === null ? 'N/A' : `${tpsPctDelta > 0 ? '+' : ''}${tpsPctDelta.toFixed(1)}%`, color: (tpsPctDelta ?? 0) < 0 ? '#ef4444' : '#22c55e' },
      { label: 'Regressed APIs', value: (comparisonResult.regressed || []).length, color: '#ef4444' },
      { label: 'Improved APIs', value: (comparisonResult.improved || []).length, color: '#22c55e' },
      { label: 'Executions Analyzed', value: runs.length, color: '#58a6ff' },
    ];

    const runRange = `${getRunLabelServer(baselineRun)} (${new Date(baselineRun.started_at).toLocaleDateString()}) → ${getRunLabelServer(latestRun)} (${new Date(latestRun.started_at).toLocaleDateString()})`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="TrendAnalysis_${baselineRun.id}-${latestRun.id}.pdf"`);

    await generateTrendAnalysisPdf({
      runRange, kpis, aiSummary,
      scores: { baseline: baselineScores, latest: latestScores },
      comparison: comparisonResult, insights,
      recommendations: { recommendations: narratedRecommendations, truncated: built.truncated, totalCount: built.totalCount },
      capacity,
      trend: { runs: trendPoints.map(p => ({ run_id: p.run_id, started_at: p.started_at })), series: trendSeries, regression: trendRegression },
    }, res);
  } catch (err) {
    console.error('[trend-analysis] GET /export-pdf failed:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to export trend analysis PDF' });
  }
});

module.exports = router;
