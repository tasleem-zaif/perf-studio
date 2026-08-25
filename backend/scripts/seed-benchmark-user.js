require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../src/db');

const ORG_NAME = 'Benchmark Org (disposable)';
const ORG_SLUG = 'benchmark-org-disposable';
const EMAIL = 'benchmark@peako.local';
const PASSWORD = 'Benchmark@123';

(async () => {
  let org = await db.prepare('SELECT id FROM organizations WHERE slug = ?').get(ORG_SLUG);
  if (!org) {
    const r = await db.prepare('INSERT INTO organizations (name, slug) VALUES (?, ?) RETURNING id').get(ORG_NAME, ORG_SLUG);
    org = { id: r.id };
    console.log('Created org', org.id);
  } else {
    console.log('Reusing org', org.id);
  }

  let user = await db.prepare('SELECT id FROM users WHERE email = ?').get(EMAIL);
  if (!user) {
    const hash = bcrypt.hashSync(PASSWORD, 10);
    const r = await db.prepare(`
      INSERT INTO users (email, name, password_hash, org_id, role, status)
      VALUES (?, ?, ?, ?, 'org_admin', 'active') RETURNING id
    `).get(EMAIL, 'Benchmark User', hash, org.id);
    user = { id: r.id };
    console.log('Created user', user.id);
  } else {
    console.log('Reusing user', user.id);
  }

  // Bump license limits so the seeding step below (multiple projects/collections) isn't blocked.
  await db.prepare(`
    INSERT INTO org_licenses (org_id, plan, max_users, max_projects, status)
    VALUES (?, 'trial', 10, 10, 'active')
    ON CONFLICT (org_id) DO UPDATE SET max_users = 10, max_projects = 10, status = 'active'
  `).run(org.id);

  console.log(JSON.stringify({ orgId: org.id, userId: user.id, email: EMAIL, password: PASSWORD }));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
