/**
 * opsAlert.js — real alerting for backend operational failures that used to only be
 * visible as a `console.error` line. Webhook (OPS_ALERT_WEBHOOK_URL) always fires
 * alongside whichever of these two applies to the failure:
 *   - User-facing failures (an org/user is known, e.g. a stale VUH reservation) —
 *     emailed only to the owning user plus that org's opted-in ops_alert_recipients.
 *     Never org_admin/super_admin by role.
 *   - Internal/infra failures (no owning org, e.g. S3 sync) — written to the
 *     `notifications` table for the in-app super_admin notification bell, no email.
 * Fire-and-forget: callers never await this and it never throws. Rate-limited per
 * `kind` + org (infra failures with no org share one global bucket per kind) so a
 * sustained outage sends one alert per window, not one per failed operation.
 */
const db = require('../db');
const { createTransport, getAlertConfig } = require('./emailUtils');

const RATE_LIMIT_MS = Number(process.env.OPS_ALERT_RATE_LIMIT_MS) || 5 * 60 * 1000;

const lastSentAt = new Map();      // rateLimitKey -> timestamp of last actually-sent alert
const suppressedCount = new Map(); // rateLimitKey -> count suppressed since that last send

function rateLimitKey(kind, orgId) {
  return `${kind}:${orgId ?? 'global'}`;
}

function shouldSend(key) {
  const now = Date.now();
  const last = lastSentAt.get(key) || 0;
  if (now - last < RATE_LIMIT_MS) {
    suppressedCount.set(key, (suppressedCount.get(key) || 0) + 1);
    return false;
  }
  lastSentAt.set(key, now);
  return true;
}

async function sendWebhook(subject, details) {
  const url = process.env.OPS_ALERT_WEBHOOK_URL;
  if (!url) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject, details, ts: new Date().toISOString(), source: 'PerfStudio' }),
      signal: controller.signal,
    });
    return res.ok;
  } catch (error) {
    console.error('[OpsAlert] webhook delivery failed:', error.message);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Emails only the reservation/action's owning user plus their org's opted-in
 * ops_alert_recipients — never the old blanket org_admin/super_admin list. */
async function sendScopedEmail(orgId, userId, subject, details) {
  try {
    const cfg = await getAlertConfig(null);
    if (!cfg) return false;
    const recipients = await db.prepare(`
      SELECT DISTINCT email FROM users
      WHERE email IS NOT NULL AND email != '' AND (
        id = ?
        OR id IN (SELECT user_id FROM ops_alert_recipients WHERE org_id = ?)
      )
    `).all(userId, orgId);
    if (!recipients.length) return false;
    const transport = createTransport(cfg);
    await transport.sendMail({
      from: cfg.smtp_from || cfg.smtp_user,
      to: recipients.map(r => r.email).join(','),
      subject: `[PerfStudio ops alert] ${subject}`,
      text: details,
    });
    return true;
  } catch (error) {
    console.error('[OpsAlert] email delivery failed:', error.message);
    return false;
  }
}

/** Infra-only failures with no owning org/user — surfaced in the in-app
 * super_admin notification bell instead of email. */
async function sendNotification(kind, subject, details) {
  try {
    await db.prepare('INSERT INTO notifications (kind, subject, details) VALUES (?, ?, ?)').run(kind, subject, details);
    return true;
  } catch (error) {
    console.error('[OpsAlert] notification insert failed:', error.message);
    return false;
  }
}

/**
 * Report an operational failure. `kind` groups related failures for rate-limiting
 * (e.g. 's3_upload_failure') — keep it stable and coarse, not per-file/per-key.
 *
 * `options.orgId`/`options.userId` route this to the owning user + their org's
 * opted-in recipients via email. Omit `orgId` (or pass `options.internal: true`)
 * for infra failures with no owning org — those go to the in-app notification
 * feed instead, never to any admin's inbox.
 */
function alertOpsFailure(kind, subject, details, options = {}) {
  const { orgId = null, userId = null, internal = false } = options;
  const key = rateLimitKey(kind, orgId);
  if (!shouldSend(key)) return;
  const suppressed = suppressedCount.get(key) || 0;
  suppressedCount.set(key, 0);
  const fullDetails = suppressed > 0
    ? `${details}\n\n(${suppressed} additional similar failure(s) suppressed in the last ${Math.round(RATE_LIMIT_MS / 60000)} min.)`
    : details;

  const useNotification = internal || !orgId;

  Promise.resolve().then(async () => {
    const [webhookOk, secondaryOk] = await Promise.all([
      sendWebhook(subject, fullDetails),
      useNotification ? sendNotification(kind, subject, fullDetails) : sendScopedEmail(orgId, userId, subject, fullDetails),
    ]);
    if (!webhookOk && !secondaryOk) {
      console.error(`[OpsAlert] No alert channel configured or all failed for: ${subject}\n${fullDetails}`);
    }
  }).catch(() => {});
}

module.exports = { alertOpsFailure };
