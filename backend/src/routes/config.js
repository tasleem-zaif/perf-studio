const router = require('express').Router();
const db = require('../db');
const auth = require('../middleware/auth');
const { updateProjectCollectionConfigs } = require('../utils/configWriter');

const DEFAULT_CONFIG = {
  urls: [{ protocol: 'https', url: '', port: '443' }],
};

router.use(auth);

router.get('/', async (req, res) => {
  const row = await db.prepare('SELECT config_json FROM global_config WHERE user_id = ?').get(req.userId);
  const config = row ? JSON.parse(row.config_json) : { ...DEFAULT_CONFIG };
  res.json({ config });
});

router.put('/', async (req, res) => {
  const cfg = req.body.config || req.body;
  const existing = await db.prepare('SELECT id FROM global_config WHERE user_id = ?').get(req.userId);
  if (existing) {
    await db.prepare('UPDATE global_config SET config_json = ? WHERE user_id = ?')
      .run(JSON.stringify(cfg), req.userId);
  } else {
    await db.prepare('INSERT INTO global_config (user_id, config_json) VALUES (?, ?)')
      .run(req.userId, JSON.stringify(cfg));
  }
  // Refresh config.json in all collection/env folders (global config is included there)
  setImmediate(async () => {
    const projects = await db.prepare('SELECT id FROM projects WHERE user_id = ?').all(req.userId);
    for (const p of projects) updateProjectCollectionConfigs(p.id);
  });
  res.json({ ok: true, config: cfg });
});

module.exports = router;
module.exports.DEFAULT_CONFIG = DEFAULT_CONFIG;
