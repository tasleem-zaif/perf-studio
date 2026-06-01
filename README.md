# 🚀 Performance Studio

**AI-Powered Performance Testing Platform** — Multi-environment load testing with JMeter & K6, AI script generation, auto-healing, and real-time analytics.

[![Docker Pulls](https://img.shields.io/docker/pulls/tasleemzaif/perf-studio-backend)](https://hub.docker.com/r/tasleemzaif/perf-studio-backend)
[![Build](https://github.com/tasleem-zaif/perf-studio/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/tasleem-zaif/perf-studio/actions)

---

## ⚡ Quick Start (Docker)

```bash
# 1. Download config files
curl -O https://raw.githubusercontent.com/tasleem-zaif/perf-studio/main/docker-compose.yml
curl -O https://raw.githubusercontent.com/tasleem-zaif/perf-studio/main/.env.example

# 2. Configure environment
cp .env.example .env
# Edit .env — set HOST_PROJECTS_ROOT and JWT_SECRET

# 3. Launch (pulls images from Docker Hub automatically)
docker compose up -d

# 4. Open in browser
open http://localhost:5173
```

**Default credentials:** `admin@perfstudio.com` / `Admin@123`

---

## ✨ Key Features

| Feature | Description |
|---|---|
| 🤖 **AI Script Generation** | Converts API collections (Postman/Swagger/cURL) to JMX/K6 scripts via GPT-4o or Claude |
| 🔧 **Auto Healer** | Detects test failures, diagnoses root cause with AI, fixes the script, re-runs (up to 3 attempts) |
| 🌍 **Multi-Environment** | QA / Staging / UAT each have isolated test data, configs, scripts, and results |
| 📊 **Real-time Analytics** | 7-section analytics dashboard: Summary, Performance, Transactions, Trends, Resources, Errors, Logs |
| 🐳 **Docker Execution** | JMeter and K6 run in isolated Docker containers — no local install needed |
| 📧 **Email Alerts** | Post-run emails with PDF analytics report and environment-specific results |
| 🔒 **Security** | AES-256-CBC encrypted API keys, JWT auth, non-root Docker containers |

---

## 🏗 Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for full system diagrams including:
- System component graph
- Multi-environment isolation model
- AI script generation flow
- Test execution sequence
- Security model

---

## 🛠 Local Development

**Prerequisites:** Node.js 18+, Docker Desktop

```bash
# Clone
git clone https://github.com/tasleem-zaif/perf-studio.git
cd perf-studio

# Backend
cd backend
npm install
node src/index.js     # runs on :3001

# Frontend (new terminal)
cd frontend
npm install
npm run dev           # runs on :5173
```

---

## 🐳 Docker Images

| Image | Docker Hub |
|---|---|
| Backend | `tasleemzaif/perf-studio-backend:latest` |
| Frontend | `tasleemzaif/perf-studio-frontend:latest` |

```bash
docker pull tasleemzaif/perf-studio-backend:latest
docker pull tasleemzaif/perf-studio-frontend:latest
```

---

## ⚙️ Environment Variables

| Variable | Required | Description |
|---|---|---|
| `JWT_SECRET` | ✅ | Random 32+ char string for token signing |
| `HOST_PROJECTS_ROOT` | ✅ | Absolute path to `./projects/` on host machine |
| `ENCRYPTION_KEY` | ⚠️ Optional | AES key for encrypting API keys in DB |
| `BACKEND_PORT` | Optional | Backend port (default: 3001) |
| `FRONTEND_PORT` | Optional | Frontend port (default: 5173) |
| `JMETER_DOCKER_IMAGE` | Optional | JMeter image (default: justb4/jmeter:latest) |
| `K6_DOCKER_IMAGE` | Optional | K6 image (default: grafana/k6:latest) |

---

## 📁 Project Structure

```
perf-studio/
├── backend/           Node.js Express API
├── frontend/          React + Vite → Nginx
├── projects/          Per-project data (gitignored)
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
3. Tags releases with semantic version (`v1.0`, `v1.1`, etc.)

---

## 🏢 Built by

**Quarks Technosoft PVT. LTD.**

---

## 📄 License

Proprietary — © Quarks Technosoft PVT. LTD. All rights reserved.
