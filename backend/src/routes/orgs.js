const router = require('express').Router();
const db = require('../db');

// Public — used by signup form to populate org dropdown
router.get('/', (req, res) => {
  const orgs = db.prepare('SELECT id, name, slug FROM organizations ORDER BY name ASC').all();
  res.json({ orgs });
});

module.exports = router;
