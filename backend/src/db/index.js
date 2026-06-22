const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const { mkdirSync } = require('fs');
const bcrypt = require('bcryptjs');

// DB_PATH env var allows Docker to persist the database in a mounted volume.
// Default: backend/data/peako.db (local dev)
// Docker:  /app/data/peako.db   (set via ENV DB_PATH in Dockerfile)
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'peako.db');
mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS organizations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    slug TEXT NOT NULL UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    org_id INTEGER REFERENCES organizations(id),
    role TEXT NOT NULL DEFAULT 'user',
    status TEXT NOT NULL DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    color TEXT DEFAULT '#1a6bff',
    bg TEXT DEFAULT '#e8f0ff',
    folder_path TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS collections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    json_content TEXT NOT NULL DEFAULT '[]',
    source_type TEXT DEFAULT 'json',
    source_content TEXT DEFAULT '',
    tool_target TEXT DEFAULT 'jmeter',
    generated_jmx TEXT DEFAULT '',
    generated_k6 TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    metric TEXT NOT NULL,
    operator TEXT NOT NULL,
    value TEXT NOT NULL,
    unit TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'error',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS scripts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'K6',
    description TEXT DEFAULT '',
    target TEXT DEFAULT '',
    vusers INTEGER DEFAULT 50,
    duration INTEGER DEFAULT 300,
    rampup INTEGER DEFAULT 30,
    status TEXT DEFAULT 'ready',
    last_run DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS global_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE,
    config_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS project_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL UNIQUE,
    config_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS test_suites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    test_type TEXT NOT NULL DEFAULT 'load',
    collection_id INTEGER,
    test_data_id INTEGER,
    engine TEXT NOT NULL DEFAULT 'jmeter',
    config_json TEXT NOT NULL DEFAULT '{}',
    jmx_path TEXT DEFAULT '',
    js_path TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE SET NULL,
    FOREIGN KEY (test_data_id) REFERENCES test_data_files(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS test_data_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    path TEXT NOT NULL,
    columns TEXT NOT NULL DEFAULT '[]',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS ai_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE,
    provider TEXT NOT NULL DEFAULT 'openai',
    api_key TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS execution_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    suite_id INTEGER REFERENCES test_suites(id) ON DELETE SET NULL,
    engine TEXT,
    status TEXT DEFAULT 'running',
    result_dir TEXT,
    report_path TEXT,
    logs TEXT DEFAULT '[]',
    started_at TEXT DEFAULT (datetime('now')),
    finished_at TEXT
  );
`);

// Migrate existing tables — each ALTER wrapped in try/catch for idempotency
const migrations = [
  "ALTER TABLE collections ADD COLUMN source_type TEXT DEFAULT 'json'",
  "ALTER TABLE collections ADD COLUMN source_content TEXT DEFAULT ''",
  "ALTER TABLE collections ADD COLUMN tool_target TEXT DEFAULT 'jmeter'",
  "ALTER TABLE collections ADD COLUMN generated_jmx TEXT DEFAULT ''",
  "ALTER TABLE collections ADD COLUMN generated_k6 TEXT DEFAULT ''",
  "ALTER TABLE projects ADD COLUMN folder_path TEXT DEFAULT ''",
  "ALTER TABLE rules ADD COLUMN value_min TEXT DEFAULT NULL",
  "ALTER TABLE rules ADD COLUMN value_max TEXT DEFAULT NULL",
  "ALTER TABLE pipeline_runs ADD COLUMN logs TEXT DEFAULT '[]'",
  "ALTER TABLE pipeline_runs ADD COLUMN triggered_by INTEGER DEFAULT NULL",
  // CI config becomes per-user — add user_id so each user has their own row
  "ALTER TABLE ci_pipeline_configs ADD COLUMN user_id INTEGER DEFAULT NULL",
  // SSH auth support
  "ALTER TABLE git_configs ADD COLUMN auth_method TEXT DEFAULT 'pat'",
  "ALTER TABLE user_git_configs ADD COLUMN auth_method TEXT DEFAULT 'pat'",
  "ALTER TABLE user_git_configs ADD COLUMN ssh_key TEXT DEFAULT ''",
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (_) { /* column already exists */ }
}

const autoHealMigrations = [
  'ALTER TABLE execution_runs ADD COLUMN auto_heal INTEGER DEFAULT 0',
  'ALTER TABLE execution_runs ADD COLUMN heal_status TEXT DEFAULT NULL',
  'ALTER TABLE execution_runs ADD COLUMN heal_run_id INTEGER DEFAULT NULL',
  // Runtime params — stored so the healer can reproduce the exact original run
  'ALTER TABLE execution_runs ADD COLUMN run_vusers INTEGER DEFAULT NULL',
  'ALTER TABLE execution_runs ADD COLUMN run_rampup INTEGER DEFAULT NULL',
  'ALTER TABLE execution_runs ADD COLUMN run_duration INTEGER DEFAULT NULL',
  'ALTER TABLE execution_runs ADD COLUMN run_loops INTEGER DEFAULT NULL',
  "ALTER TABLE execution_runs ADD COLUMN run_iter_mode TEXT DEFAULT NULL",
  `CREATE TABLE IF NOT EXISTS auto_heal_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1,
    diagnosis TEXT,
    fix_applied TEXT,
    fix_type TEXT,
    new_run_id INTEGER,
    result TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
];
for (const sql of autoHealMigrations) {
  try { db.exec(sql); } catch (_) {}
}

const alterStatements = [
  'ALTER TABLE test_suites ADD COLUMN vusers INTEGER DEFAULT 50',
  'ALTER TABLE test_suites ADD COLUMN rampup INTEGER DEFAULT 30',
  'ALTER TABLE test_suites ADD COLUMN iter_mode TEXT DEFAULT \'duration\'',
  'ALTER TABLE test_suites ADD COLUMN loops INTEGER DEFAULT 1',
  'ALTER TABLE test_suites ADD COLUMN duration INTEGER DEFAULT 300',
  "ALTER TABLE test_suites ADD COLUMN test_data_ids TEXT DEFAULT '[]'",
  "ALTER TABLE collections ADD COLUMN environment TEXT DEFAULT ''",
  "ALTER TABLE test_suites ADD COLUMN pre_run_data TEXT DEFAULT NULL",
  "ALTER TABLE test_suites ADD COLUMN pre_run_collection_hash TEXT DEFAULT NULL",
  "ALTER TABLE projects ADD COLUMN environment TEXT DEFAULT 'Default'",
];
for (const sql of alterStatements) {
  try { db.exec(sql); } catch {}
}

// Add environments array to collections
try { db.exec("ALTER TABLE collections ADD COLUMN environments TEXT DEFAULT '[]'"); } catch {}

// Pre-run data on collections (migrated from test_suites)
try { db.exec("ALTER TABLE collections ADD COLUMN pre_run_data TEXT DEFAULT NULL"); } catch {}
try { db.exec("ALTER TABLE collections ADD COLUMN pre_run_collection_hash TEXT DEFAULT NULL"); } catch {}

// Per-env configuration (each collection env has its own URL/config)
try {
  db.exec(`CREATE TABLE IF NOT EXISTS collection_env_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collection_id INTEGER NOT NULL,
    env TEXT NOT NULL,
    config_json TEXT DEFAULT '{}',
    UNIQUE(collection_id, env)
  )`);
} catch (_) {}
// Add env to test_suites so scripts go to the right env subfolder
try { db.exec("ALTER TABLE test_suites ADD COLUMN env TEXT DEFAULT ''"); } catch {}

// Env isolation for test data files — tag each file to its collection + env
try { db.exec("ALTER TABLE test_data_files ADD COLUMN collection_id INTEGER"); } catch {}
try { db.exec("ALTER TABLE test_data_files ADD COLUMN env TEXT DEFAULT ''"); } catch {}

// Add model columns to ai_settings
try { db.exec("ALTER TABLE ai_settings ADD COLUMN model TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE ai_settings ADD COLUMN heal_model TEXT DEFAULT ''"); } catch {}

// Add uuid column to projects (for directory naming)
try { db.exec("ALTER TABLE projects ADD COLUMN uuid TEXT DEFAULT ''"); } catch {}

// Cache parsed JTL report data so Analytics doesn't require the JTL file on disk
try { db.exec("ALTER TABLE execution_runs ADD COLUMN report_data TEXT DEFAULT NULL"); } catch {}

// Link execution_runs back to the ci_pipeline_run that created them (for re-sync fallback)
try { db.exec("ALTER TABLE execution_runs ADD COLUMN ci_run_id INTEGER DEFAULT NULL"); } catch {}

// Soft-delete: archived=1 hides the run from the dropdown but keeps the record recoverable
try { db.exec("ALTER TABLE execution_runs ADD COLUMN archived INTEGER DEFAULT 0"); } catch {}

// ── Migrate ci_pipeline_configs: change UNIQUE(project_id) → UNIQUE(project_id, user_id) ──
// The original table only allowed one config per project (admin-only).
// Regular users need their own row for their PAT and branch.
try {
  const hasBadUnique = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='ci_pipeline_configs'"
  ).get()?.sql || '';
  // Only run if the old UNIQUE(project_id) schema is still in place
  if (hasBadUnique.includes('project_id INTEGER NOT NULL UNIQUE') || hasBadUnique.includes('NOT NULL UNIQUE')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ci_pipeline_configs_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        user_id INTEGER DEFAULT NULL,
        gitlab_enabled INTEGER DEFAULT 0,
        gitlab_url TEXT DEFAULT 'https://gitlab.com',
        gitlab_project_id TEXT DEFAULT '',
        gitlab_token TEXT DEFAULT '',
        gitlab_trigger_token TEXT DEFAULT '',
        gitlab_ref TEXT DEFAULT 'main',
        github_enabled INTEGER DEFAULT 0,
        github_repo TEXT DEFAULT '',
        github_token TEXT DEFAULT '',
        github_workflow_file TEXT DEFAULT 'perf-test.yml',
        github_ref TEXT DEFAULT 'main',
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(project_id, user_id),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      INSERT INTO ci_pipeline_configs_v2 SELECT * FROM ci_pipeline_configs;
      DROP TABLE ci_pipeline_configs;
      ALTER TABLE ci_pipeline_configs_v2 RENAME TO ci_pipeline_configs;
    `);
  }
} catch (_) {}

// ── User Sessions (single-session enforcement) ───────────────────────────────
db.exec(`CREATE TABLE IF NOT EXISTS user_sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  jti          TEXT    NOT NULL UNIQUE,
  expires_at   DATETIME NOT NULL,
  last_used_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
)`);
// Backfill last_used_at for existing rows
try { db.exec("ALTER TABLE user_sessions ADD COLUMN last_used_at DATETIME"); } catch (_) {}

// ── Password Reset ───────────────────────────────────────────────────────────
db.exec(`CREATE TABLE IF NOT EXISTS password_resets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  token      TEXT NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  used       INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
)`);

// ── Git Integration ──────────────────────────────────────────────────────────
db.exec(`CREATE TABLE IF NOT EXISTS git_configs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL UNIQUE,
  provider    TEXT    DEFAULT 'github',
  remote_url  TEXT    DEFAULT '',
  username    TEXT    DEFAULT '',
  email       TEXT    DEFAULT '',
  auth_token  TEXT    DEFAULT '',
  git_root    TEXT    DEFAULT '',  -- workspace dir where .git lives (parent of project subfolder)
  is_initialized INTEGER DEFAULT 0,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
)`);
try { db.exec("ALTER TABLE git_configs ADD COLUMN git_root TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE git_configs ADD COLUMN base_branch TEXT DEFAULT 'main'"); } catch {}

db.exec(`CREATE TABLE IF NOT EXISTS git_prs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER NOT NULL,
  pr_number    INTEGER,
  title        TEXT    NOT NULL,
  description  TEXT    DEFAULT '',
  from_branch  TEXT    NOT NULL,
  to_branch    TEXT    DEFAULT 'main',
  created_by   INTEGER NOT NULL,
  status       TEXT    DEFAULT 'open',
  remote_pr_url TEXT   DEFAULT '',
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id)
)`);

db.exec(`CREATE TABLE IF NOT EXISTS git_commits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL,
  user_id     INTEGER NOT NULL,
  branch      TEXT    NOT NULL,
  message     TEXT    NOT NULL,
  hash        TEXT    DEFAULT '',
  pushed      INTEGER DEFAULT 0,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
)`);

db.exec(`CREATE TABLE IF NOT EXISTS user_git_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  branch_name TEXT NOT NULL DEFAULT '',
  author_name TEXT NOT NULL DEFAULT '',
  author_email TEXT NOT NULL DEFAULT '',
  auth_token TEXT NOT NULL DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, project_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
)`);

db.exec(`CREATE TABLE IF NOT EXISTS pipeline_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  steps TEXT NOT NULL DEFAULT '[]',
  stop_on_failure INTEGER DEFAULT 1,
  environment TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
)`);

db.exec(`CREATE TABLE IF NOT EXISTS pipeline_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pipeline_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  status TEXT DEFAULT 'pending',
  steps_result TEXT DEFAULT '[]',
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME,
  FOREIGN KEY (pipeline_id) REFERENCES pipeline_configs(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
)`);
// ── CI/CD Pipeline integration tables ────────────────────────────────────────
db.exec(`CREATE TABLE IF NOT EXISTS ci_pipeline_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL UNIQUE,
  gitlab_enabled INTEGER DEFAULT 0,
  gitlab_url TEXT DEFAULT 'https://gitlab.com',
  gitlab_project_id TEXT DEFAULT '',
  gitlab_token TEXT DEFAULT '',
  gitlab_trigger_token TEXT DEFAULT '',
  gitlab_ref TEXT DEFAULT 'main',
  github_enabled INTEGER DEFAULT 0,
  github_repo TEXT DEFAULT '',
  github_token TEXT DEFAULT '',
  github_workflow_file TEXT DEFAULT 'perf-test.yml',
  github_ref TEXT DEFAULT 'main',
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
)`);

db.exec(`CREATE TABLE IF NOT EXISTS ci_pipeline_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  provider TEXT NOT NULL,
  external_id TEXT,
  web_url TEXT,
  status TEXT DEFAULT 'pending',
  script_name TEXT,
  variables TEXT DEFAULT '{}',
  triggered_by INTEGER,
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
)`);

// run_name: formatted execution name e.g. "APILoadTest_5Users_60sDuration"
try { db.exec("ALTER TABLE ci_pipeline_runs ADD COLUMN run_name TEXT DEFAULT NULL"); } catch {}

// ── Bitbucket Pipelines support ───────────────────────────────────────────────
try { db.exec("ALTER TABLE ci_pipeline_configs ADD COLUMN bitbucket_enabled INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE ci_pipeline_configs ADD COLUMN bitbucket_workspace TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE ci_pipeline_configs ADD COLUMN bitbucket_username TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE ci_pipeline_configs ADD COLUMN bitbucket_app_password TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE ci_pipeline_configs ADD COLUMN bitbucket_repo_slug TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE ci_pipeline_configs ADD COLUMN bitbucket_ref TEXT DEFAULT 'main'"); } catch {}

// Add folder_path to collections
try { db.exec("ALTER TABLE collections ADD COLUMN folder_path TEXT DEFAULT ''"); } catch {}

// Org/role migrations for existing users
const orgMigrations = [
  "ALTER TABLE users ADD COLUMN org_id INTEGER REFERENCES organizations(id)",
  "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'",
  "ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'",
];
for (const sql of orgMigrations) {
  try { db.exec(sql); } catch {}
}

// Alert / notification tables
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      smtp_host TEXT DEFAULT '',
      smtp_port INTEGER DEFAULT 587,
      smtp_secure INTEGER DEFAULT 0,
      smtp_user TEXT DEFAULT '',
      smtp_pass TEXT DEFAULT '',
      from_name TEXT DEFAULT 'Performance Studio',
      from_email TEXT DEFAULT '',
      enabled INTEGER DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS alert_recipients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      project_id INTEGER,
      name TEXT DEFAULT '',
      email TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
} catch (_) {}

// ── Invite system ─────────────────────────────────────────────────────────────
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS invites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      name TEXT DEFAULT '',
      role TEXT NOT NULL,             -- 'org_admin' | 'user'
      org_id INTEGER,                 -- target org (required for 'user')
      invited_by INTEGER NOT NULL,    -- user id of inviter
      token TEXT NOT NULL UNIQUE,     -- secure random token
      status TEXT DEFAULT 'pending',  -- 'pending' | 'accepted' | 'expired'
      expires_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (invited_by) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS project_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      assigned_by INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(project_id, user_id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE
    );
  `);
} catch (_) {}

// Seed super admin if not present
const superAdmin = db.prepare("SELECT id FROM users WHERE role = 'super_admin'").get();
if (!superAdmin) {
  const hash = bcrypt.hashSync('Admin@123', 10);
  db.prepare(`
    INSERT INTO users (email, name, password_hash, role, status)
    VALUES ('admin@Peako.com', 'Super Admin', ?, 'super_admin', 'active')
  `).run(hash);
  console.log('Super admin seeded: admin@Peako.com / Admin@123');
}

module.exports = db;
