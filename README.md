# 🚀 Performance Studio

**AI-Powered Performance Testing Platform** — Multi-environment load testing with JMeter & K6, AI script generation, auto-healing, real-time analytics, Git integration, and team collaboration.

[![Docker Pulls](https://img.shields.io/docker/pulls/tasleemzaif/peako-backend)](https://hub.docker.com/r/tasleemzaif/peako-backend)
[![Build](https://github.com/tasleem-zaif/peako/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/tasleem-zaif/peako/actions)

---

## ⚡ Quick Start (Docker)

```bash
# 1. Download config files
curl -O https://raw.githubusercontent.com/tasleem-zaif/peako/main/docker-compose.yml
curl -O https://raw.githubusercontent.com/tasleem-zaif/peako/main/.env.example

# 2. Configure environment
cp .env.example .env
# Edit .env — set HOST_PROJECTS_ROOT, JWT_SECRET, FRONTEND_URL

# 3. Launch (pulls images from Docker Hub automatically)
docker compose up -d

# 4. Open in browser
open http://localhost:5173
```

**Default Super Admin credentials:** `admin@Peako.com` / `Admin@123`

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
| 🌿 **Git Integration** | Per-project Git with branch-per-user workflow, PR management, GitHub sync |
| 👥 **Team Collaboration** | Org-based invite system, role-based access (Super Admin / Org Admin / User) |
| 🔑 **Password Recovery** | Self-service forgot password via email + admin override |
| 🔒 **Security** | AES-256-CBC encrypted secrets, JWT auth, role-based guards on all routes |

---

## 👥 User Roles

| Role | Capabilities |
|---|---|
| **Super Admin** | Create organizations, invite Org Admins, configure SMTP |
| **Org Admin** | Create projects, invite team members, configure AI/Git, merge PRs, run tests |
| **Regular User** | Upload test data, configure envs, create test plans, push to own branch, raise PRs |

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

**Prerequisites:** Node.js 18+, Docker Desktop

```bash
# Clone
git clone https://github.com/tasleem-zaif/peako.git
cd peako

# Backend
cd backend && npm install
node src/index.js       # runs on :3001

# Frontend (new terminal)
cd frontend && npm install
npm run dev             # runs on :5173
```

---

## 🐳 Docker Images

| Image | Docker Hub |
|---|---|
| Backend | `tasleemzaif/peako-backend:latest` |
| Frontend | `tasleemzaif/peako-frontend:latest` |

```bash
# Pull latest
docker compose pull && docker compose up -d
```

---

## ⚙️ Environment Variables

| Variable | Required | Description |
|---|---|---|
| `JWT_SECRET` | ✅ | Random 32+ char string for token signing |
| `HOST_PROJECTS_ROOT` | ✅ | Absolute path to `./projects/` on host machine |
| `FRONTEND_URL` | ✅ | Public URL of the frontend (used in invite/reset emails) |
| `CORS_ORIGIN` | ✅ | Allowed CORS origin (same as FRONTEND_URL in production) |
| `ENCRYPTION_KEY` | Optional | AES key for encrypting API keys in DB |
| `BACKEND_PORT` | Optional | Backend port (default: 3001) |
| `FRONTEND_PORT` | Optional | Frontend port (default: 5173) |
| `JMETER_DOCKER_IMAGE` | Optional | JMeter image (default: justb4/jmeter:latest) |
| `K6_DOCKER_IMAGE` | Optional | K6 image (default: grafana/k6:latest) |

---

## 📁 Project Structure

```
peako/
├── backend/           Node.js Express API
│   └── src/
│       ├── routes/    auth, projects, collections, git, invites, ...
│       ├── utils/     AI, email, encryption, project folders
│       └── db/        SQLite schema + migrations
├── frontend/          React + Vite → Nginx
│   └── src/
│       ├── components/ Sidebar, Auth, EnvBar, GitPanel, ...
│       └── pages/      Dashboard, TestData, Config, Settings, ...
├── projects/          Per-project data (gitignored)
├── backups/           Project backup ZIPs (gitignored)
├── docs/              Architecture documentation
├── .github/workflows/ GitHub Actions CI/CD
├── docker-compose.yml
└── .env.example
```

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
