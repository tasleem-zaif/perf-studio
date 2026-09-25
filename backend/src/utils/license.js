/**
 * license.js — Organization licensing / entitlements / VUH metering
 *
 * One org_licenses row per organization. Plans are fixed tiers (not
 * self-serve billing) — a Super Admin assigns a plan to an org, which sets
 * its user/project/VU/duration/concurrency limits and its VUH pool, and
 * starts a license window for that tier.
 *
 * VUH (Virtual-User-Hours) metering: every CI-triggered run books a
 * reservation (vuh_ledger, kind='reservation', status='open') BEFORE
 * dispatch, sized off the requested VUs/duration. When the run reaches a
 * terminal status, the reservation is committed with the run's actual VUH
 * (usually smaller than requested — a failed/healed/early-finished run costs
 * less than its worst-case reservation) and added to consumed_vuh. A
 * reservation that never gets a completion callback is released by
 * sweepStaleReservations(). Renewing/changing a plan resets total_vuh and
 * consumed_vuh to the new allocation — any unused VUH from the prior period
 * is forfeited, not carried over.
 *
 * Usage:
 *   const {
 *     getOrgLicenseStatus, setOrgPlan, setOrgStatus, topUpVuh,
 *     reserveVuh, commitReservation, releaseReservation, sweepStaleReservations,
 *     calcVuh, PLAN_DEFAULTS,
 *   } = require('./license');
 */

const db = require('../db');
const { provisionOrgToken, revokeOrgToken } = require('./registry');
const { encrypt } = require('./encryption');

// vuhPerMonth is a flat allocation for 'trial' (its window is a fixed 7 days,
// not a selectable duration) and a per-month rate for every paid tier
// (multiplied by the duration the Super Admin picks — see computeVuhAllocation).
// enterprise_plus has every numeric limit set to null ("custom") — a Super
// Admin must supply every one of them explicitly via overrides when assigning it.
const PLAN_DEFAULTS = {
  trial:            { maxUsers: 2,    maxProjects: 1,  trialDays: 7,
                       monthlyPrice: 0,    vuhPerMonth: 100,   maxVUs: 50,    maxTestDurationMin: 30,   maxConcurrentTests: 1 },
  professional:     { maxUsers: 5,    maxProjects: 3,  trialDays: 180,
                       monthlyPrice: 450,  vuhPerMonth: 8000,  maxVUs: 1000,  maxTestDurationMin: 240,  maxConcurrentTests: 3 },
  business:         { maxUsers: 15,   maxProjects: 10, trialDays: 180,
                       monthlyPrice: 850,  vuhPerMonth: 16000, maxVUs: 8000,  maxTestDurationMin: 480,  maxConcurrentTests: 5 },
  enterprise:       { maxUsers: 30,   maxProjects: 25, trialDays: 180,
                       monthlyPrice: 2100, vuhPerMonth: 50000, maxVUs: 25000, maxTestDurationMin: 1440, maxConcurrentTests: 15 },
  enterprise_plus:  { maxUsers: null, maxProjects: null, trialDays: 180,
                       monthlyPrice: null, vuhPerMonth: null,  maxVUs: null,  maxTestDurationMin: null, maxConcurrentTests: null },
};

const DEFAULT_PLAN = 'trial';

// A reservation with no completion callback within its own expected runtime
// plus this grace window is treated as abandoned (sweepStaleReservations).
const RESERVATION_GRACE_SECONDS = 2 * 60 * 60;
// Reservations for loop-mode runs booked before a duration cap is known yet
// fall back to this assumed runtime for staleness purposes only.
const RESERVATION_DEFAULT_DURATION_SECONDS = 4 * 60 * 60;

function addDays(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function addMonths(months) {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d.toISOString();
}

/** VUH = virtual users x wall-clock duration, in hours. */
function calcVuh(vusers, seconds) {
  return ((Number(vusers) || 0) * (Number(seconds) || 0)) / 3600;
}

/**
 * total_vuh for a plan + chosen duration. Returns null for a plan whose
 * vuhPerMonth is itself null (enterprise_plus) — caller must supply an
 * explicit override in that case, there is no computed default.
 */
function computeVuhAllocation(plan, durationMonths) {
  const defaults = PLAN_DEFAULTS[plan];
  if (!defaults || defaults.vuhPerMonth == null) return null;
  if (plan === 'trial') return defaults.vuhPerMonth; // flat, not duration-multiplied
  return defaults.vuhPerMonth * (durationMonths || 1);
}

/**
 * Fetch an org's license row, creating a default trial license the first
 * time it's requested. Covers orgs that existed before licensing shipped.
 */
async function getOrCreateOrgLicense(orgId) {
  let license = await db.prepare('SELECT * FROM org_licenses WHERE org_id = ?').get(orgId);
  if (license) return license;

  const defaults = PLAN_DEFAULTS[DEFAULT_PLAN];
  const totalVuh = computeVuhAllocation(DEFAULT_PLAN, null);
  await db.prepare(`
    INSERT INTO org_licenses
      (org_id, plan, max_users, max_projects, max_vus, max_test_duration_min, max_concurrent_tests,
       total_vuh, consumed_vuh, duration_months, status, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'active', ?)
    ON CONFLICT (org_id) DO NOTHING
  `).run(orgId, DEFAULT_PLAN, defaults.maxUsers, defaults.maxProjects, defaults.maxVUs,
         defaults.maxTestDurationMin, defaults.maxConcurrentTests, totalVuh, null, addDays(defaults.trialDays));

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

/** Count of execution_runs currently 'running' anywhere in the org (all projects, all users). */
async function countRunningTestsForOrg(orgId) {
  const { n } = await db.prepare(`
    SELECT COUNT(*)::int AS n
    FROM execution_runs er
    JOIN projects p ON p.id = er.project_id
    JOIN users u ON u.id = p.user_id
    WHERE u.org_id = ? AND er.status = 'running'
  `).get(orgId);
  return n;
}

/** Sum of still-open reservations for an org — VUH already earmarked but not yet committed. */
async function openReservedVuhForOrg(orgId) {
  const row = await db.prepare(`
    SELECT COALESCE(SUM(reserved_vuh), 0)::float AS n FROM vuh_ledger
    WHERE org_id = ? AND kind = 'reservation' AND status = 'open'
  `).get(orgId);
  return Number(row?.n || 0);
}

/**
 * Full license status for an org: raw license row + current usage +
 * derived validity flags. This is what the license settings UI consumes —
 * heavier than getOrgAccessStatus() because it also counts users/projects/
 * running tests and sums open VUH reservations.
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

  const runningTestsCount = await countRunningTestsForOrg(orgId);
  const openReservedVuh = await openReservedVuhForOrg(orgId);

  const { isDisabled, isExpired, isValid } = licenseValidity(license);
  const daysRemaining = license.expires_at
    ? Math.ceil((new Date(license.expires_at) - Date.now()) / (24 * 60 * 60 * 1000))
    : null;

  const totalVuh    = Number(license.total_vuh || 0);
  const consumedVuh = Number(license.consumed_vuh || 0);
  const availableVuh = Math.max(0, totalVuh - consumedVuh - openReservedVuh);
  const vuhUtilizationPct = totalVuh > 0
    ? Math.min(100, Math.round(((consumedVuh + openReservedVuh) / totalVuh) * 100))
    : 0;

  return {
    orgId,
    plan: license.plan,
    status: license.status,
    maxUsers: license.max_users,               // null = unlimited
    maxProjects: license.max_projects,          // null = unlimited
    maxVUs: license.max_vus,                    // null = unlimited (enterprise_plus)
    maxTestDurationMin: license.max_test_duration_min, // null = unlimited
    maxConcurrentTests: license.max_concurrent_tests,  // null = unlimited
    durationMonths: license.duration_months,
    expiresAt: license.expires_at,
    userCount,
    projectCount,
    runningTestsCount,
    isDisabled,
    isExpired,
    isValid,
    daysRemaining,
    usersAtLimit: license.max_users !== null && userCount >= license.max_users,
    projectsAtLimit: license.max_projects !== null && projectCount >= license.max_projects,
    concurrentTestsAtLimit: license.max_concurrent_tests !== null && runningTestsCount >= license.max_concurrent_tests,
    totalVuh,
    consumedVuh,
    openReservedVuh,
    availableVuh,
    vuhUtilizationPct,
  };
}

/**
 * Assign a plan to an org (Super Admin action). Resets limits to the
 * plan's defaults (or the given overrides) and starts a fresh license
 * window. total_vuh/consumed_vuh are reset to the new period's allocation —
 * whatever was left unused in the prior period is forfeited (logged, not
 * carried forward) per the "VUH renews with the license, doesn't roll over" rule.
 *
 * overrides: { maxUsers, maxProjects, maxVUs, maxTestDurationMin,
 *              maxConcurrentTests, totalVuh, durationMonths, expiresAt }
 * All optional; enterprise_plus has no computed defaults for the VU/duration/
 * concurrency/VUH fields, so those MUST be supplied via overrides for it.
 */
async function setOrgPlan(orgId, plan, overrides = {}) {
  const defaults = PLAN_DEFAULTS[plan];
  if (!defaults) throw new Error(`Unknown plan: ${plan}`);

  const previous = await getOrCreateOrgLicense(orgId); // ensure row exists first, capture prior balance

  const durationMonths = overrides.durationMonths !== undefined ? overrides.durationMonths : (plan === 'trial' ? null : 1);
  const maxUsers             = overrides.maxUsers             !== undefined ? overrides.maxUsers             : defaults.maxUsers;
  const maxProjects          = overrides.maxProjects          !== undefined ? overrides.maxProjects          : defaults.maxProjects;
  const maxVUs               = overrides.maxVUs               !== undefined ? overrides.maxVUs               : defaults.maxVUs;
  const maxTestDurationMin   = overrides.maxTestDurationMin   !== undefined ? overrides.maxTestDurationMin   : defaults.maxTestDurationMin;
  const maxConcurrentTests   = overrides.maxConcurrentTests   !== undefined ? overrides.maxConcurrentTests   : defaults.maxConcurrentTests;

  const computedVuh = computeVuhAllocation(plan, durationMonths);
  const totalVuh = overrides.totalVuh !== undefined ? overrides.totalVuh : (computedVuh ?? 0);

  const expiresAt = overrides.expiresAt !== undefined
    ? overrides.expiresAt
    : (durationMonths ? addMonths(durationMonths) : addDays(defaults.trialDays));

  const forfeited = Math.max(0, Number(previous.total_vuh || 0) - Number(previous.consumed_vuh || 0));

  await db.prepare(`
    UPDATE org_licenses
    SET plan = ?, max_users = ?, max_projects = ?, max_vus = ?, max_test_duration_min = ?,
        max_concurrent_tests = ?, total_vuh = ?, consumed_vuh = 0, duration_months = ?,
        expires_at = ?, updated_at = NOW()
    WHERE org_id = ?
  `).run(plan, maxUsers, maxProjects, maxVUs, maxTestDurationMin, maxConcurrentTests,
         totalVuh, durationMonths, expiresAt, orgId);

  if (forfeited > 0) {
    await db.prepare(`
      INSERT INTO vuh_ledger (org_id, kind, actual_vuh, reason)
      VALUES (?, 'adjustment', ?, ?)
    `).run(orgId, -forfeited, `Forfeited ${forfeited.toFixed(2)} unused VUH — plan changed to '${plan}'`);
  }

  return getOrgLicenseStatus(orgId);
}

/**
 * Manual VUH top-up (Super Admin only). Additive on top of whatever the
 * current period already allocated; expires with the license the same way
 * the base allocation does — setOrgPlan()'s next renewal wipes it along
 * with any other unused balance, no separate expiry tracking needed.
 */
async function topUpVuh(orgId, amount, adminUserId, reason) {
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('VUH amount must be a positive number');

  await getOrCreateOrgLicense(orgId);
  await db.prepare('UPDATE org_licenses SET total_vuh = total_vuh + ?, updated_at = NOW() WHERE org_id = ?').run(amt, orgId);
  await db.prepare(`
    INSERT INTO vuh_ledger (org_id, kind, actual_vuh, reason, created_by)
    VALUES (?, 'adjustment', ?, ?, ?)
  `).run(orgId, amt, reason || 'Manual VUH top-up by super admin', adminUserId);

  return getOrgLicenseStatus(orgId);
}

// Below this, a loop-mode reservation isn't worth booking at all — the run would be
// capped so short it can't produce a meaningful result. Surfaced to the user as
// "not enough VUH left to run anything," not a confusing near-zero duration cap.
const MIN_VIABLE_LOOP_MODE_SECONDS = 60;

/**
 * Pre-flight check + reservation for a CI-triggered run. Atomic against
 * concurrent triggers: the availability/limit checks and the reservation
 * insert happen inside one db.transaction() with the org_licenses row
 * locked (SELECT ... FOR UPDATE), so two simultaneous triggers near a limit
 * can't both pass.
 *
 * `durationSeconds`:
 *  - a number  -> duration-mode. Hard-rejects if it exceeds the plan's
 *    max_test_duration_min, or if the resulting VUH exceeds what's available.
 *  - null      -> loop/iteration-mode, where there's no fixed duration to
 *    check upfront. Instead of rejecting, this computes a safety-duration
 *    cap (whichever binds tighter: the plan's max_test_duration_min, or
 *    however long the remaining available VUH stretches at this VU count)
 *    and reserves against THAT — the returned `cappedDurationSeconds` is
 *    what the caller must bake into the generated script as a hard
 *    scheduler ceiling so the run self-terminates instead of overdrawing.
 *
 * Returns { ok: true, reservationId, requestedVuh, availableVuhAfter,
 * cappedDurationSeconds? } on success, or { ok: false, reason, ...details }
 * on any limit breach — callers translate `reason` into the right HTTP
 * status/message, they never need to inspect license internals themselves.
 */
async function reserveVuh(orgId, { projectId, vusers, durationSeconds, ciRunId, userId }) {
  return db.transaction(async (client) => {
    const { rows: [license] } = await client.query(
      'SELECT * FROM org_licenses WHERE org_id = $1 FOR UPDATE', [orgId]
    );
    if (!license) return { ok: false, reason: 'no_license' };

    const { isValid } = licenseValidity(license);
    if (!isValid) return { ok: false, reason: license.status === 'disabled' ? 'license_disabled' : 'license_expired' };

    if (license.max_vus !== null && vusers > license.max_vus) {
      return { ok: false, reason: 'max_vus_exceeded', maxVUs: license.max_vus, requestedVUs: vusers };
    }

    const isLoopMode = durationSeconds == null;
    if (!isLoopMode && license.max_test_duration_min !== null && durationSeconds > license.max_test_duration_min * 60) {
      return { ok: false, reason: 'max_duration_exceeded', maxTestDurationMin: license.max_test_duration_min, requestedSeconds: durationSeconds };
    }

    if (license.max_concurrent_tests !== null) {
      const { rows: [{ n: runningCount }] } = await client.query(`
        SELECT COUNT(*)::int AS n
        FROM execution_runs er JOIN projects p ON p.id = er.project_id
        WHERE p.user_id IN (SELECT id FROM users WHERE org_id = $1) AND er.status = 'running'
      `, [orgId]);
      if (runningCount >= license.max_concurrent_tests) {
        return { ok: false, reason: 'max_concurrent_tests_exceeded', maxConcurrentTests: license.max_concurrent_tests, runningCount };
      }
    }

    const { rows: [{ n: openReservedVuh }] } = await client.query(`
      SELECT COALESCE(SUM(reserved_vuh), 0)::float AS n FROM vuh_ledger
      WHERE org_id = $1 AND kind = 'reservation' AND status = 'open'
    `, [orgId]);
    const availableVuh = Number(license.total_vuh || 0) - Number(license.consumed_vuh || 0) - Number(openReservedVuh || 0);

    let effectiveDurationSeconds = durationSeconds;
    let cappedDurationSeconds = null;
    let requestedVuh;

    if (isLoopMode) {
      const maxSecFromPlan = license.max_test_duration_min !== null ? license.max_test_duration_min * 60 : Infinity;
      const maxSecFromVuh  = vusers > 0 ? Math.floor((Math.max(0, availableVuh) / vusers) * 3600) : 0;
      const capSeconds = Math.max(0, Math.min(maxSecFromPlan, maxSecFromVuh));
      if (capSeconds < MIN_VIABLE_LOOP_MODE_SECONDS) {
        return { ok: false, reason: 'vuh_exceeded', availableVuh: Math.max(0, availableVuh), requestedVuh: 0 };
      }
      effectiveDurationSeconds = capSeconds;
      cappedDurationSeconds = capSeconds;
      requestedVuh = calcVuh(vusers, capSeconds);
    } else {
      requestedVuh = calcVuh(vusers, durationSeconds);
      if (requestedVuh > availableVuh) {
        return { ok: false, reason: 'vuh_exceeded', availableVuh: Math.max(0, availableVuh), requestedVuh };
      }
    }

    const { rows: [reservation] } = await client.query(`
      INSERT INTO vuh_ledger (org_id, project_id, ci_run_id, kind, status, vusers, duration_seconds, reserved_vuh, created_by)
      VALUES ($1, $2, $3, 'reservation', 'open', $4, $5, $6, $7)
      RETURNING id
    `, [orgId, projectId, ciRunId ?? null, vusers, effectiveDurationSeconds, requestedVuh, userId ?? null]);

    return {
      ok: true, reservationId: reservation.id, requestedVuh, cappedDurationSeconds,
      availableVuhAfter: availableVuh - requestedVuh,
    };
  });
}

/**
 * A reservation was booked with a placeholder ciRunId (or none yet) before
 * the CI dispatch call returned a real one — call this right after dispatch
 * succeeds so later commit/release lookups by ci_run_id actually find it.
 */
async function attachReservationCiRunId(reservationId, ciRunId) {
  await db.prepare('UPDATE vuh_ledger SET ci_run_id = ?, updated_at = NOW() WHERE id = ?').run(ciRunId, reservationId);
}

/**
 * Resolve a run's actual VUH and move its reservation from open -> committed,
 * adding the actual (not reserved) amount to consumed_vuh. Safe to call more
 * than once for the same ci_run_id — a second call finds no open reservation
 * and is a no-op.
 */
async function commitReservation(ciRunId, { actualVusers, actualDurationSeconds, executionRunId }) {
  const reservation = await db.prepare(`
    SELECT * FROM vuh_ledger WHERE ci_run_id = ? AND kind = 'reservation' AND status = 'open'
  `).get(ciRunId);
  if (!reservation) return null;

  const actualVuh = calcVuh(actualVusers ?? reservation.vusers, actualDurationSeconds ?? reservation.duration_seconds);

  await db.transaction(async (client) => {
    await client.query(
      `UPDATE vuh_ledger SET status = 'committed', actual_vuh = $1, execution_run_id = $2, updated_at = NOW() WHERE id = $3`,
      [actualVuh, executionRunId ?? null, reservation.id]
    );
    await client.query(
      'UPDATE org_licenses SET consumed_vuh = consumed_vuh + $1, updated_at = NOW() WHERE org_id = $2',
      [actualVuh, reservation.org_id]
    );
  });

  return { reservationId: reservation.id, actualVuh };
}

/** Run never actually started / was rejected by the CI provider — give the VUH back. */
async function releaseReservation(ciRunId) {
  const result = await db.prepare(`
    UPDATE vuh_ledger SET status = 'released', actual_vuh = 0, updated_at = NOW()
    WHERE ci_run_id = ? AND kind = 'reservation' AND status = 'open'
  `).run(ciRunId);
  return result.changes > 0;
}

/**
 * Same as releaseReservation(), but by the reservation's own id — for the window between
 * reserveVuh() succeeding and the CI dispatch call itself returning a ci_run_id to attach
 * (a dispatch failure in that window has no ci_run_id to release by).
 */
async function releaseReservationById(reservationId) {
  const result = await db.prepare(`
    UPDATE vuh_ledger SET status = 'released', actual_vuh = 0, updated_at = NOW()
    WHERE id = ? AND kind = 'reservation' AND status = 'open'
  `).run(reservationId);
  return result.changes > 0;
}

/**
 * Releases reservations that never received a completion callback within
 * their own expected runtime plus a grace window — almost always a lost
 * webhook or a status-poll path that errored out before reaching
 * commitReservation(). Fires an ops alert per release so a real monitoring
 * gap gets noticed, not just silently self-healed.
 */
async function sweepStaleReservations() {
  const open = await db.prepare(`
    SELECT id, org_id, ci_run_id, reserved_vuh, duration_seconds, created_at, created_by
    FROM vuh_ledger WHERE kind = 'reservation' AND status = 'open'
  `).all();

  const now = Date.now();
  let released = 0;
  for (const row of open) {
    const expectedMs = ((row.duration_seconds || RESERVATION_DEFAULT_DURATION_SECONDS) + RESERVATION_GRACE_SECONDS) * 1000;
    if (now - new Date(row.created_at).getTime() < expectedMs) continue;

    const result = await db.prepare(
      `UPDATE vuh_ledger SET status = 'released', actual_vuh = 0, updated_at = NOW() WHERE id = ? AND status = 'open'`
    ).run(row.id);
    if (!result.changes) continue;
    released++;

    try {
      const { alertOpsFailure } = require('./opsAlert');
      await alertOpsFailure('vuh_reservation_stale', `Stale VUH reservation released (org ${row.org_id})`,
        `Reservation #${row.id} for ci_run #${row.ci_run_id} reserved ${row.reserved_vuh} VUH and never received a ` +
        `completion callback within its expected runtime + ${RESERVATION_GRACE_SECONDS / 3600}h grace — released back ` +
        `to the pool. Usually means a CI status-poll/sync path failed before reaching commitReservation().`,
        { orgId: row.org_id, userId: row.created_by });
    } catch (_) { /* alerting is best-effort, never blocks the sweep */ }
  }
  return released;
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
  topUpVuh,
  calcVuh,
  computeVuhAllocation,
  countRunningTestsForOrg,
  reserveVuh,
  attachReservationCiRunId,
  commitReservation,
  releaseReservation,
  releaseReservationById,
  sweepStaleReservations,
};
