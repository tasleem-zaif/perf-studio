// Shared engine for pre-run: firing an endpoint live, resolving {{var}} templates
// (including {{captured:X}} references to a value dynamically extracted from another
// response earlier in the same pre-run, e.g. a login's token), and token/cookie
// extraction. Used by both the main pre-run route and the per-endpoint "Fix with AI"
// heal route (routes/ai.js) so a fix behaves identically in both places.

// Block private/loopback IP ranges (SSRF protection)
const BLOCKED_PATTERNS = [
  /^https?:\/\/localhost/i,
  /^https?:\/\/127\./,
  /^https?:\/\/0\./,
  /^https?:\/\/10\./,
  /^https?:\/\/192\.168\./,
  /^https?:\/\/172\.(1[6-9]|2\d|3[01])\./,
  /^https?:\/\/169\.254\./,
];

function isSafeUrl(url) {
  return url.startsWith('http://') || url.startsWith('https://')
    ? !BLOCKED_PATTERNS.some(p => p.test(url))
    : false;
}

// Replace {{key}} tokens with values from the collection's env config (e.g. {{url}}) or
// {{captured:key}} tokens with a value captured from a prior response in this same
// pre-run (e.g. {{captured:refreshToken}}). Unresolved tokens are left as-is so the
// caller can report exactly which variable is missing. Re-applied until the string
// stops changing (capped) so a variable whose own value is itself a template — e.g.
// baseUrl = "{{protocol}}://{{host}}" — gets fully resolved, not left with nested tokens.
function substituteVars(str, vars) {
  if (typeof str !== 'string') return str;
  let prev = str;
  for (let i = 0; i < 5; i++) {
    const next = prev.replace(/\{\{([\w:]+)\}\}/g, (match, key) =>
      Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match);
    if (next === prev) break;
    prev = next;
  }
  return prev;
}

function findMissingVars(str) {
  if (typeof str !== 'string') return [];
  return [...str.matchAll(/\{\{([\w:]+)\}\}/g)].map(m => m[1]);
}

// Resolves {{var}} tokens for a GENERATED SCRIPT (JMeter/k6) rather than a live pre-run
// request: a variable with a known value is baked in as that real value; anything still
// unresolved falls back to a JMeter ${var} reference instead of being left as literal,
// un-substituted {{var}} text — which JMeter/k6 don't support at all and would send to
// the server verbatim, failing every request that uses it. Used by both script
// generation (testSuites.js) and auto-heal's mechanical {{var}} fix (autoHealer.js) so
// both apply the exact same rule.
function resolveForScript(str, variables) {
  if (typeof str !== 'string') return str;
  return str.replace(/\{\{(\w+)\}\}/g, (m, key) => {
    const v = (variables || {})[key];
    // An empty-string value is treated the same as "not set" — a leftover placeholder
    // variable from an imported Postman environment (e.g. a "bearerToken" field the
    // collection never actually uses) must never be silently baked in as a blank
    // credential. Falling back to ${key} at least leaves a visible, debuggable JMeter
    // variable reference instead of a request that fails with an empty Authorization header.
    return (v !== undefined && v !== null && v !== '') ? v : `\${${key}}`;
  });
}

// parseCollection.js stores an endpoint's query params separately from its URL
// (ep.queryParams) — but Postman's `url.raw` (what ep.url comes from) often already
// embeds the same params as a literal query string, since `raw`/`query`/`host`/`path`
// are just different views of the same URL the user typed. Only append a queryParams
// entry if its key isn't already present in the URL's own query string, otherwise
// a collection like this one duplicates every param (?limit=10&skip=0&limit=10&skip=0).
function appendQueryParams(url, queryParams, vars) {
  const entries = Object.entries(queryParams || {}).filter(([k]) => k);
  if (!entries.length) return url;
  const [, existingQuery = ''] = url.split(/\?(.*)/s);
  const existingKeys = new Set(
    existingQuery.split('&').filter(Boolean).map(pair => decodeURIComponent(pair.split('=')[0]))
  );
  const newEntries = entries.filter(([k]) => !existingKeys.has(k));
  if (!newEntries.length) return url;
  const qs = newEntries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(substituteVars(String(v ?? ''), vars))}`)
    .join('&');
  return url + (existingQuery ? '&' : '?') + qs;
}

// Recursively search an object for common token field names. Every matching field is
// captured (not just the first) — a login response commonly returns both an access
// token and a refresh token, and different endpoints need different ones injected.
const TOKEN_KEYS = ['token', 'access_token', 'accessToken', 'jwt', 'id_token', 'idToken',
                    'auth_token', 'authToken', 'bearer', 'Bearer', 'sessionToken', 'session_token',
                    'refreshToken', 'refresh_token'];
// The subset eligible to be the blanket "inject on any 401" default — refresh-type
// tokens are deliberately excluded, since blindly using one as a generic Bearer token
// is exactly the bug this file fixes; a refresh token should only be used where an
// explicit per-endpoint override (or the AI heal flow) says so.
const DEFAULT_TOKEN_KEYS = TOKEN_KEYS.filter(k => !/refresh/i.test(k));
const WRAPPER_KEYS = ['data', 'result', 'response', 'user', 'auth', 'payload', 'body'];

function extractAllTokens(body, responseHeaders) {
  const found = {};
  if (typeof body === 'object' && body !== null) {
    for (const key of TOKEN_KEYS) {
      if (typeof body[key] === 'string' && body[key].length > 8 && !found[key]) found[key] = body[key];
    }
    for (const wrapper of WRAPPER_KEYS) {
      if (body[wrapper] && typeof body[wrapper] === 'object') {
        for (const key of TOKEN_KEYS) {
          if (typeof body[wrapper][key] === 'string' && body[wrapper][key].length > 8 && !found[key]) found[key] = body[wrapper][key];
        }
      }
    }
  }
  // Fallback: a bearer token returned only via response headers, not the body
  if (!Object.keys(found).length) {
    const hdr = responseHeaders?.['authorization'] || responseHeaders?.['x-auth-token'] || responseHeaders?.['x-access-token'];
    if (hdr) found.token = hdr.replace(/^Bearer\s+/i, '');
  }
  return found;
}

// Picks the token to inject as the blanket "any 401 gets this" default, preferring
// the same field-name priority order pre-run has always used.
function pickDefaultToken(capturedTokens) {
  for (const key of DEFAULT_TOKEN_KEYS) if (capturedTokens[key]) return capturedTokens[key];
  return null;
}

// Common variable-name aliases for a port value, used as a fallback when a resolved URL
// string doesn't carry an explicit port. Very common in real collections: protocol/host/
// port are kept as separate variables without ever stitching {{port}} into the base-URL
// template itself (e.g. baseUrl = "{{protocol}}://{{host}}", with "port" defined
// separately) — the URL alone then has no way to reveal the port, even though the
// collection unambiguously specifies one.
const PORT_VAR_ALIASES = ['port', 'serverport', 'server_port', 'targetport', 'target_port'];

function findPortVariable(variables) {
  for (const [k, v] of Object.entries(variables || {})) {
    if (PORT_VAR_ALIASES.includes(k.toLowerCase()) && v) return String(v);
  }
  return '';
}

// THE single place an endpoint's raw URL (which may reference {{var}} templates, including
// one whose own value is itself a template) is resolved into a concrete {protocol, url, port}
// set. Used by collection import/update auto-populate, script generation's host resolution,
// and the project-wide reference config — previously each of those had its own independent
// copy of this logic, which is how the same two bugs (single-pass {{var}} substitution, and
// never falling back to a separate port variable) ended up needing to be fixed three times.
// Any future caller that needs "what host does this endpoint's URL resolve to" should use
// this function rather than adding a fourth copy.
function resolveUrlSet(rawUrl, variables) {
  if (!rawUrl) return null;
  const resolved = substituteVars(rawUrl, variables || {});
  if (resolved.includes('{{')) return null; // still has an unresolved token — not a real host
  if (resolved.startsWith('/') && !resolved.includes('://')) return null; // relative path, no host at all
  try {
    const raw = resolved.startsWith('http') ? resolved : `https://${resolved}`;
    const u = new URL(raw);
    if (!u.hostname) return null;
    const port = u.port || findPortVariable(variables);
    return { protocol: u.protocol.replace(':', ''), url: u.hostname, port };
  } catch { return null; }
}

// Extract cookies from set-cookie header for session-based auth
function extractCookies(responseHeaders) {
  const setCookie = responseHeaders?.['set-cookie'];
  if (!setCookie) return null;
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  return cookies.map(c => c.split(';')[0]).join('; ');
}

// Reads one specific cookie's value out of a live response's Set-Cookie header(s) — the
// live-firing counterpart to testSuites.js's cookieRegexExtractorXml/k6CookieAccessor.
// Reuses extractCookies' "name=value" flattening (same lenient join used for the
// blanket cookie-jar re-injection elsewhere in this file) rather than a separate parser.
function getCookieValue(responseHeaders, cookieName) {
  const flat = extractCookies(responseHeaders); // "name1=value1; name2=value2" or null
  if (!flat) return undefined;
  const re = new RegExp(`(?:^|;\\s*)${cookieName}=([^;]+)`, 'i');
  const m = flat.match(re);
  return m ? m[1] : undefined;
}

// A saved per-endpoint override only applies if the endpoint at that array index still
// looks like the one it was created for — guards against a stale override silently
// misapplying to the wrong endpoint after a collection re-import reorders things.
function fingerprintMatches(ep, override) {
  if (!ep || !override) return false;
  return (ep.method || 'GET') === override.method && (ep.name || ep.url || '') === override.name;
}

// Namespaces a captured-token map under `captured:X` keys so it can be merged into the
// same `vars` object substituteVars() reads, alongside a collection's own {{var}} values.
function namespaceCaptured(capturedTokens) {
  const out = {};
  for (const [k, v] of Object.entries(capturedTokens || {})) out[`captured:${k}`] = v;
  return out;
}

// Fires one endpoint live: resolves {{var}}/{{captured:X}} templates (with an optional
// per-endpoint override's headers/body/url merged on top), checks SSRF safety, fires the
// request with a 5s timeout, and extracts any tokens/cookies from the response.
async function fireEndpoint(ep, { variables = {}, capturedTokens = {}, override = null, extraHeaders = {} } = {}) {
  const vars = { ...variables, ...namespaceCaptured(capturedTokens) };
  const rawUrl = override?.url || ep.url;
  const url = appendQueryParams(substituteVars(rawUrl, vars), ep.queryParams, vars);
  const headers = { 'Content-Type': 'application/json', ...(ep.headers || {}), ...(override?.headers || {}), ...extraHeaders };
  for (const k of Object.keys(headers)) headers[k] = substituteVars(headers[k], vars);
  let body = override?.body ?? ep.body;
  if (typeof body === 'string') body = substituteVars(body, vars);

  const missing = findMissingVars(url);
  if (missing.length) {
    return { endpoint: ep.name || ep.url, url, method: ep.method || 'GET', skipped: true, reason: `Missing value for variable(s): ${missing.join(', ')} — set them in this collection's environment config`, success: false };
  }
  if (!url || !isSafeUrl(url)) {
    return { endpoint: ep.name || ep.url, url, method: ep.method || 'GET', skipped: true, reason: 'URL blocked or invalid', success: false };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  const fetchOpts = { method: ep.method || 'GET', headers, signal: controller.signal };
  if (body && ep.method !== 'GET') fetchOpts.body = typeof body === 'string' ? body : JSON.stringify(body);
  try {
    const r = await fetch(url, fetchOpts);
    clearTimeout(timer);
    const text = await r.text();
    let respBody;
    try { respBody = JSON.parse(text); } catch { respBody = text.slice(0, 1000); }
    const responseHeaders = Object.fromEntries(r.headers.entries());
    const extracted = extractAllTokens(respBody, responseHeaders);
    const newCookies = extractCookies(responseHeaders);
    return {
      endpoint: ep.name || ep.url, method: ep.method || 'GET', url,
      status: r.status, statusText: r.statusText,
      requestHeaders: headers, requestBody: fetchOpts.body || null,
      responseHeaders, body: respBody,
      success: r.status >= 200 && r.status < 400,
      _extracted: extracted, _cookies: newCookies,
      tokenExtracted: Object.keys(extracted).length ? true : undefined,
    };
  } catch (e) {
    clearTimeout(timer);
    return { endpoint: ep.name || ep.url, method: ep.method || 'GET', url, error: e.name === 'AbortError' ? 'Request timed out (5s limit)' : e.message, success: false };
  }
}

// Reads the value at a jsonPath ("$.a.b[0]") out of a real parsed response body — the
// live-firing counterpart to scriptCorrelation.jsonPathToOptionalChain (which instead
// emits accessor CODE for a generated script to run later; here we need the actual value
// right now, to fire the NEXT request in this same pre-run pass).
function getValueAtJsonPath(obj, jsonPath) {
  const body = String(jsonPath || '').replace(/^\$\.?/, '');
  if (!body) return obj;
  const parts = body.match(/[^.[\]]+/g) || [];
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[/^\d+$/.test(p) ? Number(p) : p];
  }
  return cur;
}

// Live-firing counterpart to scriptCorrelation.substituteCorrelatedLiterals: instead of
// replacing a recorded literal with a `${var}` reference for an ENGINE to resolve later,
// this replaces it with the REAL value captured earlier in this same pre-run pass, since
// pre-run makes the actual request right now rather than generating code for later.
function applyLiveCorrelatedValues(ep, targetRules, capturedValues) {
  if (!targetRules || !targetRules.length) return ep;
  const { replaceBodyLiteral } = require('./scriptCorrelation');
  const { rawFieldNameOf } = require('./correlationEngine');
  let url = ep.url;
  const headers = { ...(ep.headers || {}) };
  const queryParams = { ...(ep.queryParams || {}) };
  let body = ep.body;

  for (const rule of targetRules) {
    let liveValue = capturedValues[rule.varName];
    // The source endpoint's response didn't actually contain this field this run (a
    // different server response shape, or the source request itself failed) — leave the
    // recorded literal in place rather than guessing; the request will fail naturally and
    // visibly, same as it would have before this feature existed.
    if (liveValue === undefined) continue;
    if (rule.transform) {
      const { transformLiveValue } = require('./transforms');
      liveValue = transformLiveValue(rule.transform, liveValue);
    }

    if (rule.targetLocation === 'urlPath') {
      if (url.includes(rule.value)) url = url.split(rule.value).join(liveValue);
    } else if (rule.targetLocation === 'query') {
      if (String(queryParams[rule.targetKey]) === rule.value) queryParams[rule.targetKey] = liveValue;
    } else if (rule.targetLocation === 'header') {
      const k = Object.keys(headers).find(h => h.toLowerCase() === String(rule.targetKey).toLowerCase());
      if (rule.value == null) {
        // "Inject" mode (see scriptCorrelation.js's matching branch) — always ensure this
        // header carries the live value, whether or not this endpoint was ever recorded
        // with it, so pre-run can actually prove the injection works before generation.
        // A real HTTP `Cookie` request header is a "name=value" pair per RFC 6265, not a
        // bare value — a cookie-sourced value injected straight into a literal "cookie"
        // header target (no pre-existing literal to preserve the "name=" prefix from,
        // since this IS inject mode) must be re-wrapped in that shape, or no server-side
        // cookie parser will ever recognize it and the request 401s regardless of how
        // fresh the captured value is.
        const needsCookiePair = rule.sourceLocation === 'cookie' && String(rule.targetKey).toLowerCase() === 'cookie';
        headers[k || rule.targetKey] = needsCookiePair ? `${rule.sourceJsonPath}=${liveValue}` : liveValue;
      } else if (k && typeof headers[k] === 'string' && headers[k].includes(rule.value)) {
        headers[k] = headers[k].split(rule.value).join(liveValue);
      }
    } else if (rule.targetLocation === 'body' && typeof body === 'string') {
      body = replaceBodyLiteral(body, rawFieldNameOf(rule.targetKey), rule.value, liveValue);
    }
  }
  return { ...ep, url, headers, body, queryParams };
}

// Fires every endpoint SEQUENTIALLY (unlike the default parallel-chunk pre-run), applying
// confirmed correlation rules with values actually captured from earlier responses in this
// same pass — so a pre-run can prove the full chain (login -> create -> fetch-by-id, etc.)
// really works before a script is ever generated from it. Only used when a collection has
// applicable correlation rules (routes/ai.js decides); collections without any keep using
// the faster parallel-chunk path unchanged, since sequential-only-when-needed avoids
// regressing pre-run's speed on the common case (no correlation involved).
// Computes a firing order where every rule's source endpoint runs before its target
// (Kahn's algorithm) — the raw collection order is NOT guaranteed to already satisfy this.
// A collection recorded by clicking around a real app (many endpoints, several unrelated
// flows) very commonly has its "Login" request recorded well after some endpoint that
// actually depends on it; firing strictly in recorded order then means the dependent
// endpoint runs before its source ever captured a live value, silently falling back to the
// stale recorded literal and failing. Always prefers the lowest original index among
// endpoints that are ready to fire, so a collection that's ALREADY in a valid order fires
// in that same order, unchanged. A cycle (shouldn't occur — detectCorrelations never
// proposes a backward reference, but a manual rule theoretically could) leaves some
// endpoints permanently non-ready; those are appended in their original order rather than
// silently dropped from execution.
function topologicalFireOrder(endpointCount, correlationRules) {
  const indegree = new Array(endpointCount).fill(0);
  const edgesFrom = new Map(); // sourceIndex -> Set(targetIndex)
  for (const rule of (correlationRules || [])) {
    const s = rule.sourceEndpointIndex, t = rule.targetEndpointIndex;
    if (s == null || t == null || s === t || s < 0 || t < 0 || s >= endpointCount || t >= endpointCount) continue;
    if (!edgesFrom.has(s)) edgesFrom.set(s, new Set());
    if (!edgesFrom.get(s).has(t)) { edgesFrom.get(s).add(t); indegree[t]++; }
  }
  const ready = [];
  for (let i = 0; i < endpointCount; i++) if (indegree[i] === 0) ready.push(i);
  const order = [];
  while (ready.length) {
    ready.sort((a, b) => a - b);
    const i = ready.shift();
    order.push(i);
    for (const t of (edgesFrom.get(i) || [])) {
      indegree[t]--;
      if (indegree[t] === 0) ready.push(t);
    }
  }
  if (order.length < endpointCount) {
    const seen = new Set(order);
    for (let i = 0; i < endpointCount; i++) if (!seen.has(i)) order.push(i);
  }
  return order;
}

async function fireEndpointsWithCorrelation(endpoints, correlationRules, { variables = {} } = {}) {
  const { groupRulesBySource, groupRulesByTarget } = require('./scriptCorrelation');
  const rulesBySource = groupRulesBySource(correlationRules);
  const rulesByTarget = groupRulesByTarget(correlationRules);
  const capturedValues = {};
  const results = new Array(endpoints.length);

  for (const i of topologicalFireOrder(endpoints.length, correlationRules)) {
    const targetRules = rulesByTarget.get(i) || [];
    const liveEp = applyLiveCorrelatedValues(endpoints[i], targetRules, capturedValues);
    const result = await fireEndpoint(liveEp, { variables });
    results[i] = result;

    const sourceFields = rulesBySource.get(i) || [];
    if (sourceFields.length) {
      let parsedBody = result.body;
      if (typeof parsedBody === 'string') { try { parsedBody = JSON.parse(parsedBody); } catch { parsedBody = null; } }
      for (const { varName, jsonPath, sourceLocation } of sourceFields) {
        if (sourceLocation === 'header') {
          // result.responseHeaders keys are already lowercase (fireEndpoint builds them
          // from the Fetch API's Headers.entries(), which the spec normalizes) — same
          // casing correlationEngine.js detected the header name under, so a direct
          // lookup is safe here (unlike the generated-script side, which must handle a
          // REAL target server's original casing at its own future runtime).
          const v = result.responseHeaders?.[jsonPath];
          if (v !== undefined) capturedValues[varName] = String(v);
        } else if (sourceLocation === 'cookie') {
          const v = getCookieValue(result.responseHeaders, jsonPath);
          if (v !== undefined) capturedValues[varName] = v;
        } else if (parsedBody && typeof parsedBody === 'object') {
          const v = getValueAtJsonPath(parsedBody, jsonPath);
          if (v !== undefined) capturedValues[varName] = String(v);
        }
      }
    }
  }
  return results;
}

module.exports = {
  isSafeUrl, substituteVars, findMissingVars, appendQueryParams,
  getValueAtJsonPath, applyLiveCorrelatedValues, fireEndpointsWithCorrelation,
  TOKEN_KEYS, extractAllTokens, pickDefaultToken, extractCookies, getCookieValue,
  fingerprintMatches, fireEndpoint, resolveUrlSet, findPortVariable, resolveForScript,
};
