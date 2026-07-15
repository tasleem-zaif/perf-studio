'use strict';
// Shared "extract JSON from a possibly markdown-fenced AI response" helper for the
// trend-analysis AI features (recommendationEngine.js, aiSummaryEngine.js) — same
// extraction shape autoHealer.js's callers use, kept as its own small module since
// this is a different domain (recommendation/summary text, not script-healing) and
// autoHealer.js doesn't export its version.
function extractJson(raw) {
  if (!raw) return null;
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || raw.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  const jsonStr = (match ? (match[1] || match[0]) : raw).trim();
  if (!jsonStr.startsWith('{') && !jsonStr.startsWith('[')) return null;
  try { return JSON.parse(jsonStr); } catch { return null; }
}

module.exports = { extractJson };
