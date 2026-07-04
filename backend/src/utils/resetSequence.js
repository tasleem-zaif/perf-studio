/**
 * resetSequence — adjusts the PostgreSQL SERIAL sequence after a bulk delete.
 *
 * After deleting rows, the sequence keeps counting from where it left off.
 * This resets it to MAX(existing id) so the next INSERT picks up immediately
 * after the highest remaining row, eliminating unnecessary gaps.
 *
 * Example: collections 1,2,3,11 exist → delete 11 → seq resets to 3 →
 *          next collection gets id 4 instead of 12.
 */
const db = require('../db');

async function resetSequence(tableName) {
  try {
    const row = await db.prepare(
      `SELECT COALESCE(MAX(id), 0) AS "maxId" FROM "${tableName}"`
    ).get();
    const maxId = row?.maxId ?? 0;
    // setval(seq, value, is_called=true) — next INSERT will use maxId + 1.
    // GREATEST(..., 1) ensures we never set the sequence below 1.
    await db.pool.query(
      `SELECT setval(pg_get_serial_sequence($1, 'id'), GREATEST($2::bigint, 1), true)`,
      [tableName, maxId]
    );
  } catch (err) {
    console.error('[resetSequence]', tableName, err.message);
  }
}

module.exports = resetSequence;
