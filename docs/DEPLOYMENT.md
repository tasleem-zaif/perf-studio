# Peako — Production Deployment Manual

**Version:** 1.2
**Stack:** Node.js 22 · React (Vite) · PostgreSQL 16
**Maintained by:** Quarks Technosoft

**Deployment model: direct (bare-metal/VM), no containers.** The application runs as a plain Node.js process on the host, managed by systemd. There is no Docker deployment path documented here.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Server Requirements](#2-server-requirements)
3. [Deployment Steps](#3-deployment-steps)
4. [Environment Variables Reference](#4-environment-variables-reference)
5. [Database](#5-database)
6. [Nginx Reverse Proxy](#6-nginx-reverse-proxy)
7. [SSL / HTTPS](#7-ssl--https)
8. [Running as a System Service](#8-running-as-a-system-service)
9. [First Login & Initial Setup](#9-first-login--initial-setup)
10. [Backup & Restore](#10-backup--restore)
11. [Upgrades](#11-upgrades)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. Architecture Overview

```
Browser
  │
  ▼
Nginx (port 80/443)          ← optional but recommended
  │
  ▼
Node.js Backend (port 3001)  ← runs directly on the host via systemd
                                serves API + built React frontend
  │
  ├── PostgreSQL 16   (separate service — DATABASE_URL)
  ├── AWS S3 (or compatible)  (MANDATORY — see below)
  ├── Projects        (/opt/perfstudio/projects — legacy/admin files only)
  ├── Git workspaces  (/opt/perfstudio/git-workspaces — SSH-mode only, ephemeral)
  └── Backups         (/opt/perfstudio/backups)
```

- The backend serves **both** the API (`/api/*`) and the built React frontend (static files) from a single Node.js process.
- No separate frontend server, container runtime, or orchestrator is required.
- PostgreSQL is a **required external service** — a self-installed server on the same host or a separate host, or a managed Postgres instance (RDS, Cloud SQL, etc.).
- **⚠ AWS S3 (or an S3-compatible store) is also a required external service — the app refuses to boot without it.** `backend/src/index.js` calls `assertBucketReachable()` at startup and exits the process if `S3_SYNC_ENABLED`/`S3_BUCKET` aren't set or the bucket isn't reachable. This is a GDPR-driven, zero-local-disk design: all git workspace data (PAT-auth mode) and all test-run results (JTL, HTML report, PDF) live in S3 only, never on local disk.
- **SSH-auth-mode git workspaces are the one thing that still touches local disk** (`/opt/perfstudio/git-workspaces`), since `isomorphic-git` has no SSH transport and this path still uses the real `git` binary against a real directory. To keep this ephemeral (no customer data persisted to physical disk, per the same GDPR requirement), mount it as a real Linux `tmpfs` (RAM-backed) filesystem rather than leaving it on normal disk — see §3, Step 10.
- **⚠ Test execution itself is CI-only.** JMeter/K6 do not run on this server at all — local/native test-execution routes are retired (HTTP 410). A real test run is triggered against an external CI provider (GitHub Actions, GitLab CI, or Bitbucket Pipelines), which is where JMeter/K6 actually execute; this server only orchestrates the trigger and pulls results back afterward. **One of GitHub/GitLab/Bitbucket is therefore effectively a required external dependency too**, not optional — see §2.

---

## 2. Server Requirements

### Minimum
| Resource | Requirement |
|---|---|
| OS | Ubuntu 20.04+ / Debian 11+ / RHEL 8+ |
| CPU | 2 vCPU |
| RAM | 4 GB |
| Disk | 20 GB |
| Node.js | 22+ |
| Git | Any recent version |

### Recommended
| Resource | Requirement |
|---|---|
| CPU | 4 vCPU |
| RAM | 8 GB (add headroom for the tmpfs git-workspaces mount — see §3, Step 10) |
| Disk | 50 GB SSD |

### Ports to open in firewall
| Port | Purpose |
|---|---|
| 22 | SSH |
| 80 | HTTP (Nginx) |
| 443 | HTTPS (Nginx) |
| 3001 | Backend (only if not using Nginx) |

### External services (in addition to the server itself)
| Service | Required? | Purpose |
|---|---|---|
| PostgreSQL 16 | **Required** | System of record |
| AWS S3 (or S3-compatible, e.g. MinIO) | **Required — boot fails without it** | All git workspace data + all test-run results (GDPR zero-local-disk design) |
| GitHub, GitLab, or Bitbucket | **Effectively required** | Test execution is CI-only — JMeter/K6 run on the CI provider's runner, not this server |
| SMTP provider | Optional but expected | Invites, password reset, run alerts |
| OpenAI and/or Anthropic | Optional | Auto-heal diagnosis, AI-assisted fixes — degrades gracefully if unset, since script generation itself is deterministic |

---

## 3. Deployment Steps

### Step 1 — Install Node.js 22

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # should print v22.x
```

### Step 2 — Install Git

```bash
sudo apt-get install -y git
git --version
```

### Step 3 — Install PostgreSQL 16

```bash
sudo apt-get install -y postgresql-16
sudo systemctl enable --now postgresql

# Create the database and a dedicated user
sudo -u postgres psql -c "CREATE DATABASE perf_studio;"
sudo -u postgres psql -c "CREATE USER perfstudio WITH PASSWORD 'CHANGE_ME';"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE perf_studio TO perfstudio;"
```

(Skip this step and use a managed Postgres instance instead if you have one — just note its connection string for Step 7.)

### Step 4 — Set up your S3 bucket (or S3-compatible store)

The app will not start without this — see §1. Create a small S3 bucket and an IAM user/role scoped to it (`s3:GetObject`/`PutObject`/`DeleteObject`/`ListBucket`/`HeadBucket`), or stand up a self-hosted S3-compatible store (e.g. MinIO installed directly on a host, not via a container) if you don't want to use AWS. Note the bucket name, region, and (if not using an instance/IAM role) access key/secret for Step 7.

### Step 5 — Get the source code

```bash
git clone https://bitbucket.org/qtsolv/PerfStudio.git /opt/perfstudio
cd /opt/perfstudio
```

### Step 6 — Install backend dependencies

```bash
cd /opt/perfstudio/backend
npm install --omit=dev
```

### Step 7 — Build the frontend

```bash
cd /opt/perfstudio/frontend
npm install
npm run build
```

Copy the built frontend to where the backend serves it:

```bash
cp -r /opt/perfstudio/frontend/dist /opt/perfstudio/backend/public
```

### Step 8 — Create the environment file

```bash
cp /opt/perfstudio/backend/.env.example /opt/perfstudio/backend/.env.production
```

Generate the two required secrets:
```bash
# JWT_SECRET (48 random bytes = 96 hex chars)
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# ENCRYPTION_KEY (32 random bytes = 64 hex chars)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Edit `/opt/perfstudio/backend/.env.production`:

```env
NODE_ENV=production
PORT=3001

JWT_SECRET=REPLACE_WITH_GENERATED_SECRET
ENCRYPTION_KEY=REPLACE_WITH_GENERATED_KEY

FRONTEND_URL=http://YOUR_SERVER_IP_OR_DOMAIN
CORS_ORIGIN=http://YOUR_SERVER_IP_OR_DOMAIN

DATABASE_URL=postgresql://perfstudio:CHANGE_ME@localhost:5432/perf_studio

PROJECTS_ROOT=/opt/perfstudio/projects
BACKUPS_ROOT=/opt/perfstudio/backups

# ── REQUIRED — the app will not boot without a reachable S3 bucket ──
# There is no way to disable this in production; all git workspace data (PAT-auth)
# and all test-run results live in S3 only (GDPR zero-local-disk requirement).
S3_SYNC_ENABLED=true
S3_BUCKET=your-bucket-name
S3_REGION=your-region
# Leave blank on AWS with an instance/IAM role attached; set explicitly otherwise:
# S3_ACCESS_KEY_ID=
# S3_SECRET_ACCESS_KEY=
```

### Step 9 — Create data directories and apply the database schema

```bash
mkdir -p /opt/perfstudio/projects
mkdir -p /opt/perfstudio/backups
mkdir -p /opt/perfstudio/git-workspaces

# Applies schema.sql against DATABASE_URL — idempotent, safe to re-run
cd /opt/perfstudio/backend
node src/db/migrate.js
```

### Step 10 (recommended) — Mount `git-workspaces` as tmpfs

SSH-auth-mode git workspaces are the one thing still written to local disk (PAT-auth is fully S3-backed). To keep this ephemeral and RAM-backed — consistent with the app's zero-physical-disk design — mount it as a real Linux tmpfs filesystem instead of leaving it on normal disk. Add to `/etc/fstab` (size to your expected concurrent SSH-mode workspace count — ~200MB each is a reasonable planning figure):

```
tmpfs /opt/perfstudio/git-workspaces tmpfs size=6g,mode=1777 0 0
```

Then mount it:
```bash
sudo mount /opt/perfstudio/git-workspaces
```

Contents are lost on reboot by design — `workspaceLifecycle.js` lazily re-hydrates any workspace from S3/the git remote on next access, so this is a cold-start cost, not data loss. If you'd rather keep it on normal persistent disk (simpler, but customer data then persists to physical disk between reboots), skip this step — the directory created in Step 9 works fine as a plain directory too.

### Step 11 — Start the backend

```bash
cd /opt/perfstudio/backend
NODE_ENV=production node src/index.js
```

A `super_admin` account (`admin@perfstudio.com` / `Admin@123`) is seeded automatically on first boot if the `users` table has none yet — no separate seed command needed.

For a real deployment, don't run it in the foreground like this — set it up as a systemd service (§8) so it survives reboots and restarts on crash.

### Step 12 — Verify

```bash
curl http://localhost:3001/api/health
```

Expected response: `{"status":"ok","ts":"..."}`

---

## 4. Environment Variables Reference

File location: `backend/.env.production` (or whatever path your systemd unit's `EnvironmentFile` points at — see §8)

| Variable | Required | Default | Description |
|---|---|---|---|
| `NODE_ENV` | Yes | `development` | Set to `production` |
| `PORT` | No | `3001` | Backend port |
| `JWT_SECRET` | **Yes** | — | Secret for signing auth tokens. Use a long random string. |
| `ENCRYPTION_KEY` | **Yes** | — | AES key for encrypting SSH keys and API tokens in DB. 32-byte hex. |
| `FRONTEND_URL` | Yes | `http://localhost:5173` | Public URL — used in invite and password reset emails |
| `CORS_ORIGIN` | Yes | `http://localhost:5173` | Allowed CORS origin. Set same as FRONTEND_URL. |
| `DATABASE_URL` | **Yes** | — | PostgreSQL connection string, e.g. `postgresql://user:pass@host:5432/perf_studio` |
| `S3_SYNC_ENABLED` | **Yes — must be `true`** | — | The app calls `assertBucketReachable()` at boot and exits the process if this isn't `true` with a reachable `S3_BUCKET`. No production configuration exists without S3. |
| `S3_BUCKET` | **Yes** | — | Target S3 bucket name |
| `S3_REGION` | Recommended | — | AWS region for the S3 client |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | No | — | Explicit credentials; omit on AWS hosting to use the instance/task IAM role instead (preferred) |
| `S3_ENDPOINT` | No | — | Only for a self-hosted S3-compatible endpoint (e.g. MinIO) instead of real AWS S3 |
| `PROJECTS_ROOT` | No | `../projects` | Directory for legacy/admin project files only — not where scripts/results live anymore |
| `BACKUPS_ROOT` | No | `../backups` | Directory for project-delete ZIP backups |
| `JMETER_BIN` / `K6_BIN` / `EXECUTION_MODE` | **Vestigial — no effect** | — | Local/native test execution is retired (every route returns HTTP 410); these env vars are read by confirmed-dead code paths only |

### Generate secrets

```bash
# JWT_SECRET (48 random bytes = 96 hex chars)
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# ENCRYPTION_KEY (32 random bytes = 64 hex chars)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## 5. Database

This application uses **PostgreSQL 16**, connected via `DATABASE_URL`. It's an external service — a self-installed server (§3, Step 3) or a managed Postgres instance (RDS, Cloud SQL, etc.).

- **Schema**: `backend/src/db/schema.sql`, applied by `node src/db/migrate.js` — idempotent `CREATE TABLE IF NOT EXISTS`, safe to re-run, does not touch existing data.
- **Super admin seeding**: `backend/src/db/index.js` checks for an existing `super_admin` row every time the backend boots and inserts one if none exists — no separate seed command needed, and it never overwrites an existing super admin.
- **Licensing**: every organization gets an `org_licenses` row (plan/limits/expiry) lazily created on first access — see [PROJECT_MAP.md](../PROJECT_MAP.md#licensing-system-added) for plan tiers.

### Default super admin (seeded on first boot if none exists)
| Field | Value |
|---|---|
| Email | `admin@perfstudio.com` |
| Password | `Admin@123` |

**Change the password immediately after first login.**

### Inspect the database

```bash
psql "$DATABASE_URL"

# List tables
\dt

# View users
SELECT id, email, name, role FROM users;

# View org licenses
SELECT org_id, plan, max_users, max_projects, status, expires_at FROM org_licenses;

# Exit
\q
```

---

## 6. Nginx Reverse Proxy

Nginx is recommended so you can:
- Use port 80/443 instead of 3001
- Add SSL/HTTPS
- Handle large file uploads

### Step 1 — Install Nginx

```bash
sudo apt-get install -y nginx
```

### Step 2 — Create the site config

```bash
sudo nano /etc/nginx/sites-available/perfstudio
```

Paste:

```nginx
server {
    listen 80;
    server_name YOUR_DOMAIN_OR_IP;

    # Increase upload limit for test scripts and data files
    client_max_body_size 100M;

    # API and file routes — proxy to Node.js backend
    location /api/ {
        proxy_pass         http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;

        # Required for Server-Sent Events (live logs during test runs)
        proxy_buffering    off;
        proxy_read_timeout 300s;
    }

    location /projects-files/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
    }

    location /workspace-files/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
    }

    # Everything else — served by backend (React SPA)
    location / {
        proxy_pass         http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
    }
}
```

### Step 3 — Enable and restart

```bash
sudo ln -s /etc/nginx/sites-available/perfstudio /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

### Step 4 — Update FRONTEND_URL and CORS_ORIGIN

In `backend/.env.production`:
```env
FRONTEND_URL=http://YOUR_DOMAIN_OR_IP
CORS_ORIGIN=http://YOUR_DOMAIN_OR_IP
```

Restart the backend after this change.

---

## 7. SSL / HTTPS

### Using Let's Encrypt (free, recommended)

You need a real domain name pointed to your server for this.

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

Certbot automatically edits your Nginx config to add HTTPS and sets up auto-renewal.

After SSL is set up, update `.env.production`:
```env
FRONTEND_URL=https://your-domain.com
CORS_ORIGIN=https://your-domain.com
```

### Auto-renewal

```bash
# Test renewal
sudo certbot renew --dry-run

# Certbot installs a cron job automatically — verify:
sudo systemctl status certbot.timer
```

---

## 8. Running as a System Service

This keeps the backend running after reboot and restarts it if it crashes.

### Create a systemd service

```bash
sudo nano /etc/systemd/system/perfstudio.service
```

Paste (adjust paths if needed):

```ini
[Unit]
Description=Peako Performance Testing Platform
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/perfstudio/backend
EnvironmentFile=/opt/perfstudio/backend/.env.production
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=perfstudio

[Install]
WantedBy=multi-user.target
```

### Enable and start

```bash
sudo systemctl daemon-reload
sudo systemctl enable perfstudio
sudo systemctl start perfstudio
```

### Check status

```bash
sudo systemctl status perfstudio

# Live logs
sudo journalctl -u perfstudio -f
```

### Stop / Restart

```bash
sudo systemctl stop perfstudio
sudo systemctl restart perfstudio
```

---

## 9. First Login & Initial Setup

1. Open the app in your browser: `http://YOUR_SERVER_IP_OR_DOMAIN`
2. Log in with the default super admin:
   - **Email:** `admin@perfstudio.com`
   - **Password:** `Admin@123`
3. **Immediately change the password:** Profile → Change Password
4. Create your organization and invite team members
5. Configure SMTP for email notifications: Settings → Alert Configuration
6. Configure AI settings if needed: Settings → AI Configuration

---

## 10. Backup & Restore

### Backup

The application's real data lives in two places:
1. **PostgreSQL database** (users, orgs, licenses, projects, configs, run history) — dumped with `pg_dump`, not a file copy
2. **AWS S3 (or compatible)** — all git workspace data (PAT-auth mode) and all test-run results (JTL, HTML report, PDF). This is the primary content backup surface; **S3 bucket versioning/backup/replication is a DevOps-owned responsibility of the bucket itself** (e.g. S3 Versioning, Cross-Region Replication, or a scheduled `aws s3 sync` to a secondary bucket) — Peako does not orchestrate this itself.

`git-workspaces/` and `projects/` are **no longer meaningful backup targets**: `git-workspaces/` is either fully S3-backed (PAT-auth) or an ephemeral tmpfs mount (SSH-auth, if you set that up in §3 Step 10 — RAM-backed, intentionally lost on reboot and re-hydrated from S3/the git remote on next access) — copying it captures nothing durable. `projects/` only holds legacy/admin-only files unrelated to the S3-backed workflow.

```bash
# Create a timestamped backup directory
BACKUP_DIR="/opt/perfstudio/backups/$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BACKUP_DIR"

# Backup database
pg_dump "$DATABASE_URL" | gzip > "$BACKUP_DIR/perf_studio.sql.gz"

# Backup project files
cp -r /opt/perfstudio/projects "$BACKUP_DIR/"

echo "Backup saved to: $BACKUP_DIR"
```

### Automated daily backup (cron)

```bash
crontab -e
```

Add:
```cron
0 2 * * * pg_dump "$DATABASE_URL" | gzip > /opt/perfstudio/backups/db_$(date +\%Y\%m\%d).sql.gz
```

### Restore

```bash
# Stop the backend first
sudo systemctl stop perfstudio

# Restore database
gunzip -c /opt/perfstudio/backups/20260101_020000/perf_studio.sql.gz | psql "$DATABASE_URL"

# Restore projects
cp -r /opt/perfstudio/backups/20260101_020000/projects /opt/perfstudio/

# Start the backend
sudo systemctl start perfstudio
```

---

## 11. Upgrades

### Step 1 — Pull latest code

```bash
cd /opt/perfstudio
git pull origin main
```

### Step 2 — Update backend dependencies

```bash
cd /opt/perfstudio/backend
npm install --omit=dev
```

### Step 3 — Rebuild and redeploy frontend

```bash
cd /opt/perfstudio/frontend
npm install
npm run build
cp -r dist ../backend/public
```

### Step 4 — Apply any new schema changes, then restart

```bash
cd /opt/perfstudio/backend
node src/db/migrate.js       # idempotent — only adds what's missing
sudo systemctl restart perfstudio
```

Schema changes are **not** applied automatically on startup — always re-run `migrate.js` after pulling code that touches `schema.sql`, before restarting.

---

## 12. Troubleshooting

### Backend not starting

```bash
# Check logs
sudo journalctl -u perfstudio -n 50 --no-pager

# Check if port 3001 is already in use
sudo lsof -i :3001

# Kill whatever is using port 3001
sudo kill $(sudo lsof -ti:3001)
```

### Health check failing

```bash
curl -v http://localhost:3001/api/health
```

### Backend exits immediately after "Refusing to start" in the logs

This means S3 isn't configured or isn't reachable — the app performs a boot-time check (`assertBucketReachable()`) and will not start without it.

```bash
# Check the actual error
sudo journalctl -u perfstudio -n 20 --no-pager

# Common causes:
# - S3_SYNC_ENABLED is not exactly "true", or S3_BUCKET is blank
# - Wrong S3_REGION for the bucket
# - Credentials don't have s3:HeadBucket / s3:ListBucket permission on this bucket
# - S3_ENDPOINT is set for a real AWS bucket (only set this for a self-hosted S3-compatible store)
```

### Database connection errors

```bash
# "relation \"users\" does not exist" — schema was never applied to this Postgres instance
cd /opt/perfstudio/backend && node src/db/migrate.js

# "ECONNREFUSED" / "could not connect to server" — Postgres isn't reachable at DATABASE_URL
sudo systemctl status postgresql            # is it running?
psql "$DATABASE_URL" -c "SELECT 1;"         # test the connection string directly

# "password authentication failed" — DATABASE_URL doesn't match the role/password you created in §3, Step 3
```

### Frontend shows blank page

```bash
# Make sure the built frontend is in backend/public
ls /opt/perfstudio/backend/public/index.html

# If missing, rebuild:
cd /opt/perfstudio/frontend && npm run build
cp -r dist ../backend/public
sudo systemctl restart perfstudio
```

### Git operations failing (SSH key errors)

```bash
# Verify SSH agent is running on the server
eval "$(ssh-agent -s)"

# Test SSH connection to GitHub
ssh -T git@github.com
```

### Check running services

```bash
sudo systemctl status perfstudio
sudo systemctl status nginx
curl http://localhost:3001/api/health
```
