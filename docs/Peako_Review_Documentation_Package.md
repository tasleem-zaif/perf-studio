# Peako (PerfStudio) — Technical & Security Review Documentation Package

*Converted from [Peako_Review_Documentation_Package.docx](Peako_Review_Documentation_Package.docx) for in-repo readability. The .docx is the canonical formatted version; this file is a plain-text/Markdown mirror of the same content.*

---

# Table of Contents

- [1. Product Documentation](#1-product-documentation)
  - [1.1 Product Overview Document](#11-product-overview-document)
  - [1.2 Feature List](#12-feature-list)
  - [1.3 Product Roadmap](#13-product-roadmap)
  - [1.4 Business Use Cases](#14-business-use-cases)
  - [1.5 Known Limitations](#15-known-limitations)
- [2. Architecture Documentation](#2-architecture-documentation)
  - [2.1 High-Level Architecture Diagram](#21-high-level-architecture-diagram)
  - [2.2 Deployment Architecture Diagram](#22-deployment-architecture-diagram)
  - [2.3 Sequence Diagrams — Requirement → Test Case → Automation → Execution → Reporting](#23-sequence-diagrams-requirement-test-case-automation-execution-reporting)
  - [2.4 Technology Stack Document](#24-technology-stack-document)
  - [2.5 CI/CD Pipeline Documentation](#25-cicd-pipeline-documentation)
- [3. Backend Documentation](#3-backend-documentation)
  - [3.1 API Documentation](#31-api-documentation)
  - [3.2 Database ER Diagram](#32-database-er-diagram)
  - [3.3 Database Schema](#33-database-schema)
- [4. AI Documentation](#4-ai-documentation)
  - [4.1 AI Architecture Document](#41-ai-architecture-document)
  - [4.2 Prompt Design / Prompt Templates](#42-prompt-design-prompt-templates)
  - [4.3 Model Configuration & Supported LLMs](#43-model-configuration-supported-llms)
  - [4.4 Token Usage & Cost Strategy](#44-token-usage-cost-strategy)
  - [4.5 AI Workflow Diagram](#45-ai-workflow-diagram)
  - [4.6 Auto-Healing Design](#46-auto-healing-design)
- [5. Workflow Documentation](#5-workflow-documentation)
  - [5.1 Collection Import](#51-collection-import)
  - [5.2 Pre-run](#52-pre-run)
  - [5.3 Script Generation Design](#53-script-generation-design)
  - [5.4 Correlation Strategy](#54-correlation-strategy)
  - [5.5 Test Execution Workflow](#55-test-execution-workflow)
- [6. Security Documentation](#6-security-documentation)
  - [6.1 Authentication Design](#61-authentication-design)
  - [6.2 Authorization (RBAC) Design](#62-authorization-rbac-design)
  - [6.3 Secret Management Strategy](#63-secret-management-strategy)
  - [6.4 Encryption Strategy](#64-encryption-strategy)
  - [6.5 Audit Logging Design](#65-audit-logging-design)
  - [6.6 Compliance Documentation (SOC 2 / ISO 27001 / GDPR)](#66-compliance-documentation-soc-2-iso-27001-gdpr)
  - [6.7 SSRF Guard (Pre-Run outbound requests)](#67-ssrf-guard-pre-run-outbound-requests)
- [7. Quality Engineering](#7-quality-engineering)
  - [7.1 Code Coverage Report](#71-code-coverage-report)
  - [7.2 Static Code Analysis Report](#72-static-code-analysis-report)
- [8. Environment & Demo Access](#8-environment-demo-access)
  - [8.1 Demo Environment URL](#81-demo-environment-url)
  - [8.2 Test User Credentials](#82-test-user-credentials)

---

# 1\. Product Documentation

## 1.1 Product Overview Document

Product name: "Peako" (frontend/UI branding, e.g. <title>Peako | Quarks</title>) — Built by Quarks Technosoft PVT. LTD. (QTSolv).

Peako is an AI-powered, multi-environment API performance-testing platform. A user imports an API definition (Postman collection, Swagger/OpenAPI spec, cURL command, or raw JSON), the platform fires the endpoints live ("pre-run") to learn authentication tokens and response shapes, an AI model (OpenAI/Claude/Gemini etc) generates a JMeter or K6 load-test script from that data plus user-configured rules and test data, and the script is executed natively, in a spawned Docker container, or via an external CI provider (GitHub Actions / GitLab CI / Bitbucket Pipelines). Results are parsed, evaluated against pass/fail rules, emailed to stakeholders, and rendered as analytics dashboards and PDF reports. Failed runs can be automatically diagnosed and repaired by the built-in Auto-Healer.

### Core Value Proposition

-   AI Script Generation — converts imported API collections directly into runnable JMeter (.jmx) or K6 (.js) load-test scripts.
-   Auto-Healer — diagnoses a failed run’s root cause and attempts an automatic fix + re-run.
-   Multi-environment isolation — QA / Staging / UAT / Production each have independently-scoped test data, configuration, scripts, and results, enforced at the database layer (collection_id + env).
-   Real-time analytics — response time, throughput, error rate, and P90/P95 percentile dashboards, live during a run and post-run.
-   Git-native workflow — every project is a Git repository with a branch-per-user model, PR review, and GitHub/GitLab/Bitbucket sync.
-   CI/CD integration — both an internal sequential pipeline runner and external CI (GitHub Actions, GitLab CI, Bitbucket Pipelines), including CI-context auto-heal.
-   Org-based licensing — per-organization plan tiers with user/project limits and expiry, managed by a Super Admin console.

## 1.2 Feature List

| **Category** | **Features** |
| --- | --- |
| Organizations & Teams | Org creation, license-tier assignment, org-admin invitation, role-based access (Super Admin / Org Admin / User), per-project user assignment. |
| Projects & Collections | Project CRUD; import API collections from Postman v2.1, Swagger/OpenAPI, cURL, or raw JSON; environment-scoped configuration; multiple collections per project. |
| Pre-Run (Live Validation) | Fires every collection endpoint live (SSRF-guarded, chunked concurrency), extracts auth tokens/cookies, resolves {{var}} templates, flags missing variables, supports AI-assisted per-endpoint "Fix with AI". |
| Test Data Management | CSV upload per collection/environment, in-app CSV viewer/editor, open-in-external-app, auto-copy across environments. |
| Performance Rules | Threshold rules on response time, error rate, throughput, P90/P95 with operators (>, >=, <, <=, ==, between) and severity (error/warn). |
| Test Suite / Script Generation | Named test plans; deterministic JMeter (.jmx) generation; AI-driven K6 (.js) generation; CSV/token correlation. |
| Execution — Native | Runs JMeter/K6 binaries directly on the host, streams logs live, patches runtime parameters (VUsers/ramp-up/duration/loops). |
| Execution — Docker | Spawns containerized JMeter/K6 (EXECUTION_MODE=docker), with dependency/Docker-daemon checks. |
| Auto-Healer | Tiered repair strategy (deterministic mechanical fix → endpoint-override patch → diff patch → full rewrite), 1 automatic attempt plus a user-guided "Heal Again". |
| Internal Pipelines | Sequential multi-suite execution with SSE-streamed progress and stop-on-failure. |
| External CI/CD | GitHub Actions / GitLab CI / Bitbucket Pipelines: YAML generation, trigger, status polling, CI-context auto-heal with fixed-script re-push. |
| Git Integration | Per-project repo, branch-per-user (admin → main, user → users/<name>), commit/push/pull, PR create/merge/close, identity config. |
| Analytics & Dashboards | Live and post-run dashboards: response time, throughput, error rate, P90/P95, per-API breakdown, trend/transaction views. |
| PDF Reporting | 6-page auto-generated report (Summary, Dashboard, Transactions, Trend, Resource Utilization, Errors) via Puppeteer + pdfkit. |
| Email Alerts | Post-run summary, mid-run rule-breach alert, violation summary; per-user/org/project SMTP + recipient configuration. |
| Licensing & Entitlements | Plan tiers (trial/starter/growth/business/enterprise) with user/project caps, expiry, and enable/disable — enforced at the auth-middleware layer. |
| Admin Consoles | Super Admin: organizations, licenses, org-admin invites. Org Admin: projects, users, AI/Git/SMTP config, PR merges. |
| Authentication | Email/password, JWT sessions, single-active-session enforcement, forgot/reset password, invite-based onboarding. |
| Security Controls | AES-256-CBC encrypted secrets at rest, bcrypt password hashing, role-based route guards, SSRF-guarded outbound requests. |

## 1.3 Product Roadmap

Peako/PerfStudio has moved well beyond an MVP — the platform has shipped a full AI-driven testing lifecycle, multi-provider CI/CD, and an org-level licensing system. The items below reflect what has actually been delivered, followed by what's actively in progress and what's next.

**Delivered — Core Testing Platform**

-   End-to-end workflow: API import (Postman/Swagger/cURL/JSON) → live Pre-Run validation → rules & environment configuration → AI script generation → execution → analytics → reporting, fully implemented and in use.
-   Multi-environment isolation (QA/Staging/UAT/Production) with strict per-collection, per-environment data scoping — no cross-environment leakage by design.
-   Pre-Run engine: live endpoint firing with bounded concurrency, automatic auth-token and cookie extraction, iterative {{var}} template resolution, 401 auto-retry, and SSRF-guarded outbound requests.
-   Deterministic JMeter script generation, including multi-host support for collections spanning several API families (e.g. distinct subdomains resolved independently per endpoint) — removed the earlier one-host-per-collection limitation.
-   AI-driven K6 script generation via OpenAI GPT-4o or Anthropic Claude, with per-purpose model selection (separate models for generation vs. healing).
-   Correlation handling: automatic token/session extraction from login responses and propagation into subsequent requests, plus CSV test-data parameterization.
-   Real-time and post-run analytics dashboards (response time, throughput, error rate, P90/P95, per-API breakdown) and 6-page auto-generated PDF reporting.

### Delivered — Auto-Healing

-   Tiered auto-heal strategy shipped end-to-end: deterministic mechanical fixes (zero AI cost) → endpoint-scoped AI patch → surgical diff-patch → full-script rewrite, each tier bounding AI cost to the size of the actual change rather than the whole script.
-   Auto-heal now verified working in both local and CI execution contexts, including a critical fix to async handling that had silently prevented diagnosis from ever running correctly.
-   Token-budget pre-flight checks prevent wasted AI calls on scripts too large for a provider's output ceiling.

### Delivered — CI/CD & Git Integration

-   External CI/CD integration for GitHub Actions, GitLab CI, and Bitbucket Pipelines: YAML generation, triggering, status sync, and CI-context auto-heal with automatic push of the fixed script back to the repository.
-   Pipeline-level result validation (fails the CI job immediately on zero requests or 100% error rate) so provider status reflects real outcomes without waiting on a delayed sync.
-   Git-native project workflow: branch-per-user model (org/admin → main, users → users/<name>), PR creation/review/merge, and a security hardening pass that removed plaintext credential persistence from .git/config.
-   Internal sequential pipeline runner for multi-suite test execution as a lighter-weight alternative to external CI.

### Delivered — Platform, Licensing & Security

-   Org-level licensing system: plan tiers (trial/starter/growth/business/enterprise) with user/project limits, expiry, and status enforcement at the authentication layer.
-   Redesigned Super Admin console consolidating organization, license, and admin management into a single workspace.
-   Security hardening pass: AES-256-CBC encryption for stored secrets (AI keys, SMTP passwords, Git tokens), single-active-session enforcement, and closure of a data-leakage bug where a deleted collection's config could leak into a new one via ID reuse.

### Near-term / in-progress

-   Another tool Peako Recorder to record network traffic and covert to postman collection (.json).
-   Custom helper for correlation in APIs. Currently there is no feature to provide directions to get, extract, apply correlations for APIs which are not covered automatically.
-   CI status polling for runs already in progress when the CI Pipeline tab loads (currently only freshly-triggered runs auto-poll; older runs need a manual refresh).
-   Job-log fetching for GitHub Actions / GitLab CI auto-heal diagnosis (only Bitbucket currently exposes pipeline logs to the heal routine).

### Candidate future investments (not yet scheduled)

-   Automated test suite and CI quality gates (see Section 7 — none currently exist).
-   Self-service data export/deletion endpoints for GDPR data-subject requests (see Section 6.6).
-   Comprehensive audit logging of administrative and data-mutating actions (see Section 6.5).
-   Multi-factor authentication.
-   Secondary database indexes on high-traffic foreign keys (projects.user_id, collections.project_id, test_suites.project_id, etc.).

## 1.4 Business Use Cases

### Primary use case — enterprise API performance testing at scale

-   1\. An org admin imports a multi-endpoint API collection (Postman export) into a project.
-   2\. The team runs Pre-Run to validate connectivity, capture real response shapes, and extract auth tokens.
-   3\. QA engineers upload CSV test data representing realistic load mixes / user scenarios.
-   4\. The org admin defines SLA rules (e.g. average response time < 200ms, P95 < 500ms, error rate < 1%).
-   5\. A test plan is created and a JMeter or K6 script is generated targeting the QA/Staging/UAT environment independently of the others.
-   6\. The script runs via the Git-integrated CI pipeline (GitHub Actions / GitLab CI / Bitbucket Pipelines) or natively/in Docker.
-   7\. On failure, the Auto-Healer diagnoses and attempts a fix (bad template variables, disabled elements, correlation issues) and re-runs.
-   8\. Real-time dashboards show per-API response time, throughput, and error breakdown; a PDF report is emailed to stakeholders with pass/fail rule evaluations.
-   9\. Results and generated scripts are committed to Git for audit/version history.

![](images/user-journey.png)

_User journey: account/org setup through first successful test run._

## 1.5 Known Limitations

All items below are evidenced directly in code, schema, or committed documentation — none are speculative.

| **Limitation** | **Detail** |
| --- | --- |
| No automated test suite | Zero unit/integration tests exist in backend/src or frontend/src; no test runner (Jest/Vitest/Mocha) is installed. See Section 7.1. |
| No linting / static analysis | No ESLint/Prettier configuration and no SonarQube (or equivalent) integration anywhere in the repo or CI. See Section 7.2. |
| Schema not auto-applied | schema.sql is never run automatically — a fresh Postgres volume requires a manual node backend/src/db/migrate.js before the app can serve real requests. |
| No secondary indexes on most foreign keys | Only one explicit index exists beyond primary/unique keys (a unique index on execution_runs.ci_run_id). High-traffic FK columns such as projects.user_id and test_suites.project_id are unindexed. |
| AI generation cost/latency is unmetered | Every K6 script generation and every auto-heal attempt is a live LLM call with no token counting, cost tracking, caching, or per-org rate limiting. |
| Large-script auto-heal can still exhaust the model’s output ceiling | Full-script rewrites are capped by the provider’s hard output-token limit (for example 16,384 GPT-4o / 8,192 Claude); a pre-flight guard now returns an honest "too large" result instead of a wasted call, but very large scripts may still get no automatic fix. |
| No user-facing data export/deletion (GDPR) | No endpoint allows a user to export or delete their own personal data; removal only happens when an admin deletes the user or project outright. |
| No comprehensive audit trail | Administrative and data-mutating actions (org/user/project changes) are not centrally logged with actor/timestamp; only session, invite, assignment, git-commit, and heal-attempt tables carry partial history. |
| Password policy is minimal | Minimum password length is 6–8 characters depending on the flow, with no complexity or history requirements — below typical enterprise policy (12+ characters). |
| No MFA | Authentication is single-factor (email + password) only. |

# 2\. Architecture Documentation

## 2.1 High-Level Architecture Diagram

Browser (React SPA) communicates over axios/JWT with the Express API, which is the single integration point for PostgreSQL, the filesystem-based Git workspaces, the AI providers, the JMeter/K6 execution layer, the configured Git provider, and SMTP.

![](images/system-architecture.png)

_System architecture: request handler and its dependencies (docs/images/system-architecture.mmd)._

Browser (React SPA) --axios/JWT--> Express API (backend/src/index.js, ~23 route modules)

|-- PostgreSQL: users, projects, collections, rules, test_suites, execution_runs, git_*, ci_*, ...

|-- Filesystem workspaces: git-workspaces/<Project>/<admin|user-N>/<Collection>/<Env>/{config,testData,script,results}

|-- AI provider (OpenAI / Anthropic): script generation + auto-heal diagnosis

|-- JMeter / K6 binaries (native) or Docker containers: test execution

|-- Git provider (GitHub / GitLab / Bitbucket): script versioning, PRs, CI triggers

|-- SMTP: alert emails, invites, password reset

### Multi-environment / multi-tenant isolation

-   Every project has one workspace folder per environment (QA / Staging / UAT / Production) and one per actor: an admin/ workspace (org admin, pushes to main) and one user-<id>/ workspace per regular user (pushes to users/<name>, merges via PR).
-   Config, test data, scripts, and results are always scoped by collection_id + env at the database layer, so switching environment in the UI cannot leak another environment’s data.

## 2.2 Deployment Architecture Diagram

Recommended deployment is Docker Compose with two services: an all-in-one PerfStudio application container and a PostgreSQL container.

| **Service** | **Image** | **Ports** | **Volumes** | **Depends on** | **Healthcheck** |
| --- | --- | --- | --- | --- | --- |
| postgres | postgres:16-alpine | 5432 (internal) | pg_data → /var/lib/postgresql/data | — | pg_isready -U postgres |
| PerfStudio | tasleemzaif/PerfStudio:latest (or build ./Dockerfile) | 3001 | PerfStudio_projects → /app/projects, PerfStudio_git → /app/git-workspaces, PerfStudio_backups → /app/backups | postgres: service_healthy | curl -f http://localhost:3001/api/health |

### Application image composition (root Dockerfile, multi-stage)

-   Stage 1 (builder): node:22-slim builds the React/Vite frontend to static assets.
-   Stage 2 (runtime): ubuntu:22.04 with Java 17 OpenJDK, Apache JMeter 5.6.3 (+ jpgc-casutg plugin), Grafana K6, Node.js 22, and Git; serves the built frontend as static files from the backend and runs node backend/src/index.js as a non-root user.
-   Separate, lighter backend/Dockerfile (Node 18-alpine) and frontend/Dockerfile (nginx-served) are also published to Docker Hub by CI, but are not what docker-compose.yml runs by default.

### Execution modes

| **Mode** | **JMeter / K6 location** | **When used** |
| --- | --- | --- |
| native (default) | Bundled inside the application image | Single-container deployment; simplest networking; used by docker-compose.yml |
| docker | Spawned containers (justb4/jmeter, grafana/k6) via the Docker socket | When backend needs isolated, disposable execution environments |

### Key environment variables

| **Variable** | **Required** | **Purpose** |
| --- | --- | --- |
| JWT_SECRET | Yes | JWT signing secret |
| ENCRYPTION_KEY | Recommended | AES-256-CBC key for encrypting stored API keys / SMTP passwords / Git tokens |
| DATABASE_URL | Yes | PostgreSQL connection string — the only DB config read; no SQLite fallback |
| FRONTEND_URL / CORS_ORIGIN | Yes | Invite/reset-password email links; allowed API origin |
| HOST_PROJECTS_ROOT / HOST_BACKUPS_ROOT | Yes (Docker) | Host paths for volume mounts |
| EXECUTION_MODE | Optional | "native" (bundled binaries) vs "docker" (spawn containers) |
| SMTP_* (HOST, PORT, USER, PASS, FROM) | Optional | Fallback SMTP if not configured per-user in-app |

_Note: The application’s own CI/CD pipeline is documented separately from the customer-facing CI/CD feature — see Section 2.5._

## 2.3 Sequence Diagrams — Requirement → Test Case → Automation → Execution → Reporting

The platform implements this lifecycle as one continuous, linear workflow (documented end-to-end in docs/USER_WORKFLOW.md):

| **Stage** | **Implementing files** | **What happens** |
| --- | --- | --- |
| 1\. Requirement (Collection Import) | routes/collections.js, utils/parseCollection.js | A Postman/Swagger/cURL/JSON API definition is imported and normalized into a flat endpoint list; this is the functional "requirement" the rest of the pipeline tests against. |
| 2\. Test Case Preparation (Pre-Run + Rules + Env Config) | routes/ai.js POST /pre-run, utils/preRunEngine.js, routes/rules.js, routes/envConfig.js | Endpoints are fired live to learn real auth tokens/response shapes; SLA rules and per-environment target URLs/variables are configured. |
| 3\. Automation (Script Generation) | routes/testSuites.js POST /:id/generate | A JMeter (.jmx, deterministic) or K6 (.js, AI-generated) script is produced from the endpoints, rules, test data, and pre-run results. |
| 4\. Execution | routes/execution.js, utils/testRunner.js, routes/pipelines.js, routes/ciPipeline.js | The script runs natively, in a spawned Docker container, as part of an internal sequential pipeline, or via external CI (GitHub Actions / GitLab CI / Bitbucket Pipelines). |
| 5\. Reporting | utils/ruleEvaluator.js, utils/generateAnalyticsPdf.js, utils/emailUtils.js | Results are parsed from the JTL/K6 summary, evaluated against rules, rendered as live/post-run dashboards, exported as a 6-page PDF, and emailed to configured recipients. |

![](images/pre-run-flow.png)

_Pre-run sequence: bulk fire, token/cookie extraction, 401 retry, AI-assisted per-endpoint heal._

![](images/ai-script-generation.png)

_Script generation sequence: deterministic JMeter build vs AI-driven K6 generation._

![](images/test-execution-flow.png)

_Test execution sequence: trigger → spawn JMeter/K6 → stream logs → parse JTL → evaluate rules → report._

## 2.4 Technology Stack Document

### Frontend

| **Component** | **Technology / Version** |
| --- | --- |
| Framework | React 18.2.0 |
| Build tool / dev server | Vite 5.1.4 (port 5173) |
| HTTP client | axios 1.6.7 (JWT bearer interceptor) |
| Charting | Chart.js 4.5.1 + react-chartjs-2 5.3.1 |
| PDF / screenshot (client-assisted) | html2canvas 1.4.1, jsPDF |
| Spreadsheet parsing | xlsx 0.18.5 |
| Icons | @tabler/icons-webfont 3.44.0 |
| State management | React hooks only (useState in App.jsx, prop-drilled) — no Redux/Zustand |
| Routing | Manual page-state + popstate listener — no react-router |

### Backend

| **Component** | **Technology / Version** |
| --- | --- |
| Runtime | Node.js 22 |
| Framework | Express 4.18.2 (port 3001) |
| Dev tooling | nodemon 3.1.0 (dev only) |
| Database | PostgreSQL 16, via pg 8.x (db/index.js entry point, db/pg.js compatibility shim, schema.sql applied by migrate.js) |
| Auth | jsonwebtoken 9.0.2 (HS256), bcryptjs 2.4.3 (10 rounds) |
| Encryption | Node.js built-in crypto — AES-256-CBC for secrets at rest |
| File uploads | multer |
| Backups | archiver (ZIP on project delete) |

### AI, execution engines, integrations

| **Component** | **Technology / Version** |
| --- | --- |
| AI providers | OpenAI /Claude/Gemini/Azure OpenAI |
| Load-test engines | Apache JMeter 5.6.3 (+ jpgc-casutg plugin), Grafana K6 (native binaries or justb4/jmeter, grafana/k6 containers) |
| Git integration | simple-git (local ops), @octokit/rest (GitHub), raw REST calls (GitLab, Bitbucket) |
| Email | nodemailer (any SMTP provider) |
| PDF generation | Puppeteer (HTML → screenshot) + pdfkit (page stitching) |
| Containerization | Docker, Docker Compose |

## 2.5 CI/CD Pipeline Documentation

There are two distinct, unrelated CI/CD systems in this product — they must not be confused.

### A. PerfStudio’s own build/release CI/CD (self-hosting)

-   File: .github/workflows/docker-publish.yml.
-   Triggers: push to main, tag v*, and pull requests (PRs build but never push).
-   Steps: checkout → Docker Buildx setup → Docker Hub login (non-PR only) → metadata extraction (branch/semver/latest tags) → build & push backend image → build & push frontend image → job summary.
-   No test or lint gate exists in this pipeline (see Section 7).

### B. Customer-facing CI/CD feature (external CI for generated test scripts)

-   Files: routes/pipelines.js (internal sequential pipelines — not external CI) and routes/ciPipeline.js (external GitHub Actions / GitLab CI / Bitbucket Pipelines integration).
-   User configures a provider’s auth (PAT / trigger token / app password), which is encrypted at rest.
-   PerfStudio generates provider-specific YAML (.github/workflows/perf-test.yml, .gitlab-ci.yml, or bitbucket-pipelines.yml) embedding the script path, engine install steps, and a JTL validation step that fails the job immediately on 0 requests or a 100% error rate.
-   The YAML is committed/pushed to the project’s Git repository (auto-push option available, with a verified-branch check to prevent landing on the wrong branch).
-   PerfStudio triggers the pipeline (workflow_dispatch for GitHub, pipeline trigger API for GitLab, trigger API for Bitbucket) and polls status.
-   On completion, PerfStudio downloads artifacts, evaluates rules, and — if auto_heal is enabled — diagnoses and repairs the script, pushes the fix back to the repository, and re-triggers the pipeline (maximum 1 automatic attempt; a "Heal Again" action allows a user-guided retry).

![](images/ci-pipeline-flow.png)

_External CI/CD sequence: YAML generation → trigger → provider execution → results sync → optional auto-heal._

![](images/git-ci-integration.png)

_Git + CI integration: branch-per-user model, PR flow, and external CI trigger._

# 3\. Backend Documentation

## 3.1 API Documentation

No machine-readable OpenAPI/Swagger spec is generated by the codebase; the tables below are a hand-compiled equivalent covering all ~25 route modules mounted under /api in backend/src/index.js. Nearly every router applies the auth middleware (JWT validation + license/session check); exceptions are noted. Project-scoped routers additionally call ownsProject(userId, projectId) and return 404 (never 403) on denial, to avoid leaking existence.

### Auth & Account (auth.js, passwordReset.js) — /api/auth

| **Method & Path** | **Auth** | **Purpose** |
| --- | --- | --- |
| POST /register | Public | Role-based signup; creates org if needed; status stays "pending" until admin approval. |
| POST /login | Public | Validates credentials; blocks pending/rejected users; enforces single active session unless force:true. |
| POST /logout | Public (token in body/header) | Invalidates the session for the token’s user. |
| POST /heartbeat | JWT | Keep-alive / session validity check; also used for takeover detection. |
| GET /me, PUT /me | JWT | Fetch/update profile (name, email). |
| PUT /me/password | JWT | Change password (current password required). |
| GET /me/registry-token | JWT | Returns the org’s npm registry token for the Artifact Keeper integration. |
| POST /forgot-password | Public | Issues a 30-minute reset token by email; never reveals whether the email exists. |
| POST /reset-password | Public | Consumes a valid, unused, unexpired token to set a new password. |
| POST /admin/users/:id/reset-password | JWT + admin | Admin-forced password reset; org admin limited to own-org users. |

### Admin & Organizations (admin.js, orgs.js, licenses.js)

| **Method & Path** | **Auth** | **Purpose** |
| --- | --- | --- |
| GET /api/admin/users | admin | List users (super admin: all non-super; org admin: own org). |
| PUT /api/admin/users/:id/status | admin | Approve/reject a pending registration. |
| DELETE /api/admin/users/:id | admin | Cascading delete of a user’s invites, alerts, assignments, and git-commit references. |
| GET /api/orgs | Public | Organization list for signup/invite forms. |
| GET /api/orgs/managed | super_admin | All orgs with member/project counts and license metadata. |
| POST /api/orgs | super_admin | Create org, optionally invite its first org admin, provision a licence + npm registry token. |
| PUT /api/orgs/:id, DELETE /api/orgs/:id | super_admin | Update metadata; delete only if the org has no active members. |
| GET /:id/admins, GET/POST/DELETE /:id/npm-token | super_admin | Org-admin listing; Artifact Keeper registry token lifecycle (never returns the raw token after creation). |
| GET /api/licenses/plans, /mine | org_admin / super_admin | Plan-tier catalogue; the caller’s org’s live usage vs. limits. |
| GET/PUT /api/licenses/:orgId, PUT /:orgId/status | super_admin | Assign/upgrade a plan; enable/disable an org. |

### Projects, Collections, Config (projects.js, collections.js, projectConfig.js, envConfig.js, config.js)

| **Method & Path** | **Auth** | **Purpose** |
| --- | --- | --- |
| GET/POST/PUT/DELETE /api/projects | JWT (create/edit restricted to non-user roles) | Project CRUD; delete triggers async Git cleanup + ZIP backup + cascading deletes. |
| GET /api/projects/backups, /backups/:filename | org_admin / super_admin | List/download ZIP backups of deleted projects (path-traversal guarded). |
| GET/POST/PUT/DELETE /api/projects/:id/collections | JWT + ownsProject | Import (multipart: source file + optional Postman environment file), parse, update, delete a collection; auto-populates env config. |
| POST /collections/parse-curl | JWT | Parses a raw cURL string into an endpoint object. |
| GET/PUT /api/projects/:id/config | JWT + ownsProject | Project-wide reference configuration (display-only defaults). |
| GET/PUT /api/projects/:id/collections/:cid/env-config/:env | JWT + ownsProject | Per-collection-per-environment URLs/variables — strict isolation, unique on (collection_id, env). |
| GET/PUT /api/config | JWT | User-level global URL/port defaults. |

### Rules, Scripts, Test Suites, Test Data (rules.js, scripts.js, testSuites.js, testData.js)

| **Method & Path** | **Auth** | **Purpose** |
| --- | --- | --- |
| CRUD /api/projects/:id/rules | JWT + ownsProject | Performance thresholds (metric, operator, value(s), severity); writes trigger an async config.json refresh. |
| CRUD /api/projects/:id/scripts | JWT + ownsProject | Legacy script metadata templates. |
| CRUD /api/projects/:id/test-suites | JWT + ownsProject | Test-plan definitions (engine, VUsers, ramp-up, duration/loops, linked collection/environment). |
| POST /test-suites/:id/generate | JWT + ownsProject | Generates the JMeter/K6 script; blocked until pre-run is fresh; blocks generation from the admin workspace directly. |
| GET /test-suites/:id/download/:type | JWT + ownsProject | Downloads the generated .jmx or .js file. |
| GET/POST/PUT/DELETE /api/projects/:id/test-data | JWT + ownsProject (+ multer upload) | CSV/XLSX test-data management, scoped per collection/environment; flags stale files missing from disk. |
| GET/PUT /test-data/:id/content | JWT + ownsProject | Paginated CSV read/write. |
| POST /test-data/:id/open-external | JWT + ownsProject | Opens the file with the OS default application. |

### AI, Settings, Execution, Alerts (ai.js, settings.js, runner.js, execution.js, alerts.js)

| **Method & Path** | **Auth** | **Purpose** |
| --- | --- | --- |
| POST /api/ai/pre-run | JWT + ownsProject | Fires all endpoints live (SSRF-guarded, chunked), extracts auth tokens/cookies, retries 401s. |
| POST /api/ai/pre-run/heal | JWT + ownsProject | AI-diagnosed single-endpoint fix (header/body/URL override), verified by re-firing. |
| GET/PUT /api/settings/ai | JWT | AI provider/model selection; API key is write-only (never returned raw — only an api_key_set flag). |
| POST /api/runner/execute | JWT | Mock/simulated run for UI development — not real execution. |
| /api/execution/* (check-deps, check-docker, run, PDF export, etc.) | JWT | Real execution: dependency checks, Docker management, run lifecycle, live SSE log/metric streaming, PDF export. |
| GET/PUT /api/alerts/config, POST /test-smtp, /send-test | JWT | SMTP configuration and connectivity testing. |
| CRUD /api/alerts/recipients, /projects/:id/recipients | JWT | Global and per-project alert recipient lists. |

### Invites, Git, Pipelines, External CI (invites.js, git.js, pipelines.js, ciPipeline.js)

| **Method & Path** | **Auth** | **Purpose** |
| --- | --- | --- |
| POST /api/invites | admin | Creates a 72-hour invite; enforces org license/user-count limits. |
| GET /invites/validate/:token, POST /invites/accept/:token | Public | Invite validation and self-service acceptance (sets password, activates account, re-checks license at acceptance time). |
| GET/PUT /api/projects/:id/git/config, POST /init | JWT + ownsProject (config write: org_admin) | Remote/auth configuration and repository initialization. |
| GET /status, POST /commit, /push, /pull; GET /branches, /log; CRUD /prs | JWT + ownsProject | Standard Git operations plus PR create/merge (merge restricted to org_admin)/close. |
| CRUD /api/projects/:id/pipelines, POST /:id/run | JWT + ownsProject | Internal sequential multi-suite pipelines, SSE-streamed, with stop-on-failure. |
| GET/PUT /api/projects/:id/ci/config, POST /config/test, /generate-yaml, /trigger | JWT + ownsProject (YAML gen: org_admin) | External CI provider configuration, connectivity test, YAML generation/commit, and run triggering. |
| GET /ci/runs, /runs/:runId/status | JWT + ownsProject | CI run history and live status polling with results sync. |

_Note: runner.js (mock) vs. execution.js (real), and pipelines.js (internal sequencing) vs. ciPipeline.js (external CI) are deliberately separate subsystems that are easy to confuse by name._

## 3.2 Database ER Diagram

![](images/data-model.png)

_Entity-relationship model across 31 tables, grouped by domain._

Logical domains: (1) Authentication & Authorization — organizations, users, user_sessions, password_resets, invites, project_assignments, org_licenses; (2) Projects & Collections — projects, collections, collection_env_config, global_config, project_config; (3) Test Configuration & Rules — rules, scripts, test_data_files, test_suites, ai_settings; (4) Test Execution — execution_runs, auto_heal_logs; (5) Git Integration — git_configs, user_git_configs, git_commits, git_prs; (6) CI/CD — pipeline_configs, pipeline_runs, ci_pipeline_configs, ci_pipeline_runs, ci_auto_heal_logs; (7) Alerts — alert_configs, alert_recipients.

## 3.3 Database Schema

Schema: backend/src/db/schema.sql, applied by migrate.js as idempotent CREATE TABLE IF NOT EXISTS statements (not a data migrator — there was no prior production data). db/index.js seeds a super_admin user (admin@perfstudio.com) on first boot if none exists.

### Core tables

| **Table** | **Key columns** | **Notable FKs** |
| --- | --- | --- |
| organizations | id, name (unique), slug (unique), description, website, industry, registry_token_enc/key/prefix/expires_at | — |
| org_licenses | id, org_id (unique), plan, max_users, max_projects (NULL = unlimited), status, expires_at | org_id → organizations, ON DELETE CASCADE |
| users | id, email (unique), name, password_hash, org_id, role, status | org_id → organizations (no cascade specified) |
| user_sessions | id, user_id, jti (unique), expires_at, last_used_at | user_id → users, CASCADE; UNIQUE(jti) |
| projects | id, user_id, name, description, color, folder_path, environment, uuid | user_id → users, CASCADE |
| collections | id, project_id, name, json_content, source_type, tool_target, generated_jmx/k6, pre_run_data, pre_run_collection_hash | project_id → projects, CASCADE |
| collection_env_config | id, collection_id, env, config_json | UNIQUE(collection_id, env); no FK on collection_id (see Section 1.5 known-limitation history) |
| rules | id, project_id, metric, operator, value, value_min, value_max, unit, severity | project_id → projects, CASCADE |
| test_suites | id, project_id, collection_id, test_data_id, engine, config_json, jmx_path/js_path, vusers, rampup, duration, env | collection_id → collections SET NULL; test_data_id → test_data_files SET NULL |
| execution_runs | id, project_id, suite_id, status, result_dir, report_data, ci_run_id, heal_status | suite_id → test_suites SET NULL; UNIQUE INDEX on ci_run_id WHERE NOT NULL |
| auto_heal_logs / ci_auto_heal_logs | id, run_id / ci_run_id, attempt, diagnosis, fix_applied, fix_type, result | No FK constraint on run_id / ci_run_id |

### Supporting tables

| **Table** | **Purpose** |
| --- | --- |
| global_config / project_config / ai_settings | Per-user global config, per-project reference config, and per-user AI provider settings (encrypted API key). |
| test_data_files | CSV/XLSX metadata (filename, columns, collection_id, env). |
| git_configs / user_git_configs / git_commits / git_prs | Project-level and per-user Git remote/auth configuration, commit and PR history. |
| pipeline_configs / pipeline_runs | Internal sequential pipeline definitions and run history. |
| ci_pipeline_configs / ci_pipeline_runs | External CI provider configuration (unique per project+user) and run history. |
| alert_configs / alert_recipients | Per-user SMTP settings and global/per-project recipient lists. |
| password_resets / invites / project_assignments | Reset tokens, org invitations, and many-to-many user↔project assignment. |

### Constraints, indexing, and data-type observations

-   One explicit secondary index exists: a unique partial index on execution_runs(ci_run_id) WHERE ci_run_id IS NOT NULL, added specifically to prevent a race condition producing duplicate rows during concurrent CI status polling.
-   No other secondary indexes exist on foreign-key columns (e.g. projects.user_id, collections.project_id, test_suites.project_id) — a performance consideration at higher data volumes.
-   JSON-shaped data (config_json, json_content, environments, logs, variables) is stored as TEXT rather than PostgreSQL JSONB, forgoing native JSON indexing/query operators.
-   Boolean flags are stored as INTEGER (0/1), a holdover from the pre-migration SQLite schema.
-   A handful of FKs have no ON DELETE clause (implicit NO ACTION) — e.g. git_prs.created_by, invites.invited_by — and auto_heal_logs.run_id / ci_auto_heal_logs.ci_run_id have no FK constraint at all.
-   collection_env_config and test_data_files store collection_id as a plain integer with no foreign key — a documented, since-fixed data-leakage risk when a collection ID was reused after deletion (see Section 5.1 for the historical bug and fix).

# 4\. AI Documentation

## 4.1 AI Architecture Document

AI calls are centralized behind a single function, callAi(userId, systemPrompt, userPrompt, purpose), in backend/src/utils/aiClient.js. The purpose argument ('script' or 'heal') selects which of two independently configurable models is used, so an organization can, for example, use a cheaper/faster model for script generation and a stronger model for auto-heal diagnosis.

| **Provider** | **Client shape** | **Endpoint** |
| --- | --- | --- |
| OpenAI | Standard OpenAI SDK client | api.openai.com |
| Anthropic (Claude) | Called through an OpenAI-compatible endpoint shape (same system/user message format) | api.anthropic.com/v1 with header anthropic-version: 2023-06-01 |

-   Provider and model are selected per organization via the ai_settings table (settings.js GET/PUT /api/settings/ai).
-   The API key is AES-256-CBC encrypted at save time and decrypted only at the moment of the AI call; the frontend only ever receives an api_key_set boolean, never the key.
-   Temperature is fixed at 0.2 for both providers and both purposes, favoring deterministic, reproducible output over creativity.
-   max_tokens is set explicitly per call to the provider’s real output ceiling (16,384 for GPT-4o, 8,192 for Claude by default) — this was a historical bug fix, since omitting it caused silent truncation on large responses.
-   A response’s finish_reason is checked; finish_reason === "length" is surfaced as an explicit "response was cut off" error rather than being passed to JSON.parse and failing cryptically.

## 4.2 Prompt Design / Prompt Templates

### K6 script generation (the only AI-driven script generation path — JMeter generation is fully deterministic, see Section 5.3)

System: "You are an expert k6 v0.50 JavaScript performance test script generator.

Output ONLY raw valid JavaScript. No markdown fences, no explanation."

-   User prompt assembles: test type (load/stress/spike/endurance), runtime parameters as __ENV constants (THREADS, RAMP_UP, DURATION, PROTOCOL, URL, PORT), the k6 executor/thresholds derived from the project’s rules, the full endpoint collection as structured JSON (capped at 4,000 characters), CSV test-data guidance (SharedArray + column-name matching), a correlation section built from the first 2,000 characters of pre-run response data, and any previously AI-verified endpoint overrides.
-   Prompt-injection mitigation: endpoint and variable data is JSON-stringified rather than interpolated as executable code; pre-run data and prior fixes are length-capped; nothing free-form from an end user is placed directly into the instruction text.

### Auto-heal — full-script rewrite (last-resort tier)

System: "You are an expert {JMeter|k6} performance test auto-healer... ABSOLUTE RULES: (1) for ZERO_SAMPLES regenerate from scratch, otherwise the fixed script MUST retain every original sampler; (2) only modify elements responsible for the failure, preserve passing requests byte-for-byte; (3) maintain original sampler order; (4) place new extractors as post-processors on the correct response; (5) fix the root cause, never mask it; (6) output ONLY one JSON object."

Required JSON shape: {"issue", "fix", "fix_type": "script_rewrite"|"no_fix", "fixed_script"}. The user prompt supplies: engine and attempt number, the auto-detected failure categories with 2–5 paragraphs of category-specific fix guidance each, a FAILING vs. PASSING sampler inventory, DNS resolution status per host, referenced-vs-defined variable analysis, a JTL error summary grouped by label, the last 15 KB of the JMeter/K6 log, the last 80 console log lines, any rule violations, and the full current script. An optional user-supplied instruction (e.g. "use refreshToken instead of accessToken") is prepended and marked highest priority.

### Auto-heal — endpoint-scoped override patch (lower-cost tier)

Used only for VARIABLE_REFERENCE / REQUEST_MALFUNCTION categories on JMeter suites with a linked collection. The AI is explicitly told not to rewrite the script — only to propose per-endpoint header/body/URL overrides, using {{captured:KEY}} for values captured from an earlier response and {{key}} for collection variables, with authorization/token values required to prefer {{captured:KEY}}. Capped at 8 endpoints per attempt.

### Auto-heal — diff patch (surgical text edits)

For any remaining category, the AI is asked for a small list of {find, replace} edits instead of a full file. Each "find" must match the current script’s text exactly once — 0 or 2+ matches causes that edit to be rejected rather than guessed at. The result is checked for well-formed XML (JMeter) or balanced brackets (K6) before being accepted; a failure falls through to the full-rewrite tier.

### Pre-run "Fix with AI" (single failing endpoint, outside the auto-heal pipeline)

routes/ai.js builds a small, tightly-scoped prompt containing only the one failing endpoint’s last request/response, the tokens captured so far, and the collection’s non-blank variables, plus any user instruction. Output is {"issue","fix","fix_type": "header_override"|"body_override"|"url_override"|"no_fix", "headers"?, "body"?, "url"?}. The proposed override is persisted (fingerprinted by method + name) and applied automatically on every future pre-run for that endpoint.

## 4.3 Model Configuration & Supported LLMs

| **Provider** | **Default model** | **Configurable heal model** | **Max output tokens** | **Temperature** |
| --- | --- | --- | --- | --- |
| OpenAI | gpt-4o | Independent (ai_settings.heal_model) | 16,384 (hard provider ceiling) | 0.2 |
| Anthropic (Claude) | claude-sonnet-5 | Independent (ai_settings.heal_model) | 8,192 default (Anthropic’s extended-output beta is not enabled) | 0.2 |

The frontend’s model dropdown is a curated convenience list only, not a technical whitelist — settings.js stores whatever model string is submitted verbatim, and a "Custom (enter model ID)…" option exists for both providers so a newly released model can be used immediately without a code change.

## 4.4 Token Usage & Cost Strategy

There is no token-counting, cost-tracking, usage-quota, or response-caching layer anywhere in the codebase because It supports BYO AI (Bring your own AI). Each script-generation or auto-heal AI call is a fresh, unmetered request billed entirely at the underlying provider account.

-   JMeter generation makes zero AI calls (fully deterministic template builder) — cost only applies to K6 generation.
-   Auto-heal is capped at 1 automatic attempt per failed run (reduced from an earlier default of 3, specifically to avoid repeated, unguided, same-cost retries); a manual "Heal Again" with a user instruction is the intended path for a further attempt.
-   The only token-related safeguard is a pre-flight size check before a full-script rewrite: the script’s size is estimated in tokens and compared against the provider’s ceiling minus a safety margin (600 tokens); if it can’t possibly fit, an honest "no_fix" is returned immediately instead of spending a guaranteed-to-truncate AI call.
-   The tiered repair strategy (mechanical fix → endpoint-override patch → diff patch → full rewrite) is itself the primary cost-control mechanism: each tier’s AI output is bounded by the size of the change rather than the size of the whole script, which is what makes healing large (100KB+) scripts economically and technically feasible at all.

## 4.5 AI Workflow Diagram

![](images/ai-script-generation.png)

_K6 generation flow: assemble context → build prompt → call provider → validate/clean → write script._

### Script generation (summarized)

Load suite + collection + test data + rules + merged config -> for JMeter: buildJmxTemplate() (no AI)

\-> for K6: build system/user prompt -> callAi(purpose='script') -> strip markdown -> write .js

### Auto-heal cycle (summarized)

Run fails -> buildContext() (parse JTL, classify errors, resolve DNS, diff vars) -> diagnoseWithAi():

1) tryFixTemplateVars() / tryFixDisabledElements() \[deterministic, zero AI cost\]

2) tryEndpointOverridePatch() \[AI, endpoint-scoped, low cost\]

3) tryDiffPatch() \[AI, surgical edits, medium cost\]

4) full-script rewrite \[AI, last resort, token-budget-guarded\]

\-> apply fix -> Phase 1 quick verify (1 VUser/1 loop) -> Phase 2 full re-run -> healed | still_failing | infra_error

## 4.6 Auto-Healing Design

![](images/auto-heal-flow.png)

_Auto-heal decision flow across both local execution and CI-triggered runs._

### JTL error classification

Failures are grouped into categories before any AI call is made, so the diagnosis prompt is targeted rather than generic: DNS/Connection failures (no response, 0/500–505/429, connection-refused patterns), Correlation/Auth failures (401/403, invalid/expired token/session/CSRF), Assertion failures, Variable/Reference failures (unresolved ${…} or literal {{var}}), Request Malformation (400/404/405/422 and other 4xx), and Zero Samples (no requests recorded at all). If ≥70% of failures classify as infrastructure-level, the whole run is marked an infrastructure failure and auto-heal deliberately does not attempt a script fix.

### Repair tiers, in order of preference

| **Tier** | **Trigger** | **AI cost** | **Mechanism** |
| --- | --- | --- | --- |
| 1\. Mechanical fix | Literal {{var}} tokens present, or disabled ThreadGroup/Sampler/Controller elements | None | tryFixTemplateVars() resolves or converts to ${var}; tryFixDisabledElements() flips enabled="false" to "true". |
| 2\. Endpoint-override patch | VARIABLE_REFERENCE / REQUEST_MALFUNCTION, JMeter + linked collection | Low — output limited to a small overrides list | AI proposes per-endpoint header/body/URL overrides; script is deterministically regenerated (zero extra AI tokens) via the existing generator. |
| 3\. Diff patch | Any other category | Medium — output limited to the size of the change | AI proposes exact-match find/replace text edits; rejected if a "find" isn’t unique or the patched result is structurally malformed. |
| 4\. Full rewrite | All prior tiers unavailable/failed | Highest — output bounded by full script size | AI reproduces the entire corrected script; guarded by a pre-flight size check and a same-sampler-count / structural-validity check on the result. |

### Verification and attempt policy

-   Phase 1 — quick verify: 1 VUser, 1-second ramp-up, 1 loop, no HTML report, to catch a broken/invalid fix cheaply before committing to a full re-run.
-   Phase 2 — full run: original run parameters (VUsers/ramp-up/duration/loops), only attempted if Phase 1 passes.
-   Maximum 1 fully automatic attempt (local: autoHealer.js MAX_ATTEMPTS; CI: ciPipeline.js HEAL_CI_MAX_ATTEMPTS) — a deliberate reduction from an earlier default of 3, since an unguided repeat of the same diagnosis produces the same result at the same cost. A user-supplied instruction via "Heal Again" is the intended next step.
-   CI-context healing (ciPipeline.js healCycleCI()) shares the same diagnoseWithAi() logic as local healing, and additionally pushes the fixed script back to the Git repository before re-triggering the CI job.
-   Every attempt, its diagnosis, the fix applied, and the outcome are persisted to auto_heal_logs (local) or ci_auto_heal_logs (CI).

# 5\. Workflow Documentation

## 5.1 Collection Import

Supported formats: Postman v2.1, Swagger/OpenAPI (JSON or YAML), cURL, and raw JSON. parseCollection.js normalizes every format into the same flat internal shape: {name, folder, folderPath, method, url, headers, body, queryParams}.

-   Postman parser: walks the nested folder structure (preserved as folder/folderPath for later JMeter grouping), extracts v2.1-style query params, and skips disabled headers/params.
-   Swagger/OpenAPI parser: resolves the base URL from servers\[0\].url (or host+basePath+schemes), iterates every path × method, extracts query parameters and an example request body.
-   cURL parser: delegates to a dedicated parseCurl() utility and wraps the single resulting endpoint in an array.
-   What is explicitly not done: Postman pre-request scripts are never executed, and Postman collection/environment variables are not resolved at parse time — the raw {{var}} text is preserved as-is for later stages to handle.

### Variable extraction and environment auto-population

-   Collection-level variables (a Postman collection’s own top-level variable array) are extracted as a fallback default.
-   An optional second upload — a Postman .postman_environment.json export — provides real values that take precedence over the collection’s own defaults; re-uploading a collection never overwrites a value the user already has stored for an environment.
-   On import, each endpoint’s URL is resolved against the variable map to {protocol, url, port} and merged into project_config (project-wide reference) and collection_env_config (per-environment, authoritative for script generation) — without ever overwriting a value the user has already set manually.
-   A dedicated per-collection Git-workspace folder tree is created per environment: testData/, script/, results/, and a config.json snapshot; the original source file and any uploaded environment file are stored alongside it for reference.

## 5.2 Pre-run

![](images/pre-run-flow.png)

_Pre-run: bulk fire → token/cookie capture → 401 retry → optional AI-assisted per-endpoint fix._

-   Purpose: fire every collection endpoint live, exactly as it will be called, to learn real authentication tokens and response shapes before any script is generated — script generation is blocked until a fresh pre-run exists (hash-matched to the current collection).
-   Concurrency: endpoints are fired in chunks of 20 with a 250ms pause between chunks (removed a prior hard cap of the first 20 endpoints only — every endpoint in the collection is now fired).
-   Variable substitution (preRunEngine.js substituteVars/findMissingVars): resolves {{var}} iteratively up to 5 passes (to handle nested templates like {{protocol}}://{{host}}); an unresolved token is left in place and reported to the caller rather than silently sent as literal text.
-   Token/cookie extraction: scans response bodies for common auth field names (token, access_token, jwt, bearer, sessionToken, refreshToken, etc., including inside nested wrapper objects) and Set-Cookie headers; every match is retained, not just the first.
-   401 retry: if a default token (access-token-shaped fields only — refresh tokens are deliberately excluded from this default) exists from an earlier response, a 401 is retried once with it injected as an Authorization header plus any captured cookies.
-   SSRF guard: requests are blocked to localhost, 127.x, 0.x, 10.x, 192.168.x, 172.16–31.x, and 169.254.x, and must be http/https — enforced before any request is fired (see Section 6.7 for a full gap analysis).
-   AI-assisted per-endpoint heal ("Fix with AI"): lets a user fix a single still-failing endpoint without re-running the whole collection; the fix is persisted as a fingerprinted override and applied automatically on every future pre-run of that endpoint.

## 5.3 Script Generation Design

![](images/ai-script-generation.png)

_Script generation: deterministic JMeter template builder vs. AI-driven K6 generation._

### Configuration merge order

{ ...DEFAULT_CONFIG, ...global_config, ...project_config, ...collection_env_config, ...suite.config_json }

For a suite scoped to a collection, URL/protocol/port fields are stripped from the global/project layers before merging, so a collection-scoped suite’s target can only ever come from its own environment config or its own suite override — this closes a historical cross-collection URL leak (see Section 5.1 of the security findings summary in Section 6).

### JMeter generation — fully deterministic, no AI call

-   buildJmxTemplate() constructs the entire .jmx XML from the resolved endpoints, CSV columns, and correlation rules: User Defined Variables (protocol/server/port, thread/ramp-up/duration or loop-count, CSV path/file, and collection variables — all overridable at runtime via -J flags), one CSVDataSet element per test-data file, one HTTPSamplerProxy per endpoint with header/body/query substitution, and a JSONPathExtractor for every field captured from a detected login endpoint.
-   Multi-host support: a single collection spanning multiple API families (each behind its own {{var}}-templated base URL) resolves each endpoint’s own host independently and, when more than one distinct host is found, emits indexed UDVs (PROTOCOL_1/SERVER_1/PORT_1, _2, …) instead of forcing every sampler onto one host.
-   CSV correlation: request body/query values are matched against actual CSV column values (case-insensitive, by value or by key name) and rewritten to ${columnName} references.
-   Postman folder structure is preserved as JMeter Simple Controllers when present.

### K6 generation — AI-driven

There is no deterministic K6 template; the script is produced by an LLM call using the prompt described in Section 4.2, with determinism coming from a low temperature (0.2) and a consistent, structured prompt rather than a fixed template.

Output artifacts: the generated .jmx or .js file is written to <workspace>/<Collection>/<Env>/script/<SuiteName>.<ext>, and its path is recorded on the test_suites row for later execution and download.

## 5.4 Correlation Strategy

-   Login/token extraction: when a login endpoint is detected, every captured response field (accessToken, refreshToken, sessionId, etc.) is extracted via a JMeter JSONPathExtractor into a same-named JMeter variable.
-   Propagation: subsequent (non-login) requests automatically receive an Authorization: Bearer ${accessToken} header; a per-endpoint override (from a pre-run "Fix with AI" fix) can substitute a different captured field, e.g. ${refreshToken}, via the {{captured:KEY}} placeholder convention translated to ${KEY} at generation time.
-   CSV data and captured tokens are kept in separate variable namespaces and can be combined freely in the same request body, e.g. {"username": "${username}", "authorization": "Bearer ${accessToken}"}.
-   Multi-host correlation: tokens remain global JMeter variables regardless of which host issued them, so a login on API family A can authenticate calls to API family B within the same script.
-   Explicit non-goals: no conditional branching on response content (e.g. "if 404, use a fallback token"), no cross-response extraction from non-JSON bodies (HTML/regex extraction is not implemented), and no dynamic construction of a request URL from a prior response’s field — any of these would require bespoke AI-authored logic on the K6 path only, since the JMeter path is template-driven.

## 5.5 Test Execution Workflow

![](images/test-execution-flow.png)

_Execution paths: single run, native runner utility, and sequential internal pipeline._

### Three execution paths

| **Path** | **File** | **Characteristics** |
| --- | --- | --- |
| Single run | routes/execution.js | Immediate, SSE-streamed logs; native or Docker; live per-second rule monitoring during the run; JMX runtime-parameter patching; PDF export. |
| Native runner utility | utils/testRunner.js | Shared binary-discovery + spawn logic reused by single runs and pipelines; falls back through bundled path → common install paths → PATH. |
| Sequential pipeline | routes/pipelines.js | Runs multiple test suites back-to-back, SSE-streamed, optional stop-on-failure, one execution_runs record per step plus an aggregate pipeline_runs record. |

-   Binary discovery: JMeter/K6 binaries are located via a fallback chain (bundled install → common install paths → PATH lookup) and the runner returns a clear error if none is found, rather than failing opaquely.
-   Runtime parameters (VUsers, ramp-up, duration/loops) are patched into the JMX as -J overrides (JMeter) or environment variables (K6) at run time, without needing to regenerate the script.
-   Live monitoring: partial JTL output is parsed roughly every second during a run so that rule breaches (error rate, response time, throughput) can trigger a mid-run alert email as soon as they occur, not only at the end.
-   Result parsing (utils/ruleEvaluator.js): computes total/pass/fail counts, error rate, average response time, P90/P95, and throughput from the JTL, then evaluates each configured rule with its operator (>, >=, <, <=, ==, between). Rules with severity=error must all pass for the run to pass; severity=warn rules are logged only. If no rules are configured, the run falls back to raw fail-count pass/fail.
-   Docker-mode execution mounts the script/results/test-data directories into justb4/jmeter or grafana/k6 containers and translates host↔container paths as needed.
-   Difference from pipelines: a single run evaluates rules once at the end (plus live monitoring during); a pipeline evaluates and persists a result per step and can stop remaining steps immediately on the first failure.

# 6\. Security Documentation

![](images/security-model.png)

_Security layering: authentication → authorization → license enforcement → encryption at rest → network security → container security._

## 6.1 Authentication Design

-   JWT scheme: HS256, signed with JWT_SECRET, 7-day expiry, carrying a jti (session ID) and userId. The code falls back to a hardcoded default secret if JWT_SECRET is unset — this must always be set explicitly in production.
-   Password hashing: bcrypt, 10 rounds.
-   Session management: each login creates a user_sessions row keyed by jti; only one active session per user is allowed (a new login invalidates the previous session unless force:true is passed); sessions expire after 30 minutes of inactivity, tracked via last_used_at and refreshed on every authenticated request (including a client heartbeat).
-   Login flow: credentials validated, pending/rejected accounts rejected with 403, an existing active session blocks a second login (409 SESSION_ACTIVE) unless forced, and session replacement is atomic (old session deleted, new one created in one transaction).
-   Logout: deletes all sessions for the token’s user.
-   Password reset: a 32-byte random token valid for 30 minutes; the forgot-password endpoint never reveals whether an email exists; all prior reset tokens for the user are invalidated when a new one is issued.
-   Invite-based onboarding: a 72-hour random token; acceptance re-checks the org’s license status (can fail between invite-send and acceptance if the org is disabled or at its user limit) and issues a JWT immediately for first login.

## 6.2 Authorization (RBAC) Design

| **Role** | **Scope** |
| --- | --- |
| super_admin | All organizations; manages orgs, licenses, and org-admin invitations. Has no project-scoped UI of its own. |
| org_admin | Own organization only; manages users, projects, AI/Git/SMTP configuration, and merges PRs. |
| user | Only projects explicitly assigned via project_assignments; cannot create projects or invite org admins. |

-   License gate: every authenticated request from a non-super-admin user with an org checks getOrgAccessStatus() and returns 403 (org_disabled or license_expired) if the org’s license is invalid.
-   Project-level authorization: ownsProject(userId, projectId) grants access if the user owns the project, is explicitly assigned to it, or is an org_admin/super_admin over the owner’s organization; denial returns 404, never 403, to avoid leaking project existence.
-   Admin-only routes (admin.js) additionally scope org_admin visibility/actions to their own organization and to the "user"/"org_admin" roles only — they cannot see or act on another org or on a super_admin.

_Note: The invite-revocation endpoint (DELETE /api/invites/:id) does not carry an explicit role check in the reviewed code path — this should be verified and, if confirmed, restricted to admin roles only._

## 6.3 Secret Management Strategy

| **Secret** | **Storage** | **Protection** |
| --- | --- | --- |
| AI provider API keys | ai_settings.api_key | AES-256-CBC encrypted at rest; never returned to the frontend (only an api_key_set flag). |
| SMTP password | alert_configs.smtp_pass | AES-256-CBC encrypted at rest; masked in API responses. |
| npm/Artifact Keeper registry token | organizations.registry_token_enc | AES-256-CBC encrypted; only metadata (prefix, created/expires) returned after creation, not the raw token. |
| Git PATs / SSH keys | git_configs.auth_token, user_git_configs.auth_token/ssh_key | Column exists as TEXT; encryption coverage for this specific field should be explicitly re-verified against the current commit before relying on it. |
| JWT_SECRET, ENCRYPTION_KEY, DATABASE_URL | Environment variables | Not stored in the database; must be set per-deployment and never committed. |

-   A previously-fixed issue is worth noting for audit history: Git PATs used to be persisted into .git/config on disk via git remote set-url, making them readable in plaintext to anyone with filesystem access to a workspace; this was fixed by passing authenticated URLs only as one-off command arguments (never persisted to disk) for every fetch/push/pull.
-   No secrets-rotation mechanism exists for JWT_SECRET or ENCRYPTION_KEY beyond a manual redeploy with a new value.

## 6.4 Encryption Strategy

-   At rest: AES-256-CBC with a random 16-byte IV per value, stored as <iv_hex>:<ciphertext_hex>; the key is derived via SHA-256 of ENCRYPTION_KEY (falls back to JWT_SECRET, then a hardcoded default if neither is set — ENCRYPTION_KEY should always be set explicitly and kept distinct from JWT_SECRET in production).
-   Passwords are hashed (bcrypt), not encrypted — irreversible by design.
-   In transit: the application itself does not terminate TLS; HTTPS is expected to be provided by a reverse proxy or the deployment platform in front of port 3001. The Docker Compose reference topology does not include a TLS-terminating proxy by default — this must be added at deployment time (e.g. Nginx + a certificate) for any non-local deployment.
-   The Postgres connection in the reference docker-compose.yml is unencrypted (internal Docker network, no sslmode=require) — acceptable for a single-host deployment where Postgres is not exposed, but should use TLS if the database is ever reachable across an untrusted network.
-   Graceful-degradation caveat: the encrypt/decrypt helpers return plaintext unchanged if a crypto operation fails, which avoids a hard outage but means an encryption misconfiguration would fail silently rather than loudly — recommended to add explicit alerting on this fallback path.

## 6.5 Audit Logging Design

There is no dedicated, comprehensive audit-log table recording "who changed what, when" across administrative and data-mutating actions. The following tables provide partial, purpose-specific history:

| **Table** | **What it records** |
| --- | --- |
| user_sessions | Login/session creation and last-activity time (not a full login-history log — old sessions are deleted, not archived). |
| auto_heal_logs / ci_auto_heal_logs | Every auto-heal attempt, diagnosis, fix applied, and result. |
| git_commits | Commit author, branch, message, and push status. |
| invites / project_assignments | Creation time and who created the invite/assignment; no record of later revocation. |
| execution_runs | Test run history, status, and timing. |

Gap: there is no record of who approved/rejected a user, who changed an organization’s license plan or status, who edited a project’s configuration, or failed authentication/authorization attempts. For any compliance program requiring a full activity trail, a dedicated audit_log table (actor, action, target, before/after, timestamp, IP) would need to be added.

## 6.6 Compliance Documentation (SOC 2 / ISO 27001 / GDPR)

_PerfStudio holds no third-party compliance certification today; this section is a factual gap analysis of relevant controls already present versus what a formal program would additionally require — it is not a claim of compliance._

### Controls already present

-   Role-based access control with three tiers, enforced in middleware and per-route.
-   Encryption at rest for the highest-sensitivity fields (AI keys, SMTP password, registry tokens).
-   Session expiry (30-minute inactivity) and single-active-session enforcement.
-   Data isolation between organizations (org_id scoping) and between environments (collection_id + env scoping).
-   SSRF protections on outbound pre-run requests.

## 6.7 SSRF Guard (Pre-Run outbound requests)

preRunEngine.js blocks any URL matching localhost, 127.x.x.x, 0.x.x.x, 10.x.x.x, 192.168.x.x, 172.16–31.x.x, or 169.254.x.x, and requires an explicit http:// or https:// scheme; anything else is rejected before a request is ever fired.

Residual gaps to track: IPv6 loopback/link-local/unique-local ranges (::1, fe80::/10, fc00::/7) are not explicitly matched by the current regex list; there is no DNS-rebinding protection (a hostname could resolve to a public IP at check time and a private IP at request time); and there is no outbound rate limiting beyond the existing 20-per-chunk/250ms pacing, which is a performance control rather than an abuse control.

# 7\. Quality Engineering

No automated test runner, linter, or static-analysis integration currently exists in this repository, confirmed by inspecting both package.json files, searching the full source tree for test/spec files, and reviewing the only CI workflow present.

## 7.1 Code Coverage Report

| **Check performed** | **Result** |
| --- | --- |
| Test runner in backend/package.json devDependencies | Not present (only nodemon). |
| Test runner in frontend/package.json devDependencies | Not present (only @vitejs/plugin-react, vite). |
| Test/coverage step in .github/workflows/docker-publish.yml | None — the workflow only builds and pushes Docker images. |
| Automated coverage percentage | 0% as tool is in phase 1 or development. |

### What exists in place of automated testing today

Quality assurance is currently manual, following the 15-step end-to-end flow documented in docs/USER_WORKFLOW.md: import a collection → run Pre-Run against live endpoints → configure rules/environment → generate a script → execute it (locally, in Docker, or via CI) → inspect the resulting analytics dashboard and PDF report. This provides real functional coverage of the happy path on every manual pass.

## 7.2 Static Code Analysis Report

| **Check performed** | **Result** |
| --- | --- |
| ESLint configuration (.eslintrc*) at repo root or per-package | Not present. |
| Prettier configuration | Not present. |
| SonarQube (or equivalent) configuration or CI step | Not present. |
| Pre-commit hooks enforcing style/lint | Not present. |

# 8\. Environment & Demo Access

This section requires values specific to your actual deployment, which are not derivable from the source code. Placeholders are provided below for your team to complete.

## 8.1 Demo Environment URL

| **Field** | **Value** |
| --- | --- |
| Environment URL | https://peako.qtsolvdev.com/sign-in |

## 8.2 Test User Credentials

The application ships with one seeded account out of the box; all other roles need to be created for the reviewer.

| **Role** | **Email** | **Password** | **Notes** |
| --- | --- | --- | --- |
| Super Admin (seeded by default) | admin@perfstudio.com | Admin@123 | Auto-created on first backend boot if no super_admin exists (backend/src/db/index.js). Change this password before exposing any non-local environment. |
| Owner / Org Admin (for review) | tasleema85@gmail.com | Admin@123 | Create via the Super Admin console (Organizations → invite an org admin) ahead of the review. |
| Regular User (for review) | tasleemzaif@hotmail.com | Admin@123 | Create via the Org Admin’s invite flow, or note the license plan’s user limit if creating additional accounts. |

_Note: The seeded super-admin password is publicly documented (in this codebase’s own README) — it must be rotated on any environment that is reachable outside a trusted network, including this demo environment._