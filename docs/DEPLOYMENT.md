# Peako — Production Deployment Manual

**Version:** 1.1  
**Stack:** Node.js 22 · React (Vite) · PostgreSQL 16 · JMeter · K6  
**Maintained by:** Quarks Technosoft

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Server Requirements](#2-server-requirements)
3. [Method A — Docker (Recommended)](#3-method-a--docker-recommended)
4. [Method B — Manual (No Docker)](#4-method-b--manual-no-docker)
5. [Environment Variables Reference](#5-environment-variables-reference)
6. [Database](#6-database)
7. [Nginx Reverse Proxy](#7-nginx-reverse-proxy)
8. [SSL / HTTPS](#8-ssl--https)
9. [Running as a System Service](#9-running-as-a-system-service)
10. [First Login & Initial Setup](#10-first-login--initial-setup)
11. [Backup & Restore](#11-backup--restore)
12. [Upgrades](#12-upgrades)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. Architecture Overview

```
Browser
  │
  ▼
Nginx (port 80/443)          ← optional but recommended
  │
  ▼
Node.js Backend (port 3001)  ← serves API + built React frontend
  │
  ├── PostgreSQL 16   (separate service — DATABASE_URL)
  ├── Projects        (/app/projects)
  ├── Git workspaces  (/app/git-workspaces)
  └── Backups         (/app/backups)
```

- The backend serves **both** the API (`/api/*`) and the built React frontend (static files).
- No separate frontend server is needed in production.
- PostgreSQL is a **required external service** — run it as a Docker Compose service (default), a managed Postgres instance, or a self-hosted server. Project files, scripts, and results still live on disk.

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

### Recommended (for teams running JMeter tests)
| Resource | Requirement |
|---|---|
| CPU | 4 vCPU |
| RAM | 8 GB |
| Disk | 50 GB SSD |

### Ports to open in firewall
| Port | Purpose |
|---|---|
| 22 | SSH |
| 80 | HTTP (Nginx) |
| 443 | HTTPS (Nginx) |
| 3001 | Backend (only if not using Nginx) |

---

## 3. Method A — Docker (Recommended)

This is the simplest deployment. One container includes Node.js, JMeter, K6, Git, and the built frontend.

### Step 1 — Install Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker
```

Verify:
```bash
docker --version
docker compose version
```

### Step 2 — Get the source code

```bash
git clone https://bitbucket.org/qtsolv/PerfStudio.git
cd PerfStudio
```

### Step 3 — Create the environment file

```bash
cp backend/.env backend/.env.docker
```

Edit `backend/.env.docker` and fill in the required values:

```bash
nano backend/.env.docker
```

Minimum required content:

```env
NODE_ENV=production
PORT=3001

# Generate with: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
JWT_SECRET=REPLACE_WITH_GENERATED_SECRET

# Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
ENCRYPTION_KEY=REPLACE_WITH_GENERATED_KEY

# Your server's public URL (used in invite/reset emails)
FRONTEND_URL=http://YOUR_SERVER_IP_OR_DOMAIN:3001
CORS_ORIGIN=http://YOUR_SERVER_IP_OR_DOMAIN:3001

# Postgres connection — points at the `postgres` service in docker-compose.yml
DATABASE_URL=postgresql://postgres:postgres@postgres:5432/perf_studio

# Storage paths inside the container
PROJECTS_ROOT=/app/projects
BACKUPS_ROOT=/app/backups
```

> Change the Postgres username/password from the `postgres`/`postgres` default before exposing this to a network you don't fully trust — update both `docker-compose.yml`'s `postgres` service environment and `DATABASE_URL` to match.

Generate the secrets:
```bash
# JWT_SECRET
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Step 4 — Start with Docker Compose (recommended)

`docker-compose.yml` at the repo root already defines both services — a `postgres:16-alpine` database and the all-in-one app container — wired together via `DATABASE_URL`. This is the simplest path and the one actually exercised in this repo:

```bash
docker compose --env-file backend/.env.docker up -d --build
```

This takes 5–10 minutes on first build (downloads JMeter, K6, Java) and also pulls/starts Postgres.

> **Important — schema is not auto-applied.** Neither the app container's startup nor the `postgres` service runs `schema.sql` automatically (no `docker-entrypoint-initdb.d` mount, no migration step in the app's boot sequence). On a **fresh** Postgres volume, run the migration once before the app can serve real requests:
> ```bash
> docker compose exec PerfStudio node backend/src/db/migrate.js
> ```
> Safe to re-run any time (idempotent `CREATE TABLE IF NOT EXISTS`) — re-run it after every upgrade that adds new tables/columns to `schema.sql`.

### Step 5 (alternative) — Plain `docker run`, without Compose

Only use this if you specifically don't want Compose managing Postgres. You must run Postgres yourself and point `DATABASE_URL` at it:

```bash
docker build -t perfstudio:latest .

docker run -d --name perfstudio-pg --restart unless-stopped \
  -e POSTGRES_DB=perf_studio -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -v perfstudio_pg_data:/var/lib/postgresql/data \
  postgres:16-alpine

docker run -d \
  --name perfstudio \
  --restart unless-stopped \
  -p 3001:3001 \
  --link perfstudio-pg:postgres \
  --env-file backend/.env.docker \
  -v perfstudio_projects:/app/projects \
  -v perfstudio_git:/app/git-workspaces \
  -v perfstudio_backups:/app/backups \
  perfstudio:latest
```

(`--link` gives the app container a `postgres` hostname resolving to the DB container, matching the `DATABASE_URL` above — on a real deployment prefer a user-defined Docker network over `--link`, which is deprecated in modern Docker.)

### Step 6 — Verify it is running

```bash
docker ps
curl http://localhost:3001/api/health
```

Expected response: `{"status":"ok","ts":"..."}`

### Step 7 — View logs

```bash
docker logs -f perfstudio
```

---

## 4. Method B — Manual (No Docker)

Use this if you do not want Docker, or you are deploying on a managed VM.

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

### Step 3 — Install Java 17 (required by JMeter)

```bash
sudo apt-get install -y openjdk-17-jdk-headless
java -version
```

### Step 4 — Install Apache JMeter 5.6.3

```bash
wget https://archive.apache.org/dist/jmeter/binaries/apache-jmeter-5.6.3.tgz -O /tmp/jmeter.tgz
sudo mkdir -p /opt/jmeter
sudo tar -xzf /tmp/jmeter.tgz -C /opt/
sudo mv /opt/apache-jmeter-5.6.3/* /opt/jmeter/
rm /tmp/jmeter.tgz

# Add to PATH
echo 'export PATH=$PATH:/opt/jmeter/bin' >> ~/.bashrc
source ~/.bashrc

jmeter --version
```

### Step 5 — Install K6

```bash
curl -fsSL https://dl.k6.io/key.gpg | sudo gpg --dearmor -o /usr/share/keyrings/k6-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
  | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update
sudo apt-get install -y k6
k6 version
```

### Step 5b — Install PostgreSQL 16

```bash
sudo apt-get install -y postgresql-16
sudo systemctl enable --now postgresql

# Create the database and a dedicated user
sudo -u postgres psql -c "CREATE DATABASE perf_studio;"
sudo -u postgres psql -c "CREATE USER perfstudio WITH PASSWORD 'CHANGE_ME';"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE perf_studio TO perfstudio;"
```

(Skip this step and use a managed Postgres instance instead if you have one — just note its connection string for Step 9.)

### Step 6 — Get the source code

```bash
git clone https://bitbucket.org/qtsolv/PerfStudio.git /opt/perfstudio
cd /opt/perfstudio
```

### Step 7 — Install backend dependencies

```bash
cd /opt/perfstudio/backend
npm install --omit=dev
```

### Step 8 — Build the frontend

```bash
cd /opt/perfstudio/frontend
npm install
npm run build
```

Copy the built frontend to where the backend serves it:

```bash
cp -r /opt/perfstudio/frontend/dist /opt/perfstudio/backend/public
```

### Step 9 — Create the environment file

```bash
cp /opt/perfstudio/backend/.env /opt/perfstudio/backend/.env.production
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

JMETER_BIN=/opt/jmeter/bin/jmeter
K6_BIN=/usr/bin/k6
EXECUTION_MODE=native
```

### Step 10 — Create data directories and apply the database schema

```bash
mkdir -p /opt/perfstudio/projects
mkdir -p /opt/perfstudio/backups
mkdir -p /opt/perfstudio/git-workspaces

# Applies schema.sql against DATABASE_URL — idempotent, safe to re-run
cd /opt/perfstudio/backend
node src/db/migrate.js
```

### Step 11 — Start the backend

```bash
cd /opt/perfstudio/backend
NODE_ENV=production node src/index.js
```

A `super_admin` account (`admin@perfstudio.com` / `Admin@123`) is seeded automatically on first boot if the `users` table has none yet — no separate seed command needed.

Or in background:

```bash
nohup NODE_ENV=production node src/index.js > /opt/perfstudio/backend.log 2>&1 &
echo "Backend PID: $!"
```

### Step 12 — Verify

```bash
curl http://localhost:3001/api/health
```

---

## 5. Environment Variables Reference

File location: `backend/.env`

| Variable | Required | Default | Description |
|---|---|---|---|
| `NODE_ENV` | Yes | `development` | Set to `production` |
| `PORT` | No | `3001` | Backend port |
| `JWT_SECRET` | **Yes** | — | Secret for signing auth tokens. Use a long random string. |
| `ENCRYPTION_KEY` | **Yes** | — | AES key for encrypting SSH keys and API tokens in DB. 32-byte hex. |
| `FRONTEND_URL` | Yes | `http://localhost:5173` | Public URL — used in invite and password reset emails |
| `CORS_ORIGIN` | Yes | `http://localhost:5173` | Allowed CORS origin. Set same as FRONTEND_URL. |
| `DATABASE_URL` | **Yes** | — | PostgreSQL connection string, e.g. `postgresql://user:pass@host:5432/perf_studio` |
| `PROJECTS_ROOT` | No | `../projects` | Directory for project files and test scripts |
| `BACKUPS_ROOT` | No | `../backups` | Directory for database backups |
| `JMETER_BIN` | No | auto-detected | Full path to `jmeter` binary |
| `K6_BIN` | No | auto-detected | Full path to `k6` binary |
| `EXECUTION_MODE` | No | `docker` | Set to `native` if JMeter/K6 are installed directly |

### Generate secrets

```bash
# JWT_SECRET (48 random bytes = 96 hex chars)
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# ENCRYPTION_KEY (32 random bytes = 64 hex chars)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## 6. Database

This application uses **PostgreSQL 16**, connected via `DATABASE_URL`. It's an external service — run it as the `postgres` service in `docker-compose.yml` (default), a self-installed server (Method B, Step 5b), or a managed Postgres instance (RDS, Cloud SQL, etc.).

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
# Using the Postgres container directly (Docker Compose deployment)
docker exec -it perf_studio_pg psql -U postgres -d perf_studio

# Or, if you have the psql client installed locally and DATABASE_URL is reachable:
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

## 7. Nginx Reverse Proxy

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

In `backend/.env`:
```env
FRONTEND_URL=http://YOUR_DOMAIN_OR_IP
CORS_ORIGIN=http://YOUR_DOMAIN_OR_IP
```

Restart the backend after this change.

---

## 8. SSL / HTTPS

### Using Let's Encrypt (free, recommended)

You need a real domain name pointed to your server for this.

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

Certbot automatically edits your Nginx config to add HTTPS and sets up auto-renewal.

After SSL is set up, update `.env`:
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

## 9. Running as a System Service

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
EnvironmentFile=/opt/perfstudio/backend/.env
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

## 10. First Login & Initial Setup

1. Open the app in your browser: `http://YOUR_SERVER_IP_OR_DOMAIN`
2. Log in with the default super admin:
   - **Email:** `admin@perfstudio.com`
   - **Password:** `Admin@123`
3. **Immediately change the password:** Profile → Change Password
4. Create your organization and invite team members
5. Configure SMTP for email notifications: Settings → Alert Configuration
6. Configure AI settings if needed: Settings → AI Configuration

---

## 11. Backup & Restore

### Backup

The entire application state is in:
1. **PostgreSQL database** (users, orgs, licenses, projects, configs, run history) — dumped with `pg_dump`, not a file copy
2. `projects/` directory — test scripts, generated JMX/JS files, test data
3. `git-workspaces/` directory — local git clones

```bash
# Create a timestamped backup directory
BACKUP_DIR="/opt/perfstudio/backups/$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BACKUP_DIR"

# Backup database — Docker Compose deployment
docker exec perf_studio_pg pg_dump -U postgres perf_studio | gzip > "$BACKUP_DIR/perf_studio.sql.gz"

# Backup database — Method B (Postgres on the host)
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
0 2 * * * docker exec perf_studio_pg pg_dump -U postgres perf_studio | gzip > /opt/perfstudio/backups/db_$(date +\%Y\%m\%d).sql.gz
```

### Restore

```bash
# Stop the backend first
sudo systemctl stop perfstudio    # or: docker compose stop PerfStudio

# Restore database — Docker Compose deployment (drops and recreates first)
gunzip -c /opt/perfstudio/backups/20260101_020000/perf_studio.sql.gz | \
  docker exec -i perf_studio_pg psql -U postgres -d perf_studio

# Restore database — Method B (Postgres on the host)
gunzip -c /opt/perfstudio/backups/20260101_020000/perf_studio.sql.gz | psql "$DATABASE_URL"

# Restore projects
cp -r /opt/perfstudio/backups/20260101_020000/projects /opt/perfstudio/

# Start the backend
sudo systemctl start perfstudio   # or: docker compose start PerfStudio
```

---

## 12. Upgrades

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

Unlike the old SQLite setup, schema changes are **not** applied automatically on startup — always re-run `migrate.js` after pulling code that touches `schema.sql`, before restarting.

### Docker Compose upgrade

```bash
cd /opt/perfstudio
git pull origin main
docker compose --env-file backend/.env.docker up -d --build
docker compose exec PerfStudio node backend/src/db/migrate.js
```

---

## 13. Troubleshooting

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

### Database connection errors

```bash
# "relation \"users\" does not exist" — schema was never applied to this Postgres instance
cd /opt/perfstudio/backend && node src/db/migrate.js
# (Docker Compose): docker compose exec PerfStudio node backend/src/db/migrate.js

# "ECONNREFUSED" / "could not connect to server" — Postgres isn't reachable at DATABASE_URL
docker ps | grep postgres          # is the postgres container running/healthy?
docker compose logs postgres       # check its own startup logs
psql "$DATABASE_URL" -c "SELECT 1;"  # test the connection string directly

# "password authentication failed" — DATABASE_URL doesn't match the postgres service's
# POSTGRES_USER/POSTGRES_PASSWORD in docker-compose.yml (or the role you created in Method B)
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

### JMeter not found

```bash
# Verify JMeter is in PATH
which jmeter
jmeter --version

# If not found, set JMETER_BIN in .env
echo "JMETER_BIN=/opt/jmeter/bin/jmeter" >> /opt/perfstudio/backend/.env
sudo systemctl restart perfstudio
```

### Check running services

```bash
sudo systemctl status perfstudio
sudo systemctl status nginx
curl http://localhost:3001/api/health
```
