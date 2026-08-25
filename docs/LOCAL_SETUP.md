# Performance Studio — Local Setup Guide

This guide walks you through running Performance Studio on your local machine directly — Node.js dev servers, a locally-installed PostgreSQL, no containers.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Clone the Repository](#2-clone-the-repository)
3. [Set Up PostgreSQL](#3-set-up-postgresql)
4. [Set Up S3 (or a Local S3-Compatible Store)](#4-set-up-s3-or-a-local-s3-compatible-store)
5. [Environment Configuration](#5-environment-configuration)
6. [Run the Backend and Frontend](#6-run-the-backend-and-frontend)
7. [First Login](#7-first-login)
8. [Folder Structure Created at Runtime](#8-folder-structure-created-at-runtime)
9. [Troubleshooting](#9-troubleshooting)

---

## 1. Prerequisites

Install the following before proceeding.

| Tool | Minimum Version | Download |
|---|---|---|
| **Node.js** | 20+ (22 recommended) | https://nodejs.org |
| **npm** | 9+ (comes with Node.js) | — |
| **Git** | Any recent version | https://git-scm.com |
| **PostgreSQL** | 16+ | https://www.postgresql.org/download/ |
| **An S3 bucket** (real AWS, or a local MinIO binary — see §4) | — | **Required — see below** |

The app requires a running PostgreSQL database (`DATABASE_URL`) — there is no SQLite/file-based fallback.

**⚠ The app also requires a reachable S3 bucket to boot at all — this is easy to miss if you're following an older guide.** `backend/src/index.js` calls `assertBucketReachable()` at startup and will `process.exit(1)` immediately if `S3_SYNC_ENABLED`/`S3_BUCKET` aren't set or the bucket isn't reachable — there is no way to run this app locally without one. See §4.

**Verify your installation:**
```bash
node --version    # should print v20.x or higher
npm --version     # should print 9.x or higher
git --version
psql --version
```

---

## 2. Clone the Repository

```bash
git clone https://bitbucket.org/qtsolv/PerfStudio.git
cd PerfStudio
```

---

## 3. Set Up PostgreSQL

Install PostgreSQL 16 directly on your machine (not via a container) and create a database:

**Linux (Debian/Ubuntu):**
```bash
sudo apt-get install -y postgresql-16
sudo systemctl enable --now postgresql
sudo -u postgres psql -c "CREATE DATABASE perf_studio;"
```

**macOS:**
```bash
brew install postgresql@16
brew services start postgresql@16
createdb perf_studio
```

**Windows:** install from https://www.postgresql.org/download/windows/, then use pgAdmin or `psql` to create a `perf_studio` database.

Note the connection string for the next steps — for a default local install with the `postgres` user, that's typically `postgresql://postgres:postgres@localhost:5432/perf_studio`.

---

## 4. Set Up S3 (or a Local S3-Compatible Store)

Two options, neither involving a container:

- **Real AWS S3** (simplest for anything beyond a quick local test): create a small bucket and an IAM user/key scoped to it (`s3:GetObject`/`PutObject`/`DeleteObject`/`ListBucket`/`HeadBucket`). Note the bucket name, region, access key, and secret key.
- **Local MinIO, installed directly (no container)**: download the single MinIO server binary and run it as a normal process:
  ```bash
  # Linux/macOS
  curl -o minio https://dl.min.io/server/minio/release/linux-amd64/minio
  chmod +x minio
  MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin ./minio server ./minio-data --console-address ":9001"

  # Windows — download minio.exe from https://dl.min.io/server/minio/release/windows-amd64/minio.exe, then:
  set MINIO_ROOT_USER=minioadmin
  set MINIO_ROOT_PASSWORD=minioadmin
  minio.exe server .\minio-data --console-address ":9001"
  ```
  Then create a bucket named e.g. `perfstudio-dev` via the console at `http://localhost:9001`, and use:
  ```
  S3_ENDPOINT=http://localhost:9000
  S3_ACCESS_KEY_ID=minioadmin
  S3_SECRET_ACCESS_KEY=minioadmin
  ```

---

## 5. Environment Configuration

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

Create a file named `.env` in `backend/` (`PerfStudio/backend/.env`) with the content below. Replace the placeholder values with the keys you just generated and the PostgreSQL/S3 details from §3–4.

```env
# ── Required ──────────────────────────────────────────────
JWT_SECRET=PASTE_YOUR_JWT_SECRET_HERE
ENCRYPTION_KEY=PASTE_YOUR_ENCRYPTION_KEY_HERE

DATABASE_URL=postgresql://postgres:postgres@localhost:5432/perf_studio

# ── Server ────────────────────────────────────────────────
PORT=3001
NODE_ENV=development
FRONTEND_URL=http://localhost:5173
CORS_ORIGIN=http://localhost:5173

# ── Storage paths (relative to backend folder) ────────────
PROJECTS_ROOT=../projects
BACKUPS_ROOT=../backups

# ── REQUIRED — S3 (or local MinIO from §4) — the backend refuses to start without this ──
S3_SYNC_ENABLED=true
S3_BUCKET=your-bucket-name
S3_REGION=us-east-1
# Only needed for MinIO/an S3-compatible endpoint, not real AWS S3:
# S3_ENDPOINT=http://localhost:9000
# S3_ACCESS_KEY_ID=minioadmin
# S3_SECRET_ACCESS_KEY=minioadmin
```

---

## 6. Run the Backend and Frontend

Requires two terminal windows, with PostgreSQL (§3) and your S3/MinIO (§4) already running.

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

## 7. First Login

On first backend startup, a Super Admin account is seeded into the database automatically (as long as `migrate.js` has already applied the schema — see above).

| Field | Value |
|---|---|
| **URL** | http://localhost:5173 |
| **Email** | `admin@perfstudio.com` |
| **Password** | `Admin@123` |

> **Change the default password** immediately after first login via Profile → Change Password.

### Initial setup flow after login

1. **Super Admin** — Create an organisation and invite an Org Admin
2. **Org Admin** — Create a project, configure AI provider (OpenAI or Anthropic API key)
3. **Org Admin** — Invite regular users to the project
4. **Users** — Add API Sources, run pre-run, upload CSV test data, configure rules, create test plans, generate and run scripts

---

## 8. Folder Structure Created at Runtime

The database itself (users, orgs, licenses, projects, run history, etc.) lives in PostgreSQL, not on disk here — see `DATABASE_URL`. **Test-run results and PAT-auth git workspaces live in S3, not on local disk at all** (see the S3 requirement above) — the tree below is what's real for `projects/`/`backups/` and for SSH-auth-mode git workspaces only:

```
PerfStudio/
├── projects/                   ← Legacy admin project files only
├── backups/                    ← Project ZIP backups (on delete)
└── git-workspaces/             ← SSH-auth-mode workspaces only, real local disk.
    │                              PAT-auth-mode workspaces never appear here at all —
    │                              they're held entirely in S3 via an in-memory git engine.
    ├── admin/                  ← Org Admin git workspace (main branch)
    │   └── ProjectName/
    │       └── CollectionName/
    │           ├── QA/
    │           │   ├── script/     ← Generated JMX / K6 scripts
    │           │   ├── testData/   ← CSV test data files
    │           │   ├── results/    ← JMeter results + HTML report (S3-only in practice —
    │           │   │                 this path shape is preserved as an S3 key prefix)
    │           │   └── config/     ← config.json
    │           ├── Staging/
    │           └── Production/
    └── user-{id}/              ← Per-user git workspace (feature branch)
        └── (same structure)
```

**Test execution is CI-only.** Running the app locally lets you build/generate scripts, run pre-run, and use the full UI — but to actually execute a load test, you need a project connected to GitHub Actions, GitLab CI, or Bitbucket Pipelines (see [USER_WORKFLOW.md §12](USER_WORKFLOW.md#12-running-tests-via-an-external-ci-pipeline)). There is no local/native "just run it here" execution path anymore.

---

## 9. Troubleshooting

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

### Cannot log in / JWT errors

The `JWT_SECRET` in `backend/.env` was likely changed after accounts were created — existing tokens/sessions no longer validate. This doesn't require wiping data; users just need to log in again. If you genuinely want a clean slate:
```bash
# Drop and recreate the database, then re-apply the schema (all data will be lost)
psql "$DATABASE_URL" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
cd backend && node src/db/migrate.js
```
Restart the backend afterward — the default super admin account will be re-seeded automatically.

### "relation does not exist" errors on login/register

The schema was never applied to this Postgres instance. Run `node src/db/migrate.js` from `backend/` — this is a required one-time step, not automatic.

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
If it fails, start the backend first (Terminal 1) before opening the frontend.

### Backend exits immediately with "Refusing to start"

S3 isn't configured or reachable — check `S3_SYNC_ENABLED`/`S3_BUCKET` in `backend/.env`, and that your MinIO process (if using one) is actually running.

---

*For questions or support, contact the development team at tasleem.zaif@qtsolv.com*
