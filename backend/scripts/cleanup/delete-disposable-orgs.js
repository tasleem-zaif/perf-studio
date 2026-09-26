/**
 * delete-disposable-orgs.js — permanently deletes organizations whose name matches a
 * disposable test-org pattern (default: benchmark/disposable orgs like
 * seed-benchmark-user.js creates), plus every row of data that belongs to them.
 *
 * Targets organizations.name against whatever DATABASE_URL is currently configured
 * (.env) — point that at the right environment (local vs staging) before running.
 *
 * Usage:
 *   node scripts/cleanup/delete-disposable-orgs.js                          # dry run, default pattern
 *   node scripts/cleanup/delete-disposable-orgs.js --confirm                # delete, default pattern
 *   node scripts/cleanup/delete-disposable-orgs.js --like=S3TestOrg         # dry run, custom prefix
 *   node scripts/cleanup/delete-disposable-orgs.js --like=S3TestOrg --confirm
 */
// Load backend/.env by path (not CWD) so this still finds it when run from inside
// scripts/cleanup/ instead of from backend/ — see migrate.js for the same pattern.
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const db = require('../../src/db');

const CONFIRM = process.argv.includes('--confirm');
const likeArg = process.argv.find(a => a.startsWith('--like='));
const NAME_PATTERN = likeArg
  ? `name ILIKE '%${likeArg.slice('--like='.length)}%'`
  : "name ILIKE '%benchmark%' OR name ILIKE '%disposable%'";

async function main() {
  const orgs = await db.prepare(`SELECT id, name, slug FROM organizations WHERE ${NAME_PATTERN} ORDER BY id`).all();

  if (!orgs.length) {
    console.log('No organizations match the benchmark/disposable pattern. Nothing to do.');
    return;
  }

  console.log(`Matched ${orgs.length} organization(s):`);
  for (const o of orgs) {
    const users = await db.prepare('SELECT id, email, role, status FROM users WHERE org_id = ?').all(o.id);
    const projects = await db.prepare('SELECT id, name FROM projects WHERE user_id IN (SELECT id FROM users WHERE org_id = ?)').all(o.id);
    console.log(`\n  [${o.id}] ${o.name} (${o.slug})`);
    console.log(`    users:    ${users.map(u => `${u.email} (${u.role}, ${u.status})`).join(', ') || '(none)'}`);
    console.log(`    projects: ${projects.map(p => p.name).join(', ') || '(none)'}`);
  }

  if (!CONFIRM) {
    console.log('\nDry run only — nothing deleted. Re-run with --confirm to actually delete the above.');
    return;
  }

  console.log('\n--confirm passed — deleting now...');
  const orgIds = orgs.map(o => o.id);

  await db.transaction(async (client) => {
    // Most tables cascade via project_id -> projects(id) ON DELETE CASCADE, which itself
    // cascades from projects.user_id -> users(id) ON DELETE CASCADE (see schema.sql) — so
    // deleting the users below takes almost everything with it. These specific columns are
    // the exceptions (confirmed against information_schema, not just schema.sql, since the
    // file has drifted from live constraints): they reference users(id) with delete_rule
    // 'NO ACTION', so they'd block the user delete unless handled first. All seven are
    // NOT NULL, so the row itself must go — nulling the column isn't an option.
    await client.query(`DELETE FROM collection_env_config WHERE user_id IN (SELECT id FROM users WHERE org_id = ANY($1))`, [orgIds]);
    await client.query(`DELETE FROM collections WHERE user_id IN (SELECT id FROM users WHERE org_id = ANY($1))`, [orgIds]);
    await client.query(`DELETE FROM rules WHERE user_id IN (SELECT id FROM users WHERE org_id = ANY($1))`, [orgIds]);
    await client.query(`DELETE FROM test_data_files WHERE user_id IN (SELECT id FROM users WHERE org_id = ANY($1))`, [orgIds]);
    await client.query(`DELETE FROM test_suites WHERE user_id IN (SELECT id FROM users WHERE org_id = ANY($1))`, [orgIds]);
    await client.query(`DELETE FROM git_prs WHERE created_by IN (SELECT id FROM users WHERE org_id = ANY($1))`, [orgIds]);
    await client.query(`DELETE FROM invites WHERE invited_by IN (SELECT id FROM users WHERE org_id = ANY($1))`, [orgIds]);

    // These two are also NO ACTION but nullable, so they can be cleared in place instead.
    await client.query(`UPDATE trend_comparisons SET created_by = NULL WHERE created_by IN (SELECT id FROM users WHERE org_id = ANY($1))`, [orgIds]);
    await client.query(`UPDATE vuh_ledger SET created_by = NULL WHERE created_by IN (SELECT id FROM users WHERE org_id = ANY($1))`, [orgIds]);

    // invites.org_id is a plain int with no FK, but it's still this org's data.
    await client.query(`DELETE FROM invites WHERE org_id = ANY($1)`, [orgIds]);

    const usersResult = await client.query(`DELETE FROM users WHERE org_id = ANY($1)`, [orgIds]);
    const orgsResult = await client.query(`DELETE FROM organizations WHERE id = ANY($1)`, [orgIds]);

    console.log(`Deleted ${usersResult.rowCount} user(s) and ${orgsResult.rowCount} organization(s), plus everything cascaded from them.`);
  });
}

main()
  .then(() => db.pool.end())
  .catch(e => { console.error('FAILED (transaction rolled back):', e.message); return db.pool.end().then(() => process.exit(1)); });
