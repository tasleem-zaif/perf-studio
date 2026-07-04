/**
 * Run the PostgreSQL schema against the DATABASE_URL.
 * Safe to run multiple times — all tables use CREATE TABLE IF NOT EXISTS.
 *
 * Usage:
 *   node src/db/migrate.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

  console.log('Connecting to PostgreSQL…');
  const client = await pool.connect();
  try {
    console.log('Running schema.sql…');
    await client.query(sql);
    console.log('Schema applied successfully.');

    // Verify table count
    const { rows } = await client.query(`
      SELECT count(*) AS n FROM information_schema.tables
      WHERE table_schema = 'public'
    `);
    console.log(`Tables in public schema: ${rows[0].n}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => { console.error(err.message); process.exit(1); });
