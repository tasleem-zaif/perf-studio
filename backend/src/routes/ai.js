const router = require('express').Router();
const auth = require('../middleware/auth');
const db = require('../db');
const ownsProject = require('../utils/ownsProject');
const { callAi } = require('../utils/aiClient');
const {
  extractAllTokens, pickDefaultToken, fingerprintMatches, fireEndpoint, fireEndpointsWithCorrelation,
} = require('../utils/preRunEngine');
const {
  detectCorrelations, mergeRules, describeAllCapturedFields, extractRequestLiterals,
  resolveFieldNameToJsonPath, parseBodyToObject, rawFieldNameOf,
} = require('../utils/correlationEngine');
const { filterApplicableRules } = require('../utils/scriptCorrelation');
const { isValidGeneratorType, GENERATORS } = require('../utils/fieldGenerators');
const { isValidTransform, TRANSFORMS } = require('../utils/transforms');

router.use(auth);

// Same djb2-style hash used on the frontend — identifies collection content changes
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString();
}

async function loadEnvConfig(collectionId, env) {
  const row = await db.prepare('SELECT config_json FROM collection_env_config WHERE collection_id = ? AND env = ?').get(collectionId, env);
  let cfg = {};
  try { cfg = JSON.parse(row?.config_json || '{}'); } catch {}
  return { row, cfg };
}

async function saveEnvConfig(collectionId, env, row, cfg) {
  if (row) {
    await db.prepare('UPDATE collection_env_config SET config_json = ? WHERE collection_id = ? AND env = ?')
      .run(JSON.stringify(cfg), collectionId, env);
  } else {
    await db.prepare('INSERT INTO collection_env_config (collection_id, env, config_json) VALUES (?, ?, ?)')
      .run(collectionId, env, JSON.stringify(cfg));
  }
}

// Shared by GET/POST /correlations routes below: loads the collection + its env config,
// enforcing the same ownership/existence checks the rest of this file uses.
async function loadCollectionAndCfg(userId, projectId, collectionId) {
  if (!await ownsProject(userId, projectId)) return { error: [404, 'Project not found'] };
  const collection = await db.prepare('SELECT * FROM collections WHERE id = ? AND project_id = ?').get(collectionId, projectId);
  if (!collection) return { error: [404, 'Collection not found'] };
  const { row: envRow, cfg: envCfg } = await loadEnvConfig(collectionId, collection.environment);
  return { collection, envRow, envCfg };
}

router.post('/pre-run', async (req, res) => {
  try {
    const { collection_id, project_id, suite_id } = req.body;
    if (!collection_id || !project_id) return res.status(400).json({ error: 'collection_id and project_id required' });

    if (!await ownsProject(req.userId, project_id)) return res.status(404).json({ error: 'Project not found' });
    const collection = await db.prepare('SELECT * FROM collections WHERE id = ? AND project_id = ?').get(collection_id, project_id);
    if (!collection) return res.status(404).json({ error: 'Collection not found' });

    let endpoints = [];
    try { endpoints = JSON.parse(collection.json_content); } catch { return res.status(400).json({ error: 'Invalid collection data' }); }

    // Load {{var}} values for this collection's default environment (set at import time,
    // from a collection's own `variable` defaults and/or an uploaded Postman environment
    // file) and any per-endpoint fixes previously applied via the "Fix with AI" heal action.
    const { row: envRow, cfg: envCfg } = await loadEnvConfig(collection_id, collection.environment);
    const variables = envCfg.variables || {};
    const overrides = envCfg.endpointOverrides || {};

    // Phase 1: fire every endpoint. A collection with confirmed/high-confidence correlation
    // rules (utils/correlationEngine.js) fires SEQUENTIALLY instead of in parallel chunks —
    // correlation only works if a source's live response is captured before its target
    // fires, which parallel firing can't guarantee. This is what actually proves the whole
    // chain (login -> create -> fetch-by-id, etc.) works before a script is ever generated,
    // not just that each request individually got a response. Collections with no
    // correlation rules keep the original faster parallel-chunk path, unchanged.
    const applicableRules = filterApplicableRules(envCfg.correlationRules);
    let rawResults;
    if (applicableRules.length) {
      rawResults = await fireEndpointsWithCorrelation(endpoints, applicableRules, { variables });
    } else {
      // Bounded-concurrency chunks (5s timeout each) — not capped to a subset, but never
      // all fired at once either, to avoid hammering the target server with a huge burst
      // of simultaneous requests on large collections.
      const CHUNK_SIZE = 20; // concurrency per chunk — matches the old single-batch size
      rawResults = [];
      for (let i = 0; i < endpoints.length; i += CHUNK_SIZE) {
        const chunk = endpoints.slice(i, i + CHUNK_SIZE);
        rawResults.push(...await Promise.all(chunk.map(ep => fireEndpoint(ep, { variables }))));
        if (i + CHUNK_SIZE < endpoints.length) await new Promise(r => setTimeout(r, 250));
      }
    }

    // Merge every token-like field found across all responses (not just the first) — a
    // login response commonly returns both an access token and a refresh token, and
    // different endpoints may need different ones injected (see per-endpoint overrides).
    const capturedTokens = {};
    let cookieJar = null;
    for (const r of rawResults) {
      if (r._extracted) for (const [k, v] of Object.entries(r._extracted)) if (!capturedTokens[k]) capturedTokens[k] = v;
      if (r._cookies && !cookieJar) cookieJar = r._cookies;
    }
    const defaultToken = pickDefaultToken(capturedTokens);

    // Phase 2: an endpoint with a saved AI-fixed override gets re-fired with that override
    // applied ONLY if Phase 1 didn't already succeed on its own. A saved override predates
    // whatever fixed the endpoint in Phase 1 just now (e.g. a correlation rule confirmed
    // after the override was created) — unconditionally re-applying it would silently
    // clobber a working result with a stale fix, which is exactly what happens when the
    // override still references a field (e.g. a cookie-sourced {{captured:KEY}}) that was
    // never resolvable in the first place. Anything that's still failing after Phase 1,
    // override or not, still gets the saved-override retry (its original purpose) or —
    // failing that — one retry with the blanket default token, same as before.
    const responses = await Promise.all(rawResults.map(async (r, i) => {
      const ep = endpoints[i];
      const saved = overrides[i];
      const override = !r.success && fingerprintMatches(ep, saved) ? saved : null;

      if (override) {
        const retry = await fireEndpoint(ep, { variables, capturedTokens, override });
        retry.tokenInjected = true;
        retry.aiFixed = true;
        delete retry._extracted; delete retry._cookies;
        return retry;
      }
      if (r.status === 401 && defaultToken) {
        const retry = await fireEndpoint(ep, {
          variables, capturedTokens,
          extraHeaders: { Authorization: `Bearer ${defaultToken}`, ...(cookieJar ? { Cookie: cookieJar } : {}) },
        });
        retry.tokenInjected = true;
        delete retry._extracted; delete retry._cookies;
        return retry;
      }
      const clean = { ...r };
      if (defaultToken && !r._extracted) clean.tokenInjected = true;
      delete clean._extracted; delete clean._cookies;
      return clean;
    }));

    // Persist results — always on collection, also on test_suite when suite_id provided (legacy)
    const hash = simpleHash(collection.json_content || '');
    await db.prepare('UPDATE collections SET pre_run_data = ?, pre_run_collection_hash = ? WHERE id = ?')
      .run(JSON.stringify(responses), hash, collection_id);
    if (suite_id) {
      await db.prepare('UPDATE test_suites SET pre_run_data = ?, pre_run_collection_hash = ? WHERE id = ?')
        .run(JSON.stringify(responses), hash, suite_id);
    }

    // Full correlation detection (tokens, query params, path segments, body fields — not
    // just auth) runs off this same live response set. Re-run on every pre-run (the
    // collection may have changed), but merge against whatever the user already
    // confirmed/rejected/added by hand so a re-run never silently undoes a human decision.
    const freshRules = detectCorrelations(endpoints, responses);
    const correlationRules = mergeRules(envCfg.correlationRules, freshRules);
    envCfg.correlationRules = correlationRules;
    await saveEnvConfig(collection_id, collection.environment, envRow, envCfg);

    res.json({ responses, correlationRules, extractedToken: defaultToken ? '(present — not returned for security)' : null });
  } catch (err) {
    console.error('[ai/pre-run] error:', err);
    res.status(500).json({ error: err.message || 'Pre-run failed unexpectedly' });
  }
});

// Lets a user coach the AI to fix ONE specific failing endpoint (e.g. "this needs the
// refreshToken from the login response, not the accessToken") instead of pre-run's blanket
// "retry any 401 with the one extracted token" heuristic. Only ever offered/accepted for an
// endpoint that's currently failing — mirrors the CI pipeline's custom-instruction heal
// (routes/ciPipeline.js POST /runs/:runId/heal, autoHealer.js's customInstruction prefix).
router.post('/pre-run/heal', async (req, res) => {
  try {
    const { project_id, collection_id, index, instruction } = req.body;
    if (!collection_id || !project_id || index === undefined || index === null || !instruction || !String(instruction).trim()) {
      return res.status(400).json({ error: 'collection_id, project_id, index, and instruction are required' });
    }
    if (!await ownsProject(req.userId, project_id)) return res.status(404).json({ error: 'Project not found' });
    const collection = await db.prepare('SELECT * FROM collections WHERE id = ? AND project_id = ?').get(collection_id, project_id);
    if (!collection) return res.status(404).json({ error: 'Collection not found' });

    let endpoints = [];
    try { endpoints = JSON.parse(collection.json_content); } catch { return res.status(400).json({ error: 'Invalid collection data' }); }
    let priorResults = [];
    try { priorResults = JSON.parse(collection.pre_run_data || '[]'); } catch {}

    const idx = Number(index);
    const ep = endpoints[idx];
    const prior = priorResults[idx];
    if (!ep || !prior) return res.status(404).json({ error: 'Endpoint not found — re-run pre-run and try again' });
    if (prior.success) return res.status(400).json({ error: 'This endpoint already succeeded — nothing to heal' });

    const { row: envRow, cfg: envCfg } = await loadEnvConfig(collection_id, collection.environment);
    const variables = envCfg.variables || {};
    const overrides = envCfg.endpointOverrides || {};

    // Recompute every captured token from the endpoints already fired in the last full
    // pre-run — no need to re-hit unrelated live endpoints just to know what's available.
    const capturedTokens = {};
    for (const r of priorResults) {
      if (!r) continue;
      for (const [k, v] of Object.entries(extractAllTokens(r.body, r.responseHeaders))) {
        if (!capturedTokens[k]) capturedTokens[k] = v;
      }
    }

    // Broader field pool (utils/correlationEngine.js) — ANY body field or response header
    // across prior results, not just the fixed TOKEN_KEYS list extractAllTokens() is
    // restricted to. Lets the AI reference {{captured:orderId}} etc. for the same reasons
    // the deterministic correlation engine can, not just auth tokens. capturedTokens wins
    // on any name collision — it's the already-battle-tested source for the handful of
    // token-shaped names, so this only ever ADDS coverage, never changes existing behavior.
    const { fields: capturedFieldValues, described: capturedFieldsDescribed } = describeAllCapturedFields(priorResults, endpoints);
    const allCaptured = { ...capturedFieldValues, ...capturedTokens };

    const systemPrompt = [
      'You are diagnosing a single failing API request captured during "pre-run" — a live pre-flight check that fires every endpoint in a collection before load-test script generation.',
      'Output ONLY a JSON object, no markdown fences, no prose outside the JSON, with this exact shape:',
      '{"issue": string, "fix": string, "fix_type": "header_override"|"body_override"|"url_override"|"no_fix", "headers"?: object, "body"?: string, "url"?: string}',
      '- "issue": 1-2 sentences on the root cause of the failure.',
      '- "fix": 1-2 sentences describing exactly what you changed and why.',
      '- Only include "headers"/"body"/"url" for fields you are overriding; omit anything you are not changing.',
      '- A value that should come from another response captured earlier in this pre-run (e.g. a refresh token, an order id, a resource id returned via a response header) MUST use the placeholder {{captured:KEY}}, where KEY is one of the "Captured fields available" listed below — never invent a KEY that is not listed.',
      '- A value that should come from the collection\'s own configured variables MUST use {{key}}, where key is one of the "Collection variables" listed below.',
      '- For an Authorization header or any other token/session value, ALWAYS prefer {{captured:KEY}} over a collection variable — a token is normally produced dynamically by a login/auth response, not configured statically. Only fall back to a collection variable if no matching captured field exists.',
      '- If more than one endpoint produced a same-named field, the "(from EndpointName)" annotations tell you which occurrence came from where — pick the one whose endpoint is actually relevant to this fix.',
      '- If the given information is not enough to determine a fix, return fix_type "no_fix" and explain why in "issue" — do not guess.',
    ].join('\n');

    const responseBodyStr = typeof prior.body === 'string' ? prior.body : JSON.stringify(prior.body, null, 2);
    const capturedFieldsList = capturedFieldsDescribed
      .map(f => `${f.name} (from ${f.fromEndpoint}, ${f.location})`)
      .join(', ') || '(none captured yet)';
    const userPrompt = [
      '=== USER INSTRUCTION (APPLY THIS FIX — HIGHEST PRIORITY) ===',
      String(instruction).trim(),
      '',
      '=== Failing Endpoint ===',
      `${ep.method || 'GET'} ${prior.url || ep.url}`,
      '',
      '=== Last Request Sent ===',
      `Headers: ${JSON.stringify(prior.requestHeaders || {}, null, 2)}`,
      `Body: ${prior.requestBody || '(none)'}`,
      '',
      '=== Last Response ===',
      `Status: ${prior.status || '(none)'} ${prior.statusText || ''}`,
      `Body: ${(responseBodyStr || '').slice(0, 2000)}`,
      prior.error ? `Error: ${prior.error}` : '',
      prior.reason ? `Skip reason: ${prior.reason}` : '',
      '',
      '=== Captured fields available (from any response in this pre-run — body fields AND response headers) ===',
      capturedFieldsList,
      '',
      '=== Collection variables available ===',
      // Blank values (e.g. a leftover placeholder from an imported Postman environment,
      // never actually populated) are excluded — offering them as a fix target only invites
      // the AI to "fix" a failure by wiring in an empty credential, which just moves the
      // failure elsewhere and is exactly the kind of bug this filtering prevents.
      Object.keys(variables).filter(k => variables[k] !== '' && variables[k] != null).join(', ') || '(none)',
    ].filter(Boolean).join('\n');

    const raw = await callAi(req.userId, systemPrompt, userPrompt, 'heal');
    const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || raw.match(/(\{[\s\S]*\})/);
    const jsonStr = match ? (match[1] || match[0]) : raw;
    let diagnosis;
    try { diagnosis = JSON.parse(jsonStr.trim()); }
    catch { return res.status(502).json({ error: 'AI returned an unparseable response', raw: String(raw).slice(0, 500) }); }

    if (diagnosis.fix_type === 'no_fix' || (!diagnosis.headers && !diagnosis.body && !diagnosis.url)) {
      return res.json({ diagnosis: { issue: diagnosis.issue, fix: diagnosis.fix, fix_type: 'no_fix' } });
    }

    // Persist the fix as a per-endpoint override — it now governs every future full
    // pre-run of this collection (see the /pre-run route above), not just this one retry.
    const override = {
      method: ep.method || 'GET', name: ep.name || ep.url || '',
      ...(diagnosis.headers ? { headers: diagnosis.headers } : {}),
      ...(diagnosis.body !== undefined ? { body: diagnosis.body } : {}),
      ...(diagnosis.url ? { url: diagnosis.url } : {}),
      issue: diagnosis.issue, fix: diagnosis.fix,
      updatedAt: new Date().toISOString(),
    };
    envCfg.endpointOverrides = { ...overrides, [idx]: override };
    await saveEnvConfig(collection_id, collection.environment, envRow, envCfg);

    // Re-fire just this one endpoint with the new override applied, to verify immediately.
    // Uses the combined field map so a {{captured:KEY}} the AI wrote for a non-token field
    // (e.g. {{captured:orderId}}) resolves here too, not just the original token names.
    const result = await fireEndpoint(ep, { variables, capturedTokens: allCaptured, override });
    delete result._extracted; delete result._cookies;
    result.aiFixed = true;

    priorResults[idx] = result;
    await db.prepare('UPDATE collections SET pre_run_data = ? WHERE id = ?').run(JSON.stringify(priorResults), collection_id);

    res.json({ diagnosis: { issue: diagnosis.issue, fix: diagnosis.fix, fix_type: diagnosis.fix_type }, result });
  } catch (err) {
    console.error('[ai/pre-run/heal] error:', err);
    res.status(500).json({ error: err.message || 'Heal failed unexpectedly' });
  }
});

// Lists whatever correlation rules were last computed by /pre-run for this collection
// (detection only runs as part of a pre-run — this route just reads the stored result,
// it never re-fires live requests).
router.get('/correlations', async (req, res) => {
  const { collection_id, project_id } = req.query;
  if (!collection_id || !project_id) return res.status(400).json({ error: 'collection_id and project_id required' });
  const { error, envCfg } = await loadCollectionAndCfg(req.userId, project_id, collection_id);
  if (error) return res.status(error[0]).json({ error: error[1] });
  res.json({ correlationRules: envCfg.correlationRules || [] });
});

// Accepts or rejects one detected rule (or a previously-added manual one) by id — the
// only mutation a reviewer needs day-to-day. Only 'confirmed' rules are ever burned into
// generated scripts (see testSuites.js); 'rejected' just means "don't ask me again",
// distinct from deleting the row outright.
router.post('/correlations/status', async (req, res) => {
  const { collection_id, project_id, id, status } = req.body;
  if (!collection_id || !project_id || !id || !['confirmed', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'collection_id, project_id, id, and a valid status are required' });
  }
  const { error, collection, envRow, envCfg } = await loadCollectionAndCfg(req.userId, project_id, collection_id);
  if (error) return res.status(error[0]).json({ error: error[1] });

  const rules = envCfg.correlationRules || [];
  const rule = rules.find(r => r.id === id);
  if (!rule) return res.status(404).json({ error: 'Correlation rule not found — re-run pre-run and try again' });
  rule.status = status;
  envCfg.correlationRules = rules;
  await saveEnvConfig(collection_id, collection.environment, envRow, envCfg);
  res.json({ correlationRules: rules });
});

// Lets a user hand-author a rule the heuristic missed (e.g. a value transformed between
// capture and reuse, which value-matching can never detect on its own). Always saved as
// pre-confirmed and 'manual' confidence — see correlationEngine.mergeRules, which keeps
// manual rules alive across every future re-detection regardless of what's redetected.
router.post('/correlations/manual', async (req, res) => {
  const {
    collection_id, project_id, sourceEndpointIndex, sourceJsonPath, sourceLocation,
    targetEndpointIndex, targetLocation, targetKey, varName, transform, value: explicitValue,
    injectIfMissing,
  } = req.body;
  // targetEndpointIndex accepts either a single index or an array — the same source/
  // varName/transform is applied across every listed target, one rule per target, so a
  // token extracted once (e.g. a session id from Login's cookie) can be wired into many
  // APIs in a single call instead of repeating the whole form per endpoint.
  const targetIndexes = Array.isArray(targetEndpointIndex) ? targetEndpointIndex : [targetEndpointIndex];
  if (
    !collection_id || !project_id || sourceEndpointIndex === undefined || !sourceJsonPath ||
    !targetIndexes.length || targetIndexes.some(i => i === undefined || i === null || i === '') ||
    !targetLocation || targetKey === undefined
  ) {
    return res.status(400).json({ error: 'sourceEndpointIndex, sourceJsonPath, targetEndpointIndex (one or more), targetLocation, and targetKey are required' });
  }
  if (sourceLocation !== undefined && !['body', 'header', 'cookie'].includes(sourceLocation)) {
    return res.status(400).json({ error: 'sourceLocation must be "body", "header", or "cookie"' });
  }
  // A transform is the ONLY way a rule can point at a value that doesn't literally match
  // anything in the source response (e.g. "target needs the md5 of the login response's
  // userId") — auto-detection can never propose this since value-matching requires the
  // literal to be identical, so it's always manually authored, always from this whitelist.
  if (transform !== undefined && !isValidTransform(transform)) {
    return res.status(400).json({ error: `Unknown transform "${transform}" — must be one of: ${Object.keys(TRANSFORMS).join(', ')}` });
  }
  // "Inject" mode (scriptCorrelation.js's header branch, rule.value === null) skips the
  // "a literal must already exist on the target" requirement entirely — for pushing an
  // auth/session value into endpoints that never recorded that header at all. Scoped to
  // headers only: a query param/body field/URL segment that was never recorded has no
  // well-defined place to "add" a value, unlike a header, which is just a name+value pair.
  if (injectIfMissing && targetLocation !== 'header') {
    return res.status(400).json({ error: 'injectIfMissing is only supported for targetLocation "header"' });
  }
  const { error, collection, envRow, envCfg } = await loadCollectionAndCfg(req.userId, project_id, collection_id);
  if (error) return res.status(error[0]).json({ error: error[1] });

  // Resolves a bare field name (no leading "$") against a real parsed body by searching
  // every leaf — so a user can just say "accessToken" instead of "$.accessToken". A full
  // jsonPath is still accepted untouched, for disambiguating a name that appears more than
  // once. `body: null` (nothing to validate against, e.g. pre-run never run) falls back to
  // a best-effort top-level guess rather than hard-failing.
  function resolveBareFieldName(body, name, label) {
    const trimmed = String(name).trim();
    if (trimmed.startsWith('$')) return { jsonPath: trimmed };
    if (!body) return { jsonPath: `$.${trimmed}` };
    const resolved = resolveFieldNameToJsonPath(body, trimmed);
    if (resolved.ambiguous) {
      return { httpError: `"${name}" matches multiple fields in the ${label}: ${resolved.candidates.join(', ')} — use one of these exact paths instead` };
    }
    if (!resolved.jsonPath) {
      return { httpError: `"${name}" was not found in the ${label} — check the field name, or provide a full jsonPath (e.g. "$.data.${trimmed}")` };
    }
    return { jsonPath: resolved.jsonPath };
  }

  let endpoints = [];
  try { endpoints = JSON.parse(collection.json_content || '[]'); } catch {}

  // Resolve the SOURCE field ONCE — shared across every target. Only meaningful for 'body'
  // (a header/cookie "field name" IS already the literal header/cookie name, not a
  // jsonPath, so it's used as typed for those).
  let resolvedSourceJsonPath = sourceJsonPath;
  if ((sourceLocation || 'body') === 'body') {
    let priorResults = [];
    try { priorResults = JSON.parse(collection.pre_run_data || '[]'); } catch {}
    const sourceResult = priorResults[Number(sourceEndpointIndex)];
    let sourceBody = sourceResult?.body;
    if (typeof sourceBody === 'string') sourceBody = parseBodyToObject(sourceBody);
    const resolved = resolveBareFieldName(sourceBody, sourceJsonPath, 'source endpoint\'s captured response');
    if (resolved.httpError) return res.status(400).json({ error: resolved.httpError });
    resolvedSourceJsonPath = resolved.jsonPath;
  }
  const defaultVarNameBase = (sourceLocation || 'body') === 'body' ? rawFieldNameOf(resolvedSourceJsonPath) : sourceJsonPath;
  const finalVarName = (varName || defaultVarNameBase).replace(/[^a-zA-Z0-9]/g, '_');

  // Applies per-target: resolves a bare targetKey, validates the literal exists (skipped
  // entirely in inject mode), and builds the rule. A failure for ONE target (doesn't exist,
  // or — outside inject mode — never recorded that field) doesn't block the others; each
  // target succeeds or is skipped independently and both lists are reported back.
  const rules = [...(envCfg.correlationRules || [])];
  const created = [];
  const skipped = [];
  for (const rawIdx of targetIndexes) {
    const idx = Number(rawIdx);
    const targetEp = endpoints[idx];
    if (!targetEp) { skipped.push({ targetEndpointIndex: idx, reason: 'Target endpoint not found in this collection' }); continue; }

    let resolvedTargetKey = targetKey;
    if (targetLocation === 'body') {
      let targetBody = targetEp.body;
      if (typeof targetBody === 'string') targetBody = parseBodyToObject(targetBody);
      const resolved = resolveBareFieldName(targetBody, targetKey, `endpoint #${idx}'s own request body`);
      if (resolved.httpError) { skipped.push({ targetEndpointIndex: idx, reason: resolved.httpError }); continue; }
      resolvedTargetKey = resolved.jsonPath;
    }

    let ruleValue = null;
    if (!injectIfMissing) {
      // substituteCorrelatedLiterals only ever replaces a literal that still matches
      // rule.value (its staleness guard) — a "replace" rule needs that CURRENT literal
      // recorded the same way auto-detection does, or it would silently never apply.
      const literal = extractRequestLiterals(targetEp).find(l => l.location === targetLocation && String(l.key) === String(resolvedTargetKey));
      if (!literal) {
        skipped.push({ targetEndpointIndex: idx, reason: `No literal value found at ${targetLocation} "${resolvedTargetKey}" on endpoint #${idx} — pass injectIfMissing to add it instead of replacing an existing value` });
        continue;
      }
      // For a header target, the recorded literal often WRAPS the correlated part with a
      // prefix (e.g. "Bearer <token>") — the value that must actually be searched-for/
      // replaced is the token alone, not the whole header text. Auto-detection resolves
      // this itself by matching against the source's own value; a manual rule has no such
      // source value to check against, so an explicit `value` (the substring to replace)
      // is required in that case and validated against what's really on the endpoint now.
      ruleValue = literal.value;
      if (explicitValue !== undefined) {
        const matches = targetLocation === 'header' ? literal.value.includes(explicitValue) : literal.value === explicitValue;
        if (!matches) {
          skipped.push({ targetEndpointIndex: idx, reason: `Provided value "${explicitValue}" was not found in endpoint #${idx}'s current literal ("${literal.value}")` });
          continue;
        }
        ruleValue = explicitValue;
      }
    }

    const id = `${idx}:${targetLocation}:${resolvedTargetKey}`;
    const existingAt = rules.findIndex(r => r.id === id);
    const rule = {
      id, sourceEndpointIndex: Number(sourceEndpointIndex), sourceJsonPath: resolvedSourceJsonPath,
      sourceLocation: sourceLocation || 'body',
      targetEndpointIndex: idx, targetLocation, targetKey: resolvedTargetKey,
      value: ruleValue, // null in inject mode — see scriptCorrelation.js's header branch
      varName: finalVarName,
      ...(transform ? { transform } : {}),
      confidence: 'manual', status: 'confirmed',
    };
    if (existingAt >= 0) rules[existingAt] = rule; else rules.push(rule);
    created.push(id);
  }

  if (!created.length) {
    return res.status(400).json({ error: 'No correlation rule could be created for any target endpoint', skipped });
  }

  envCfg.correlationRules = rules;
  await saveEnvConfig(collection_id, collection.environment, envRow, envCfg);
  res.json({ correlationRules: rules, created, skipped });
});

router.post('/correlations/delete', async (req, res) => {
  const { collection_id, project_id, id } = req.body;
  if (!collection_id || !project_id || !id) return res.status(400).json({ error: 'collection_id, project_id, and id are required' });
  const { error, collection, envRow, envCfg } = await loadCollectionAndCfg(req.userId, project_id, collection_id);
  if (error) return res.status(error[0]).json({ error: error[1] });

  const rules = (envCfg.correlationRules || []).filter(r => r.id !== id);
  envCfg.correlationRules = rules;
  await saveEnvConfig(collection_id, collection.environment, envRow, envCfg);
  res.json({ correlationRules: rules });
});

// Field generators (utils/fieldGenerators.js) — for a recorded literal that never came
// from any earlier response (a unique email/username/idempotency key), so correlation has
// no source to point at. Always user-authored: "does this field need to be unique" isn't
// reliably detectable from recorded traffic, so unlike correlationRules there is no
// auto-detection pass here, only manual add/list/delete.
router.get('/generators', async (req, res) => {
  const { collection_id, project_id } = req.query;
  if (!collection_id || !project_id) return res.status(400).json({ error: 'collection_id and project_id required' });
  const { error, envCfg } = await loadCollectionAndCfg(req.userId, project_id, collection_id);
  if (error) return res.status(error[0]).json({ error: error[1] });
  res.json({ fieldGenerators: envCfg.fieldGenerators || [], availableTypes: Object.keys(GENERATORS) });
});

router.post('/generators/manual', async (req, res) => {
  const { collection_id, project_id, targetEndpointIndex, targetLocation, targetKey, value, generator } = req.body;
  if (
    !collection_id || !project_id || targetEndpointIndex === undefined ||
    !targetLocation || targetKey === undefined || value === undefined || !generator
  ) {
    return res.status(400).json({ error: 'targetEndpointIndex, targetLocation, targetKey, value, and generator are required' });
  }
  if (!isValidGeneratorType(generator)) {
    return res.status(400).json({ error: `Unknown generator type "${generator}" — must be one of: ${Object.keys(GENERATORS).join(', ')}` });
  }
  const { error, collection, envRow, envCfg } = await loadCollectionAndCfg(req.userId, project_id, collection_id);
  if (error) return res.status(error[0]).json({ error: error[1] });

  const id = `${targetEndpointIndex}:${targetLocation}:${targetKey}`;
  const rules = (envCfg.fieldGenerators || []).filter(r => r.id !== id);
  rules.push({ id, targetEndpointIndex: Number(targetEndpointIndex), targetLocation, targetKey, value: String(value), generator });
  envCfg.fieldGenerators = rules;
  await saveEnvConfig(collection_id, collection.environment, envRow, envCfg);
  res.json({ fieldGenerators: rules });
});

router.post('/generators/delete', async (req, res) => {
  const { collection_id, project_id, id } = req.body;
  if (!collection_id || !project_id || !id) return res.status(400).json({ error: 'collection_id, project_id, and id are required' });
  const { error, collection, envRow, envCfg } = await loadCollectionAndCfg(req.userId, project_id, collection_id);
  if (error) return res.status(error[0]).json({ error: error[1] });

  const rules = (envCfg.fieldGenerators || []).filter(r => r.id !== id);
  envCfg.fieldGenerators = rules;
  await saveEnvConfig(collection_id, collection.environment, envRow, envCfg);
  res.json({ fieldGenerators: rules });
});

module.exports = router;
