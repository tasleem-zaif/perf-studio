const router = require('express').Router();
const auth = require('../middleware/auth');
const db = require('../db');
const ownsProject = require('../utils/ownsProject');
const { callAi } = require('../utils/aiClient');
const {
  extractAllTokens, pickDefaultToken, fingerprintMatches, fireEndpoint,
} = require('../utils/preRunEngine');

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
    const { cfg: envCfg } = await loadEnvConfig(collection_id, collection.environment);
    const variables = envCfg.variables || {};
    const overrides = envCfg.endpointOverrides || {};

    // Phase 1: fire all requests as-is, in bounded-concurrency chunks (5s timeout each) —
    // not capped to a subset, but never all fired at once either, to avoid hammering the
    // target server with a huge burst of simultaneous requests on large collections.
    const CHUNK_SIZE = 20; // concurrency per chunk — matches the old single-batch size
    const rawResults = [];
    for (let i = 0; i < endpoints.length; i += CHUNK_SIZE) {
      const chunk = endpoints.slice(i, i + CHUNK_SIZE);
      rawResults.push(...await Promise.all(chunk.map(ep => fireEndpoint(ep, { variables }))));
      if (i + CHUNK_SIZE < endpoints.length) await new Promise(r => setTimeout(r, 250));
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

    // Phase 2: endpoints with a saved AI-fixed override always get re-fired with that
    // override applied (it's the known-correct way to call them now, regardless of
    // whether this run's Phase-1 attempt happened to succeed); anything else that got a
    // 401 is retried once with the blanket default token, same as before.
    const responses = await Promise.all(rawResults.map(async (r, i) => {
      const ep = endpoints[i];
      const saved = overrides[i];
      const override = fingerprintMatches(ep, saved) ? saved : null;

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

    res.json({ responses, extractedToken: defaultToken ? '(present — not returned for security)' : null });
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

    const systemPrompt = [
      'You are diagnosing a single failing API request captured during "pre-run" — a live pre-flight check that fires every endpoint in a collection before load-test script generation.',
      'Output ONLY a JSON object, no markdown fences, no prose outside the JSON, with this exact shape:',
      '{"issue": string, "fix": string, "fix_type": "header_override"|"body_override"|"url_override"|"no_fix", "headers"?: object, "body"?: string, "url"?: string}',
      '- "issue": 1-2 sentences on the root cause of the failure.',
      '- "fix": 1-2 sentences describing exactly what you changed and why.',
      '- Only include "headers"/"body"/"url" for fields you are overriding; omit anything you are not changing.',
      '- A value that should come from another response captured earlier in this pre-run (e.g. a refresh token) MUST use the placeholder {{captured:KEY}}, where KEY is one of the "Captured token fields" listed below — never invent a KEY that is not listed.',
      '- A value that should come from the collection\'s own configured variables MUST use {{key}}, where key is one of the "Collection variables" listed below.',
      '- For an Authorization header or any other token/session value, ALWAYS prefer {{captured:KEY}} over a collection variable — a token is normally produced dynamically by a login/auth response, not configured statically. Only fall back to a collection variable if no matching captured field exists.',
      '- If the given information is not enough to determine a fix, return fix_type "no_fix" and explain why in "issue" — do not guess.',
    ].join('\n');

    const responseBodyStr = typeof prior.body === 'string' ? prior.body : JSON.stringify(prior.body, null, 2);
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
      '=== Captured token fields available (from other responses in this pre-run) ===',
      Object.keys(capturedTokens).join(', ') || '(none captured yet)',
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
    if (envRow) {
      await db.prepare('UPDATE collection_env_config SET config_json = ? WHERE collection_id = ? AND env = ?')
        .run(JSON.stringify(envCfg), collection_id, collection.environment);
    } else {
      await db.prepare('INSERT INTO collection_env_config (collection_id, env, config_json) VALUES (?, ?, ?)')
        .run(collection_id, collection.environment, JSON.stringify(envCfg));
    }

    // Re-fire just this one endpoint with the new override applied, to verify immediately.
    const result = await fireEndpoint(ep, { variables, capturedTokens, override });
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

module.exports = router;
