# PerfStudio — System Requirements

---

## Required — Must be installed before first run

**Deployment model: direct (bare-metal/VM), no containers.** JMeter/K6 no longer run on this server at all — local/native test execution is retired (every such route returns HTTP 410). Real test execution happens exclusively on an external CI provider's own runners (GitHub Actions, GitLab CI, or Bitbucket Pipelines) — see item 5 below, which is now effectively required, not optional. The application itself runs as a plain Node.js process (systemd-managed in production) — see `docs/DEPLOYMENT.md`.

### 1. Node.js 22
- **Why:** Runs the backend directly (`node src/index.js`), which also serves the built React frontend as static files.
- **Install:** `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -` then `sudo apt-get install -y nodejs` (Linux), or download from https://nodejs.org (Windows/macOS).

### 2. PostgreSQL 16
- **Why:** System of record — no SQLite/file-based fallback exists.
- **Install:** Directly on the host (`sudo apt-get install -y postgresql-16`) or use a managed instance (RDS, Cloud SQL, etc.) — see `docs/DEPLOYMENT.md` §3.

### 3. An S3 bucket (or self-hosted S3-compatible store, e.g. MinIO installed directly — not via a container)
- **Why:** The app refuses to boot without a reachable bucket. All git workspace data (PAT-auth mode) and all test-run results (JTL, HTML report, PDF) live in S3 only — a GDPR-driven, zero-local-disk design (`backend/src/index.js` calls `assertBucketReachable()` at startup and exits the process if this isn't configured/reachable).
- **Install:** A small AWS S3 bucket + IAM credentials, or the MinIO server binary run directly on a host — see `docs/LOCAL_SETUP.md` §4.

### 4. Nginx (recommended, for production)
- **Why:** Reverse proxy for port 80/443 and TLS termination — the Node.js process itself only serves plain HTTP on port 3001.
- **Install:** `sudo apt-get install -y nginx` — see `docs/DEPLOYMENT.md` §6–7.

---

## Required — Configuration before deployment

### 5. `.env` file (`backend/.env.production` in production, `backend/.env` for local dev)
Copy `backend/.env.example` and fill in:

| Variable | Required | Description |
|---|---|---|
| `JWT_SECRET` | **Yes** | Random secret — `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `ENCRYPTION_KEY` | **Yes** | 32-char hex string for AES encryption of API keys/git tokens/SMTP passwords |
| `S3_SYNC_ENABLED` + `S3_BUCKET` | **Yes** | App will not start without both — see item 3 above |
| `DATABASE_URL` | **Yes** | PostgreSQL connection string — see item 2 above |
| `FRONTEND_URL` | **Yes** | Public URL of the app — used in invite/reset emails |
| `CORS_ORIGIN` | Recommended | Intended to restrict allowed origins — **note:** the current code allows all origins regardless of this value; not yet enforced as a strict whitelist |

---

## Optional — For full functionality

### 6. AI Script Generation
- **OpenAI API Key** with GPT-4o access — https://platform.openai.com/api-keys
- **OR Anthropic Claude API Key** — https://console.anthropic.com
- Configured per-project inside the app: Project → AI Configuration

### 7. SMTP for Invite & Alert Emails
- Any SMTP server (Gmail recommended)
- For Gmail: enable 2FA → generate App Password → https://myaccount.google.com/apppasswords
- Configured in app: Settings → SMTP Configuration

### 8. Git + CI Provider Integration (effectively required, not optional)
- A **GitHub**, **GitLab**, or **Bitbucket** account — this is now the only way to actually execute a load test (see the note at the top of this file)
- A **Personal Access Token (PAT)** with repo + Actions/pipeline-trigger scope
- An empty private repository per project
- Configured in app: Project → Git → Settings, and Project → CI/CD → connect provider

---

## Network Requirements

| Port | Service | Direction |
|---|---|---|
| 3001 | App (API + built frontend, direct Node.js process) | Inbound from browsers, or from Nginx if using a reverse proxy |
| 5173 | Frontend dev server (local dev only) | Inbound from browsers |
| 5432 | PostgreSQL | Internal (or inbound if DB is remote) |
| 80/443 | Nginx (recommended, production) | Inbound from browsers |
| 443/80 (outbound) | S3, SMTP, AI APIs, GitHub/GitLab/Bitbucket | Outbound from server — S3 and one of GitHub/GitLab/Bitbucket are required, not just SMTP/AI |

---

## Hardware Recommendations

| Load | RAM | CPU | Disk |
|---|---|---|---|
| Development / Demo | 8 GB | 4 cores | 20 GB |
| Small team (2–5 users) | 16 GB | 4 cores | 50 GB |
| Production (10+ users) | 32 GB | 8 cores | 100 GB |

> Results and JMeter HTML reports can be large. Allocate disk generously.
