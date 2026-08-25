/**
 * Evaluates a completed JMeter run against the project's Rule Engine definitions.
 *
 * Rules are stored with:
 *   metric   – "Response Time" | "Error Rate" | "P90" | "P95" | "Throughput" | "Avg Response Time"
 *   operator – ">" | "<" | ">=" | "<="
 *   value    – numeric string threshold
 *   unit     – "ms" | "%" | "req/s"
 *   severity – "error" | "warn"
 *
 * Returns { passed, violations }
 *   passed     – true when no *error*-severity rule is breached
 *   violations – array of { rule, actual, label } for every breached rule
 */

const fs   = require('fs');
const db   = require('../db');
const { parseK6Metrics, parseK6MetricsFromContent } = require('./parseK6');

// ── Parse JTL and compute aggregate metrics ───────────────────────────────────
function parseJtlMetrics(jtlPath) {
  if (!jtlPath || !fs.existsSync(jtlPath)) return null;
  return parseJtlMetricsFromContent(fs.readFileSync(jtlPath, 'utf8'));
}

/** Same as parseJtlMetrics, but from already-fetched CSV text (e.g. read via resultsStore). */
function parseJtlMetricsFromContent(content) {
  if (!content) return null;

  const lines   = content.trim().split('\n').filter(Boolean);
  if (lines.length < 2) return null;

  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const idx = {
    elapsed:    headers.indexOf('elapsed'),
    success:    headers.indexOf('success'),
    latency:    headers.indexOf('latency'),
    timeStamp:  headers.indexOf('timeStamp'),
  };

  const elapsed = [];
  let pass = 0, fail = 0, minTs = Infinity, maxTs = -Infinity;

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    const e  = parseInt((parts[idx.elapsed]   || '0').replace(/^"|"$/g, '')) || 0;
    const ok = (parts[idx.success] || '').replace(/^"|"$/g, '').trim() === 'true';
    const ts = parseInt((parts[idx.timeStamp] || '0').replace(/^"|"$/g, '')) || 0;

    elapsed.push(e);
    ok ? pass++ : fail++;
    if (ts < minTs) minTs = ts;
    if (ts > maxTs) maxTs = ts;
  }

  if (!elapsed.length) return null;

  const total       = elapsed.length;
  const sorted      = [...elapsed].sort((a, b) => a - b);
  const pct = p     => sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
  const avgRt       = elapsed.reduce((a, b) => a + b, 0) / total;
  const durationSec = minTs < maxTs ? (maxTs - minTs) / 1000 : 1;

  return {
    total,
    pass,
    fail,
    error_rate:       (fail / total) * 100,          // %
    avg_response_time: avgRt,                         // ms
    p90:              pct(90),                        // ms
    p95:              pct(95),                        // ms
    throughput:       total / durationSec,            // req/s
  };
}

// ── Map rule metric name → computed metric key ─────────────────────────────────
const METRIC_MAP = {
  'response time':      'avg_response_time',
  'avg response time':  'avg_response_time',
  'average response time': 'avg_response_time',
  'error rate':         'error_rate',
  'p90':                'p90',
  'p95':                'p95',
  'throughput':         'throughput',
  'tps':                'throughput',
};

function metricKey(ruleName) {
  return METRIC_MAP[(ruleName || '').toLowerCase().trim()] || null;
}

function compare(actual, op, threshold, thresholdMin, thresholdMax) {
  switch (op) {
    case '>':       return actual >  threshold;
    case '>=':      return actual >= threshold;
    case '<':       return actual <  threshold;
    case '<=':      return actual <= threshold;
    case '==':
    case '=':       return actual === threshold;
    case 'between': return actual >= thresholdMin && actual <= thresholdMax;
    default:        return false;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Evaluates a results file against all rules defined for projectId, scoped to the rule
 * owner (userId) — rules are now per-user (Phase 2 of the per-user data isolation
 * project), so every caller must resolve which user's rules apply to this run before
 * calling in. execution_runs has no user_id column, so callers that only have a
 * suite_id/projectId in scope must resolve userId via test_suites.user_id first.
 * @param {number|string} projectId
 * @param {string}        resultsPath – absolute path to results.jtl (JMeter) or results.json (k6)
 * @param {number|string} userId      – owner of the rules to evaluate against
 * @param {string}        [engine]    – 'jmeter' (default) or 'k6' — picks the parser
 * @returns {{ passed: boolean, violations: Array, metrics: object|null, noRules: boolean }}
 */
async function evaluateRules(projectId, resultsPath, userId, engine = 'jmeter') {
  const metrics = engine === 'k6' ? parseK6Metrics(resultsPath) : parseJtlMetrics(resultsPath);
  return evaluateRulesFromMetrics(projectId, metrics, userId);
}

/** Same as evaluateRules, but from already-fetched text (e.g. read via resultsStore). */
async function evaluateRulesFromContent(projectId, resultsContent, userId, engine = 'jmeter') {
  const metrics = engine === 'k6'
    ? parseK6MetricsFromContent(resultsContent)
    : parseJtlMetricsFromContent(resultsContent);
  return evaluateRulesFromMetrics(projectId, metrics, userId);
}

async function evaluateRulesFromMetrics(projectId, metrics, userId) {
  const rules = await db.prepare('SELECT * FROM rules WHERE project_id = ? AND user_id = ?').all(projectId, userId);

  if (!rules || rules.length === 0) {
    // No rules defined — pass/fail determined by raw JTL fail count only
    return { passed: null, violations: [], metrics: null, noRules: true };
  }

  if (!metrics) {
    // Can't parse JTL — no verdict
    return { passed: null, violations: [], metrics: null, noRules: false };
  }

  const violations = [];

  for (const rule of rules) {
    const key = metricKey(rule.metric);
    if (!key) continue;                       // unknown metric — skip

    const actual       = metrics[key];
    const threshold    = parseFloat(rule.value);
    const thresholdMin = parseFloat(rule.value_min);
    const thresholdMax = parseFloat(rule.value_max);

    // For non-between rules require a valid threshold; for between require min+max
    if (rule.operator === 'between') {
      if (isNaN(thresholdMin) || isNaN(thresholdMax)) continue;
    } else {
      if (isNaN(threshold)) continue;
    }

    const breached = compare(actual, rule.operator, threshold, thresholdMin, thresholdMax);
    if (breached) {
      const thresholdLabel = rule.operator === 'between'
        ? `between ${rule.value_min}–${rule.value_max}${rule.unit}`
        : `${rule.operator} ${rule.value}${rule.unit}`;
      violations.push({
        rule,
        actual: parseFloat(actual.toFixed(2)),
        label: `${rule.metric} ${thresholdLabel} (actual: ${actual.toFixed(2)}${rule.unit})`,
      });
    }
  }

  // Run "passes" when no error-severity rule is violated
  const errorViolations = violations.filter(v => v.rule.severity === 'error');
  const passed = errorViolations.length === 0;

  return { passed, violations, metrics, noRules: false };
}

module.exports = { evaluateRules, evaluateRulesFromContent, parseJtlMetrics, parseJtlMetricsFromContent };
