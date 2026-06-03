# PerfStudio — System Requirements

---

## Required — Must be installed before first run

### 1. Docker Desktop (Windows / macOS) or Docker Engine (Linux)
- **Version:** 20.10 or later
- **Why:** All test tools (JMeter, K6) run inside Docker containers. The backend
  spawns them via the Docker socket at test execution time.
- **Install:**
  - Windows / macOS: https://www.docker.com/products/docker-desktop/
  - Linux: `curl -fsSL https://get.docker.com | sh`
- **Permission (Linux/macOS):** Current user must be in the `docker` group:
  ```
  sudo usermod -aG docker $USER && newgrp docker
  ```

### 2. Docker Compose v2
- **Version:** 2.0 or later (bundled with Docker Desktop)
- **Why:** Used to orchestrate backend + frontend containers.

---

## Required — Configuration before deployment

### 3. `.env` file (project root)
Copy `.env.example` to `.env` and fill in:

| Variable | Required | Description |
|---|---|---|
| `JWT_SECRET` | **Yes** | Random secret — `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `HOST_PROJECTS_ROOT` | **Yes** | Absolute path on HOST to the `./projects/` folder |
| `FRONTEND_URL` | **Yes** | Public URL of the app (e.g. `http://192.168.1.10:5173`) — used in invite/reset emails |
| `CORS_ORIGIN` | **Yes** | Same as FRONTEND_URL |
| `ENCRYPTION_KEY` | Optional | 32-char hex string for AES encryption of API keys |

---

## Optional — For full functionality

### 4. AI Script Generation
- **OpenAI API Key** with GPT-4o access — https://platform.openai.com/api-keys
- **OR Anthropic Claude API Key** — https://console.anthropic.com
- Configured per-project inside the app: Project → AI Configuration

### 5. SMTP for Invite & Alert Emails
- Any SMTP server (Gmail recommended)
- For Gmail: enable 2FA → generate App Password → https://myaccount.google.com/apppasswords
- Configured in app: Settings → SMTP Configuration

### 6. Git Integration (optional)
- A **GitHub** (or GitLab) account
- A **Personal Access Token (PAT)** with `repo` scope
- An empty private GitHub repository per project
- Configured in app: Project → Git → Settings

---

## Network Requirements

| Port | Service | Direction |
|---|---|---|
| 5173 | Frontend UI | Inbound from browsers |
| 3001 | Backend API | Internal (proxied by frontend) |
| 443/80 | SMTP + AI APIs | Outbound from server |

---

## Hardware Recommendations

| Load | RAM | CPU | Disk |
|---|---|---|---|
| Development / Demo | 8 GB | 4 cores | 20 GB |
| Small team (2–5 users) | 16 GB | 4 cores | 50 GB |
| Production (10+ users) | 32 GB | 8 cores | 100 GB |

> Results and JMeter HTML reports can be large. Allocate disk generously.
