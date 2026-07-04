const jwt = require('jsonwebtoken');
const db  = require('../db');
const { getOrgAccessStatus } = require('../utils/license');
const JWT_SECRET = process.env.JWT_SECRET || 'perf_studio_secret_change_in_prod';

const INACTIVITY_MINUTES = 30;

module.exports = async function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET);

    if (!payload.jti) {
      return res.status(401).json({ error: 'Session expired. Please sign in again.' });
    }

    const session = await db.prepare(`
      SELECT id FROM user_sessions
      WHERE user_id = ? AND jti = ?
        AND expires_at > NOW()
        AND COALESCE(last_used_at, created_at) + interval '${INACTIVITY_MINUTES} minutes' > NOW()
    `).get(payload.userId, payload.jti);

    if (!session) {
      await db.prepare('DELETE FROM user_sessions WHERE user_id = ? AND jti = ?').run(payload.userId, payload.jti);
      return res.status(401).json({ error: 'Session expired. Please sign in again.' });
    }

    await db.prepare('UPDATE user_sessions SET last_used_at = NOW() WHERE id = ?').run(session.id);

    // Org-level license check — super admins have no org and are exempt;
    // every org_admin/user request is gated the same way here.
    const caller = await db.prepare('SELECT role, org_id FROM users WHERE id = ?').get(payload.userId);
    if (caller && caller.role !== 'super_admin' && caller.org_id) {
      const access = await getOrgAccessStatus(caller.org_id);
      if (!access.isValid) {
        return res.status(403).json(
          access.isDisabled
            ? { error: 'org_disabled', message: 'Your organization\'s access has been disabled. Contact your administrator.' }
            : { error: 'license_expired', message: 'Your organization\'s license has expired. Contact your administrator to renew.' }
        );
      }
    }

    req.userId = payload.userId;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  }
};
