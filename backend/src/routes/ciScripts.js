/**
 * ciScripts.js — license-gated plaintext script delivery for CI runners
 *
 * Routes (mounted at /api/ci, NOT under the session-authenticated /api/projects/:projectId/ci
 * router — a CI runner has no user session):
 *   POST /scripts/decrypt — exchange a short-lived run-scoped token (minted by ciPipeline.js's
 *                           /trigger route right after reserveVuh succeeds) for the test suite's
 *                           plaintext script content, but only while the org's license is valid.
 *
 * Despite the route name, no cryptography happens here — the token's own signature is the only
 * thing verified. What's returned is Peako's own internal plaintext copy (same source auto-heal
 * reads via scriptContent.js), never the encrypted copy pushed into the customer's git repo.
 * Named "decrypt" to match what the CI step conceptually does from its own point of view: turn
 * the useless ciphertext sitting in its checkout into something it can actually run.
 */

const router = require('express').Router();
const jwt = require('jsonwebtoken');
const db = require('../db');
const { getOrgAccessStatus } = require('../utils/license');
const { readScriptContent } = require('../utils/scriptContent');

const TOKEN_SECRET = process.env.CI_SCRIPT_TOKEN_SECRET || process.env.JWT_SECRET;

router.post('/scripts/decrypt', async (req, res) => {
  console.log(`[CIScripts] Decrypt call received — ip=${req.ip}`);
  try {
    await handleDecrypt(req, res);
  } catch (e) {
    console.error(`[CIScripts] Unhandled error in decrypt handler:`, e);
    if (!res.headersSent) res.status(500).json({ error: 'Internal error processing decrypt request' });
  }
});

async function handleDecrypt(req, res) {
  const { token } = req.body || {};
  if (!token) {
    console.warn(`[CIScripts] Decrypt refused — no token in request body, ip=${req.ip}`);
    return res.status(400).json({ error: 'token required' });
  }

  let claims;
  try {
    claims = jwt.verify(token, TOKEN_SECRET);
  } catch (e) {
    console.warn(`[CIScripts] Decrypt refused — token verify failed (${e.name}: ${e.message}), ip=${req.ip}`);
    return res.status(401).json({ error: 'Invalid or expired run token', reason: 'invalid_token' });
  }

  const { orgId, projectId, suiteId } = claims;
  if (!orgId || !projectId || !suiteId) {
    console.warn(`[CIScripts] Decrypt refused — malformed claims: ${JSON.stringify(claims)}, ip=${req.ip}`);
    return res.status(401).json({ error: 'Malformed run token', reason: 'invalid_token' });
  }

  const access = await getOrgAccessStatus(orgId);
  if (!access.isValid) {
    const reason = access.isDisabled ? 'license_disabled' : 'license_expired';
    console.warn(`[CIScripts] Decrypt refused for org ${orgId}, suite ${suiteId} — ${reason}`);
    return res.status(403).json({
      error: access.isDisabled
        ? "Your organization's license is disabled. Contact your administrator."
        : "Your organization's license has expired. Contact your administrator to renew.",
      reason,
    });
  }

  const suite = await db.prepare(
    'SELECT id, user_id, project_id, engine, jmx_path, js_path FROM test_suites WHERE id = ? AND project_id = ?'
  ).get(suiteId, projectId);
  if (!suite) {
    console.warn(`[CIScripts] Decrypt refused — no test_suites row for suiteId=${suiteId} projectId=${projectId}`);
    return res.status(404).json({ error: 'Test suite not found' });
  }

  const scriptPath = suite.engine === 'k6' ? suite.js_path : suite.jmx_path;
  const filename = (scriptPath || '').replace(/\\/g, '/').split('/').pop();
  const content = await readScriptContent({ project_id: suite.project_id }, suite, scriptPath);
  if (!content) {
    console.warn(`[CIScripts] Decrypt refused — readScriptContent returned empty for suite=${suite.id} scriptPath=${scriptPath}`);
    return res.status(404).json({ error: 'Script content not found' });
  }

  console.log(`[CIScripts] Decrypt served — org=${orgId} suite=${suiteId} ip=${req.ip} contentBytes=${content.length}`);
  res.json({ ok: true, filename, content });
}

module.exports = router;
