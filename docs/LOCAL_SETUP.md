# Performance Studio — Local Setup Guide

This guide walks you through running Performance Studio on your local machine. Two methods are covered: **Docker** (recommended, one command) and **Manual** (Node.js dev servers).

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Clone the Repository](#2-clone-the-repository)
3. [Environment Configuration](#3-environment-configuration)
4. [Method A — Docker (Recommended)](#4-method-a--docker-recommended)
5. [Method B — Manual (Node.js)](#5-method-b--manual-nodejs)
6. [First Login](#6-first-login)
7. [Folder Structure Created at Runtime](#7-folder-structure-created-at-runtime)
8. [Troubleshooting](#8-troubleshooting)

---

## 1. Prerequisites

Install the following before proceeding.

| Tool | Minimum Version | Download |
|---|---|---|
| **Node.js** | 20+ (22 recommended) | https://nodejs.org |
| **npm** | 9+ (comes with Node.js) | — |
| **Git** | Any recent version | https://git-scm.com |
| **Docker Desktop** *(Method A only, or to run Postgres in Method B)* | Latest | https://www.docker.com/products/docker-desktop |
| **PostgreSQL 16** *(Method B only, if not running it via Docker)* | 16+ | https://www.postgresql.org/download/ |

The app requires a running PostgreSQL database (`DATABASE_URL`) — there is no SQLite/file-based fallback. Method A's Docker Compose stack provisions Postgres for you; Method B needs either a local Postgres install or a Postgres container you run separately.

**Verify your installation:**
```bash
node --version    # should print v20.x or higher
npm --version     # should print 9.x or higher
git --version
docker --version  # only needed for Method A, or to run Postgres via Docker in Method B
```

---

## 2. Clone the Repository

```bash
git clone https://bitbucket.org/qtsolv/PerfStudio.git
cd PerfStudio
```

---

## 3. Environment Configuration

The application needs two secret keys before it can start. Run the commands below — each prints a random key you will paste into the `.env` file.

### Step 1 — Generate secrets

```bash
# Generate JWT_SECRET (authentication tokens)
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# Generate ENCRYPTION_KEY (encrypts API keys, Git tokens, SMTP passwords)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy the two outputs — you will need them in the next step.

### Step 2 — Create the `.env` file

Create a file named `.env` in the **project root** (`PerfStudio/.env`) with the content below. Replace the placeholder values with the keys you just generated.

```env
# ── Required ──────────────────────────────────────────────
JWT_SECRET=PASTE_YOUR_JWT_SECRET_HERE
ENCRYPTION_KEY=PASTE_YOUR_ENCRYPTION_KEY_HERE

# PostgreSQL connection string — see Method A/B below for how to get one running
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/perf_studio

# ── Server ────────────────────────────────────────────────
PORT=3001
NODE_ENV=development
FRONTEND_URL=http://localhost:5173
CORS_ORIGIN=http://localhost:5173

# ── Storage paths (relative to backend folder) ────────────
PROJECTS_ROOT=../../projects
BACKUPS_ROOT=../../backups

# ── Docker paths (only needed for Method A) ───────────────
# Set these to the absolute path of the project on your machine
HOST_PROJECTS_ROOT=C:/Users/YourName/PerfStudio/projects
HOST_BACKUPS_ROOT=C:/Users/YourName/PerfStudio/backups
```

> **Important:** `HOST_PROJECTS_ROOT` and `HOST_BACKUPS_ROOT` must be absolute paths using forward slashes. Only needed for Method A (Docker). For Method A, `DATABASE_URL` should instead point at the `postgres` service hostname (`postgresql://postgres:postgres@postgres:5432/perf_studio`) since the app and database run as sibling containers — see below.

---

## 4. Method A — Docker (Recommended)

This runs the entire application (backend + frontend served as static files) plus a PostgreSQL container, in one Compose stack. No Node.js or Postgres setup required after the prerequisites.

```bash
# From the project root
docker compose up -d
```

Docker will build the image and pull Postgres on the first run (takes 2–5 minutes). Subsequent starts are instant.

**First run only — apply the database schema** (not done automatically):
```bash
docker compose exec PerfStudio node backend/src/db/migrate.js
```

**Access the application:** http://localhost:3001

**View logs:**
```bash
docker compose logs -f
```

**Stop the application:**
```bash
docker compose down
```

---

## 5. Method B — Manual (Node.js)

This runs the backend and frontend as separate dev servers with hot-reload. Requires two terminal windows, plus a running Postgres instance.

### Terminal 0 — Postgres (if you don't already have one)

```bash
docker run -d --name perf_studio_pg \
  -e POSTGRES_DB=perf_studio -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 postgres:16-alpine
```

Make sure `.env`'s `DATABASE_URL` points at it (`postgresql://postgres:postgres@localhost:5432/perf_studio` for the command above).

### Terminal 1 — Backend

```bash
cd PerfStudio/backend
npm install
node src/db/migrate.js   # applies schema.sql — first run only, safe to re-run anytime
npm run dev
```

You should see:
```
Performance Studio API running on http://localhost:3001
```

### Terminal 2 — Frontend

```bash
cd PerfStudio/frontend
npm install
npm run dev
```

You should see:
```
VITE ready in 500ms
➜  Local:   http://localhost:5173
```

**Access the application:** http://localhost:5173

> The backend must be running before you open the frontend.

---

## 6. First Login

On first backend startup, a Super Admin account is seeded into the database automatically (as long as `migrate.js` has already applied the schema — see above).

| Field | Value |
|---|---|
| **URL** | http://localhost:5173 (Method B) or http://localhost:3001 (Method A) |
| **Email** | `admin@perfstudio.com` |
| **Password** | `Admin@123` |

> **Change the default password** immediately after first login via Profile → Change Password.

### Initial setup flow after login

1. **Super Admin** — Create an organisation and invite an Org Admin
2. **Org Admin** — Create a project, configure AI provider (OpenAI or Anthropic API key)
3. **Org Admin** — Invite regular users to the project
4. **Users** — Add API Sources, run pre-run, upload CSV test data, configure rules, create test plans, generate and run scripts

---

## 7. Folder Structure Created at Runtime

The application creates the following folders automatically — do not delete them while the app is running.

The database itself (users, orgs, licenses, projects, run history, etc.) lives in PostgreSQL, not on disk here — see `DATABASE_URL`.

```
PerfStudio/
├── projects/                   ← Legacy admin project files
├── backups/                    ← Project ZIP backups (on delete)
└── git-workspaces/
    ├── admin/                  ← Org Admin git workspace (main branch)
    │   └── ProjectName/
    │       └── CollectionName/
    │           ├── QA/
    │           │   ├── script/     ← Generated JMX / K6 scripts
    │           │   ├── testData/   ← CSV test data files
    │           │   ├── results/    ← JMeter results + HTML report
    │           │   └── config/     ← config.json
    │           ├── Staging/
    │           └── Production/
    └── user-{id}/              ← Per-user git workspace (feature branch)
        └── (same structure)
```

---

## 8. Troubleshooting

### Port already in use

```bash
# Find the process using port 3001 (Windows)
netstat -ano | findstr :3001
# Kill it (replace PID with the number from above)
taskkill /PID <PID> /F

# Find the process using port 5173
netstat -ano | findstr :5173
taskkill /PID <PID> /F
```

### Docker container fails to start

1. Make sure Docker Desktop is running
2. Check that `HOST_PROJECTS_ROOT` and `HOST_BACKUPS_ROOT` in `.env` use absolute paths with forward slashes
3. Run `docker compose down -v` then `docker compose up -d --build` to do a clean rebuild

### Cannot log in / JWT errors

The `JWT_SECRET` in `.env` was likely changed after accounts were created — existing tokens/sessions no longer validate. This doesn't require wiping data; users just need to log in again. If you genuinely want a clean slate:
```bash
# Drop and recreate the database, then re-apply the schema (all data will be lost)
psql "$DATABASE_URL" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
cd backend && node src/db/migrate.js
```
Restart the backend afterward — the default super admin account will be re-seeded automatically.

### "relation does not exist" errors on login/register

The schema was never applied to this Postgres instance. Run `node src/db/migrate.js` from `backend/` (or `docker compose exec PerfStudio node backend/src/db/migrate.js` for Method A) — this is a required one-time step, not automatic.

### npm install fails

Make sure you are running Node.js 20 or higher:
```bash
node --version
```
If you have an older version, install Node.js 22 from https://nodejs.org and re-run `npm install`.

### Frontend shows "Network Error" or blank data

The backend is not running or is on a different port. Confirm:
```bash
# Should return {"status":"ok"}
curl http://localhost:3001/api/health
```
If it fails, start the backend first (Method B Terminal 1) before opening the frontend.

---

*For questions or support, contact the development team at tasleem.zaif@qtsolv.com*
