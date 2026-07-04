/**
 * invites.js — Invite-based user onboarding
 *
 * Super Admin  → invites Org Admin   → email sent → Org Admin accepts → sets password
 * Org Admin    → invites Regular User → email sent → User accepts → sets password
 * Org Admin    → assigns projects to Regular Users
 */

const router  = require('express').Router();
const crypto  = require('crypto');
const bcrypt  = require('bcryptjs');
const db      = require('../db');
const auth    = require('../middleware/auth');
const nodemailer = require('nodemailer');
const { getOrgLicenseStatus } = require('../utils/license');

const INVITE_EXPIRY_HOURS = 72; // 3 days

function getFrontendUrl() {
  return process.env.FRONTEND_URL || 'http://localhost:5173';
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getInviteTransport(userId) {
  const { decrypt } = require('../utils/encryption');

  // Helper: check if a config row is usable for sending
  const isUsable = c => c?.smtp_host && c?.from_email && c?.smtp_pass;

  // Try user's own config first
  let cfg = await db.prepare('SELECT * FROM alert_configs WHERE user_id = ?').get(userId);

  // Fall back to super admin if user has no config OR their config is incomplete/not usable
  if (!isUsable(cfg)) {
    const superAdmin = await db.prepare("SELECT id FROM users WHERE role = 'super_admin' LIMIT 1").get();
    if (superAdmin && superAdmin.id !== userId) {
      const superCfg = await db.prepare('SELECT * FROM alert_configs WHERE user_id = ?').get(superAdmin.id);
      if (isUsable(superCfg)) cfg = superCfg;
    }
  }

  if (!isUsable(cfg)) return { transport: null, cfg: null };

  const transport = nodemailer.createTransport({
    host: cfg.smtp_host, port: Number(cfg.smtp_port) || 587,
    secure: !!cfg.smtp_secure,
    auth: cfg.smtp_user ? { user: cfg.smtp_user, pass: decrypt(cfg.smtp_pass) } : undefined,
    tls: { rejectUnauthorized: false },
  });
  return { transport, cfg };
}

function buildInviteEmail(invite, acceptUrl, inviterName, orgName) {
  const roleLabel = invite.role === 'org_admin' ? 'Organization Admin' : 'Team Member';
  return {
    subject: `You have been invited to PerfStudio — ${orgName || 'PerfStudio'}`,
    html: `<!DOCTYPE html>
<html>
<body style="font-family:Arial,sans-serif;background:#f4f6f9;margin:0;padding:32px;">
<div style="max-width:520px;margin:0 auto;background:#1a2035;border-radius:12px;overflow:hidden;">

  <!-- Header -->
  <div style="background:linear-gradient(135deg,#0f172a 0%,#1e3a5f 100%);padding:18px 24px;">
    <img src="https://www.qtsolv.com/wp-content/themes/qtsolvtheme/assets/images/svg/logo.svg"
         alt="Quarks" height="32"
         style="display:inline-block;height:32px;vertical-align:middle;margin-right:10px;filter:brightness(0) invert(1);" />
    <span style="color:#f0f3fa;font-size:16px;font-weight:700;vertical-align:middle;">PerfStudio</span>
  </div>

  <!-- Body -->
  <div style="padding:28px 28px 24px;">
    <h2 style="color:#22c55e;margin:0 0 14px;font-size:18px;font-weight:700;">
      🎉 You have been invited!
    </h2>
    <p style="color:#b8c4d8;line-height:1.7;margin:0 0 6px;font-size:13px;">
      <strong style="color:#f0f3fa;">${inviterName}</strong> has invited you to join
      <strong style="color:#f0f3fa;">${orgName || 'PerfStudio'}</strong> as a
      <strong style="color:#22c55e;">${roleLabel}</strong>.
    </p>
    <p style="color:#b8c4d8;margin:0 0 20px;font-size:13px;line-height:1.6;">
      Click the button below to set up your account and get started.
    </p>

    <!-- CTA Button -->
    <div style="text-align:center;margin:24px 0;">
      <a href="${acceptUrl}"
         style="background:#22c55e;color:#fff;padding:13px 36px;border-radius:8px;
                text-decoration:none;font-weight:700;font-size:15px;display:inline-block;">
        Accept Invitation
      </a>
    </div>

    <!-- Fallback URL -->
    <p style="color:#7a8eaa;font-size:12px;margin:0 0 6px;">
      If the button doesn't work, copy and paste this link into your browser:
    </p>
    <div style="background:#0f172a;border:1px solid #2e3a55;border-radius:6px;
                padding:10px 14px;word-break:break-all;font-family:monospace;
                font-size:12px;color:#94a3b8;margin-bottom:20px;">
      ${acceptUrl}
    </div>

    <p style="color:#4b5563;font-size:11px;margin:0;line-height:1.6;">
      This invitation expires in <strong style="color:#7a8eaa;">72 hours</strong>.
      If you did not expect this email, you can safely ignore it.
    </p>
  </div>

  <!-- Footer -->
  <div style="background:#0f172a;padding:10px 24px;border-top:1px solid #2e3a55;text-align:center;">
    <p style="color:#4b5563;font-size:11px;margin:0;">PerfStudio — AI-Powered Performance Testing</p>
  </div>

</div>
</body>
</html>`,
    text: `You have been invited!\n\n${inviterName} has invited you to join ${orgName || 'PerfStudio'} as ${roleLabel}.\n\nAccept your invitation here:\n${acceptUrl}\n\nThis link expires in 72 hours.\n\n— PerfStudio`,
  };
}

// ── Shared invite-creation logic ───────────────────────────────────────────────
// Used by the POST / route below, and reused directly by orgs.js when an admin
// email is supplied at organization-creation time. Throws { status, error, message? }
// on failure so callers can translate it into the right HTTP response.

async function createInviteCore({ email, name, role, orgId, invitedByUserId, invitedByName, frontendUrl }) {
  const existing = await db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) throw { status: 400, error: 'A user with this email already exists' };

  if (orgId) {
    const license = await getOrgLicenseStatus(orgId);
    if (!license.isValid) {
      throw {
        status: 403,
        error: license.isDisabled ? 'org_disabled' : 'license_expired',
        message: license.isDisabled
          ? 'This organization\'s access has been disabled.'
          : 'This organization\'s license has expired.',
      };
    }
    if (license.usersAtLimit) {
      throw {
        status: 400,
        error: 'user_limit_reached',
        message: `This organization has reached its user limit (${license.maxUsers}) for the ${license.plan} plan. Upgrade the plan to invite more users.`,
      };
    }
  }

  // Expire ALL prior invites for this email (pending or accepted) before creating a fresh one
  await db.prepare("UPDATE invites SET status='expired' WHERE email=?").run(email);

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + INVITE_EXPIRY_HOURS * 3600 * 1000).toISOString();

  await db.prepare(
    'INSERT INTO invites (email, name, role, org_id, invited_by, token, expires_at) VALUES (?,?,?,?,?,?,?)'
  ).run(email, name || '', role, orgId, invitedByUserId, token, expiresAt);

  const resolvedFrontendUrl = (frontendUrl && frontendUrl.startsWith('http')) ? frontendUrl : getFrontendUrl();
  const acceptUrl = `${resolvedFrontendUrl}/accept-invite/${token}`;

  const { transport, cfg: smtpCfg } = await getInviteTransport(invitedByUserId);
  const org = orgId ? await db.prepare('SELECT name FROM organizations WHERE id = ?').get(orgId) : null;
  const email_ = buildInviteEmail({ role }, acceptUrl, invitedByName, org?.name || 'PerfStudio');
  let emailSent = false;

  if (transport) {
    try {
      await transport.sendMail({
        from: `"${smtpCfg?.from_name || 'PerfStudio'}" <${smtpCfg?.from_email}>`,
        replyTo: smtpCfg?.from_email,
        to: name ? `"${name}" <${email}>` : email,
        subject: email_.subject,
        html: email_.html,
        text: email_.text,
        headers: {
          'X-Mailer':    'PerfStudio',
          'X-Priority':  '1',
          'Importance':  'high',
          'Precedence':  'bulk',
        },
      });
      emailSent = true;
      console.log(`[Invites] Email sent to ${email}`);
    } catch (e) {
      console.error('[Invites] Email send error:', e.message);
    }
  }

  return {
    ok: true,
    message: emailSent ? `Invitation email sent to ${email}` : `Invite created — email not sent (SMTP not configured)`,
    invite_url: acceptUrl,
    email_sent: emailSent,
  };
}

// ── Create invite (Super Admin or Org Admin) ──────────────────────────────────

router.post('/', auth, async (req, res) => {
  const inviter = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!inviter) return res.status(401).json({ error: 'Unauthorized' });

  const { email, name, role } = req.body;
  if (!email || !role) return res.status(400).json({ error: 'email and role required' });

  // Super admin can invite org_admin; org_admin can invite user OR another org_admin (same org)
  if (inviter.role === 'super_admin' && role !== 'org_admin')
    return res.status(403).json({ error: 'Super admin can only invite org admins' });
  if (inviter.role === 'org_admin' && !['user', 'org_admin'].includes(role))
    return res.status(403).json({ error: 'Org admin can only invite regular users or other org admins' });
  if (inviter.role === 'user')
    return res.status(403).json({ error: 'Regular users cannot send invites' });

  // Org admin inviting another org_admin must belong to an org themselves
  if (inviter.role === 'org_admin' && role === 'org_admin' && !inviter.org_id)
    return res.status(400).json({ error: 'You must belong to an organization to invite another Org Admin' });

  // Super admin MUST assign an organization when inviting org admin
  if (inviter.role === 'super_admin' && role === 'org_admin' && !req.body.org_id)
    return res.status(400).json({ error: 'You must select an organization for the Org Admin. Create one first under Organizations.' });

  // Determine org — super admin can pre-assign an org when inviting org_admin
  const orgId = inviter.role === 'org_admin'
    ? inviter.org_id
    : (req.body.org_id ? Number(req.body.org_id) : null);

  try {
    const result = await createInviteCore({
      email, name, role, orgId,
      invitedByUserId: req.userId,
      invitedByName: inviter.name,
      frontendUrl: req.body.frontend_url,
    });
    res.json(result);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.error, message: e.message });
    throw e;
  }
});

// ── List pending invites ───────────────────────────────────────────────────────

router.get('/', auth, async (req, res) => {
  const inviter = await db.prepare('SELECT role, org_id FROM users WHERE id = ?').get(req.userId);
  let invites;
  if (inviter.role === 'super_admin') {
    invites = await db.prepare(`
      SELECT i.*, u.name as inviter_name FROM invites i
      LEFT JOIN users u ON u.id = i.invited_by
      ORDER BY i.created_at DESC
    `).all();
  } else if (inviter.role === 'org_admin') {
    invites = await db.prepare(`
      SELECT i.*, u.name as inviter_name FROM invites i
      LEFT JOIN users u ON u.id = i.invited_by
      WHERE i.org_id = ? ORDER BY i.created_at DESC
    `).all(inviter.org_id);
  } else {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json({ invites });
});

// ── Cancel / revoke invite ────────────────────────────────────────────────────

router.delete('/:id', auth, async (req, res) => {
  await db.prepare("UPDATE invites SET status = 'expired' WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ── Validate token (public — no auth required) ────────────────────────────────

router.get('/validate/:token', async (req, res) => {
  // Look up invite regardless of status so we can give specific error messages
  const invite = await db.prepare('SELECT * FROM invites WHERE token = ?').get(req.params.token);

  if (!invite) {
    return res.status(404).json({ error: 'not_found', message: 'This invite link is invalid or does not exist.' });
  }

  if (invite.status === 'accepted') {
    return res.status(409).json({ error: 'already_accepted', message: 'This invitation has already been accepted. Please log in with your account.' });
  }

  if (invite.status === 'expired' || new Date(invite.expires_at) < new Date()) {
    return res.status(410).json({ error: 'expired', message: 'This invitation link has expired (72-hour limit). Please ask your administrator to send a new invite.' });
  }

  // Valid pending invite
  const org     = invite.org_id ? await db.prepare('SELECT name FROM organizations WHERE id = ?').get(invite.org_id) : null;
  const inviter = await db.prepare('SELECT name FROM users WHERE id = ?').get(invite.invited_by);

  res.json({
    email:        invite.email,
    name:         invite.name,
    role:         invite.role,
    org_name:     org?.name || '',
    inviter_name: inviter?.name || '',
  });
});

// ── Accept invite — set name + password ───────────────────────────────────────

router.post('/accept/:token', async (req, res) => {
  const invite = await db.prepare(
    "SELECT * FROM invites WHERE token = ? AND status = 'pending'"
  ).get(req.params.token);
  if (!invite) return res.status(404).json({ error: 'Invite not found or already used' });
  if (new Date(invite.expires_at) < new Date())
    return res.status(410).json({ error: 'Invite has expired' });

  const { name, password } = req.body;
  if (!name || !password) return res.status(400).json({ error: 'Name and password required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  // Check if user already exists
  const existing = await db.prepare('SELECT id FROM users WHERE email = ?').get(invite.email);
  if (existing) return res.status(400).json({ error: 'Account already exists for this email' });

  const passwordHash = bcrypt.hashSync(password, 10);

  // Org is always pre-assigned by super admin — never created during acceptance
  let orgId = invite.org_id;
  if (invite.role === 'org_admin' && !orgId) {
    return res.status(400).json({ error: 'No organization assigned to this invite. Contact Super Admin.' });
  }

  // Re-check the org's license — time may have passed since the invite was sent,
  // and other invites could have been accepted in the meantime.
  if (orgId) {
    const license = await getOrgLicenseStatus(orgId);
    if (!license.isValid) {
      return res.status(403).json({
        error: license.isDisabled ? 'org_disabled' : 'license_expired',
        message: license.isDisabled
          ? 'This organization\'s access has been disabled. Contact your administrator.'
          : 'This organization\'s license has expired. Contact your administrator.',
      });
    }
    if (license.usersAtLimit) {
      return res.status(400).json({
        error: 'user_limit_reached',
        message: `This organization has reached its user limit (${license.maxUsers}) for the ${license.plan} plan. Contact your administrator.`,
      });
    }
  }

  // Create user
  const userResult = await db.prepare(
    'INSERT INTO users (email, name, password_hash, role, org_id, status) VALUES (?,?,?,?,?,?)'
  ).run(invite.email, name, passwordHash, invite.role, orgId, 'active');

  // Mark invite as accepted
  await db.prepare("UPDATE invites SET status = 'accepted' WHERE id = ?").run(invite.id);

  // Generate JWT for immediate login
  const jwt = require('jsonwebtoken');
  const token = jwt.sign({ userId: userResult.lastInsertRowid }, process.env.JWT_SECRET || 'perf_studio_secret_change_in_prod', { expiresIn: '14d' });
  const user  = await db.prepare('SELECT id, email, name, role, org_id, status FROM users WHERE id = ?').get(userResult.lastInsertRowid);

  res.json({ ok: true, token, user });
});

// ── Project assignments ───────────────────────────────────────────────────────

// List users in my org with their assigned projects
router.get('/org-users', auth, async (req, res) => {
  const caller = await db.prepare('SELECT role, org_id FROM users WHERE id = ?').get(req.userId);
  if (!['super_admin', 'org_admin'].includes(caller.role))
    return res.status(403).json({ error: 'Forbidden' });

  const orgId = caller.role === 'org_admin' ? caller.org_id : req.query.org_id;
  const users = await db.prepare(`
    SELECT u.id, u.email, u.name, u.role, u.status,
      STRING_AGG(pa.project_id::text, ',') as assigned_project_ids
    FROM users u
    LEFT JOIN project_assignments pa ON pa.user_id = u.id
    WHERE u.org_id = ? AND u.role = 'user'
    GROUP BY u.id ORDER BY u.name
  `).all(orgId);

  res.json({ users: users.map(u => ({
    ...u,
    assigned_project_ids: u.assigned_project_ids
      ? u.assigned_project_ids.split(',').map(Number)
      : [],
  }))});
});

// Assign / unassign projects to a user
router.put('/assign/:userId', auth, async (req, res) => {
  const caller = await db.prepare('SELECT role, org_id FROM users WHERE id = ?').get(req.userId);
  if (!['super_admin', 'org_admin'].includes(caller.role))
    return res.status(403).json({ error: 'Forbidden' });

  const { project_ids } = req.body; // array of project ids to assign
  const userId = Number(req.params.userId);

  // Clear existing assignments
  await db.prepare('DELETE FROM project_assignments WHERE user_id = ?').run(userId);

  // Add new assignments
  for (const pid of (project_ids || [])) {
    try {
      await db.prepare(
        'INSERT INTO project_assignments (project_id, user_id, assigned_by) VALUES (?,?,?)'
      ).run(pid, userId, req.userId);
    } catch (_) {}
  }

  res.json({ ok: true });
});

module.exports = router;
module.exports.createInviteCore = createInviteCore;
