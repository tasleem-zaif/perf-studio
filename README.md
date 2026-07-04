# 🚀 Performance Studio

**AI-Powered Performance Testing Platform** — Multi-environment load testing with JMeter & K6, AI script generation, auto-healing, real-time analytics, Git integration, and team collaboration.

[![Docker Pulls](https://img.shields.io/docker/pulls/tasleemzaif/PerfStudio-backend)](https://hub.docker.com/r/tasleemzaif/PerfStudio-backend)
[![Build](https://github.com/tasleem-zaif/PerfStudio/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/tasleem-zaif/PerfStudio/actions)

---

## ⚡ Quick Start (Docker)

```bash
# 1. Download config files
curl -O https://raw.githubusercontent.com/tasleem-zaif/PerfStudio/main/docker-compose.yml
curl -O https://raw.githubusercontent.com/tasleem-zaif/PerfStudio/main/.env.example

# 2. Configure environment
cp .env.example .env
# Edit .env — set HOST_PROJECTS_ROOT, JWT_SECRET, FRONTEND_URL

# 3. Launch (pulls images from Docker Hub automatically)
docker compose up -d

# 4. Open in browser
open http://localhost:5173
```

**Default Super Admin credentials:** `admin@perfstudio.com` / `Admin@123`

---

## ✨ Key Features

| Feature | Description |
|---|---|
| 🤖 **AI Script Generation** | Converts API collections (Postman/Swagger/cURL) to JMX/K6 scripts via GPT-4o or Claude |
| 🔧 **Auto Healer** | Detects test failures, diagnoses root cause with AI, fixes the script, re-runs automatically |
| 🌍 **Multi-Environment** | QA / Staging / UAT each have isolated test data, configs, scripts, and results |
| 📊 **Real-time Analytics** | Live dashboards: response time, throughput, error rate, percentiles |
| 🐳 **Docker Execution** | JMeter and K6 run in isolated Docker containers — no local install needed |
| 📧 **Email Alerts** | Post-run emails with analytics and auto-healer results |
| 🌿 **Git Integration** | Per-project Git with branch-per-user workflow, PR management, GitHub/GitLab/Bitbucket sync |
| 🔀 **CI/CD Pipelines** | Internal sequential test-plan pipelines plus external CI (GitHub Actions / GitLab CI / Bitbucket Pipelines) with auto-heal in CI context |
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

**Prerequisites:** Node.js 18+, PostgreSQL 16 (or Docker Desktop to run it in a container)

```bash
# Clone
git clone https://github.com/tasleem-zaif/PerfStudio.git
cd PerfStudio

# Postgres (if you don't already have one running)
docker run -d --name perf_studio_pg -e POSTGRES_DB=perf_studio -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16-alpine

# Backend — set DATABASE_URL (see Environment Variables below), then:
cd backend && npm install
node src/db/migrate.js  # applies schema.sql (idempotent, safe to re-run)
npm run dev              # runs on :3001

# Frontend (new terminal)
cd frontend && npm install
npm run dev             # runs on :5173
```

---

## 🐳 Docker Images

| Image | Docker Hub |
|---|---|
| Backend | `tasleemzaif/PerfStudio-backend:latest` |
| Frontend | `tasleemzaif/PerfStudio-frontend:latest` |

```bash
# Pull latest
docker compose pull && docker compose up -d
```

---

## ⚙️ Environment Variables

| Variable | Required | Description |
|---|---|---|
| `JWT_SECRET` | ✅ | Random 32+ char string for token signing |
| `DATABASE_URL` | ✅ | Postgres connection string, e.g. `postgresql://postgres:postgres@postgres:5432/perf_studio` |
| `HOST_PROJECTS_ROOT` | ✅ (Docker) | Absolute path to `./projects/` on host machine |
| `FRONTEND_URL` | ✅ | Public URL of the frontend (used in invite/reset emails) |
| `CORS_ORIGIN` | ✅ | Allowed CORS origin (same as FRONTEND_URL in production) |
| `ENCRYPTION_KEY` | Recommended | AES-256-CBC key for encrypting stored API keys/SMTP passwords/git tokens |
| `BACKEND_PORT` | Optional | Backend port (default: 3001) |
| `FRONTEND_PORT` | Optional | Frontend port (default: 5173) |
| `EXECUTION_MODE` | Optional | `native` (bundled JMeter/K6 binaries, default in the all-in-one image) vs `docker` (spawn containers) |
| `JMETER_DOCKER_IMAGE` | Optional | JMeter image (only used in `docker` execution mode) |
| `K6_DOCKER_IMAGE` | Optional | K6 image (only used in `docker` execution mode) |

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
├── git-workspaces/    Per-project/per-user git working copies (gitignored, runtime-generated)
├── projects/          Per-project data (gitignored)
├── backups/           Project backup ZIPs (gitignored)
├── docs/              Architecture documentation
├── .github/workflows/ GitHub Actions CI/CD
├── docker-compose.yml (Postgres + all-in-one app container)
└── .env.example
```

See [PROJECT_MAP.md](PROJECT_MAP.md) for the full architecture reference, including API endpoints, DB models, and non-obvious business logic.

---

## 🔄 CI/CD

Every push to `main` automatically:
1. Builds Docker images for backend and frontend
2. Pushes to Docker Hub with `latest` tag

---

## 🏢 Built by

**Quarks Technosoft PVT. LTD.**

---

## 📄 License

Proprietary — © Quarks Technosoft PVT. LTD. All rights reserved.
