const jwt = require('jsonwebtoken');
const db  = require('../db');
const JWT_SECRET = process.env.JWT_SECRET || 'perf_studio_secret_change_in_prod';

// Sessions idle for longer than this are treated as expired.
const INACTIVITY_MINUTES = 30;

module.exports = function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET);

    if (!payload.jti) {
      return res.status(401).json({ error: 'Session expired. Please sign in again.' });
    }

    // A valid session must:
    //   1. Exist in user_sessions with matching jti
    //   2. Not have passed its absolute expiry (7 days)
    //   3. Have been active within the inactivity window
    //      (COALESCE: use last_used_at if set, otherwise fall back to created_at)
    const session = db.prepare(`
      SELECT id FROM user_sessions
      WHERE user_id = ? AND jti = ?
        AND expires_at > datetime('now')
        AND datetime(COALESCE(last_used_at, created_at), '+${INACTIVITY_MINUTES} minutes') > datetime('now')
    `).get(payload.userId, payload.jti);

    if (!session) {
      // Clean up the dead session so it cannot be replayed later
      db.prepare('DELETE FROM user_sessions WHERE user_id = ? AND jti = ?').run(payload.userId, payload.jti);
      return res.status(401).json({ error: 'Session expired. Please sign in again.' });
    }

    // Keep last_used_at fresh — heartbeat / any API call resets the inactivity clock
    db.prepare('UPDATE user_sessions SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(session.id);

    req.userId = payload.userId;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  }
};
