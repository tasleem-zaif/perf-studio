// fieldGenerators.js — the other half of "no parameter left behind": correlation only
// helps a value that some EARLIER response in the same run actually produced. A recorded
// email, username, or idempotency key was never returned by any response — replaying it
// verbatim to a real target means everything after VU/iteration #1 fails on a duplicate
// or already-used value. This module attaches a per-request generator expression instead,
// using JMeter's/k6's own runtime primitives so every request sends a genuinely new value —
// no correlation to break, no CSV file to maintain for it.
//
// A generator rule is user-authored (via the API, mirroring correlationRules' manual-add
// path) — unlike correlation, "does this field need to be unique" isn't reliably
// detectable from recorded traffic alone, so this deliberately never auto-applies.

const { rawFieldNameOf } = require('./correlationEngine');
const { replaceBodyLiteral } = require('./scriptCorrelation');

const GENERATORS = {
  uuid: {
    label: 'Random UUID',
    jmeter: () => '${__UUID()}',
    k6: () => "${(() => { try { return crypto.randomUUID(); } catch (e) { return Math.random().toString(36).slice(2) + Date.now().toString(36); } })()}",
  },
  timestamp: {
    label: 'Current timestamp (ms)',
    jmeter: () => '${__time()}',
    k6: () => '${Date.now()}',
  },
  // Not a true sequential counter — combines the running thread/VU with a timestamp so
  // every request across every thread/VU still gets a distinct value without needing a
  // shared counter primitive (JMeter's __counter/k6 have no simple cross-VU equivalent).
  unique: {
    label: 'Unique per request (thread + timestamp)',
    jmeter: () => '${__threadNum()}_${__time()}',
    k6: () => '${__VU}_${Date.now()}_${__ITER}',
  },
};

function isValidGeneratorType(type) {
  return Object.prototype.hasOwnProperty.call(GENERATORS, type);
}

function generatorExpression(type, engine) {
  const gen = GENERATORS[type];
  if (!gen) return null;
  return engine === 'k6' ? gen.k6() : gen.jmeter();
}

// Applies every generator rule targeting this endpoint to its normalized request shape —
// same shape/guard pattern as scriptCorrelation.substituteCorrelatedLiterals (only replaces
// when the current value still matches what the rule was authored against), and safe to
// run right after correlation substitution: if correlation already replaced a field,
// the value no longer matches and this is a no-op, so correlation always wins if both
// somehow target the same field.
function applyFieldGenerators(normalized, targetRules, engine) {
  if (!targetRules || !targetRules.length) return normalized;
  let path = normalized.path;
  const headers = { ...normalized.headers };
  const queryParams = { ...normalized.queryParams };
  let body = normalized.body;

  for (const rule of targetRules) {
    const ref = generatorExpression(rule.generator, engine);
    if (!ref) continue;

    if (rule.targetLocation === 'urlPath') {
      const segments = path.split('/');
      if (segments[rule.targetKey] === rule.value) {
        segments[rule.targetKey] = ref;
        path = segments.join('/');
      }
    } else if (rule.targetLocation === 'query') {
      if (String(queryParams[rule.targetKey]) === rule.value) queryParams[rule.targetKey] = ref;
    } else if (rule.targetLocation === 'header') {
      const k = Object.keys(headers).find(h => h.toLowerCase() === String(rule.targetKey).toLowerCase());
      if (k && typeof headers[k] === 'string' && headers[k].includes(rule.value)) {
        headers[k] = headers[k].split(rule.value).join(ref);
      }
    } else if (rule.targetLocation === 'body' && typeof body === 'string') {
      body = replaceBodyLiteral(body, rawFieldNameOf(rule.targetKey), rule.value, ref);
    }
  }
  return { ...normalized, path, headers, body, queryParams };
}

// endpointIndex -> [rule, ...], mirrors scriptCorrelation.groupRulesByTarget.
function groupGeneratorsByTarget(rules) {
  const map = new Map();
  for (const r of (rules || [])) {
    if (!isValidGeneratorType(r.generator)) continue;
    if (!map.has(r.targetEndpointIndex)) map.set(r.targetEndpointIndex, []);
    map.get(r.targetEndpointIndex).push(r);
  }
  return map;
}

module.exports = {
  GENERATORS, isValidGeneratorType, generatorExpression, applyFieldGenerators, groupGeneratorsByTarget,
};
