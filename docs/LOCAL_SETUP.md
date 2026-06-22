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
| **Docker Desktop** *(Method A only)* | Latest | https://www.docker.com/products/docker-desktop |

**Verify your installation:**
```bash
node --version    # should print v20.x or higher
npm --version     # should print 9.x or higher
git --version
docker --version  # only needed for Method A
```

---

## 2. Clone the Repository

```bash
git clone https://bitbucket.org/qtsolv/peako.git
cd peako
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

Create a file named `.env` in the **project root** (`peako/.env`) with the content below. Replace the placeholder values with the keys you just generated.

```env
# ── Required ──────────────────────────────────────────────
JWT_SECRET=PASTE_YOUR_JWT_SECRET_HERE
ENCRYPTION_KEY=PASTE_YOUR_ENCRYPTION_KEY_HERE

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
HOST_PROJECTS_ROOT=C:/Users/YourName/peako/projects
HOST_BACKUPS_ROOT=C:/Users/YourName/peako/backups
```

> **Important:** `HOST_PROJECTS_ROOT` and `HOST_BACKUPS_ROOT` must be absolute paths using forward slashes. Only needed for Method A (Docker).

---

## 4. Method A — Docker (Recommended)

This runs the entire application (backend + frontend served as static files) in a single container. No Node.js setup required after the prerequisites.

```bash
# From the project root
docker compose up -d
```

Docker will build the image on the first run (takes 2–5 minutes). Subsequent starts are instant.

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

This runs the backend and frontend as separate dev servers with hot-reload. Requires two terminal windows.

### Terminal 1 — Backend

```bash
cd peako/backend
npm install
npm run dev
```

You should see:
```
Performance Studio API running on http://localhost:3001
```

### Terminal 2 — Frontend

```bash
cd peako/frontend
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

On first startup the database is created automatically and a Super Admin account is seeded.

| Field | Value |
|---|---|
| **URL** | http://localhost:5173 (Method B) or http://localhost:3001 (Method A) |
| **Email** | `admin@Peako.com` |
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

```
peako/
├── data/
│   └── peako.db          ← SQLite database (all app data)
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

The `JWT_SECRET` in `.env` was likely changed after accounts were created. Run:
```bash
# Delete the database and restart (all data will be lost)
# Windows
del data\peako.db
# Mac/Linux
rm data/peako.db
```
Then restart the server — the database and default admin account will be re-created.

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
