# PerfStudio — System Requirements

All checks below are automatically verified by the built-in **System Requirements** checker
(`Configuration → System Requirements → Run Check`) when the application is running.

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
- **Docker socket** `/var/run/docker.sock` must be readable/writable by the process
  (handled automatically on Windows via Docker Desktop named pipe).

### 2. Docker Compose v2
- **Version:** 2.0 or later (bundled with Docker Desktop)
- **Why:** Used by `docker-start.bat` / `setup.sh` to orchestrate backend + frontend
  containers.
- **Note:** Docker Compose v1 (`docker-compose` binary) also works but v2 (`docker compose`
  plugin) is recommended.

---

## Required — Configuration before deployment

### 3. `.env` file (project root)
Copy `backend/.env.example` to `.env` next to `docker-compose.yml` and fill in:

| Variable | Required | Description |
|---|---|---|
| `JWT_SECRET` | **Yes** | Random secret for JWT tokens. Generate with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `HOST_PROJECTS_ROOT` | **Yes (Docker mode)** | Absolute path to `./projects/` on the HOST machine. Used for Docker `-v` volume mounts when spawning JMeter/K6 containers. See `.env.example` for examples. |
| `HOST_BACKUPS_ROOT` | No | Absolute path to `./backups/` on the HOST machine. Defaults to not set (backups still work in dev mode). |
| `CORS_ORIGIN` | No | Frontend origin. Default: `http://localhost:5173` |
| `JMETER_DOCKER_IMAGE` | No | Default: `justb4/jmeter:latest` |
| `K6_DOCKER_IMAGE` | No | Default: `grafana/k6:latest` |

### 4. File system write permissions
The following directories must be writable by the backend process / container:

| Path | Purpose |
|---|---|
| `projects/` | Test scripts (.jmx, .js), config files, test data (CSV), execution results |
| `backups/` | ZIP backups created when projects are deleted |
| `backend/data/` | SQLite database (`perf_studio.db`) |

---

## Required for dev mode (running without Docker Compose)

### 5. Node.js v18 or later
- **Why:** Backend and frontend dev server (Vite) run directly on Node.js.
- **Install:** https://nodejs.org/

---

## Required at test execution time

### 6. JMeter Docker image — `justb4/jmeter:latest`
- **When pulled:** Once, before first JMeter test run.
- **How:** `Configuration → Docker Engine → Test Tool Images → Pull` or:
  ```
  docker pull justb4/jmeter:latest
  ```
- **Size:** ~500 MB

### 7. K6 Docker image — `grafana/k6:latest`
- **When pulled:** Once, before first K6 test run.
- **How:** `Configuration → Docker Engine → Test Tool Images → Pull` or:
  ```
  docker pull grafana/k6:latest
  ```
- **Size:** ~60 MB

---

## Recommended minimums

| Resource | Minimum | Recommended |
|---|---|---|
| Disk space | 5 GB | 20 GB (Docker images + test results) |
| RAM | 4 GB | 8 GB |
| CPU | 2 cores | 4+ cores |
| Internet | Required for first pull | Can work offline after images cached |

---

## Ports used

| Port | Service | Configurable via |
|---|---|---|
| `3001` | Backend API | `BACKEND_PORT` in `.env` |
| `5173` | Frontend (dev) / Nginx (Docker) | `FRONTEND_PORT` in `.env` |

---

## Network permissions

- **Outbound HTTPS** to `hub.docker.com` — required to pull Docker images.
- **Outbound HTTP/HTTPS** to target system under test — required to run pre-run API calls.
- No inbound firewall rules needed for local use.

---

## Quick-start checklist

```
[ ] Docker Desktop installed and running
[ ] Copied backend/.env.example to .env (project root)
[ ] Set JWT_SECRET in .env
[ ] Set HOST_PROJECTS_ROOT in .env (absolute path to ./projects on host)
[ ] Run: docker-start.bat   (Windows)
         ./setup.sh          (Linux/macOS)
[ ] Open http://localhost:5173
[ ] Go to Configuration → System Requirements → Run Check
[ ] Pull JMeter and K6 images in Configuration → Docker Engine
```
