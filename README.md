# 🚀 Performance Studio

**AI-Powered Performance Testing Platform** — Multi-environment load testing with JMeter & K6, AI script generation, auto-healing, real-time analytics, Git integration, and team collaboration.

[![Docker Pulls](https://img.shields.io/docker/pulls/tasleemzaif/PerfStudio-backend)](https://hub.docker.com/r/tasleemzaif/PerfStudio-backend)
[![Build](https://github.com/tasleem-zaif/PerfStudio/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/tasleem-zaif/PerfStudio/actions)

---

## ⚡ Quick Start (Direct Deployment)

Peako runs as a plain Node.js process — no containers. You need Node.js 22, PostgreSQL 16, and an S3 (or S3-compatible) bucket set up first (see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for full details).

```bash
# 1. Get the source code
git clone https://bitbucket.org/qtsolv/PerfStudio.git
cd PerfStudio

# 2. Install backend dependencies and build the frontend
cd backend && npm install --omit=dev
cd ../frontend && npm install && npm run build
cp -r dist ../backend/public

# 3. Configure environment
cd ../backend
cp .env.example .env.production
# Edit .env.production — set JWT_SECRET, ENCRYPTION_KEY, DATABASE_URL, FRONTEND_URL, and
# S3_SYNC_ENABLED/S3_BUCKET/S3_REGION.
# ⚠ S3 (or a self-hosted S3-compatible store) is REQUIRED — the app refuses to boot without a
# reachable bucket (GDPR zero-local-disk design; see docs/DEPLOYMENT.md §1).

# 4. Apply the database schema (first run only — idempotent, safe to re-run)
node src/db/migrate.js

# 5. Start
NODE_ENV=production node src/index.js
```

**Default Super Admin credentials:** `admin@perfstudio.com` / `Admin@123` — change this immediately after first login.

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the full production deployment guide (including running as a systemd service and an Nginx reverse proxy), or [docs/LOCAL_SETUP.md](docs/LOCAL_SETUP.md) for local development.

---

## ✨ Key Features

| Feature | Description |
|---|---|
| 🤖 **AI Script Generation** | Converts API collections (Postman/Swagger/cURL) to JMX/K6 scripts via GPT-4o or Claude |
| 🔧 **Auto Healer** | Detects test failures, diagnoses root cause with AI, fixes the script, re-runs automatically |
| 🌍 **Multi-Environment** | QA / Staging / UAT each have isolated test data, configs, scripts, and results |
| 📊 **Real-time Analytics** | Live dashboards: response time, throughput, error rate, percentiles |
| ☁️ **CI-Only Execution** | JMeter and K6 run exclusively on your connected CI provider's runners (GitHub Actions / GitLab CI / Bitbucket Pipelines) — the Peako server itself never executes a load test |
| 📧 **Email Alerts** | Post-run emails with analytics and auto-healer results |
| 🌿 **Git Integration** | Per-project Git with branch-per-user workflow, PR management, GitHub/GitLab/Bitbucket sync |
| 🔀 **CI/CD Pipelines** | External CI (GitHub Actions / GitLab CI / Bitbucket Pipelines) triggered from the app, with auto-heal in CI context (1 automatic fix-and-retry, then a manual "Heal Again" for follow-ups) |
| 🪣 **S3-Backed Storage** | All git workspace data and test-run results live in S3 (or an S3-compatible store) — zero local-disk persistence of customer data, a required dependency, not optional |
| 👥 **Team Collaboration** | Org-based invite system, role-based access (Super Admin / Org Admin / User) |
| 💳 **Org Licensing** | Per-organization plan tiers (trial/starter/growth/business/enterprise) with user/project limits and expiry, managed from a Super Admin console |
| 🔑 **Password Recovery** | Self-service forgot password via email + admin override |
| 🔒 **Security** | AES-256-CBC encrypted secrets, JWT auth, single-active-session enforcement, role-based guards on all routes |

---

## 👥 User Roles

| Role | Capabilities |
|---|---|
| **Super Admin** | Create organizations, set license plans/limits, invite Org Admins — no other org-scoped access; the "Organizations" console is their only page |
| **Org Admin** | Create projects (up to the org's license limit), invite team members, configure AI/Git/SMTP, merge PRs, run tests |
| **Regular User** | Upload test data, configure envs, create test plans, push to own branch, raise PRs |

Every organization has a license (`org_licenses` row: plan, `max_users`, `max_projects`, `status`, `expires_at`). New orgs default to a 7-day `trial` plan. A disabled or expired license blocks non-super-admin access to that org (`403`); user/project creation is blocked once the plan's limits are reached.

---

## 🌿 Git Integration

Each project can be connected to a GitHub/GitLab repository:

```
GitHub Repo
└── Project_Name/          ← visible subfolder on GitHub
    ├── Collection_Name/
    │   ├── QA/
    │   │   ├── testData/
    │   │   ├── script/
    │   │   ├── results/
    │   │   └── config/
    │   └── UAT/
    └── README.md
```

**Branch strategy:**
- `main` — Org Admin branch (direct push)
- `users/<name>` — per-user branches (PR required to merge)

---

## 🏗 Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for full system diagrams.

---

## 🛠 Local Development

**Prerequisites:** Node.js 20+ (22 recommended), PostgreSQL 16 installed directly, and a reachable S3 bucket (real AWS, or the MinIO server binary run directly — see [docs/LOCAL_SETUP.md](docs/LOCAL_SETUP.md) §4). **The backend will not start without S3 configured** — see Environment Variables below.

```bash
# Clone
git clone https://github.com/tasleem-zaif/PerfStudio.git
cd PerfStudio

# Postgres — install directly (see docs/LOCAL_SETUP.md §3), then create the database:
psql -U postgres -c "CREATE DATABASE perf_studio;"

# Backend — set DATABASE_URL and S3_SYNC_ENABLED/S3_BUCKET/S3_REGION (see Environment Variables below), then:
cd backend && npm install
node src/db/migrate.js  # applies schema.sql (idempotent, safe to re-run)
npm run dev              # runs on :3001

# Frontend (new terminal)
cd frontend && npm install
npm run dev             # runs on :5173
```

---

## ⚙️ Environment Variables

| Variable | Required | Description |
|---|---|---|
| `JWT_SECRET` | ✅ | Random 32+ char string for token signing |
| `DATABASE_URL` | ✅ | Postgres connection string, e.g. `postgresql://postgres:postgres@postgres:5432/perf_studio` |
| `S3_SYNC_ENABLED` + `S3_BUCKET` | ✅ **— app refuses to boot without both** | All git workspace data + all test-run results live in S3 only (GDPR zero-local-disk design) — see `docs/DEPLOYMENT.md` |
| `S3_REGION` | Recommended | AWS region for the S3 client |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | Optional | Explicit credentials; omit on AWS hosting to use an instance/task IAM role instead |
| `PROJECTS_ROOT` / `BACKUPS_ROOT` | Optional | Local filesystem paths for legacy/admin project files and ZIP backups (default `../projects`/`../backups`) |
| `FRONTEND_URL` | ✅ | Public URL of the frontend (used in invite/reset emails) |
| `CORS_ORIGIN` | ✅ | Allowed CORS origin (same as FRONTEND_URL in production) — **note:** the current code allows all origins regardless of this value; it's read but not yet enforced as a strict whitelist |
| `ENCRYPTION_KEY` | Recommended | AES-256-CBC key for encrypting stored API keys/SMTP passwords/git tokens |
| `PORT` | Optional | Backend port (default: 3001) — serves both the API and the built frontend |
| `EXECUTION_MODE` / `JMETER_BIN` / `K6_BIN` | **Vestigial — no effect** | Local test execution is retired; these are read only by confirmed-dead code. Real execution is CI-only (GitHub Actions/GitLab CI/Bitbucket Pipelines) |

SQLite is no longer used at all — `DATABASE_URL` (PostgreSQL) is the only database configuration this app reads.

---

## 📁 Project Structure

```
PerfStudio/
├── backend/           Node.js Express API
│   └── src/
│       ├── routes/    ~23 route modules — auth, projects, collections, git, ciPipeline, licenses, invites, ...
│       ├── utils/     AI client, auto-healer, rule evaluator, test runner, email, encryption, project folders
│       └── db/        index.js (Postgres entry point + super-admin seed), pg.js, schema.sql, migrate.js
├── frontend/          React + Vite → Nginx
│   └── src/
│       ├── components/ Sidebar, Auth, EnvBar, GitPanel, SMTPConfigPanel, ...
│       └── pages/      Dashboard, TestData, Config, Settings, OrganizationsAdmin, ...
├── git-workspaces/    SSH-auth-mode git working copies only (gitignored; recommended to mount as a
│                      real Linux tmpfs for ephemerality — see docs/DEPLOYMENT.md §3, Step 10).
│                      PAT-auth-mode workspaces and all test-run results live in S3 only —
│                      never on local disk (GDPR zero-local-disk design, S3 is a required dependency)
├── projects/          Per-project data (gitignored)
├── backups/           Project backup ZIPs (gitignored)
├── docs/              Architecture documentation
├── .github/workflows/ GitHub Actions CI/CD
└── backend/.env.example (copy to backend/.env.production — see docs/DEPLOYMENT.md)
```

See [PROJECT_MAP.md](PROJECT_MAP.md) for the full architecture reference, including API endpoints, DB models, and non-obvious business logic.

---


## 🏢 Built by

**Quarks Technosoft PVT. LTD.**

---

## 📄 License

Proprietary — © Quarks Technosoft PVT. LTD. All rights reserved.
