/**
 * license.js — Organization licensing / entitlements
 *
 * One org_licenses row per organization. Plans are fixed tiers (not
 * self-serve billing) — a Super Admin assigns a plan to an org, which sets
 * its user/project limits and starts a trial window for that tier.
 *
 * Usage:
 *   const { getOrgLicenseStatus, setOrgPlan, setOrgStatus, PLAN_DEFAULTS } = require('./license');
 */

const db = require('../db');
const { provisionOrgToken, revokeOrgToken } = require('./registry');
const { encrypt } = require('./encryption');

const PLAN_DEFAULTS = {
  trial:      { maxUsers: 2,    maxProjects: 1,    trialDays: 7   },
  starter:    { maxUsers: 5,    maxProjects: 3,    trialDays: 180 },
  growth:     { maxUsers: 15,   maxProjects: 10,   trialDays: 180 },
  business:   { maxUsers: 30,   maxProjects: 20,   trialDays: 180 },
  enterprise: { maxUsers: null, maxProjects: null, trialDays: 180 }, // null = unlimited
};

const DEFAULT_PLAN = 'trial';

function addDays(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Fetch an org's license row, creating a default trial license the first
 * time it's requested. Covers orgs that existed before licensing shipped.
 */
async function getOrCreateOrgLicense(orgId) {
  let license = await db.prepare('SELECT * FROM org_licenses WHERE org_id = ?').get(orgId);
  if (license) return license;

  const defaults = PLAN_DEFAULTS[DEFAULT_PLAN];
  await db.prepare(`
    INSERT INTO org_licenses (org_id, plan, max_users, max_projects, status, expires_at)
    VALUES (?, ?, ?, ?, 'active', ?)
    ON CONFLICT (org_id) DO NOTHING
  `).run(orgId, DEFAULT_PLAN, defaults.maxUsers, defaults.maxProjects, addDays(defaults.trialDays));

  license = await db.prepare('SELECT * FROM org_licenses WHERE org_id = ?').get(orgId);
  return license;
}

function licenseValidity(license) {
  const isDisabled = license.status === 'disabled';
  const isExpired  = !!license.expires_at && new Date(license.expires_at) < new Date();
  return { isDisabled, isExpired, isValid: !isDisabled && !isExpired };
}

/**
 * Lightweight validity check — one query, no usage counts. This is what
 * the auth middleware calls on every request, so it stays cheap.
 */
async function getOrgAccessStatus(orgId) {
  const license = await getOrCreateOrgLicense(orgId);
  return {
    orgId,
    plan: license.plan,
    status: license.status,
    expiresAt: license.expires_at,
    ...licenseValidity(license),
  };
}

/**
 * Full license status for an org: raw license row + current usage +
 * derived validity flags. This is what the license settings UI consumes —
 * heavier than getOrgAccessStatus() because it also counts users/projects.
 */
async function getOrgLicenseStatus(orgId) {
  const license = await getOrCreateOrgLicense(orgId);

  const { n: userCount } = await db.prepare(
    "SELECT COUNT(*)::int as n FROM users WHERE org_id = ? AND status = 'active'"
  ).get(orgId);

  const { n: projectCount } = await db.prepare(`
    SELECT COUNT(*)::int as n FROM projects p
    JOIN users u ON u.id = p.user_id
    WHERE u.org_id = ?
  `).get(orgId);

  const { isDisabled, isExpired, isValid } = licenseValidity(license);
  const daysRemaining = license.expires_at
    ? Math.ceil((new Date(license.expires_at) - Date.now()) / (24 * 60 * 60 * 1000))
    : null;

  return {
    orgId,
    plan: license.plan,
    status: license.status,
    maxUsers: license.max_users,       // null = unlimited
    maxProjects: license.max_projects, // null = unlimited
    expiresAt: license.expires_at,
    userCount,
    projectCount,
    isDisabled,
    isExpired,
    isValid,
    daysRemaining,
    usersAtLimit: license.max_users !== null && userCount >= license.max_users,
    projectsAtLimit: license.max_projects !== null && projectCount >= license.max_projects,
  };
}

/**
 * Assign a plan to an org (Super Admin action). Resets limits to the
 * plan's defaults and starts a fresh trial window for that tier, unless
 * an explicit expiresAt/limit override is passed.
 */
async function setOrgPlan(orgId, plan, overrides = {}) {
  const defaults = PLAN_DEFAULTS[plan];
  if (!defaults) throw new Error(`Unknown plan: ${plan}`);

  await getOrCreateOrgLicense(orgId); // ensure row exists first

  const maxUsers    = overrides.maxUsers !== undefined ? overrides.maxUsers : defaults.maxUsers;
  const maxProjects = overrides.maxProjects !== undefined ? overrides.maxProjects : defaults.maxProjects;
  const expiresAt   = overrides.expiresAt !== undefined ? overrides.expiresAt : addDays(defaults.trialDays);

  await db.prepare(`
    UPDATE org_licenses
    SET plan = ?, max_users = ?, max_projects = ?, expires_at = ?, updated_at = NOW()
    WHERE org_id = ?
  `).run(plan, maxUsers, maxProjects, expiresAt, orgId);

  return getOrgLicenseStatus(orgId);
}

/**
 * Enable / disable an org's license (Super Admin action). A disabled org
 * fails the auth-layer license check for every member except super admins.
 */
async function setOrgStatus(orgId, status) {
  if (!['active', 'disabled'].includes(status)) throw new Error(`Invalid status: ${status}`);
  await getOrCreateOrgLicense(orgId);
  await db.prepare('UPDATE org_licenses SET status = ?, updated_at = NOW() WHERE org_id = ?').run(status, orgId);

  // Registry token follows org status — non-fatal if Artifact Keeper is unreachable.
  const org = await db.prepare('SELECT id, name, registry_token_key FROM organizations WHERE id = ?').get(orgId);
  if (org) {
    try {
      if (status === 'disabled' && org.registry_token_key) {
        await revokeOrgToken(org.registry_token_key);
        await db.prepare(`
          UPDATE organizations
          SET registry_token_enc = NULL, registry_token_key = NULL, registry_token_prefix = NULL,
              registry_token_created_at = NULL, registry_token_expires_at = NULL
          WHERE id = ?
        `).run(orgId);
      } else if (status === 'active' && !org.registry_token_key) {
        const license = await getOrgLicenseStatus(orgId);
        const { token, key } = await provisionOrgToken(org.name, license.expiresAt);
        await db.prepare(`
          UPDATE organizations
          SET registry_token_enc = ?, registry_token_key = ?, registry_token_prefix = ?, registry_token_created_at = NOW()
          WHERE id = ?
        `).run(encrypt(token), key, token.slice(0, 12), orgId);
      }
    } catch (e) {
      console.warn(`[org-${status} registry]`, e.message);
    }
  }

  return getOrgLicenseStatus(orgId);
}

module.exports = {
  PLAN_DEFAULTS,
  DEFAULT_PLAN,
  getOrCreateOrgLicense,
  getOrgAccessStatus,
  getOrgLicenseStatus,
  setOrgPlan,
  setOrgStatus,
};
