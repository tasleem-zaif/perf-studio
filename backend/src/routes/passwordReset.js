/**
 * passwordReset.js — Self-service + admin password recovery
 *
 * POST /auth/forgot-password        — user requests reset email
 * POST /auth/reset-password         — user sets new password via token
 * POST /admin/users/:id/reset-password — admin sets a new password for a user
 */

const router  = require('express').Router();
const crypto  = require('crypto');
const bcrypt  = require('bcryptjs');
const db      = require('../db');
const auth    = require('../middleware/auth');
const nodemailer = require('nodemailer');

const RESET_EXPIRY_MINUTES = 30;

// ── Helper: get SMTP transport (same fallback logic as invites) ──────────────
function getTransport(userId) {
  const { decrypt } = require('../utils/encryption');
  let cfg = db.prepare('SELECT * FROM alert_configs WHERE user_id = ?').get(userId);
  if (!cfg?.smtp_host || !cfg?.from_email || !cfg?.smtp_pass) {
    const superAdmin = db.prepare("SELECT id FROM users WHERE role = 'super_admin' LIMIT 1").get();
    if (superAdmin) cfg = db.prepare('SELECT * FROM alert_configs WHERE user_id = ?').get(superAdmin.id);
  }
  if (!cfg?.smtp_host || !cfg?.from_email) return null;
  return { transport: nodemailer.createTransport({
    host: cfg.smtp_host, port: Number(cfg.smtp_port) || 587,
    secure: !!cfg.smtp_secure,
    auth: cfg.smtp_user ? { user: cfg.smtp_user, pass: decrypt(cfg.smtp_pass) } : undefined,
    tls: { rejectUnauthorized: false },
  }), cfg };
}

// ── POST /auth/forgot-password ───────────────────────────────────────────────
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required.' });

  // Always respond OK — don't reveal whether email exists (security best practice)
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) return res.json({ ok: true, message: 'If that email exists, a reset link has been sent.' });

  // Expire any existing tokens for this user
  db.prepare("UPDATE password_resets SET used=1 WHERE user_id=? AND used=0").run(user.id);

  // Create new token (valid for 30 min)
  const token     = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + RESET_EXPIRY_MINUTES * 60 * 1000).toISOString();
  db.prepare('INSERT INTO password_resets (user_id, token, expires_at) VALUES (?,?,?)')
    .run(user.id, token, expiresAt);

  // Build reset URL from request origin header
  const frontendUrl = req.headers.origin || process.env.FRONTEND_URL || 'http://localhost:5173';
  const resetUrl    = `${frontendUrl}/reset-password/${token}`;

  // Send email
  const result = getTransport(user.id);
  if (result) {
    const { transport, cfg } = result;
    try {
      await transport.sendMail({
        from: `"Performance Studio" <${cfg.from_email}>`,
        to: email,
        subject: 'Performance Studio — Password Reset',
        html: `<!DOCTYPE html>
<html>
<body style="font-family:Arial,sans-serif;background:#f4f6f9;margin:0;padding:32px;">
<div style="max-width:520px;margin:0 auto;background:#1a2035;border-radius:12px;overflow:hidden;">
  <div style="background:linear-gradient(135deg,#0f172a,#1e3a5f);padding:18px 24px;">
    <img src="https://www.qtsolv.com/wp-content/themes/qtsolvtheme/assets/images/svg/logo.svg"
         alt="Quarks" height="32"
         style="height:32px;vertical-align:middle;margin-right:10px;filter:brightness(0) invert(1);" />
    <span style="color:#f0f3fa;font-size:16px;font-weight:700;vertical-align:middle;">Performance Studio</span>
  </div>
  <div style="padding:28px;">
    <h2 style="color:#f59e0b;margin:0 0 14px;font-size:18px;">🔑 Password Reset Request</h2>
    <p style="color:#b8c4d8;font-size:13px;line-height:1.7;margin:0 0 20px;">
      We received a request to reset the password for <strong style="color:#f0f3fa;">${email}</strong>.
      Click the button below to set a new password.
    </p>
    <div style="text-align:center;margin:24px 0;">
      <a href="${resetUrl}"
         style="background:#f59e0b;color:#fff;padding:13px 36px;border-radius:8px;
                text-decoration:none;font-weight:700;font-size:15px;display:inline-block;">
        Reset Password
      </a>
    </div>
    <p style="color:#7a8eaa;font-size:12px;margin:0 0 8px;">
      This link expires in <strong style="color:#f0f3fa;">${RESET_EXPIRY_MINUTES} minutes</strong>.
    </p>
    <p style="color:#4b5563;font-size:11px;margin:0;">
      If you didn't request this, you can safely ignore this email.
    </p>
  </div>
  <div style="background:#0f172a;padding:10px 24px;border-top:1px solid #2e3a55;text-align:center;">
    <p style="color:#4b5563;font-size:11px;margin:0;">Performance Studio — AI-Powered Performance Testing</p>
  </div>
</div>
</body>
</html>`,
        text: `Password Reset\n\nClick here to reset your password:\n${resetUrl}\n\nThis link expires in ${RESET_EXPIRY_MINUTES} minutes.\n\nIf you didn't request this, ignore this email.`,
      });
    } catch (e) {
      console.error('[Reset] Email send failed:', e.message);
    }
  }

  res.json({ ok: true, message: 'If that email exists, a reset link has been sent.' });
});

// ── POST /auth/reset-password ─────────────────────────────────────────────────
router.post('/reset-password', (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token and password are required.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  const reset = db.prepare("SELECT * FROM password_resets WHERE token=? AND used=0").get(token);
  if (!reset) return res.status(404).json({ error: 'Reset link is invalid or already used.' });
  if (new Date(reset.expires_at) < new Date()) {
    return res.status(410).json({ error: `Reset link has expired (${RESET_EXPIRY_MINUTES}-minute limit). Request a new one.` });
  }

  const hash = bcrypt.hashSync(password, 10);
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, reset.user_id);
  db.prepare('UPDATE password_resets SET used=1 WHERE id=?').run(reset.id);

  res.json({ ok: true, message: 'Password reset successfully. You can now sign in.' });
});

// ── POST /admin/users/:id/reset-password (admin overrides a user's password) ──
router.post('/users/:id/reset-password', auth, (req, res) => {
  const caller = db.prepare('SELECT role, org_id FROM users WHERE id = ?').get(req.userId);
  if (!caller || !['super_admin', 'org_admin'].includes(caller.role)) {
    return res.status(403).json({ error: 'Only admins can reset passwords.' });
  }

  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (target.role === 'super_admin') return res.status(403).json({ error: 'Cannot reset super admin password.' });

  // Org admin can only reset users in their org
  if (caller.role === 'org_admin' && target.org_id !== caller.org_id) {
    return res.status(403).json({ error: 'Forbidden.' });
  }

  const { new_password } = req.body;
  if (!new_password || new_password.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  }

  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, target.id);

  res.json({ ok: true, message: `Password for ${target.name} reset successfully.` });
});

module.exports = router;
