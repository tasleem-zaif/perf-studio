const router = require('express').Router({ mergeParams: true });
const db     = require('../db');
const auth   = require('../middleware/auth');
const { createTransport } = require('nodemailer');
const { encrypt, decrypt } = require('../utils/encryption');

router.use(auth);

// ── SMTP Config ───────────────────────────────────────────────────────────────

router.get('/config', (req, res) => {
  let row = db.prepare('SELECT * FROM alert_configs WHERE user_id = ?').get(req.userId);

  // If user has no config, return super admin's config (without password) as default
  if (!row || !row.smtp_host) {
    const superAdmin = db.prepare("SELECT id FROM users WHERE role = 'super_admin' LIMIT 1").get();
    if (superAdmin && superAdmin.id !== req.userId) {
      const superRow = db.prepare('SELECT * FROM alert_configs WHERE user_id = ?').get(superAdmin.id);
      if (superRow?.smtp_host) {
        return res.json({
          config: {
            ...superRow,
            smtp_pass: '',        // never send password to other users
            inherited_from_super_admin: true,
          }
        });
      }
    }
  }

  if (!row) return res.json({ config: null });
  res.json({ config: { ...row, smtp_pass: row.smtp_pass ? '••••••••' : '' } });
});

router.put('/config', (req, res) => {
  const { smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass, from_name, from_email } = req.body;
  const existing = db.prepare('SELECT id, smtp_pass FROM alert_configs WHERE user_id = ?').get(req.userId);

  const finalPass = (smtp_pass && smtp_pass !== '••••••••')
    ? encrypt(smtp_pass)
    : (existing?.smtp_pass || '');

  if (existing) {
    db.prepare(`
      UPDATE alert_configs SET smtp_host=?, smtp_port=?, smtp_secure=?, smtp_user=?,
        smtp_pass=?, from_name=?, from_email=?, enabled=1 WHERE user_id=?
    `).run(smtp_host||'', Number(smtp_port)||587, smtp_secure?1:0, smtp_user||'',
           finalPass, from_name||'Peako', from_email||'', req.userId);
  } else {
    db.prepare(`
      INSERT INTO alert_configs (user_id, smtp_host, smtp_port, smtp_secure, smtp_user,
        smtp_pass, from_name, from_email, enabled) VALUES (?,?,?,?,?,?,?,?,1)
    `).run(req.userId, smtp_host||'', Number(smtp_port)||587, smtp_secure?1:0, smtp_user||'',
           finalPass, from_name||'Peako', from_email||'');
  }
  res.json({ ok: true });
});

// ── Test SMTP connection ──────────────────────────────────────────────────────

router.post('/test-smtp', async (req, res) => {
  const row = db.prepare('SELECT * FROM alert_configs WHERE user_id = ?').get(req.userId);
  if (!row || !row.smtp_host) return res.status(400).json({ error: 'SMTP not configured' });
  try {
    const transport = createTransport({
      host: row.smtp_host, port: Number(row.smtp_port)||587,
      secure: !!row.smtp_secure,
      auth: row.smtp_user ? { user: row.smtp_user, pass: decrypt(row.smtp_pass) } : undefined,
      tls: { rejectUnauthorized: false },
    });
    await transport.verify();
    res.json({ ok: true, message: 'SMTP connection successful' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Send test email ───────────────────────────────────────────────────────────

router.post('/send-test', async (req, res) => {
  const row = db.prepare('SELECT * FROM alert_configs WHERE user_id = ?').get(req.userId);
  if (!row || !row.smtp_host || !row.from_email) return res.status(400).json({ error: 'SMTP not configured. Fill in all fields and click Save Config first.' });
  if (!row.smtp_pass) return res.status(400).json({ error: 'SMTP password not saved. Enter your password and click Save Config first.' });
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'Recipient email required' });
  try {
    const transport = createTransport({
      host: row.smtp_host, port: Number(row.smtp_port)||587,
      secure: !!row.smtp_secure,
      auth: row.smtp_user ? { user: row.smtp_user, pass: decrypt(row.smtp_pass) } : undefined,
      tls: { rejectUnauthorized: false },
      logger: false,
      debug: false,
    });

    // Verify connection first
    await transport.verify();

    const info = await transport.sendMail({
      from:    `"${row.from_name||'Peako'}" <${row.from_email}>`,
      to,
      replyTo: row.from_email,
      subject: `Peako — SMTP Configuration Verified`,
      text: `Hello,\n\nYour Peako SMTP configuration is working correctly.\nSent from: ${row.from_email}\n\nThis is a test email. If you received this, email alerts will be delivered to your inbox after each test run.\n\nThanks,\nPeako`,
      html: `<div style="font-family:Arial,sans-serif;max-width:520px;background:#1a2035;border-radius:12px;overflow:hidden;">
        <div style="background:linear-gradient(135deg,#0f172a 0%,#1e3a5f 100%);padding:18px 24px;">
          <img src="https://www.qtsolv.com/wp-content/themes/qtsolvtheme/assets/images/svg/logo.svg"
               alt="Quarks" height="32"
               style="display:inline-block;height:32px;vertical-align:middle;margin-right:10px;filter:brightness(0) invert(1);" />
          <span style="color:#f0f3fa;font-size:16px;font-weight:700;vertical-align:middle;">Peako</span>
        </div>
        <div style="padding:24px;">
          <h2 style="color:#22c55e;margin:0 0 12px;font-size:16px;">✅ SMTP Configuration Working</h2>
          <p style="color:#b8c4d8;margin:0 0 8px;font-size:13px;">Your Peako email alerts are configured correctly.</p>
          <p style="color:#b8c4d8;margin:0 0 16px;font-size:13px;">Sent from: <strong style="color:#f0f3fa;">${row.from_email}</strong></p>
          <p style="color:#7a8eaa;font-size:12px;margin:0;">If you received this in your inbox, email alerts will be delivered after each test run.</p>
        </div>
        <div style="background:#0f172a;padding:10px 24px;border-top:1px solid #2e3a55;text-align:center;">
          <p style="color:#4b5563;font-size:11px;margin:0;">Peako — Automated Test Reporting</p>
        </div>
      </div>`,
      headers: {
        'X-Mailer':       'Peako',
        'X-Priority':     '3',
        'Importance':     'Normal',
      },
    });

    console.log(`[Alerts] Test email sent to ${to} — MessageId: ${info.messageId}, Response: ${info.response}`);
    res.json({
      ok: true,
      message: `✅ Email delivered to ${to}. Check your inbox (and spam folder). MessageId: ${info.messageId}`,
    });
  } catch (e) {
    console.error('[Alerts] Send test failed:', e.message);
    // Provide helpful error messages for common failures
    let msg = e.message;
    if (msg.includes('Invalid login') || msg.includes('Username and Password') || msg.includes('535')) {
      msg = 'Authentication failed — wrong username or password. For Gmail, use an App Password (not your account password).';
    } else if (msg.includes('ECONNREFUSED')) {
      msg = `Connection refused on port ${row.smtp_port}. Try port 587 with Secure OFF, or port 465 with Secure ON.`;
    } else if (msg.includes('ETIMEDOUT') || msg.includes('ENOTFOUND')) {
      msg = `Cannot reach ${row.smtp_host}. Check the SMTP Host field — it should be a server address like smtp.gmail.com, not an email address.`;
    } else if (msg.includes('self signed') || msg.includes('certificate')) {
      msg = 'SSL certificate error. Try unchecking the Secure checkbox and using port 587.';
    }
    res.status(400).json({ error: msg });
  }
});

// ── Global Recipients (not tied to a project) ─────────────────────────────────

router.get('/recipients', (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM alert_recipients WHERE user_id = ? AND project_id IS NULL ORDER BY email'
  ).all(req.userId);
  res.json({ recipients: rows });
});

router.post('/recipients', (req, res) => {
  const { email, name } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  const existing = db.prepare('SELECT id FROM alert_recipients WHERE user_id = ? AND project_id IS NULL AND email = ?').get(req.userId, email);
  if (existing) return res.status(400).json({ error: 'Recipient already exists' });
  const r = db.prepare('INSERT INTO alert_recipients (user_id, email, name) VALUES (?,?,?)').run(req.userId, email, name||'');
  res.json({ recipient: db.prepare('SELECT * FROM alert_recipients WHERE id=?').get(r.lastInsertRowid) });
});

router.delete('/recipients/:id', (req, res) => {
  db.prepare('DELETE FROM alert_recipients WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
  res.json({ ok: true });
});

// ── Project-specific Recipients ───────────────────────────────────────────────

router.get('/projects/:projectId/recipients', (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM alert_recipients WHERE project_id = ? ORDER BY email'
  ).all(req.params.projectId);
  res.json({ recipients: rows });
});

router.post('/projects/:projectId/recipients', (req, res) => {
  const { email, name } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  const existing = db.prepare('SELECT id FROM alert_recipients WHERE project_id = ? AND email = ?').get(req.params.projectId, email);
  if (existing) return res.status(400).json({ error: 'Recipient already exists' });
  const r = db.prepare('INSERT INTO alert_recipients (user_id, project_id, email, name) VALUES (?,?,?,?)').run(req.userId, req.params.projectId, email, name||'');
  res.json({ recipient: db.prepare('SELECT * FROM alert_recipients WHERE id=?').get(r.lastInsertRowid) });
});

router.delete('/projects/:projectId/recipients/:id', (req, res) => {
  db.prepare('DELETE FROM alert_recipients WHERE id = ? AND project_id = ?').run(req.params.id, req.params.projectId);
  res.json({ ok: true });
});

module.exports = router;
