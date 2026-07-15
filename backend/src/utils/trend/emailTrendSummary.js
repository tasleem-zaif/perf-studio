'use strict';
// Assembles the Trend Analysis section shown in the execution-report email (see
// emailUtils.js's buildEmailBody) — the 6 weighted Performance Scores plus an
// executive-summary bullet list, exactly as the Trend Analysis dashboard shows them
// (ScoreCards.jsx/AiSummaryCard.jsx), but scoped automatically to "this run vs. the
// immediately preceding run of the same test plan" rather than a user-picked run
// range. Reuses the same engines the dashboard's /scores and /ai-summary routes
// call (runScoring.js, aiSummaryEngine.js, recommendationEngine.js) so the numbers
// in the email always match what the dashboard would show for the same two runs.
const metricsStore = require('./metricsStore');
const { getPreviousRun, computeScoresForRun, resolveComparison } = require('./runScoring');
const { diagnoseRootCause } = require('./recommendationEngine');
const { generateExecutiveSummary } = require('./aiSummaryEngine');

/**
 * @param {number} projectId
 * @param {{id:number, suite_id:number|null, started_at:string}} run — the just-completed run
 * @param {number} userId — for AI-narration provider lookup (falls back to rule-based on failure)
 * @returns {Promise<{scores:object, aiSummary:{bullets:string[], source:'ai'|'rule'}}|null>}
 *   null if there's no prior run for this suite yet — nothing to trend against.
 */
async function buildEmailTrendSummary(projectId, run, userId) {
  const prevRun = await getPreviousRun(projectId, run);
  if (!prevRun) return null;

  const latestScores = await computeScoresForRun(projectId, run);
  const baselineScores = await computeScoresForRun(projectId, prevRun);

  const comparisonResult = await resolveComparison(projectId, [prevRun.id, run.id], userId);
  if (!comparisonResult) return null;

  const healthyApis = [...(comparisonResult.stable || []), ...(comparisonResult.improved || [])]
    .filter(e => (e.latest?.error_rate || 0) < 5)
    .map(e => e.label);

  const worstRegression = (comparisonResult.regressed || [])[0];
  const topRegression = worstRegression
    ? { label: worstRegression.label, ...diagnoseRootCause(worstRegression.baseline, worstRegression.latest) }
    : null;

  const baselineSummary = (await metricsStore.getOrBuildReportData(prevRun))?.summary || null;
  const latestSummary = (await metricsStore.getOrBuildReportData(run))?.summary || null;

  const aiSummary = await generateExecutiveSummary(userId, {
    avgBaselineMs: baselineSummary?.avg_response_time, avgLatestMs: latestSummary?.avg_response_time,
    scoreBaseline: baselineScores.overall.value, scoreLatest: latestScores.overall.value,
    healthyApis, topRegression,
  });

  return { scores: latestScores, aiSummary };
}

module.exports = { buildEmailTrendSummary };
