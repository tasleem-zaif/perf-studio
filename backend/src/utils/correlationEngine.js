// correlationEngine.js — generalizes preRunEngine.js's token-only capture (a fixed
// TOKEN_KEYS name list) into full value-based correlation: ANY literal value in a later
// endpoint's URL path segment, query param, header, or body that exactly matches a value
// seen in an earlier endpoint's pre-run response is a candidate correlation rule — not
// just auth tokens. Detection only (pure functions, no DB/network) so it's unit-testable
// and reusable by both the pre-run route (persists rules) and script generation (burns
// confirmed rules into JMX/k6 output).

// Values shorter than this, or in the fixed noise list, are excluded as correlation
// sources/targets — short/common values (booleans, tiny counters, enums) collide across
// unrelated fields far too often to be a reliable signal.
const MIN_VALUE_LENGTH = 4;
const NOISE_VALUES = new Set([
  'true', 'false', 'null', 'undefined', 'ok', 'OK', 'success', 'error',
  'application/json', 'application/x-www-form-urlencoded', 'text/plain',
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS',
]);

function isNoiseValue(value) {
  if (typeof value !== 'string') return true;
  if (value.length < MIN_VALUE_LENGTH) return true;
  if (NOISE_VALUES.has(value)) return true;
  if (/^\d+$/.test(value) && value.length <= 2) return true; // "1", "10" — too common to trust
  return false;
}

// Infra/boilerplate response headers that are never a meaningful correlation source (a
// business value some other request would ever need) — excluded so indexing every
// response header doesn't flood detection with content negotiation/caching noise.
// set-cookie is deliberately excluded too: it has its own dedicated capture path
// (preRunEngine.js's extractCookies/cookieJar), not the generic value-matching one here.
const HEADER_SOURCE_DENYLIST = new Set([
  'content-type', 'content-length', 'date', 'connection', 'server', 'cache-control',
  'vary', 'etag', 'expires', 'pragma', 'transfer-encoding', 'keep-alive', 'set-cookie',
  'access-control-allow-origin', 'access-control-allow-credentials', 'x-powered-by',
]);

// Flattens a parsed JSON value into {jsonPath, value} leaf pairs (string/number leaves
// only — objects/arrays aren't themselves literal request params). jsonPath uses the
// same `$.key.sub[0]` shape JMeter's JSONPostProcessor / a JS accessor both understand.
function flattenToLeaves(obj, prefix = '$') {
  const out = [];
  if (obj === null || obj === undefined) return out;
  if (typeof obj === 'string' || typeof obj === 'number') {
    out.push({ jsonPath: prefix, value: String(obj) });
    return out;
  }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => out.push(...flattenToLeaves(v, `${prefix}[${i}]`)));
    return out;
  }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) out.push(...flattenToLeaves(v, `${prefix}.${k}`));
  }
  return out;
}

// The last path/key segment of a jsonPath or param name, used to judge whether a source
// field and a target field are plausibly "the same thing" (e.g. response `id` vs request
// param `orderId`) — a coarse heuristic (substring match), not a real schema match. Good
// enough to rank candidate sources; the human review step (see routes wiring) is what
// actually guards against a wrong guess reaching a generated script.
function fieldNameOf(jsonPath) {
  const m = String(jsonPath).match(/([A-Za-z0-9_]+)(?:\[\d+\])?$/);
  return m ? m[1].toLowerCase() : '';
}
// Case-preserving counterpart of fieldNameOf, used wherever the actual name is needed
// (suggested variable names, building a real regex against JSON text) rather than a
// fuzzy comparison key.
function rawFieldNameOf(jsonPath) {
  const m = String(jsonPath).match(/([A-Za-z0-9_]+)(?:\[\d+\])?$/);
  return m ? m[1] : '';
}
function namesRelated(a, b) {
  if (!a || !b) return false;
  a = a.replace(/[_-]/g, '');
  b = b.replace(/[_-]/g, '');
  return a === b || a.includes(b) || b.includes(a);
}

// Parses a request/response body string into a plain object regardless of whether it's
// JSON or form-urlencoded (key1=value1&key2=value2) — the two body formats this app's
// recorded traffic actually uses. XML/multipart bodies are deliberately out of scope: a
// real XPath-style extractor is a much larger undertaking than the two formats that cover
// the overwhelming majority of recorded HTTP API traffic in 2026.
function parseBodyToObject(bodyStr) {
  if (typeof bodyStr !== 'string' || !bodyStr.trim()) return null;
  const trimmed = bodyStr.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { return JSON.parse(trimmed); } catch { return null; }
  }
  // Only attempt form-urlencoded parsing when the text actually looks like key=value pairs
  // — requires no '<' (rules out XML/HTML) and no whitespace/newlines (rules out plain
  // prose) before the first '=', so an unrecognized format is left alone rather than
  // misparsed into something that looks plausible but is wrong.
  if (/^[^\s<>=&]+=[^\s]*(&[^\s<>=&]+=[^\s]*)*$/.test(trimmed)) {
    try {
      const params = new URLSearchParams(trimmed);
      const obj = {};
      for (const [k, v] of params.entries()) obj[k] = v;
      return Object.keys(obj).length ? obj : null;
    } catch { return null; }
  }
  return null;
}

// Every literal value an endpoint's outbound request actually sends, tagged with WHERE
// it appears so a later step knows what to rewrite. `key` meaning depends on location:
//   urlPath -> path segment index   query -> param name   header -> header name
//   body    -> jsonPath into the parsed request body
//
// The URL is scanned as PATH ONLY (query string stripped) — parseCollection.js notes
// url.raw commonly duplicates the same params already tracked in ep.queryParams, so
// scanning both would double-report the same literal under two locations.
function extractRequestLiterals(ep) {
  const out = [];
  // Segment indices MUST align with testSuites.js's normalizeEp(), which strips
  // protocol/host and works off the URL's pathname only (via `new URL(...).pathname`) —
  // indexing against the raw ep.url string here would count "https:", "", and the
  // hostname as segments too, throwing every downstream index off and silently
  // no-op'ing the substitution when a script generator tries to apply the rule.
  const rawUrl = String(ep.url || '');
  let pathname;
  try {
    const u = new URL(rawUrl.startsWith('http') ? rawUrl : `https://x${rawUrl}`);
    pathname = decodeURIComponent(u.pathname);
  } catch {
    pathname = rawUrl.split('?')[0];
  }
  pathname.split('/').forEach((seg, i) => {
    if (!seg || seg.includes('{{')) return;
    out.push({ location: 'urlPath', key: i, value: seg });
  });

  for (const [k, v] of Object.entries(ep.queryParams || {})) {
    if (typeof v === 'string' && v && !v.includes('{{')) out.push({ location: 'query', key: k, value: v });
  }

  for (const [k, v] of Object.entries(ep.headers || {})) {
    if (typeof v === 'string' && v && !v.includes('{{') && k.toLowerCase() !== 'content-type') {
      out.push({ location: 'header', key: k, value: v });
    }
  }

  if (ep.body) {
    const parsed = typeof ep.body === 'string' ? parseBodyToObject(ep.body) : ep.body;
    if (parsed && typeof parsed === 'object') {
      for (const leaf of flattenToLeaves(parsed)) {
        if (!leaf.value.includes('{{')) out.push({ location: 'body', key: leaf.jsonPath, value: leaf.value });
      }
    }
  }
  return out;
}

// Builds a value -> [{endpointIndex, jsonPath, sourceLocation}] index from every response
// captured during pre-run — both the JSON body AND the response headers (e.g. a `Location`
// header on a 201 Created, or a session token returned via a custom header instead of the
// body) — in endpoint (= request) order. Entries are pushed in ascending index order, so
// for any value the FIRST candidate in its list is the earliest endpoint that produced it.
// `jsonPath` holds a "$.a.b" body path when sourceLocation is 'body', or the literal
// (lowercase — see fireEndpoint's Headers.entries() normalization) header name when it's
// 'header'; downstream extractor-building code branches on sourceLocation to know which.
function buildSourceIndex(preRunData) {
  const index = new Map();
  const allValues = []; // flat list, used for header substring matching (e.g. "Bearer <token>")
  preRunData.forEach((r, i) => {
    if (!r) return;
    if (r.body) {
      const body = typeof r.body === 'string' ? parseBodyToObject(r.body) : r.body;
      if (body && typeof body === 'object') {
        for (const leaf of flattenToLeaves(body)) {
          if (isNoiseValue(leaf.value)) continue;
          const entry = { endpointIndex: i, jsonPath: leaf.jsonPath, value: leaf.value, sourceLocation: 'body' };
          if (!index.has(leaf.value)) index.set(leaf.value, []);
          index.get(leaf.value).push(entry);
          allValues.push(entry);
        }
      }
    }
    for (const [headerName, headerValue] of Object.entries(r.responseHeaders || {})) {
      if (HEADER_SOURCE_DENYLIST.has(headerName.toLowerCase())) continue;
      if (typeof headerValue !== 'string' || isNoiseValue(headerValue)) continue;
      const entry = { endpointIndex: i, jsonPath: headerName, value: headerValue, sourceLocation: 'header' };
      if (!index.has(headerValue)) index.set(headerValue, []);
      index.get(headerValue).push(entry);
      allValues.push(entry);
    }
  });
  // Longest-first so a header substring match prefers the more specific/longer value
  // (avoids e.g. a 4-char value incidentally matching inside a much longer token string).
  allValues.sort((a, b) => b.value.length - a.value.length);
  return { index, allValues };
}

function suggestVarName(location, key, sourceJsonPath) {
  const base = rawFieldNameOf(sourceJsonPath) || (location === 'urlPath' ? 'pathParam' : String(key));
  return (base.replace(/[^a-zA-Z0-9]/g, '_') || 'capturedValue');
}

// Runs full correlation detection across a pre-run's captured responses and the
// endpoints that produced them (same array, same index alignment as preRunData).
// Returns candidate rules in endpoint order. Each candidate:
//   { sourceEndpointIndex, sourceJsonPath, targetEndpointIndex, targetLocation,
//     targetKey, value, varName, confidence }
// confidence is 'high' (source/target field names looked related) or 'low' (value
// matched, names didn't — most likely still correct, e.g. a bare path segment ID, but
// worth a human glance). Only ever looks at sources with a LOWER endpoint index than
// the target: a response can't inform a request that was fired before it existed.
function detectCorrelations(endpoints, preRunData) {
  if (!Array.isArray(endpoints) || !Array.isArray(preRunData)) return [];
  const { index, allValues } = buildSourceIndex(preRunData);
  const rules = [];
  const seen = new Set();

  endpoints.forEach((ep, targetIdx) => {
    if (!ep) return;
    for (const lit of extractRequestLiterals(ep)) {
      if (isNoiseValue(lit.value)) continue;

      let candidates;
      if (lit.location === 'header') {
        // Headers commonly wrap a value (e.g. "Bearer <token>") rather than equal it
        // exactly, so match by containment against the longest-first value list.
        const hit = allValues.find(v => v.endpointIndex < targetIdx && lit.value.includes(v.value));
        candidates = hit ? [hit] : [];
      } else {
        candidates = (index.get(lit.value) || []).filter(c => c.endpointIndex < targetIdx);
      }
      if (!candidates.length) continue;

      let best, confidence;
      if (lit.location === 'header') {
        // A header value matched by containment against a real captured value is already
        // a strong, specific signal on its own (tokens are long) — the header's own key
        // name (e.g. "Authorization") never resembles the source field's name (e.g.
        // "accessToken"), so requiring a name match here would misclassify the single most
        // common correlation case (auth token propagation) as low-confidence and block it
        // from auto-applying, regressing behavior this feature is meant to keep automatic.
        best = candidates[0];
        confidence = 'high';
      } else {
        const targetFieldName = lit.location === 'body' ? fieldNameOf(lit.key) : String(lit.key);
        best = candidates.find(c => namesRelated(fieldNameOf(c.jsonPath), targetFieldName));
        confidence = 'high';
        if (!best) { best = candidates[0]; confidence = 'low'; }
      }

      const dedupeKey = `${targetIdx}:${lit.location}:${lit.key}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      rules.push({
        id: dedupeKey,
        sourceEndpointIndex: best.endpointIndex,
        sourceJsonPath: best.jsonPath,
        // 'body' (default) or 'header' — which part of the SOURCE endpoint's response
        // this value came from. Old persisted rules predating this field are still valid:
        // absence means 'body', matching how every rule behaved before header sourcing existed.
        sourceLocation: best.sourceLocation || 'body',
        targetEndpointIndex: targetIdx,
        targetLocation: lit.location,
        targetKey: lit.key,
        // The matched candidate's own value, NOT lit.value — for a header these differ
        // (lit.value is the whole header text, e.g. "Bearer <token>"; best.value is just
        // the token) and script generation needs the exact substring to replace.
        value: best.value,
        varName: suggestVarName(lit.location, lit.key, best.jsonPath),
        confidence,
        status: 'auto',
      });
    }
  });
  return rules;
}

// Reconciles a fresh detection pass against previously stored rules so a human's
// decision survives re-running pre-run (e.g. after the target collection changes):
// - A rule the user already confirmed or rejected keeps that verdict (and whatever
//   varName they edited) instead of being silently overwritten by a new 'auto' guess.
// - A manually-authored rule (confidence 'manual' — added by a user, never produced by
//   detection) is always kept even if this detection pass doesn't happen to redetect it.
// - Anything else (a not-yet-reviewed 'auto'/'low' suggestion) is replaced by the fresh
//   result, and disappears entirely if the fresh pass no longer finds it — there was
//   nothing for a human to lose by that, since no one had acted on it yet.
function mergeRules(previousRules, freshRules) {
  const prevById = new Map((previousRules || []).map(r => [r.id, r]));
  const merged = freshRules.map(r => {
    const prev = prevById.get(r.id);
    return (prev && (prev.status === 'confirmed' || prev.status === 'rejected')) ? prev : r;
  });
  // A confirmed/rejected rule must survive even when THIS run's fresh detection pass
  // doesn't happen to re-propose the same id — which, for a volatile value (a session
  // token that's different on every live run), is actually the common case: detection
  // only matches when a freshly captured source value literally equals the target's
  // still-static recorded literal, which is true at most once (whenever that coincidence
  // holds) and essentially never again afterward. Without this, a rule the user already
  // confirmed would silently vanish from storage the very next pre-run — worse than the
  // "silently overwritten" this function's own docs above promise never happens — and a
  // generated script would quietly regress back to replaying the stale recorded literal.
  for (const prev of previousRules || []) {
    if (merged.some(m => m.id === prev.id)) continue;
    if (prev.confidence === 'manual' || prev.status === 'confirmed' || prev.status === 'rejected') merged.push(prev);
  }
  return merged;
}

// After one or more endpoints are permanently removed from a collection (see
// routes/collections.js's endpoint-delete route), every correlationRule/fieldGenerator/
// endpointOverride that references an endpoint by its array INDEX (not a stable id) needs
// updating: an entry referencing a REMOVED index no longer has anything to point at and
// must be dropped; an entry referencing an index that came AFTER a removed one must shift
// down by however many removed indices preceded it, or it would silently misdirect at the
// wrong (shifted) endpoint after deletion. Applied identically to every env's config row
// for a collection, since `json_content`'s endpoint array is shared across envs but
// correlationRules/fieldGenerators/endpointOverrides are stored per collection+env.
function reindexAfterEndpointRemoval(envCfg, removedIndices) {
  const removed = new Set(removedIndices);
  const sortedRemoved = [...removed].sort((a, b) => a - b);
  const shiftOf = (idx) => sortedRemoved.filter(r => r < idx).length;
  const remap = (idx) => (removed.has(idx) ? null : idx - shiftOf(idx));

  const cfg = { ...envCfg };
  if (Array.isArray(cfg.correlationRules)) {
    cfg.correlationRules = cfg.correlationRules
      .map(r => {
        const s = remap(r.sourceEndpointIndex);
        const t = remap(r.targetEndpointIndex);
        if (s === null || t === null) return null;
        return { ...r, sourceEndpointIndex: s, targetEndpointIndex: t, id: `${t}:${r.targetLocation}:${r.targetKey}` };
      })
      .filter(Boolean);
  }
  if (Array.isArray(cfg.fieldGenerators)) {
    cfg.fieldGenerators = cfg.fieldGenerators
      .map(g => {
        const t = remap(g.targetEndpointIndex);
        if (t === null) return null;
        return { ...g, targetEndpointIndex: t, id: `${t}:${g.targetLocation}:${g.targetKey}` };
      })
      .filter(Boolean);
  }
  if (cfg.endpointOverrides && typeof cfg.endpointOverrides === 'object') {
    const next = {};
    for (const [k, v] of Object.entries(cfg.endpointOverrides)) {
      const t = remap(Number(k));
      if (t !== null) next[t] = v;
    }
    cfg.endpointOverrides = next;
  }
  return cfg;
}

// Flattens EVERY prior pre-run response (body leaves AND response headers, same denylist
// buildSourceIndex uses) into a field-name -> value map, plus a richer per-occurrence list
// attributed to the endpoint that produced it. Used by ai.js's /pre-run/heal to let the AI
// reference ANY captured field via {{captured:KEY}} — not just the fixed TOKEN_KEYS list
// extractAllTokens() (preRunEngine.js) was restricted to. `fields` (first-occurrence-wins
// per name) is what actually resolves a {{captured:KEY}} placeholder; `described` (every
// occurrence, endpoint-attributed) is strictly for showing the AI enough context to pick
// the right key name when more than one endpoint happens to have a same-named field.
function describeAllCapturedFields(priorResults, endpoints) {
  const fields = {};
  const described = [];
  (priorResults || []).forEach((r, i) => {
    if (!r) return;
    const fromEndpoint = endpoints?.[i]?.name || endpoints?.[i]?.url || `#${i}`;
    const body = typeof r.body === 'string' ? parseBodyToObject(r.body) : r.body;
    if (body && typeof body === 'object') {
      for (const leaf of flattenToLeaves(body)) {
        if (isNoiseValue(leaf.value)) continue;
        const name = rawFieldNameOf(leaf.jsonPath);
        if (!name) continue;
        if (!(name in fields)) fields[name] = leaf.value;
        described.push({ name, value: leaf.value, fromEndpoint, location: 'body' });
      }
    }
    for (const [headerName, headerValue] of Object.entries(r.responseHeaders || {})) {
      if (HEADER_SOURCE_DENYLIST.has(headerName.toLowerCase())) continue;
      if (typeof headerValue !== 'string' || isNoiseValue(headerValue)) continue;
      if (!(headerName in fields)) fields[headerName] = headerValue;
      described.push({ name: headerName, value: headerValue, fromEndpoint, location: 'header' });
    }
  });
  return { fields, described };
}

// Resolves a bare field name (e.g. "accessToken", no jsonPath syntax) against a real
// parsed JSON object, so a manual correlation rule (routes/ai.js's /correlations/manual)
// never has to make the USER type "$.accessToken" — they can just say the name, the same
// way auto-detection's own field names read in the review UI. Searches every depth (not
// just top level), since `flattenToLeaves` already walks the whole tree. Three outcomes:
//   - exactly one leaf matches  -> { jsonPath: '$.a.b', ambiguous: false }
//   - zero leaves match         -> { jsonPath: null, ambiguous: false, candidates: [] }
//   - 2+ leaves share that name -> { jsonPath: null, ambiguous: true, candidates: [...] }
//     (e.g. two different nested objects both have an "id" field) — the caller must ask
//     for a real jsonPath to disambiguate rather than silently guessing which one.
function resolveFieldNameToJsonPath(body, fieldName) {
  if (!body || typeof body !== 'object' || !fieldName) return { jsonPath: null, ambiguous: false, candidates: [] };
  const target = String(fieldName).toLowerCase();
  const matches = flattenToLeaves(body).filter(l => rawFieldNameOf(l.jsonPath).toLowerCase() === target);
  if (matches.length === 0) return { jsonPath: null, ambiguous: false, candidates: [] };
  if (matches.length === 1) return { jsonPath: matches[0].jsonPath, ambiguous: false, candidates: [matches[0].jsonPath] };
  return { jsonPath: null, ambiguous: true, candidates: [...new Set(matches.map(m => m.jsonPath))] };
}

module.exports = {
  MIN_VALUE_LENGTH, isNoiseValue, HEADER_SOURCE_DENYLIST, flattenToLeaves, fieldNameOf, rawFieldNameOf, namesRelated,
  parseBodyToObject, extractRequestLiterals, buildSourceIndex, suggestVarName, detectCorrelations, mergeRules,
  describeAllCapturedFields, resolveFieldNameToJsonPath, reindexAfterEndpointRemoval,
};
