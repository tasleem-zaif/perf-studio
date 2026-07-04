-- PerfStudio — PostgreSQL Schema
-- Consolidated from all SQLite CREATE TABLE + ALTER TABLE migrations.
-- Run once via: node src/db/migrate.js

-- ── Core ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS organizations (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  slug        TEXT NOT NULL UNIQUE,
  description TEXT DEFAULT '',
  website     TEXT DEFAULT '',
  industry    TEXT DEFAULT '',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  org_id        INTEGER REFERENCES organizations(id),
  role          TEXT NOT NULL DEFAULT 'user',
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS projects (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT DEFAULT '',
  color       TEXT DEFAULT '#1a6bff',
  bg          TEXT DEFAULT '#e8f0ff',
  folder_path TEXT DEFAULT '',
  environment TEXT DEFAULT 'Default',
  uuid        TEXT DEFAULT '',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS collections (
  id                       SERIAL PRIMARY KEY,
  project_id               INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name                     TEXT NOT NULL,
  description              TEXT DEFAULT '',
  json_content             TEXT NOT NULL DEFAULT '[]',
  source_type              TEXT DEFAULT 'json',
  source_content           TEXT DEFAULT '',
  tool_target              TEXT DEFAULT 'jmeter',
  generated_jmx            TEXT DEFAULT '',
  generated_k6             TEXT DEFAULT '',
  environment              TEXT DEFAULT '',
  environments             TEXT DEFAULT '[]',
  pre_run_data             TEXT DEFAULT NULL,
  pre_run_collection_hash  TEXT DEFAULT NULL,
  folder_path              TEXT DEFAULT '',
  created_at               TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rules (
  id         SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  metric     TEXT NOT NULL,
  operator   TEXT NOT NULL,
  value      TEXT NOT NULL,
  unit       TEXT NOT NULL,
  severity   TEXT NOT NULL DEFAULT 'error',
  value_min  TEXT DEFAULT NULL,
  value_max  TEXT DEFAULT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS scripts (
  id          SERIAL PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'K6',
  description TEXT DEFAULT '',
  target      TEXT DEFAULT '',
  vusers      INTEGER DEFAULT 50,
  duration    INTEGER DEFAULT 300,
  rampup      INTEGER DEFAULT 30,
  status      TEXT DEFAULT 'ready',
  last_run    TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS global_config (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  config_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS project_config (
  id          SERIAL PRIMARY KEY,
  project_id  INTEGER NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  config_json TEXT NOT NULL DEFAULT '{}'
);

-- ── Test Data ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS test_data_files (
  id            SERIAL PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  filename      TEXT NOT NULL,
  original_name TEXT NOT NULL,
  path          TEXT NOT NULL,
  columns       TEXT NOT NULL DEFAULT '[]',
  collection_id INTEGER,
  env           TEXT DEFAULT '',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_settings (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL DEFAULT 'openai',
  api_key     TEXT NOT NULL DEFAULT '',
  model       TEXT DEFAULT '',
  heal_model  TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS test_suites (
  id                       SERIAL PRIMARY KEY,
  project_id               INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name                     TEXT NOT NULL,
  test_type                TEXT NOT NULL DEFAULT 'load',
  collection_id            INTEGER REFERENCES collections(id) ON DELETE SET NULL,
  test_data_id             INTEGER REFERENCES test_data_files(id) ON DELETE SET NULL,
  engine                   TEXT NOT NULL DEFAULT 'jmeter',
  config_json              TEXT NOT NULL DEFAULT '{}',
  jmx_path                 TEXT DEFAULT '',
  js_path                  TEXT DEFAULT '',
  status                   TEXT DEFAULT 'pending',
  vusers                   INTEGER DEFAULT 50,
  rampup                   INTEGER DEFAULT 30,
  iter_mode                TEXT DEFAULT 'duration',
  loops                    INTEGER DEFAULT 1,
  duration                 INTEGER DEFAULT 300,
  test_data_ids            TEXT DEFAULT '[]',
  pre_run_data             TEXT DEFAULT NULL,
  pre_run_collection_hash  TEXT DEFAULT NULL,
  env                      TEXT DEFAULT '',
  created_at               TIMESTAMPTZ DEFAULT NOW()
);

-- ── Execution ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS execution_runs (
  id           SERIAL PRIMARY KEY,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  suite_id     INTEGER REFERENCES test_suites(id) ON DELETE SET NULL,
  engine       TEXT,
  status       TEXT DEFAULT 'running',
  result_dir   TEXT,
  report_path  TEXT,
  logs         TEXT DEFAULT '[]',
  started_at   TIMESTAMPTZ DEFAULT NOW(),
  finished_at  TIMESTAMPTZ,
  auto_heal    INTEGER DEFAULT 0,
  heal_status  TEXT DEFAULT NULL,
  heal_run_id  INTEGER DEFAULT NULL,
  run_vusers   INTEGER DEFAULT NULL,
  run_rampup   INTEGER DEFAULT NULL,
  run_duration INTEGER DEFAULT NULL,
  run_loops    INTEGER DEFAULT NULL,
  run_iter_mode TEXT DEFAULT NULL,
  report_data  TEXT DEFAULT NULL,
  ci_run_id    INTEGER DEFAULT NULL,
  archived     INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS auto_heal_logs (
  id          SERIAL PRIMARY KEY,
  run_id      INTEGER NOT NULL,
  attempt     INTEGER NOT NULL DEFAULT 1,
  diagnosis   TEXT,
  fix_applied TEXT,
  fix_type    TEXT,
  new_run_id  INTEGER,
  result      TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Sessions & Auth ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_sessions (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  jti          TEXT NOT NULL UNIQUE,
  expires_at   TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ DEFAULT NOW(),
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS password_resets (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used       INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Git Integration ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS git_configs (
  id             SERIAL PRIMARY KEY,
  project_id     INTEGER NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  provider       TEXT DEFAULT 'github',
  remote_url     TEXT DEFAULT '',
  username       TEXT DEFAULT '',
  email          TEXT DEFAULT '',
  auth_token     TEXT DEFAULT '',
  git_root       TEXT DEFAULT '',
  is_initialized INTEGER DEFAULT 0,
  base_branch    TEXT DEFAULT 'main',
  auth_method    TEXT DEFAULT 'pat',
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS git_prs (
  id            SERIAL PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  pr_number     INTEGER,
  title         TEXT NOT NULL,
  description   TEXT DEFAULT '',
  from_branch   TEXT NOT NULL,
  to_branch     TEXT DEFAULT 'main',
  created_by    INTEGER NOT NULL REFERENCES users(id),
  status        TEXT DEFAULT 'open',
  remote_pr_url TEXT DEFAULT '',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS git_commits (
  id         SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL,
  branch     TEXT NOT NULL,
  message    TEXT NOT NULL,
  hash       TEXT DEFAULT '',
  pushed     INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_git_configs (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  branch_name  TEXT NOT NULL DEFAULT '',
  author_name  TEXT NOT NULL DEFAULT '',
  author_email TEXT NOT NULL DEFAULT '',
  auth_token   TEXT NOT NULL DEFAULT '',
  auth_method  TEXT DEFAULT 'pat',
  ssh_key      TEXT DEFAULT '',
  git_username TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, project_id)
);

-- ── Internal Pipelines ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pipeline_configs (
  id              SERIAL PRIMARY KEY,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT DEFAULT '',
  steps           TEXT NOT NULL DEFAULT '[]',
  stop_on_failure INTEGER DEFAULT 1,
  environment     TEXT DEFAULT '',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id           SERIAL PRIMARY KEY,
  pipeline_id  INTEGER NOT NULL REFERENCES pipeline_configs(id) ON DELETE CASCADE,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status       TEXT DEFAULT 'pending',
  steps_result TEXT DEFAULT '[]',
  logs         TEXT DEFAULT '[]',
  triggered_by INTEGER DEFAULT NULL,
  started_at   TIMESTAMPTZ DEFAULT NOW(),
  finished_at  TIMESTAMPTZ
);

-- ── CI/CD Pipelines ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ci_pipeline_configs (
  id                    SERIAL PRIMARY KEY,
  project_id            INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id               INTEGER DEFAULT NULL,
  gitlab_enabled        INTEGER DEFAULT 0,
  gitlab_url            TEXT DEFAULT 'https://gitlab.com',
  gitlab_project_id     TEXT DEFAULT '',
  gitlab_token          TEXT DEFAULT '',
  gitlab_trigger_token  TEXT DEFAULT '',
  gitlab_ref            TEXT DEFAULT 'main',
  gitlab_auth_method    TEXT DEFAULT 'pat',
  github_enabled        INTEGER DEFAULT 0,
  github_repo           TEXT DEFAULT '',
  github_token          TEXT DEFAULT '',
  github_workflow_file  TEXT DEFAULT 'perf-test.yml',
  github_ref            TEXT DEFAULT 'main',
  github_auth_method    TEXT DEFAULT 'pat',
  bitbucket_enabled     INTEGER DEFAULT 0,
  bitbucket_workspace   TEXT DEFAULT '',
  bitbucket_username    TEXT DEFAULT '',
  bitbucket_app_password TEXT DEFAULT '',
  bitbucket_repo_slug   TEXT DEFAULT '',
  bitbucket_ref         TEXT DEFAULT 'main',
  bitbucket_auth_method TEXT DEFAULT 'pat',
  ssh_private_key       TEXT DEFAULT '',
  updated_at            TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, user_id)
);

CREATE TABLE IF NOT EXISTS ci_pipeline_runs (
  id                    SERIAL PRIMARY KEY,
  project_id            INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider              TEXT NOT NULL,
  external_id           TEXT,
  web_url               TEXT,
  status                TEXT DEFAULT 'pending',
  script_name           TEXT,
  variables             TEXT DEFAULT '{}',
  triggered_by          INTEGER,
  run_name              TEXT DEFAULT NULL,
  heal_status           TEXT DEFAULT NULL,
  heal_ci_run_id        INTEGER DEFAULT NULL,
  is_heal_run           INTEGER DEFAULT 0,
  auto_heal             INTEGER DEFAULT 0,
  auto_heal_mode        TEXT DEFAULT 'auto',
  auto_heal_instruction TEXT DEFAULT '',
  heal_summary          TEXT DEFAULT NULL,
  started_at            TIMESTAMPTZ DEFAULT NOW(),
  finished_at           TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS ci_auto_heal_logs (
  id            SERIAL PRIMARY KEY,
  ci_run_id     INTEGER NOT NULL,
  attempt       INTEGER NOT NULL DEFAULT 1,
  diagnosis     TEXT,
  fix_applied   TEXT,
  fix_type      TEXT,
  new_ci_run_id INTEGER,
  result        TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── Alerts ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS alert_configs (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  smtp_host   TEXT DEFAULT '',
  smtp_port   INTEGER DEFAULT 587,
  smtp_secure INTEGER DEFAULT 0,
  smtp_user   TEXT DEFAULT '',
  smtp_pass   TEXT DEFAULT '',
  from_name   TEXT DEFAULT 'PerfStudio',
  from_email  TEXT DEFAULT '',
  enabled     INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS alert_recipients (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER,
  project_id INTEGER,
  name       TEXT DEFAULT '',
  email      TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Invites & Assignments ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS invites (
  id         SERIAL PRIMARY KEY,
  email      TEXT NOT NULL,
  name       TEXT DEFAULT '',
  role       TEXT NOT NULL,
  org_id     INTEGER,
  invited_by INTEGER NOT NULL REFERENCES users(id),
  token      TEXT NOT NULL UNIQUE,
  status     TEXT DEFAULT 'pending',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_assignments (
  id          SERIAL PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_by INTEGER NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, user_id)
);

-- ── Collection Env Config ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS collection_env_config (
  id            SERIAL PRIMARY KEY,
  collection_id INTEGER NOT NULL,
  env           TEXT NOT NULL,
  config_json   TEXT DEFAULT '{}',
  UNIQUE(collection_id, env)
);

-- ── Licensing ─────────────────────────────────────────────────────────────────
-- One row per organization. Created lazily with plan defaults the first time
-- it's read (see utils/license.js) so pre-existing orgs get a license too.

CREATE TABLE IF NOT EXISTS org_licenses (
  id           SERIAL PRIMARY KEY,
  org_id       INTEGER NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  plan         TEXT NOT NULL DEFAULT 'trial',
  max_users    INTEGER DEFAULT 2,    -- NULL = unlimited (enterprise)
  max_projects INTEGER DEFAULT 1,    -- NULL = unlimited (enterprise)
  status       TEXT NOT NULL DEFAULT 'active',
  expires_at   TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
