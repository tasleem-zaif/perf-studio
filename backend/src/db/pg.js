/**
 * PostgreSQL async pool with a SQLite-compatible helper API.
 *
 * Compatibility rules so route files need minimal changes:
 *  - db.prepare(sql).run(...params)  → awaitable, returns { lastInsertRowid, changes }
 *  - db.prepare(sql).get(...params)  → awaitable, returns first row or undefined
 *  - db.prepare(sql).all(...params)  → awaitable, returns array of rows
 *  - db.exec(sql)                    → awaitable raw query (DDL / statements)
 *  - db.transaction(fn)              → runs fn(client) inside BEGIN/COMMIT
 *  - db.pool                         → raw pg Pool (escape hatch)
 *
 * Automatic conversions applied to every query:
 *  - '?' placeholders → '$1', '$2', … (SQLite → PostgreSQL)
 *  - INSERT without RETURNING → 'RETURNING id' appended automatically
 *    so result.lastInsertRowid keeps working without touching callers
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Keep a small pool for the single-process backend.
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[pg] idle client error:', err.message);
});

// Convert '?' positional markers to '$1', '$2', …
function toPositional(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// Flatten .run(a, b) and .run([a, b]) into a plain array.
function flatParams(args) {
  if (args.length === 1 && Array.isArray(args[0])) return args[0];
  return args;
}

function prepare(rawSql) {
  const sql = toPositional(rawSql.trim());
  const isInsert = /^INSERT\s/i.test(sql);
  const hasReturning = /RETURNING\s/i.test(sql);

  // Append RETURNING id so lastInsertRowid works without touching callers.
  const querySql = isInsert && !hasReturning ? `${sql} RETURNING id` : sql;

  return {
    async run(...args) {
      const params = flatParams(args);
      const result = await pool.query(querySql, params);
      return {
        lastInsertRowid: result.rows[0]?.id ?? null,
        changes: result.rowCount,
      };
    },

    async get(...args) {
      const params = flatParams(args);
      const result = await pool.query(sql, params);
      return result.rows[0];
    },

    async all(...args) {
      const params = flatParams(args);
      const result = await pool.query(sql, params);
      return result.rows;
    },
  };
}

async function exec(sql) {
  await pool.query(sql);
}

// Runs fn(client) inside a transaction. Commits on success, rolls back on error.
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const db = { prepare, exec, transaction, pool };

module.exports = db;
