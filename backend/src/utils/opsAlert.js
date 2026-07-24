/**
 * opsAlert.js — real alerting for backend operational failures (currently: S3 sync
 * failures) that used to only be visible as a `console.error` line. Two channels, either
 * or both may be configured; no-ops silently if neither is:
 *   - Webhook: OPS_ALERT_WEBHOOK_URL — POSTed a JSON payload.
 *   - Email: reuses the existing SMTP alert infra (emailUtils.js/alert_configs) — the
 *     same admin-fallback SMTP config run alerts already use — sent to every
 *     org_admin/super_admin.
 * Fire-and-forget: callers never await this and it never throws. Rate-limited per
 * failure `kind` so a sustained outage (e.g. S3 down for an hour) sends one alert per
 * window, not one per failed operation.
 */
const db = require('../db');
const { createTransport, getAlertConfig } = require('./emailUtils');

const RATE_LIMIT_MS = Number(process.env.OPS_ALERT_RATE_LIMIT_MS) || 5 * 60 * 1000;

const lastSentAt = new Map();      // kind -> timestamp of last actually-sent alert
const suppressedCount = new Map(); // kind -> count suppressed since that last send

function shouldSend(kind) {
  const now = Date.now();
  const last = lastSentAt.get(kind) || 0;
  if (now - last < RATE_LIMIT_MS) {
    suppressedCount.set(kind, (suppressedCount.get(kind) || 0) + 1);
    return false;
  }
  lastSentAt.set(kind, now);
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

async function sendEmail(subject, details) {
  try {
    const cfg = await getAlertConfig(null);
    if (!cfg) return false;
    const recipients = await db.prepare(
      `SELECT DISTINCT email FROM users WHERE role IN ('org_admin', 'super_admin') AND email IS NOT NULL AND email != ''`
    ).all();
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

/**
 * Report an operational failure. `kind` groups related failures for rate-limiting
 * (e.g. 's3_upload_failure') — keep it stable and coarse, not per-file/per-key.
 */
function alertOpsFailure(kind, subject, details) {
  if (!shouldSend(kind)) return;
  const suppressed = suppressedCount.get(kind) || 0;
  suppressedCount.set(kind, 0);
  const fullDetails = suppressed > 0
    ? `${details}\n\n(${suppressed} additional similar failure(s) suppressed in the last ${Math.round(RATE_LIMIT_MS / 60000)} min.)`
    : details;

  Promise.resolve().then(async () => {
    const [webhookOk, emailOk] = await Promise.all([
      sendWebhook(subject, fullDetails),
      sendEmail(subject, fullDetails),
    ]);
    if (!webhookOk && !emailOk) {
      console.error(`[OpsAlert] No alert channel configured or all failed for: ${subject}\n${fullDetails}`);
    }
  }).catch(() => {});
}

module.exports = { alertOpsFailure };
