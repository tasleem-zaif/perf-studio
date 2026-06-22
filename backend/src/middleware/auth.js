const jwt = require('jsonwebtoken');
const db  = require('../db');
const JWT_SECRET = process.env.JWT_SECRET || 'peako_secret_change_in_prod';

module.exports = function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET);

    // Enforce single session: token must have a jti that exists in user_sessions
    if (!payload.jti) {
      return res.status(401).json({ error: 'Session expired. Please sign in again.' });
    }
    const session = db.prepare(
      'SELECT id FROM user_sessions WHERE user_id = ? AND jti = ?'
    ).get(payload.userId, payload.jti);
    if (!session) {
      return res.status(401).json({ error: 'Your session was ended because you signed in from another location. Please sign in again.' });
    }

    // Keep last_used_at fresh so the login page can distinguish active vs orphaned sessions
    db.prepare('UPDATE user_sessions SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(session.id);

    req.userId = payload.userId;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token. Please sign in again.' });
  }
};
