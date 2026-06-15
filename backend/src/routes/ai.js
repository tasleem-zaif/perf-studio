const router = require('express').Router();
const auth = require('../middleware/auth');
const db = require('../db');
const ownsProject = require('../utils/ownsProject');

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

// Recursively search an object for common token field names
const TOKEN_KEYS = ['token', 'access_token', 'accessToken', 'jwt', 'id_token', 'idToken',
                    'auth_token', 'authToken', 'bearer', 'Bearer', 'sessionToken', 'session_token'];
const WRAPPER_KEYS = ['data', 'result', 'response', 'user', 'auth', 'payload', 'body'];

function extractToken(body, responseHeaders) {
  if (typeof body === 'object' && body !== null) {
    for (const key of TOKEN_KEYS) {
      if (typeof body[key] === 'string' && body[key].length > 8) return body[key];
    }
    for (const wrapper of WRAPPER_KEYS) {
      if (body[wrapper] && typeof body[wrapper] === 'object') {
        for (const key of TOKEN_KEYS) {
          if (typeof body[wrapper][key] === 'string' && body[wrapper][key].length > 8) return body[wrapper][key];
        }
      }
    }
  }
  // Check response headers
  const hdr = responseHeaders?.['authorization'] || responseHeaders?.['x-auth-token'] || responseHeaders?.['x-access-token'];
  if (hdr) return hdr.replace(/^Bearer\s+/i, '');
  return null;
}

// Extract cookies from set-cookie header for session-based auth
function extractCookies(responseHeaders) {
  const setCookie = responseHeaders?.['set-cookie'];
  if (!setCookie) return null;
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  return cookies.map(c => c.split(';')[0]).join('; ');
}

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

router.post('/pre-run', async (req, res) => {
  const { collection_id, project_id, suite_id } = req.body;
  if (!collection_id || !project_id) return res.status(400).json({ error: 'collection_id and project_id required' });

  if (!ownsProject(req.userId, project_id)) return res.status(404).json({ error: 'Project not found' });
  const collection = db.prepare('SELECT * FROM collections WHERE id = ? AND project_id = ?').get(collection_id, project_id);
  if (!collection) return res.status(404).json({ error: 'Collection not found' });

  let endpoints = [];
  try { endpoints = JSON.parse(collection.json_content); } catch { return res.status(400).json({ error: 'Invalid collection data' }); }

  const batch = endpoints.slice(0, 20);

  // Phase 1: fire all requests in parallel (5s timeout each)
  async function fireEndpoint(ep, extraHeaders = {}) {
    if (!ep.url || !isSafeUrl(ep.url)) {
      return { endpoint: ep.name || ep.url, url: ep.url, method: ep.method || 'GET', skipped: true, reason: 'URL blocked or invalid', success: false };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const headers = { 'Content-Type': 'application/json', ...(ep.headers || {}), ...extraHeaders };
    const fetchOpts = { method: ep.method || 'GET', headers, signal: controller.signal };
    if (ep.body && ep.method !== 'GET') fetchOpts.body = typeof ep.body === 'string' ? ep.body : JSON.stringify(ep.body);
    try {
      const r = await fetch(ep.url, fetchOpts);
      clearTimeout(timer);
      const text = await r.text();
      let body;
      try { body = JSON.parse(text); } catch { body = text.slice(0, 1000); }
      const responseHeaders = Object.fromEntries(r.headers.entries());
      const extracted = extractToken(body, responseHeaders);
      const newCookies = extractCookies(responseHeaders);
      return {
        endpoint: ep.name || ep.url, method: ep.method || 'GET', url: ep.url,
        status: r.status, statusText: r.statusText,
        requestHeaders: headers, requestBody: fetchOpts.body || null,
        responseHeaders, body,
        success: r.status >= 200 && r.status < 400,
        _extracted: extracted, _cookies: newCookies,
        tokenExtracted: extracted ? true : undefined,
      };
    } catch (e) {
      clearTimeout(timer);
      return { endpoint: ep.name || ep.url, method: ep.method || 'GET', url: ep.url, error: e.name === 'AbortError' ? 'Request timed out (5s limit)' : e.message, success: false };
    }
  }

  // Run all in parallel
  const rawResults = await Promise.all(batch.map(ep => fireEndpoint(ep)));

  // Extract any auth token from the first successful response that has one
  let authToken = null;
  let cookieJar = null;
  for (const r of rawResults) {
    if (r._extracted) { authToken = r._extracted; break; }
    if (r._cookies) { cookieJar = r._cookies; }
  }

  // Phase 2: retry endpoints that got 401 and we now have a token
  const responses = await Promise.all(rawResults.map(async (r, i) => {
    const ep = batch[i];
    if (r.status === 401 && authToken) {
      const retry = await fireEndpoint(ep, {
        Authorization: `Bearer ${authToken}`,
        ...(cookieJar ? { Cookie: cookieJar } : {}),
      });
      retry.tokenInjected = true;
      delete retry._extracted; delete retry._cookies;
      return retry;
    }
    const clean = { ...r };
    if (authToken && !r._extracted) clean.tokenInjected = true;
    delete clean._extracted; delete clean._cookies;
    return clean;
  }));

  // Persist results — always on collection, also on test_suite when suite_id provided (legacy)
  const hash = simpleHash(collection.json_content || '');
  db.prepare('UPDATE collections SET pre_run_data = ?, pre_run_collection_hash = ? WHERE id = ?')
    .run(JSON.stringify(responses), hash, collection_id);
  if (suite_id) {
    db.prepare('UPDATE test_suites SET pre_run_data = ?, pre_run_collection_hash = ? WHERE id = ?')
      .run(JSON.stringify(responses), hash, suite_id);
  }

  res.json({ responses, extractedToken: authToken ? '(present — not returned for security)' : null });
});

module.exports = router;
