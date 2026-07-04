const router = require('express').Router();
const db = require('../db');
const auth = require('../middleware/auth');
const { encrypt } = require('../utils/encryption');

router.use(auth);

router.get('/ai', async (req, res) => {
  const row = await db.prepare('SELECT provider, model, heal_model, api_key FROM ai_settings WHERE user_id = ?').get(req.userId);
  res.json({
    provider:    row?.provider    || 'openai',
    model:       row?.model       || '',
    heal_model:  row?.heal_model  || '',
    api_key_set: !!(row?.api_key),
    // Never return the raw/encrypted key to the frontend
  });
});

router.put('/ai', async (req, res) => {
  const { provider, model, heal_model, api_key } = req.body;
  if (!provider) return res.status(400).json({ error: 'provider required' });

  const existing = await db.prepare('SELECT id FROM ai_settings WHERE user_id = ?').get(req.userId);
  if (existing) {
    const updates = ['provider = ?', 'model = ?', 'heal_model = ?'];
    const values  = [provider, model || '', heal_model || ''];
    if (api_key) {
      updates.push('api_key = ?');
      values.push(encrypt(api_key)); // store encrypted
    }
    values.push(req.userId);
    await db.prepare(`UPDATE ai_settings SET ${updates.join(', ')} WHERE user_id = ?`).run(...values);
  } else {
    await db.prepare('INSERT INTO ai_settings (user_id, provider, model, heal_model, api_key) VALUES (?, ?, ?, ?, ?)')
      .run(req.userId, provider, model || '', heal_model || '', api_key ? encrypt(api_key) : '');
  }
  res.json({ ok: true });
});

module.exports = router;
