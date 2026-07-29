'use strict';
// Recommendation Engine — deterministic Root Cause Analysis (RCA) per regressed API,
// then ranked, actionable recommendations. Mechanical diagnosis first (zero-cost,
// always available), AI only narrates the finding into friendlier prose — same
// "mechanical first, AI only to narrate" philosophy as autoHealer.js. AI narration
// never blocks or throws: a caller always gets the rule-based recommendations even
// if AI is unconfigured or the request fails.
const { callAi } = require('../aiClient');
const { extractJson } = require('./aiJson');

const FORMULA_VERSION = 'v1';

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function pctChange(from, to) {
  if (!from || from === 0) return to > 0 ? 100 : 0;
  return ((to - from) / from) * 100;
}
function round1(n) { return Math.round(n * 10) / 10; }

/**
 * Splits an API's response-time regression into its likely driver — connection
 * time (network), processing time (backend/database), transfer time (payload/
 * bandwidth), or error rate — by comparing which component grew the most between
 * baseline and latest. JMeter's own timing model makes this decomposition possible
 * without any new instrumentation: elapsed ⊇ latency (time-to-first-byte) ⊇ connect.
 * @param {{avg,avg_connect,avg_latency,avg_bytes,error_rate}} baseline
 * @param {{avg,avg_connect,avg_latency,avg_bytes,error_rate}} latest
 */
function diagnoseRootCause(baseline, latest) {
  const connectDelta = (latest.avg_connect || 0) - (baseline.avg_connect || 0);
  const processingBaseline = Math.max(0, (baseline.avg_latency || 0) - (baseline.avg_connect || 0));
  const processingLatest = Math.max(0, (latest.avg_latency || 0) - (latest.avg_connect || 0));
  const processingDelta = processingLatest - processingBaseline;
  const transferBaseline = Math.max(0, (baseline.avg || 0) - (baseline.avg_latency || 0));
  const transferLatest = Math.max(0, (latest.avg || 0) - (latest.avg_latency || 0));
  const transferDelta = transferLatest - transferBaseline;
  const errorRateDelta = (latest.error_rate || 0) - (baseline.error_rate || 0);
  const bytesDeltaPct = pctChange(baseline.avg_bytes, latest.avg_bytes);

  // A large error-rate jump is diagnosed on its own axis — it isn't a component of
  // response time, and an outage matters more than which timing bucket grew.
  if (errorRateDelta >= 5) {
    const category = latest.error_rate >= 50 ? 'infrastructure' : 'application';
    return {
      category, dominantFactor: 'error_rate',
      causePhrase: 'an elevated error rate',
      rootCause: `Error rate increased by ${round1(errorRateDelta)} points (${round1(baseline.error_rate || 0)}% → ${round1(latest.error_rate || 0)}%)`,
      confidencePct: clamp(Math.round(50 + errorRateDelta), 50, 95),
    };
  }

  const components = [
    { key: 'connect',    delta: connectDelta,    category: 'network',
      causePhrase: 'increased network/connection latency',
      rootCause: `Connection time increased by ${Math.round(connectDelta)}ms` },
    { key: 'processing', delta: processingDelta, category: 'database',
      causePhrase: 'increased backend/database processing latency',
      rootCause: `Server processing time increased by ${Math.round(processingDelta)}ms` },
    { key: 'transfer',   delta: transferDelta,   category: bytesDeltaPct >= 15 ? 'application' : 'infrastructure',
      causePhrase: bytesDeltaPct >= 15 ? 'a larger response payload increasing transfer time' : 'increased network transfer time',
      rootCause: `Response transfer time increased by ${Math.round(transferDelta)}ms${bytesDeltaPct >= 15 ? ` (payload size +${round1(bytesDeltaPct)}%)` : ''}` },
  ];

  const positive = components.filter(c => c.delta > 0);
  if (!positive.length) {
    return { category: 'unknown', dominantFactor: null, causePhrase: 'no single clear driver', rootCause: 'No clear regression driver identified from timing breakdown', confidencePct: 0 };
  }

  const totalPositiveDelta = positive.reduce((s, c) => s + c.delta, 0) || 1;
  const worst = positive.reduce((a, b) => (b.delta > a.delta ? b : a));
  const confidencePct = clamp(Math.round((worst.delta / totalPositiveDelta) * 100), 30, 95);

  return { category: worst.category, dominantFactor: worst.key, causePhrase: worst.causePhrase, rootCause: worst.rootCause, confidencePct };
}

function priorityFor(badness) {
  if (badness >= 40) return 'critical';
  if (badness >= 20) return 'high';
  if (badness >= 10) return 'medium';
  return 'low';
}

/**
 * Builds ranked, actionable recommendations from a comparisonEngine.compareRuns()
 * result (one per regressed API, worst-first) plus an optional capacity-planning
 * recommendation when the run's Scalability Score indicates poor load tolerance.
 * @param {{regressed:Array}} comparisonResult
 * @param {{scalability?:{value:number|null}}} [scores]
 * @param {number} [maxCount=10] — caps the list; excess is reported via `truncated`
 */
function buildRecommendations(comparisonResult, scores = {}, maxCount = 10) {
  const regressed = comparisonResult?.regressed || [];
  const recommendations = regressed.map(entry => {
    const rca = diagnoseRootCause(entry.baseline, entry.latest);
    const priority = priorityFor(entry.deltas.badness);
    return {
      category: rca.category,
      priority,
      scope: entry.label,
      title: `${categoryActionVerb(rca.category)} for ${entry.label}`,
      description: `${entry.label} regressed (avg RT ${entry.deltas.avgPct > 0 ? '+' : ''}${round1(entry.deltas.avgPct)}%, error rate ${entry.deltas.errorRatePts > 0 ? '+' : ''}${round1(entry.deltas.errorRatePts)} pts). ${rca.rootCause}.`,
      root_cause: rca.rootCause,
      confidence_pct: rca.confidencePct,
      source: 'rule',
    };
  });

  if (scores?.scalability?.value !== null && scores?.scalability?.value !== undefined && scores.scalability.value < 60) {
    recommendations.push({
      category: 'capacity',
      priority: scores.scalability.value < 40 ? 'high' : 'medium',
      scope: '__overall__',
      title: 'Review capacity planning',
      description: `Scalability Score is ${scores.scalability.value}/100 — response time and/or error rate are trending up as concurrency increases across this suite's execution history.`,
      root_cause: 'Performance degrades disproportionately under increasing load',
      confidence_pct: clamp(Math.round(100 - scores.scalability.value), 40, 90),
      source: 'rule',
    });
  }

  const priorityWeight = { critical: 3, high: 2, medium: 1, low: 0 };
  recommendations.sort((a, b) => (priorityWeight[b.priority] - priorityWeight[a.priority]) || (b.confidence_pct - a.confidence_pct));

  const truncated = recommendations.length > maxCount;
  return { recommendations: recommendations.slice(0, maxCount), truncated, totalCount: recommendations.length, formulaVersion: FORMULA_VERSION };
}

function categoryActionVerb(category) {
  switch (category) {
    case 'database': return 'Optimize database/backend processing';
    case 'network': return 'Investigate network/connection latency';
    case 'application': return 'Review application logic/payload size';
    case 'infrastructure': return 'Check infrastructure capacity';
    case 'capacity': return 'Review capacity planning';
    default: return 'Investigate regression';
  }
}

/**
 * Optionally rephrases each recommendation's description via the configured AI
 * provider — the underlying facts (category/root_cause/confidence) are unchanged,
 * only wording is affected, and any AI failure (not configured, network error,
 * unparseable response) silently keeps the original rule-based text.
 * @param {number} userId
 * @param {Array} recommendations — buildRecommendations()'s output array
 */
async function narrateWithAi(userId, recommendations) {
  if (!recommendations.length) return recommendations;

  const systemPrompt = 'You are a performance engineering assistant. You are given a list of already-diagnosed performance regressions with their root cause. Rephrase each "description" into one clear, professional sentence for a report, in plain English, without inventing new facts or numbers beyond what is given. Return ONLY a JSON array of objects: [{"scope": "<same scope value>", "description": "<rewritten sentence>"}].';
  const userPrompt = JSON.stringify(recommendations.map(r => ({ scope: r.scope, category: r.category, priority: r.priority, root_cause: r.root_cause, original: r.description })));

  try {
    const raw = await callAi(userId, systemPrompt, userPrompt);
    const parsed = extractJson(raw);
    if (!Array.isArray(parsed)) return recommendations;

    const byScope = new Map(parsed.filter(p => p && p.scope).map(p => [p.scope, p.description]));
    return recommendations.map(r => {
      const narrated = byScope.get(r.scope);
      return narrated ? { ...r, description: narrated, source: 'ai' } : r;
    });
  } catch (_) {
    return recommendations; // AI not configured, or the call failed — rule-based text stands on its own
  }
}

module.exports = { diagnoseRootCause, buildRecommendations, narrateWithAi, FORMULA_VERSION };
