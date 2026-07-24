'use strict';
// Persists per-API metrics (run_api_metrics) so trend/comparison queries are indexed SQL
// scans instead of re-parsing JTL (or re-scanning execution_runs.report_data's JSON blob)
// on every request — the same cache-on-first-read philosophy execution.js's report-data
// route already uses for the whole-run summary, applied at API granularity.
const db = require('../../db');
const { parseJtlContent } = require('../parseJtl');
const resultsStore = require('../resultsStore');
const { resolveOrgSlugForProject } = require('../projectFolders');

/**
 * Returns the full parsed report-data object ({summary, by_api, timeline, errors})
 * for a run — from the execution_runs.report_data cache if present, else parsed
 * from the JTL on disk (and backfills the cache, matching execution.js's own
 * report-data route behavior). Shared by ensureRunApiMetrics (needs by_api) and
 * the /trend endpoint's overall-scope path (needs summary) so neither duplicates
 * this cache-or-parse fallback.
 * @param {{id:number, project_id:number, result_dir:string|null, report_data:string|null}} run
 * @returns {Promise<object|null>}
 */
async function getOrBuildReportData(run) {
  if (run.report_data) {
    try { return JSON.parse(run.report_data); } catch (_) { /* fall through to reparse */ }
  }
  if (!run.result_dir) return null;
  const orgSlug = await resolveOrgSlugForProject(run.project_id);
  const jtlText = await resultsStore.readText(run.result_dir, orgSlug, 'results.jtl');
  if (!jtlText) return null;
  const parsed = parseJtlContent(jtlText, { run_id: run.id });
  if (!parsed) return null;
  if (!run.report_data) {
    try { await db.prepare('UPDATE execution_runs SET report_data=? WHERE id=?').run(JSON.stringify(parsed), run.id); } catch (_) {}
  }
  return parsed;
}

/**
 * Ensure run_api_metrics rows exist for a run. No-op if already populated.
 * @param {{id:number, project_id:number, result_dir:string|null, report_data:string|null}} run
 * @returns {Promise<boolean>} true if metrics are available (already present or just populated)
 */
async function ensureRunApiMetrics(run) {
  const existing = await db.prepare('SELECT 1 FROM run_api_metrics WHERE run_id = ? LIMIT 1').get(run.id);
  if (existing) return true;

  const parsed = await getOrBuildReportData(run);
  const byApi = parsed?.by_api;
  if (!byApi || !byApi.length) return false;

  for (const api of byApi) {
    await db.prepare(`
      INSERT INTO run_api_metrics
        (run_id, project_id, label, total, success, failed, error_rate, avg, min, max, median, p90, p95, tps, avg_latency, avg_connect, avg_bytes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (run_id, label) DO NOTHING
    `).run(
      run.id, run.project_id, api.label, api.total, api.success, api.failed, api.error_rate,
      api.avg, api.min, api.max, api.median, api.p90, api.p95, api.tps,
      api.avg_latency, api.avg_connect, api.avg_bytes,
    );
  }
  return true;
}

/** All persisted per-API metrics for one run, alphabetical by label. */
async function getApiMetricsForRun(runId) {
  return db.prepare('SELECT * FROM run_api_metrics WHERE run_id = ? ORDER BY label').all(runId);
}

/** Persisted per-API metrics across several runs — the shape trend/comparison queries need. */
async function getApiMetricsAcrossRuns(runIds) {
  if (!runIds || !runIds.length) return [];
  const placeholders = runIds.map(() => '?').join(',');
  return db.prepare(
    `SELECT * FROM run_api_metrics WHERE run_id IN (${placeholders}) ORDER BY label, run_id`
  ).all(...runIds);
}

module.exports = { getOrBuildReportData, ensureRunApiMetrics, getApiMetricsForRun, getApiMetricsAcrossRuns };
