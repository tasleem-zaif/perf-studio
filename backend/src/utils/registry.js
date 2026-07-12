/**
 * registry.js — Artifact Keeper npm registry token client
 *
 * Peako organizations get one npm token from Artifact Keeper. It's issued/
 * rotated/revoked by a Super Admin and viewed/copied by any org member for
 * local `npm install` / .npmrc setup.
 *
 * Artifact Keeper scopes tokens by repository + package format, not by an
 * npm scope string — there is no server-side "@peako" restriction. The
 * @peako boundary is enforced entirely by which repository the token/.npmrc
 * points at (see the ARTIFACT_KEEPER repository created for Peako packages).
 *
 * Usage:
 *   const { provisionOrgToken, revokeOrgToken } = require('./registry');
 *   const { token, key } = await provisionOrgToken(org.name, expiresAt);
 *   await revokeOrgToken(org.registry_token_key);
 */

const ARTIFACT_KEEPER_URL     = process.env.ARTIFACT_KEEPER_URL || 'https://artifact-keeper.qtsolvdev.com';
const ARTIFACT_KEEPER_API_KEY = process.env.ARTIFACT_KEEPER_API_KEY;

// No real credentials configured — issue locally-generated fake tokens instead
// of calling the real service, so the provision/rotate/revoke UI can be
// exercised end-to-end in dev. Self-disabling: set ARTIFACT_KEEPER_API_KEY and
// this path is never hit again.
const STUB_MODE = !ARTIFACT_KEEPER_API_KEY;
if (STUB_MODE) {
  console.warn('[registry] ARTIFACT_KEEPER_API_KEY not set — issuing fake local registry tokens (dev/test only)');
}

let cachedAdminUserId = null;

async function getAdminUserId() {
  if (cachedAdminUserId) return cachedAdminUserId;
  const res = await fetch(`${ARTIFACT_KEEPER_URL}/api/v1/auth/me`, {
    headers: { Authorization: `Bearer ${ARTIFACT_KEEPER_API_KEY}` },
  });
  if (!res.ok) throw new Error(`Artifact Keeper auth failed: ${res.status} ${await res.text()}`);
  const me = await res.json();
  cachedAdminUserId = me.id;
  return cachedAdminUserId;
}

function slugify(name) {
  return (name || 'org').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Provision a new npm token for an org, scoped to @peako packages.
 * Returns { token, key } — token is the raw secret (store encrypted, shown
 * once), key is Artifact Keeper's token UUID (used to revoke it later).
 */
async function provisionOrgToken(orgName, expiresAt) {
  if (STUB_MODE) {
    const crypto = require('crypto');
    return { token: `peako_fake_${crypto.randomBytes(24).toString('hex')}`, key: crypto.randomUUID() };
  }

  const userId = await getAdminUserId();
  const name = `peako-${slugify(orgName)}-${Date.now()}`;

  const expiresInDays = expiresAt
    ? Math.max(1, Math.ceil((new Date(expiresAt) - Date.now()) / (24 * 60 * 60 * 1000)))
    : 180;

  const res = await fetch(`${ARTIFACT_KEEPER_URL}/api/v1/users/${userId}/tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ARTIFACT_KEEPER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name, expires_in_days: expiresInDays, scopes: ['read'], formats: ['npm'] }),
  });
  if (!res.ok) throw new Error(`Artifact Keeper token creation failed: ${res.status} ${await res.text()}`);

  const data = await res.json();
  return { token: data.token, key: data.id || data.key };
}

/**
 * Revoke a previously issued token. A 404 (already gone) counts as success.
 */
async function revokeOrgToken(tokenKey) {
  if (!tokenKey) return;
  if (STUB_MODE) return; // fake token was never registered with the real service

  const userId = await getAdminUserId();
  const res = await fetch(`${ARTIFACT_KEEPER_URL}/api/v1/users/${userId}/tokens/${tokenKey}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${ARTIFACT_KEEPER_API_KEY}` },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Artifact Keeper token revocation failed: ${res.status} ${await res.text()}`);
  }
}

module.exports = { provisionOrgToken, revokeOrgToken };
