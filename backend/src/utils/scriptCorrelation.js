// scriptCorrelation.js — turns correlationEngine.js's detected/reviewed rules into the
// two things a script generator actually needs, for either JMeter or k6:
//   1. which endpoints need an extractor added after them (groupRulesBySource), and
//   2. which literal values in a later endpoint's request need replacing with a
//      variable reference (substituteCorrelatedLiterals).
// Deliberately engine-agnostic: JMeter's `${var}` property syntax and a JS template
// literal's `${var}` interpolation are textually identical, so the same substitution
// function produces correct output whether the caller embeds it in JMX XML or in a
// backtick-quoted k6 request URL/body.

const { rawFieldNameOf } = require('./correlationEngine');
const { transformScriptExpression } = require('./transforms');

function escapeRegexStr(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Only a rule a human confirmed, or one detection is confident about (source/target
// field names looked related), is safe to bake into a generated script unattended.
// 'rejected' and unreviewed 'low' confidence guesses are excluded — see
// correlationEngine.js's mergeRules for how a rule's status/confidence get here.
function filterApplicableRules(rules) {
  return (rules || []).filter(r => r.status === 'confirmed' || (r.status === 'auto' && r.confidence === 'high'));
}

// endpointIndex -> deduped [{varName, jsonPath, sourceLocation}] — the extractors that
// must run right after that endpoint's request, so every distinct captured field only
// gets declared once even if several later endpoints each depend on it. sourceLocation
// ('body' | 'header') tells the caller which kind of extractor to emit — a JMeter
// JSONPostProcessor / k6 res.json() accessor for 'body', or a header-targeted
// RegexExtractor / res.headers lookup for 'header'.
function groupRulesBySource(rules) {
  const map = new Map();
  for (const r of (rules || [])) {
    if (!map.has(r.sourceEndpointIndex)) map.set(r.sourceEndpointIndex, []);
    const list = map.get(r.sourceEndpointIndex);
    if (!list.some(e => e.varName === r.varName && e.jsonPath === r.sourceJsonPath)) {
      list.push({ varName: r.varName, jsonPath: r.sourceJsonPath, sourceLocation: r.sourceLocation || 'body' });
    }
  }
  return map;
}

// endpointIndex -> [rule, ...] — every rule whose literal needs substituting into that
// endpoint's own outbound request.
function groupRulesByTarget(rules) {
  const map = new Map();
  for (const r of (rules || [])) {
    if (!map.has(r.targetEndpointIndex)) map.set(r.targetEndpointIndex, []);
    map.get(r.targetEndpointIndex).push(r);
  }
  return map;
}

// Replaces the literal value at `key` (the JSON leaf's own field name, e.g. "orderId"
// out of jsonPath "$.orderId") in a JSON-shaped body STRING with `replacement` (a full
// `${...}` expression — a correlation variable reference or a fieldGenerators.js generator
// expression, both callers pass the complete text) — via targeted regex, not a full JSON
// re-serialize, so formatting/key order the AI or the recorder produced is left untouched
// (same approach substituteCSVVars already uses in testSuites.js for the same reason).
function replaceBodyLiteral(bodyStr, key, value, replacement) {
  const escKey = escapeRegexStr(key);
  const escVal = escapeRegexStr(value);
  const quoted = bodyStr.replace(new RegExp(`("${escKey}"\\s*:\\s*)"${escVal}"`), `$1"${replacement}"`);
  if (quoted !== bodyStr) return quoted;
  // Bare numeric/bool literal (e.g. "orderId": 12345, no quotes)
  const bareNumeric = bodyStr.replace(new RegExp(`("${escKey}"\\s*:\\s*)${escVal}(?=[,\\s\\n\\r}])`), `$1${replacement}`);
  if (bareNumeric !== bodyStr) return bareNumeric;
  // Form-urlencoded body (key=value&key2=value2) — correlationEngine.js's parseBodyToObject
  // detects these the same way this falls back to matching them; a value containing
  // characters that need percent-encoding is a known limitation (the encoded and decoded
  // forms would differ, and this matches against the literal text as recorded).
  return bodyStr.replace(new RegExp(`(^|&)(${escKey}=)${escVal}(?=&|$)`), `$1$2${replacement}`);
}

// Applies every rule targeting this endpoint to its normalized request shape
// ({ path, headers, body, queryParams } — testSuites.js's normalizeEp() output), replacing
// each rule's recorded literal with a `${varName}` reference — or, when the rule carries
// an optional `transform` (utils/transforms.js — only ever set by a human via a manual
// rule, never auto-detected), a transform-wrapped expression like `${__digest(MD5,${x},,,)}`
// instead of a bare reference. `engine` ('jmeter' | 'k6') only matters for a transformed
// rule — an untransformed `${varName}` reference is identical text either way. Guards every
// replacement against the CURRENT value still matching the rule's recorded value, so a rule
// that no longer applies (the endpoint's literal changed some other way since detection)
// silently no-ops instead of corrupting unrelated text.
function substituteCorrelatedLiterals(normalized, targetRules, engine = 'jmeter') {
  if (!targetRules || !targetRules.length) return normalized;
  let path = normalized.path;
  const headers = { ...normalized.headers };
  const queryParams = { ...normalized.queryParams };
  let body = normalized.body;

  for (const rule of targetRules) {
    const ref = rule.transform
      ? (transformScriptExpression(rule.transform, rule.varName, engine) || `\${${rule.varName}}`)
      : `\${${rule.varName}}`;
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
      if (rule.value == null) {
        // "Inject" mode — no recorded literal to replace (rule.value is null, not just a
        // stale mismatch), so always ensure this header carries the extracted value
        // rather than requiring it to already exist. The common case this exists for:
        // injecting an auth/session token into many endpoints, some of which were never
        // recorded with that header at all. Overwrites under the existing header's own
        // case if already present, otherwise adds it under the name as configured.
        // A real HTTP `Cookie` request header is a "name=value" pair per RFC 6265, not a
        // bare value — reconstruct that shape when injecting a cookie-sourced value into
        // a literal "cookie" header target, or no server-side cookie parser will ever
        // recognize it at the script's own future runtime.
        const needsCookiePair = rule.sourceLocation === 'cookie' && String(rule.targetKey).toLowerCase() === 'cookie';
        headers[k || rule.targetKey] = needsCookiePair ? `${rule.sourceJsonPath}=${ref}` : ref;
      } else if (k && typeof headers[k] === 'string' && headers[k].includes(rule.value)) {
        headers[k] = headers[k].split(rule.value).join(ref);
      }
    } else if (rule.targetLocation === 'body' && typeof body === 'string') {
      body = replaceBodyLiteral(body, rawFieldNameOf(rule.targetKey), rule.value, ref);
    }
  }
  return { ...normalized, path, headers, body, queryParams };
}

// Converts a jsonPath ("$.a.b[0]") into a JS optional-chain suffix ("?.a?.b[0]") to append
// to a k6 response's `.json()` call — e.g. `res0.json()?.user?.tags[0]`. Optional chaining
// means a response shaped differently than it was during detection (a field missing this
// run) produces `undefined` instead of throwing, matching JMeter's extractor default-value
// behavior (which just yields NOT_FOUND rather than aborting the sample).
function jsonPathToOptionalChain(jsonPath) {
  const body = String(jsonPath || '').replace(/^\$\.?/, '');
  if (!body) return '';
  return body.split('.').map(seg => {
    const m = seg.match(/^([A-Za-z0-9_]+)((?:\[\d+\])*)$/);
    return m ? `?.${m[1]}${m[2]}` : '';
  }).join('');
}

// Builds a case-insensitive header lookup expression against a k6 response's `.headers`
// object — k6 preserves whatever casing the target server actually sent (e.g. "Location"),
// but the header name correlationEngine.js detected is lowercase-normalized (it comes from
// preRunEngine.js's use of the Fetch API's Headers.entries(), which the spec always
// lowercases). A plain `res.headers['location']` would silently miss a real "Location"
// header at runtime, so this scans entries case-insensitively instead of indexing directly.
function k6HeaderAccessor(resVar, headerName) {
  const esc = String(headerName).toLowerCase().replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `Object.entries(${resVar}.headers).find(([k]) => k.toLowerCase() === '${esc}')?.[1]`;
}

// k6's response object exposes `.cookies` as `{ [name]: [{name, value, ...}] }` (an array
// per name — a server can theoretically set the same cookie name at different paths) —
// this reads the first entry's value. Unlike headers, cookie names are looked up exactly
// as given (k6 keys them by the literal name the server set, and cookie names are legally
// case-sensitive), so no case-insensitive scanning is needed here.
function k6CookieAccessor(resVar, cookieName) {
  const esc = String(cookieName).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `${resVar}.cookies['${esc}']?.[0]?.value`;
}

// Escapes a string for safe embedding inside a k6/JS template literal (backtick-quoted
// string) — only backslashes and backticks, deliberately NOT '$' or '{'. A `${varName}`
// placeholder inserted by substituteCorrelatedLiterals/CSV substitution must interpolate
// as a real k6 variable reference; escaping '$' would turn it back into inert literal text.
// A recorded value that happens to contain a genuine "${" sequence of its own (not one of
// our placeholders) is accepted as a rare, undetectable edge case rather than solved here.
function toK6TemplateLiteral(str) {
  return String(str ?? '').replace(/\\/g, '\\\\').replace(/`/g, '\\`');
}

module.exports = {
  filterApplicableRules, groupRulesBySource, groupRulesByTarget,
  substituteCorrelatedLiterals, replaceBodyLiteral,
  jsonPathToOptionalChain, k6HeaderAccessor, k6CookieAccessor, toK6TemplateLiteral,
};
