/**
 * resetSequence — adjusts the SQLite AUTOINCREMENT counter after a delete.
 *
 * Two cases:
 *  • Table is empty  → remove the sqlite_sequence entry entirely so the
 *                      next INSERT starts from 1.
 *  • Table has rows  → set the sequence to MAX(existing id) so the next
 *                      INSERT picks up immediately after the highest
 *                      remaining row, eliminating unnecessary gaps.
 *
 * Example: collections 1,2,3,11 exist → delete 11 → seq resets to 3 →
 *          next collection gets id 4 instead of 12.
 */
const db = require('../db');

function resetSequence(tableName) {
  try {
    const { maxId } = db.prepare(
      `SELECT COALESCE(MAX(id), 0) as maxId FROM "${tableName}"`
    ).get();

    if (maxId === 0) {
      // Table is empty — remove entry so next insert starts from 1
      db.prepare(`DELETE FROM sqlite_sequence WHERE name = ?`).run(tableName);
    } else {
      // Table still has rows — clamp sequence to the actual max id
      // (INSERT OR IGNORE handles the case where the row doesn't exist yet)
      db.prepare(
        `INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET seq = ?`
      ).run(tableName, maxId, maxId);
    }
  } catch (_) {
    // sqlite_sequence may not exist if the table never had AUTOINCREMENT rows
  }
}

module.exports = resetSequence;
