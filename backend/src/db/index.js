// PostgreSQL entry point — replaces the old node:sqlite DatabaseSync module.
// Schema is managed separately via src/db/schema.sql + src/db/migrate.js.
// All route files import from here and get the async pg wrapper.
const db = require('./pg');
const bcrypt = require('bcryptjs');

// Seed super admin on first boot (async, non-blocking).
db.prepare("SELECT id FROM users WHERE role = 'super_admin'")
  .get()
  .then(superAdmin => {
    if (!superAdmin) {
      const hash = bcrypt.hashSync('Admin@123', 10);
      return db.prepare(`
        INSERT INTO users (email, name, password_hash, role, status)
        VALUES (?, ?, ?, 'super_admin', 'active')
      `).run('admin@perfstudio.com', 'Super Admin', hash);
    }
  })
  .then(result => {
    if (result?.lastInsertRowid) {
      console.log('Super admin seeded: admin@perfstudio.com / Admin@123');
    }
  })
  .catch(err => console.error('[DB] Seed error:', err.message));

module.exports = db;
