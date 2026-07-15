'use strict';
// AI Summary Engine — a plain-English executive summary of a baseline-vs-latest
// comparison. A deterministic template (buildDeterministicSummary) is always
// available and used verbatim when AI isn't configured; when it is, the same facts
// are handed to the model purely to *reword* into flowing prose — the model is
// never the source of the numbers, only the phrasing (mirrors recommendationEngine's
// narrateWithAi philosophy).
const { callAi } = require('../aiClient');
const { extractJson } = require('./aiJson');

function round1(n) { return n === null || n === undefined ? null : Math.round(n * 10) / 10; }

/**
 * Returns a list of plain-English bullet facts (not a paragraph) — an executive
 * summary reads faster as bullets than as prose, and each bullet maps 1:1 to a
 * single verified fact, which also makes the AI-rewording step below trivial to
 * keep honest (one bullet in, one bullet out, never merged/invented).
 * @param {object} ctx
 * @param {number} ctx.avgBaselineMs / ctx.avgLatestMs — overall avg response time, baseline vs latest
 * @param {number|null} ctx.scoreBaseline / ctx.scoreLatest — overall Performance Score, baseline vs latest run
 * @param {Array<string>} ctx.healthyApis — API labels classified stable/improved with a good error rate
 * @param {{label:string, category:string, causePhrase:string}|null} ctx.topRegression — worst regressed API + its RCA
 * @returns {string[]}
 */
function buildDeterministicSummary(ctx) {
  const { avgBaselineMs, avgLatestMs, scoreBaseline, scoreLatest, healthyApis = [], topRegression } = ctx;
  const bullets = [];

  if (scoreBaseline !== null && scoreLatest !== null && scoreBaseline !== undefined && scoreLatest !== undefined) {
    const scorePct = scoreBaseline === 0 ? 0 : ((scoreLatest - scoreBaseline) / scoreBaseline) * 100;
    bullets.push(`Compared to the previous execution, the application has ${scorePct < 0 ? 'degraded' : 'improved'} by ${Math.abs(round1(scorePct))}%.`);
  }

  if (Number.isFinite(avgBaselineMs) && Number.isFinite(avgLatestMs)) {
    const deltaMs = avgLatestMs - avgBaselineMs;
    if (Math.abs(deltaMs) >= 1) bullets.push(`Response time ${deltaMs > 0 ? 'increased' : 'decreased'} by ${Math.round(Math.abs(deltaMs))} ms.`);
  }

  if (healthyApis.length) {
    bullets.push(`${healthyApis.slice(0, 3).join(', ')} API${healthyApis.length > 1 ? 's' : ''} remain healthy.`);
  }

  if (topRegression) {
    bullets.push(`${topRegression.label} API shows significant regression due to ${topRegression.causePhrase}.`);
  }

  if (scoreBaseline !== null && scoreLatest !== null && scoreBaseline !== undefined && scoreLatest !== undefined) {
    bullets.push(`Overall system health ${scoreLatest < scoreBaseline ? 'reduced' : 'increased'} from ${round1(scoreBaseline)} to ${round1(scoreLatest)}.`);
  }

  if (topRegression) {
    bullets.push(`Recommended priority is ${topRegression.category} optimization.`);
  }

  return bullets;
}

/**
 * Returns { bullets: string[], source: 'ai'|'rule' } — always succeeds; AI failure
 * of any kind falls back to the deterministic bullets rather than blocking the caller.
 * @param {number} userId
 * @param {object} ctx — see buildDeterministicSummary
 */
async function generateExecutiveSummary(userId, ctx) {
  const deterministic = buildDeterministicSummary(ctx);
  if (!deterministic.length) return { bullets: ['Not enough data to generate a summary yet.'], source: 'rule' };

  const systemPrompt = 'You are a performance engineering assistant writing a short executive summary for a load-test comparison report. You are given a list of already-verified facts, one per bullet. Rewrite each bullet into one clear, professional sentence in plain English — same number of bullets in as out, same order, do NOT invent, omit, merge, or change any number or fact. Return ONLY a JSON object: {"bullets": ["<rewritten bullet 1>", "<rewritten bullet 2>", ...]}.';
  const userPrompt = JSON.stringify({ facts: deterministic });

  try {
    const raw = await callAi(userId, systemPrompt, userPrompt);
    const parsed = extractJson(raw);
    if (Array.isArray(parsed?.bullets) && parsed.bullets.length === deterministic.length) {
      return { bullets: parsed.bullets.map(String), source: 'ai' };
    }
    return { bullets: deterministic, source: 'rule' };
  } catch (_) {
    return { bullets: deterministic, source: 'rule' };
  }
}

module.exports = { buildDeterministicSummary, generateExecutiveSummary };
