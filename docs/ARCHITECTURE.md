# Peako — Architecture & Flow Diagrams

---

## Table of Contents

1. [System Architecture](#1-system-architecture)
2. [Data Model](#2-data-model)
3. [User Journey](#3-user-journey)
4. [Role-Based Access Model](#4-role-based-access-model)
5. [AI Script Generation Flow](#5-ai-script-generation-flow)
6. [Pre-Run Flow](#6-pre-run-flow)
7. [Test Execution Flow](#7-test-execution-flow)
8. [Auto-Heal Flow](#8-auto-heal-flow)
9. [Git & CI Integration Flow](#9-git--ci-integration-flow)
10. [CI Pipeline Flow](#10-ci-pipeline-flow)
11. [Alert & Email Flow](#11-alert--email-flow)
12. [Multi-Environment Isolation](#12-multi-environment-isolation)
13. [Security Model](#13-security-model)
14. [Technology Stack](#14-technology-stack)
15. [Licensing System](#15-licensing-system)

---

## 1. System Architecture

High-level view of every component and how they relate.

![system-architecture](./images/system-architecture.png)

---

## 2. Data Model

Entity-relationship diagram for the PostgreSQL database (schema in `backend/src/db/schema.sql`, applied by `migrate.js`).

![data-model](./images/data-model.png)

---

## 3. User Journey

End-to-end flow from account creation to a passing test run.

![user-journey](./images/user-journey.png)

---

## 4. Role-Based Access Model

![role-based-access](./images/role-based-access.png)

---

## 5. AI Script Generation Flow

How a test plan becomes an executable JMeter or K6 script.

![ai-script-generation](./images/ai-script-generation.png)

---

## 6. Pre-Run Flow

How live API responses are captured to power correlation and token extraction in generated scripts.

![pre-run-flow](./images/pre-run-flow.png)

---

## 7. Test Execution Flow

How a test run is triggered, streamed, and reported.

![test-execution-flow](./images/test-execution-flow.png)

---

## 8. Auto-Heal Flow

How failed test scripts are automatically diagnosed and fixed by AI.

![auto-heal-flow](./images/auto-heal-flow.png)

---

## 9. Git & CI Integration Flow

How test scripts are versioned, pushed, and merged via Git.

![git-ci-integration](./images/git-ci-integration.png)

---

## 10. CI Pipeline Flow

How a test run is configured, triggered against an **external** CI provider, and tracked.

![ci-pipeline-flow](./images/ci-pipeline-flow.png)

---

## 11. Alert & Email Flow

How test results trigger email notifications with analytics.

![alert-email-flow](./images/alert-email-flow.png)

---

## 12. Multi-Environment Isolation

```
peako-workspaces/
└── <organization>/
    └── <Project Name>/
        ├── admin/                             ← Org Admin workspace (main branch)
        │   └── Workflow YAML File
        │   └── Patch JMX File
        └── <user>/                            ← Regular user workspace (users/name branch)
            └── <Project Name>/
                └── <Collection Name>/
                    ├── QA/
                    │   ├── config/
                    │   ├── results/
                    │   ├── script/
                    │   └── testData/
                    ├── Staging/
                    ├── UAT/
                    └── Production/
```

---

## 13. Security Model

![security-model](./images/security-model.png)

| Concern | Implementation |
|---|---|
| **Authentication** | JWT HS256, 7-day expiry (`auth.js`'s `JWT_EXPIRES`), `auth` middleware on all routes |
| **Session control** | Every JWT carries a `jti`; `user_sessions` enforces one active session per user server-side (logging in elsewhere invalidates the old session unless `force: true`), and sessions expire after 30 minutes of inactivity (`last_used_at`) |
| **Password storage** | bcrypt, 10 rounds |
| **Password reset** | Single-use token, 30-minute expiry |
| **API keys / PATs / SMTP passwords** | AES-256-CBC encrypted at rest in PostgreSQL — never returned via API (masked or presence-flagged instead) |
| **Git push authentication** | PAT injected into HTTPS URL at runtime only, never persisted in `.git/config` |
| **Route authorization** | Role checks per operation; `ownsProject()` for all project-scoped routes |
| **License enforcement** | `auth` middleware checks the caller's org license (`getOrgAccessStatus()`) on every request for non-super-admin users — `403 org_disabled` / `license_expired` blocks access when the org's license is disabled or past `expires_at` |
| **SSRF protection** | Pre-run blocks RFC1918 IPs, loopback, and requires http/https scheme |
| **CORS** | **⚠ Currently permissive, not a strict whitelist.** The code's own comment in `backend/src/index.js` reads "allow all in current setup — restrict in production via CORS_ORIGIN env var"; the callback returns `true` for any origin today. `CORS_ORIGIN` is read but not yet enforced as a hard whitelist — flagged as an open item for the dev team, not a hidden gap |
| **Storage** | **AWS S3 (or S3-compatible) is a mandatory, boot-blocking dependency** — `backend/src/index.js` calls `assertBucketReachable()` at startup and exits the process if S3 isn't configured/reachable. All git workspace data (PAT-mode) and all test-run results live in S3 only |
| **Process isolation** | The documented deployment model runs the app as a plain Node.js process (systemd-managed, non-root recommended) directly on the host — see `docs/DEPLOYMENT.md` |
| **Invite system** | Scoped token per email+org+role; expires 7 days after creation |
| **Rate limiting / security headers** | Not implemented — no rate limiting, no Helmet or equivalent security-headers middleware detected |

---

## 14. Technology Stack

| Layer | Technology |
|---|---|
| **Frontend** | React 18, Vite 5, axios, react-chartjs-2 / chart.js, html2canvas, jsPDF, xlsx |
| **Backend** | Node.js, Express 4, nodemon (dev) |
| **Database** | PostgreSQL via `pg` (`db/index.js` is the entry point every route imports, re-exporting `db/pg.js`'s async wrapper; `schema.sql` applied by `migrate.js`). No SQLite code remains — the migration is fully complete. |
| **AI Generation** | OpenAI GPT-4o (`openai` SDK) · Anthropic Claude — routed through one client (`utils/aiClient.js`); Anthropic is called via an OpenAI-compatible endpoint shape |
| **Test Engines** | Apache JMeter 5.6.3 · Grafana K6 — **run only on external CI runners** (GitHub Actions/GitLab CI/Bitbucket Pipelines), never on the Peako host. Local/native/Docker-spawned execution is retired (every such route returns HTTP 410). The binaries are still bundled in the all-in-one Docker image and `EXECUTION_MODE`/`JMETER_DOCKER_IMAGE`/`K6_DOCKER_IMAGE` still exist as env vars, but none of it is reachable anymore — confirmed dead code |
| **Object Storage** | AWS S3 (or S3-compatible, e.g. MinIO) via `@aws-sdk/client-s3` — **mandatory, boot-blocking.** All git workspace data (PAT-mode) and all test-run results live in S3 only, never on local disk |
| **Git Integration** | `simple-git` (local ops) · `@octokit/rest` (GitHub API) · raw HTTP for GitLab/Bitbucket REST APIs |
| **Email** | `nodemailer` (SMTP transport, TLS) |
| **PDF Reports** | `puppeteer` (HTML → screenshot) · `pdfkit` (page stitching) |
| **Excel / CSV** | `xlsx` (frontend parsing) · custom CSV parser (backend) |
| **Encryption** | `crypto` (Node built-in AES-256-CBC) · `bcryptjs` |
| **File uploads** | `multer` (memory + disk storage) |
| **Backups** | `archiver` (ZIP on project delete) |
| **Process supervision** | systemd (direct deployment — see `docs/DEPLOYMENT.md`) |
| **CI/CD** | GitHub Actions (`workflow_dispatch`) · GitLab CI (`pipeline_trigger`) · Bitbucket Pipelines |
| **Deployment** | Direct (bare-metal/VM) — a Node.js process managed by systemd, against a directly-installed or managed PostgreSQL instance and an S3 (or S3-compatible) bucket — see `docs/DEPLOYMENT.md` |

---

## 15. Licensing System

Every organization has one `org_licenses` row (`plan`, `max_users`, `max_projects` — `NULL` = unlimited, `status` active/disabled, `expires_at`). New orgs lazily get a `trial` row (2 users / 1 project / 7 days) the first time they're accessed if none exists yet.

| Plan | Max Users | Max Projects | Duration |
|---|---|---|---|
| trial | 2 | 1 | 7 days |
| starter | 5 | 3 | 180 days |
| growth | 15 | 10 | 180 days |
| business | 30 | 20 | 180 days |
| enterprise | unlimited | unlimited | 180 days |

- **Enforcement**: `middleware/auth.js` checks `getOrgAccessStatus()` on every authenticated request for non-super-admin users with an org, returning `403 org_disabled`/`license_expired` when invalid. Invite creation/acceptance and project creation additionally check `usersAtLimit`/`projectsAtLimit`.
- **Management**: `routes/licenses.js` (`/api/licenses/*`) exposes plan tiers, the caller's own org's license (`/mine`), and full CRUD for super admins. `routes/orgs.js`'s `POST /` creates an org + its initial license (and optionally sends the first Org Admin invite) in one call.
- **Super Admin UI**: consolidated into a single page, `frontend/src/pages/OrganizationsAdmin.jsx` — stat cards plus an org list/detail view with Overview / Edit Details / License & Limits / Org Admins tabs. Super admins have no Sidebar — this Organizations console is their only destination.
