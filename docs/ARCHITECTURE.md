# Performance Studio — Architecture & Flow Diagrams

All diagrams use [Mermaid](https://mermaid.js.org/) and render natively on GitHub.

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

> The static image previously here (`images/system-architecture.png`) had two stale points, fixed below: it still labeled the database "SQLite" (this app is fully migrated to PostgreSQL — see [Technology Stack](#14-technology-stack)), and it drew Auto-Healer as a peer of the normal request flow (fed directly by Request Handler, in parallel with AI Engine/Test Executor/Email/Git) rather than as a **reactive step triggered by a failed Test Executor run**. This is now a Mermaid diagram (matching this doc's own stated approach) so it stays text-diffable and doesn't drift out of sync again.

```mermaid
flowchart TB
    Browser["Your Browser<br/>Performance Studio Web App<br/>React · Vite"]
    RH["Request Handler<br/>Processes all user actions"]

    subgraph Server["Performance Studio Server"]
        RH
        AI["AI Engine<br/>Generates test scripts automatically"]
        EA["Email Alerts<br/>Sends reports after each test run"]
        VC["Version Control<br/>Tracks scripts and changes via Git"]
        TE["Test Executor<br/>Runs JMeter and K6 performance tests"]
        AH["Auto-Healer<br/>Triggered by a failed run — diagnoses and fixes the script"]
    end

    subgraph ExtSvc["External Services"]
        AIP["AI Provider<br/>OpenAI GPT-4o or Anthropic Claude"]
        ES["Email Server<br/>Gmail · Outlook · Any SMTP"]
        GP["Git Platform<br/>GitHub · GitLab · Bitbucket"]
    end

    subgraph ExecEnv["Test Execution Environment"]
        TC["Test Container<br/>JMeter · K6 · Java · Node.js"]
    end

    subgraph Storage["Data Storage"]
        DB[("Database<br/>PostgreSQL — Orgs · Licenses · Projects ·<br/>Users · Results · Settings")]
        FS["File Storage<br/>Generated scripts · Test data CSV · HTML reports"]
    end

    Browser -- "User actions" --> RH
    RH --> AI
    RH --> EA
    RH --> VC
    RH --> TE

    AI -- "Script generation" --> AIP
    EA -- "Sends email with report" --> ES
    VC -- "Push and pull" --> GP
    TE -- "Launches test container" --> TC
    TC -- "Saves results and reports" --> FS

    TE -- "Run fails rule checks" --> AH
    AH -- "Asks AI to fix the script" --> AI
    AH -- "Overwrites the script file" --> FS
    AH -- "Reruns fixed script" --> TE

    RH -.-> DB
    TE -.-> DB
    AH -.-> DB
    VC -.-> DB
```

**Why Auto-Healer sits where it does**: `autoHealer.js` is only ever invoked after a test run's results fail rule evaluation by `ruleEvaluator.js` (see [PROJECT_MAP.md](../PROJECT_MAP.md#backend-services-utils)) — it is never a step in the normal request path. It asks the AI Engine for a fix, overwrites the script file directly on disk (confirmed: it never calls git itself), then reruns via the Test Executor — up to 3 attempts. Committing the healed script to Git is a separate, manual step the user takes afterward via the Git panel, same as any other script change.

---

## 2. Data Model

Entity-relationship diagram for the PostgreSQL database (schema in `backend/src/db/schema.sql`, applied by `migrate.js`). Note: the diagram image below predates the licensing system (`org_licenses` table) and may not show it — see [Licensing System](#15-licensing-system) for that addition.

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

```mermaid
sequenceDiagram
    actor User
    participant FE as Frontend
    participant TS as testSuites.js Route
    participant DB as Database (Postgres)
    participant AC as aiClient.js
    participant LLM as LLM Provider
    participant FS as File System

    User->>FE: Click "Generate Script"
    FE->>TS: POST /api/projects/:id/test-suites/:suiteId/generate
    TS->>DB: Fetch test suite (engine, test_type, vusers, rampup, duration, env)
    TS->>DB: Fetch linked collection (json_content, pre_run_data)
    TS->>DB: Fetch test data files (CSV paths + column names)
    TS->>DB: Fetch performance rules (metric, operator, value, severity)
    TS->>DB: Fetch global_config → project_config → collection_env_config
    TS->>TS: Merge config (DEFAULT → global → project → env → suite)
    Note over TS: Pre-run data read from collection.pre_run_data<br/>(no longer passed from frontend)

    alt engine = jmeter
        TS->>TS: buildJmxTemplate() — deterministic JMX builder, no LLM needed
        TS->>TS: Login endpoint detected? → add JSONPostProcessor extractor
        TS->>TS: CSV columns → CSVDataSet + variable substitution
        TS->>TS: Folders from Postman? → SimpleController grouping
        TS->>TS: cleanScript() → strip markdown fences + fixJmxHashTrees()
    else engine = k6
        TS->>AC: callAi(userId, systemPrompt, userPrompt)
        AC->>DB: Read ai_settings (provider, api_key encrypted)
        AC->>AC: decrypt(api_key)
        AC->>LLM: generateText(k6 system prompt + endpoints + CSV + correlation + thresholds)
        LLM-->>AC: Raw K6 JavaScript
        AC-->>TS: Script content
        TS->>TS: cleanScript() → strip markdown fences
    end

    TS->>TS: getUserProjectPath(userId, role, projectName)
    TS->>TS: isAdminWorkspace()? → reject if admin workspace
    TS->>FS: mkdirSync(collection/ENV/script/)
    TS->>FS: writeFileSync(suiteName_testType.jmx)
    TS->>DB: UPDATE test_suites SET jmx_path = filePath, status = 'generated'
    TS-->>FE: { ok: true, filename, path }
    FE->>FE: Show download button + Re-generate option
```

---

## 6. Pre-Run Flow

How live API responses are captured to power correlation and token extraction in generated scripts.

```mermaid
sequenceDiagram
    actor User
    participant CJ as Collections.jsx
    participant AI as ai.js Route
    participant DB as Database (Postgres)
    participant EP as External API Endpoints

    User->>CJ: Click "Run Pre-run" on an API Source
    CJ->>AI: POST /api/ai/pre-run { collection_id, project_id }
    AI->>DB: Verify ownsProject(userId, project_id)
    AI->>DB: SELECT * FROM collections WHERE id = collection_id
    AI->>AI: Parse json_content → endpoints array (max 20)

    rect rgba(255, 245, 200, 0.5)
    Note over AI: Phase 1 — Fire all endpoints in parallel (Promise.all)
    loop For each endpoint
        AI->>AI: isSafeUrl()? Block RFC1918 + loopback (SSRF protection)
        AI->>EP: fetch(url, { method, headers, body, signal: AbortController 5s })
        EP-->>AI: { status, statusText, headers, body }
        AI->>AI: extractToken(body, responseHeaders) — checks token/access_token/jwt/bearer keys
        AI->>AI: extractCookies(set-cookie header)
    end
    end

    AI->>AI: Find first extracted auth token from successful responses

    rect rgba(255, 245, 200, 0.5)
    Note over AI: Phase 2 — Retry any 401s with extracted token
    loop For each 401 response
        AI->>EP: fetch(url, { Authorization: Bearer token })
        EP-->>AI: { status, body }
        AI->>AI: Mark tokenInjected: true
    end
    end

    AI->>AI: simpleHash(collection.json_content) → freshness hash
    AI->>DB: UPDATE collections SET pre_run_data = responses, pre_run_collection_hash = hash
    AI-->>CJ: { responses[], extractedToken: '(present)' }
    CJ->>CJ: setPreRunData({ [collectionId]: responses })
    CJ->>CJ: Re-fetch collections to get updated pre_run_collection_hash
    CJ->>CJ: Show pass/fail counts + "Show Logs" button

    Note over CJ: Freshness gate in Test Plans:<br/>simpleHash(json_content) === pre_run_collection_hash<br/>→ only then enable "Generate Script"
```

---

## 7. Test Execution Flow

How a test run is triggered, streamed, and reported.

![test-execution-flow](./images/test-execution-flow.png)

---

## 8. Auto-Heal Flow

How failed test scripts are automatically diagnosed and fixed by AI. **This is a reactive step, triggered only after a test run's results fail rule evaluation — it is never part of the normal generate/run request path** (see the corrected [System Architecture](#1-system-architecture) diagram above).

```mermaid
sequenceDiagram
    participant TE as Test Executor
    participant AH as autoHealer.js
    participant DB as Database (Postgres)
    participant AC as aiClient.js
    participant LLM as LLM Provider
    participant FS as File System

    TE->>AH: triggerHeal(runId, suiteId, projectId, errorLog)

    loop Up to 3 attempts
        AH->>DB: INSERT auto_heal_logs (attempt, run_id)
        AH->>FS: Read current JMX/K6 script
        AH->>DB: Read ai_settings (heal_model)
        AH->>AC: callAi(userId, healSystemPrompt, "Fix this script given errors:\n" + errorLog + "\nScript:\n" + scriptContent)
        AC->>LLM: generateText(heal prompt)
        LLM-->>AC: Fixed script content
        AC-->>AH: Fixed script
        AH->>AH: cleanScript() → validate output
        AH->>FS: Overwrite script file with fix
        AH->>DB: UPDATE auto_heal_logs SET fix_applied = diff
        AH->>TE: Re-run test suite (new execution_run)
        TE-->>AH: { passed, error }

        alt passed
            AH->>DB: UPDATE auto_heal_logs SET result = healed
            AH->>DB: UPDATE execution_runs SET heal_status = healed
            AH->>AH: sendAlertEmail (heal success report)
            AH-->>TE: done
        else still failing
            AH->>DB: UPDATE auto_heal_logs SET result = failed
            Note over AH: Continue to next attempt
        end
    end

    AH->>DB: UPDATE execution_runs SET heal_status = exhausted
```

**Note**: `autoHealer.js` writes the fixed script directly to the **File System** — it never calls git. Committing the healed script (and pushing/raising a PR) remains a separate, manual step the user takes afterward via the Git panel, same as any other script change.

---

## 9. Git & CI Integration Flow

How test scripts are versioned, pushed, and merged via Git.

![git-ci-integration](./images/git-ci-integration.png)

---

## 10. CI Pipeline Flow

How sequential performance test pipelines are configured, triggered, and tracked.

```mermaid
sequenceDiagram
    actor User
    participant PC as PipelineConfig.jsx
    participant CI as pipelines.js + ciPipeline.js
    participant DB as Database (Postgres)
    participant FS as File System
    participant CIP as GitHub Actions / GitLab CI

    rect rgba(255, 245, 200, 0.5)
    Note over User,CIP: Setup — configure pipeline
    User->>PC: Create pipeline (name, test plan steps, stop_on_failure)
    PC->>CI: POST /api/projects/:id/pipelines
    CI->>DB: INSERT pipeline_configs (steps as JSON array)
    CI-->>PC: Pipeline saved

    User->>PC: Generate CI YAML file
    PC->>CI: POST /api/projects/:id/ci/generate-yaml
    CI->>DB: Fetch test suites to get script paths
    CI->>CI: Resolve user role → select workspace (org_admin → git-workspaces/admin/, regular user → git-workspaces/user-id/)
    CI->>DB: Fetch user branch from user_git_configs
    CI->>FS: Write gitlab-ci.yml / github-actions.yml with correct branch refs auto-populated
    CI-->>PC: "message: Generated — push to {branch}"

    User->>PC: Commit & push YAML via GitPanel
    PC->>CIP: CI provider detects workflow file
    end

    rect rgba(210, 235, 255, 0.5)
    Note over User,CIP: Runtime — trigger pipeline run
    User->>PC: Click Run Pipeline
    PC->>CI: POST /api/projects/:id/pipelines/:id/run
    CI->>DB: INSERT pipeline_runs (status: running)
    CI->>CI: Setup SSE stream → frontend

    loop For each step (sequential)
        CI->>CI: runSuite(suiteId, projectId, userId)
        CI->>CI: docker run JMeter/K6 for this step
        CI->>CI: Evaluate rules → pass/fail
        CI->>DB: UPDATE pipeline_runs steps_result[i]
        CI-->>PC: SSE { step_update: { index, status } }
        alt stop_on_failure = true AND step failed
            CI->>CI: Mark remaining steps as skipped
            Note over CI: Break loop
        end
    end

    CI->>DB: UPDATE pipeline_runs SET status = completed/failed
    CI->>CI: sendAlertEmail (pipeline summary)
    CI-->>PC: SSE { done: true, passed, failed, skipped }
    end
```

---

## 11. Alert & Email Flow

How test results trigger email notifications with analytics.

![alert-email-flow](./images/alert-email-flow.png)

---

## 12. Multi-Environment Isolation

```
git-workspaces/
├── admin/                                ← Org Admin workspace (main branch)
│   └── Project_Name/
│       ├── .git/
│       ├── .gitignore
│       └── Project_Name/
│           └── CollectionName_ID/
│               ├── QA/
│               │   ├── testData/         ← env-scoped CSV files
│               │   ├── script/           ← generated JMX / K6 scripts
│               │   ├── results/          ← JMeter results.jtl + HTML report
│               │   └── config/           ← config.json (URLs · rules · test plans)
│               ├── Staging/
│               ├── UAT/
│               └── Production/
│
└── user-{id}/                            ← Regular user workspace (users/name branch)
    └── Project_Name/
        └── (same structure as above)
```

**Isolation guarantees:**
- Every DB query that touches test data, configs, or scripts is scoped by `collection_id + env`
- Switching environment in the UI never shows data from another environment
- Regular users write only to their own `user-{id}` workspace; admin workspace is read-only for users
- Script generation is blocked in the admin workspace — users must generate in their own workspace

---

## 13. Security Model

```mermaid
flowchart TB
    subgraph Auth["Authentication"]
        A1["JWT HS256<br/>7-day expiry<br/>stored in localStorage"]
        A2["bcrypt<br/>10 rounds<br/>password hashing"]
        A3["Password Reset<br/>30-min token<br/>expires on use"]
    end

    subgraph Authz["Authorization"]
        Z1["auth middleware<br/>verifies JWT + session on every route"]
        Z2["Role checks<br/>super_admin · org_admin · user"]
        Z3["ownsProject()<br/>owner · assigned · org scope"]
    end

    subgraph Lic["License Enforcement"]
        L1["getOrgAccessStatus()<br/>checked on every request for<br/>non-super-admin users with an org"]
        L2["403 org_disabled / license_expired<br/>blocks access when disabled or past expires_at"]
    end

    subgraph Enc["Encryption at Rest"]
        E1["AES-256-CBC<br/>all secrets in PostgreSQL"]
        E2["Encrypted fields:<br/>AI API keys · Git PATs<br/>SMTP passwords · CI tokens"]
    end

    subgraph Net["Network Security"]
        N1["Strict CORS<br/>CORS_ORIGIN env var"]
        N2["SSRF Protection<br/>Block RFC1918 + loopback<br/>in pre-run endpoint"]
        N3["PAT injection<br/>URL at runtime only<br/>never in .git/config"]
    end

    subgraph Cont["Container Security"]
        C1["Non-root user<br/>in JMeter + K6 containers"]
        C2["Read-only source mounts<br/>for script files"]
    end
```

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
| **CORS** | Strict origin whitelist via `CORS_ORIGIN` env var |
| **Docker containers** | Non-root user; read-only source mounts |
| **Invite system** | Scoped token per email+org+role; expires 7 days after creation |

---

## 14. Technology Stack

| Layer | Technology |
|---|---|
| **Frontend** | React 18, Vite 5, axios, react-chartjs-2 / chart.js, html2canvas, jsPDF, xlsx |
| **Backend** | Node.js, Express 4, nodemon (dev) |
| **Database** | PostgreSQL via `pg` (`db/index.js` is the entry point every route imports, re-exporting `db/pg.js`'s async wrapper; `schema.sql` applied by `migrate.js`). No SQLite code remains — the migration is fully complete. |
| **AI Generation** | OpenAI GPT-4o (`openai` SDK) · Anthropic Claude — routed through one client (`utils/aiClient.js`); Anthropic is called via an OpenAI-compatible endpoint shape |
| **Test Engines** | Apache JMeter 5.6.3 · Grafana K6 — bundled in the all-in-one Docker image for native execution, or spawned as containers when `EXECUTION_MODE=docker` |
| **Git Integration** | `simple-git` (local ops) · `@octokit/rest` (GitHub API) · raw HTTP for GitLab/Bitbucket REST APIs |
| **Email** | `nodemailer` (SMTP transport, TLS) |
| **PDF Reports** | `puppeteer` (HTML → screenshot) · `pdfkit` (page stitching) |
| **Excel / CSV** | `xlsx` (frontend parsing) · custom CSV parser (backend) |
| **Encryption** | `crypto` (Node built-in AES-256-CBC) · `bcryptjs` |
| **File uploads** | `multer` (memory + disk storage) |
| **Backups** | `archiver` (ZIP on project delete) |
| **Containerisation** | Docker · Docker Compose (`postgres` + all-in-one app service) |
| **CI/CD** | GitHub Actions (`workflow_dispatch`) · GitLab CI (`pipeline_trigger`) · Bitbucket Pipelines |
| **Deployment** | Single Docker image (`Dockerfile`) or Compose stack, with a Postgres service alongside it |

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
