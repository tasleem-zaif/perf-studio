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

---

## 1. System Architecture

High-level view of every component and how they relate.

```mermaid
graph TB
    subgraph Client["Browser (User)"]
        UI["React SPA\n(Vite · port 5173 dev / Nginx prod)"]
    end

    subgraph Backend["Backend — Node.js / Express  :3001"]
        direction TB
        API["REST API + SSE\n24 route modules"]
        Auth["Auth Middleware\nJWT HS256 · 14-day expiry"]
        AIEngine["AI Engine\nOpenAI GPT-4o / Anthropic Claude"]
        Healer["Auto Healer\nread errors → fix JMX → re-run"]
        GitSvc["Git Service\nsimple-git · Octokit"]
        CIWebhook["CI Webhook\nGitHub Actions · GitLab CI"]
        Email["Alert Engine\nNodemailer + PDF reports"]
        Enc["Encryption\nAES-256-CBC"]
        Exec["Test Executor\ndocker run perf-studio-runner"]
    end

    subgraph Storage["Persistence"]
        DB[("SQLite\nnode:sqlite")]
        FS["File System\ngit-workspaces/\ndata/projects/"]
    end

    subgraph Execution["Test Execution Containers"]
        Runner["perf-studio-runner\nJava · JMeter · K6 · Node.js"]
    end

    subgraph External["External Services"]
        GPT["OpenAI\nGPT-4o"]
        Claude["Anthropic\nClaude Sonnet / Opus"]
        SMTP["SMTP Server\nGmail · Outlook · Custom"]
        GitHub["GitHub API\nOctokit REST"]
        GitLab["GitLab API"]
    end

    UI -->|"REST + SSE (axios)"| API
    API --> Auth --> AIEngine & GitSvc & CIWebhook & Email & Exec
    API --> DB
    API --> FS
    AIEngine --> GPT & Claude
    Exec -->|"docker run"| Runner
    Runner -->|"results.jtl + HTML report / results.json"| FS
    Healer --> AIEngine
    Healer -->|"re-run fixed script"| Exec
    Email --> SMTP
    GitSvc --> GitHub & GitLab
    CIWebhook --> GitHub & GitLab
    Enc --> DB
```

---

## 2. Data Model

Entity-relationship diagram for the SQLite database.

```mermaid
erDiagram
    organizations {
        int id PK
        string name
        string slug
        datetime created_at
    }
    users {
        int id PK
        string email
        string name
        string password_hash
        int org_id FK
        string role
        string status
        datetime created_at
    }
    projects {
        int id PK
        int user_id FK
        string name
        string description
        string folder_path
        string environment
        string color
        string bg
        datetime created_at
    }
    project_assignments {
        int id PK
        int project_id FK
        int user_id FK
    }
    collections {
        int id PK
        int project_id FK
        string name
        string description
        string json_content
        string source_type
        string environments
        string pre_run_data
        string pre_run_collection_hash
        datetime created_at
    }
    rules {
        int id PK
        int project_id FK
        string metric
        string operator
        string value
        string unit
        string severity
    }
    test_suites {
        int id PK
        int project_id FK
        int collection_id FK
        string name
        string test_type
        string engine
        int vusers
        int rampup
        int duration
        string env
        string jmx_path
        string js_path
        string status
    }
    test_data_files {
        int id PK
        int project_id FK
        int collection_id FK
        string env
        string filename
        string original_name
        string path
        string columns
    }
    collection_env_config {
        int id PK
        int collection_id FK
        string env
        string config_json
    }
    execution_runs {
        int id PK
        int project_id FK
        int suite_id FK
        string engine
        string status
        string result_dir
        string report_path
        string logs
        int auto_heal
        string heal_status
        datetime started_at
        datetime finished_at
    }
    pipeline_configs {
        int id PK
        int project_id FK
        string name
        string steps
        int stop_on_failure
        string environment
    }
    pipeline_runs {
        int id PK
        int pipeline_id FK
        int project_id FK
        string status
        string steps_result
        string logs
        datetime started_at
        datetime finished_at
    }
    git_configs {
        int id PK
        int project_id FK
        string remote_url
        string auth_token
        string auth_method
        string git_root
    }
    user_git_configs {
        int id PK
        int user_id FK
        int project_id FK
        string branch_name
        string author_name
        string author_email
        string auth_token
        string auth_method
    }
    git_commits {
        int id PK
        int project_id FK
        int user_id FK
        string branch
        string message
        string hash
        int pushed
    }
    git_prs {
        int id PK
        int project_id FK
        string pr_number
        string title
        string from_branch
        string to_branch
        string status
    }
    ci_pipeline_configs {
        int id PK
        int project_id FK
        int user_id FK
        int gitlab_enabled
        string gitlab_url
        int github_enabled
        string github_repo
    }
    ai_settings {
        int id PK
        int user_id FK
        string provider
        string api_key
        string model
        string heal_model
    }
    alert_configs {
        int id PK
        int user_id FK
        string smtp_host
        string smtp_port
        string smtp_user
        string smtp_pass
        string from_email
    }
    alert_recipients {
        int id PK
        int user_id FK
        int project_id FK
        string email
    }
    invites {
        int id PK
        string email
        string role
        int org_id FK
        string token
        string status
        datetime expires_at
    }
    auto_heal_logs {
        int id PK
        int run_id FK
        int attempt
        string diagnosis
        string fix_applied
        string fix_type
        int new_run_id FK
        string result
        datetime created_at
    }

    organizations ||--o{ users : "has"
    organizations ||--o{ invites : "sends"
    users ||--o{ projects : "owns"
    projects ||--o{ project_assignments : "assigns"
    users ||--o{ project_assignments : "assigned to"
    projects ||--o{ collections : "has"
    projects ||--o{ rules : "has"
    projects ||--o{ test_suites : "has"
    projects ||--o{ test_data_files : "has"
    projects ||--o{ execution_runs : "has"
    projects ||--o{ pipeline_configs : "has"
    projects ||--o{ git_configs : "has"
    collections ||--o{ test_suites : "linked to"
    collections ||--o{ test_data_files : "scopes"
    collections ||--o{ collection_env_config : "has"
    test_suites ||--o{ execution_runs : "runs"
    pipeline_configs ||--o{ pipeline_runs : "executes"
    execution_runs ||--o{ auto_heal_logs : "heals"
    users ||--o{ user_git_configs : "configures"
    users ||--o{ ai_settings : "configures"
    users ||--o{ alert_configs : "configures"
    users ||--o{ alert_recipients : "receives"
```

---

## 3. User Journey

End-to-end flow from account creation to a passing test run.

```mermaid
flowchart TD
    A([Super Admin]) -->|1 Create organization| B[Organization created]
    B -->|2 Send email invite to Org Admin| C[Invite token emailed]
    C -->|3 Org Admin registers with token| D[Account created & joined org]

    D -->|4 Create project| E[Project record saved in DB]
    E -->|5 Auto-scaffold workspace folders| F["git-workspaces/admin/Project_Name/\nCollection/ENV/testData · script · config"]

    F -->|6 Configure AI provider| G["AI key saved AES-256-CBC encrypted\nOpenAI GPT-4o or Anthropic Claude"]

    G -->|7 Add API Source collection| H{Import method}
    H -->|Postman JSON upload| I[Postman v2.1 parser → endpoints]
    H -->|Swagger / OpenAPI| J[OpenAPI 3 / Swagger 2 parser → endpoints]
    H -->|cURL paste| K[cURL parser → single endpoint]
    H -->|Raw JSON| L[Manual endpoint array]
    I & J & K & L --> M[Collection saved to DB\njson_content = normalized endpoint array]

    M -->|8 Run Pre-run on API Source| N["POST /api/ai/pre-run\nFire all endpoints live · 5s timeout · SSRF-safe"]
    N -->|Capture auth tokens\n401 retry with extracted token| O["Pre-run responses saved\nto collections.pre_run_data\nHash stored for freshness check"]

    O -->|9 Upload CSV test data| P["CSV tagged by collection + env\nColumns parsed & stored"]

    P -->|10 Invite regular users| Q[Users assigned to project]
    Q -->|11 Configure env URLs| R[Per-env URL/port config saved]

    R -->|12 Create Test Plan| S["Test suite record created\nLinked to collection + env + test data\nvusers · rampup · duration configured"]

    S -->|13 Generate JMX/K6 script| T["AI assembles JMX/K6 from:\n- Collection endpoints\n- Merged config (global → project → env → suite)\n- CSV column names\n- Pre-run correlation data\n- Performance rules as thresholds"]

    T -->|Script written to disk| U["git-workspaces/user-id/Project/Collection/ENV/script/suite_load.jmx"]

    U -->|14 Run test| V["docker run justb4/jmeter\nSSE stream to frontend"]

    V -->|Pass| W["Results saved · HTML report generated\nEmail alert with analytics PDF"]
    V -->|Fail| X["Auto Healer:\nRead errors → AI fix → Re-run up to 3 times"]
    X --> W

    W -->|15 Commit & push to Git| Y{Role}
    Y -->|Org Admin| Z[Push direct to main branch]
    Y -->|Regular user| AA[Push to users/name branch\nRaise PR → Org Admin merges]
```

---

## 4. Role-Based Access Model

```mermaid
flowchart TD
    SA["Super Admin\n(platform-wide)"]
    OA["Org Admin\n(per organization)"]
    U["Regular User\n(per assigned project)"]

    SA -->|"Create / manage organizations"| SA1[Organizations CRUD]
    SA -->|"Invite org admins"| SA2[Email invite with token]
    SA -->|"Suspend / activate users"| SA3[User management]
    SA -->|"Configure platform SMTP"| SA4[Global SMTP settings]
    SA -->|"No project access\n(UI shows Settings only)"| SA5[Hidden: Dashboard · Projects]

    OA -->|"CRUD projects in own org"| OA1[Projects]
    OA -->|"Configure AI key"| OA2[OpenAI / Claude API key]
    OA -->|"Set up git integration\n(remote URL · PAT)"| OA3[Git config per project]
    OA -->|"Push to main branch directly"| OA4[No PR required]
    OA -->|"Merge PRs from users"| OA5[PR lifecycle management]
    OA -->|"Invite & assign users to projects"| OA6[Project assignments]
    OA -->|"Generate CI YAML for admin workspace"| OA7[git-workspaces/admin/]

    U -->|"Access only assigned projects"| U1[project_assignments table]
    U -->|"Upload test data (own env)"| U2[CSV per collection + env]
    U -->|"Configure env URLs"| U3[collection_env_config]
    U -->|"Create & run test plans"| U4[Test suites + execution]
    U -->|"Push to users/name branch only"| U5[No direct main access]
    U -->|"Generate CI YAML to own workspace"| U6[git-workspaces/user-id/]
    U -->|"Raise PR to main"| U7[Via PerfStudio or GitHub]
```

---

## 5. AI Script Generation Flow

How a test plan becomes an executable JMeter or K6 script.

```mermaid
sequenceDiagram
    actor User
    participant UI as Frontend
    participant API as testSuites.js Route
    participant DB as SQLite Database
    participant AI as aiClient.js
    participant LLM as LLM Provider
    participant FS as File System

    User->>UI: Click "Generate Script"
    UI->>API: POST /api/projects/:id/test-suites/:suiteId/generate

    API->>DB: Fetch test suite (engine, test_type, vusers, rampup, duration, env)
    API->>DB: Fetch linked collection (json_content, pre_run_data)
    API->>DB: Fetch test data files (CSV paths + column names)
    API->>DB: Fetch performance rules (metric, operator, value, severity)
    API->>DB: Fetch global_config → project_config → collection_env_config
    API->>API: Merge config (DEFAULT → global → project → env → suite)

    Note over API: Pre-run data read from collection.pre_run_data<br/>(no longer passed from frontend)

    alt engine = jmeter
        API->>API: buildJmxTemplate()<br/>deterministic JMX builder<br/>no LLM needed for JMeter
        API->>API: Login endpoint detected? → add JSONPostProcessor extractor
        API->>API: CSV columns → CSVDataSet + variable substitution
        API->>API: Folders from Postman? → SimpleController grouping
        API->>API: cleanScript() → strip markdown fences + fixJmxHashTrees()
    else engine = k6
        API->>AI: callAi(userId, systemPrompt, userPrompt)
        AI->>DB: Read ai_settings (provider, api_key encrypted)
        AI->>AI: decrypt(api_key)
        AI->>LLM: generateText(k6 system prompt + endpoints + CSV + correlation + thresholds)
        LLM-->>AI: Raw K6 JavaScript
        AI-->>API: Script content
        API->>API: cleanScript() → strip markdown fences
    end

    API->>API: getUserProjectPath(userId, role, projectName)
    API->>API: isAdminWorkspace()? → reject if admin workspace
    API->>FS: mkdirSync(collection/ENV/script/)
    API->>FS: writeFileSync(suiteName_testType.jmx)
    API->>DB: UPDATE test_suites SET jmx_path = filePath, status = 'generated'
    API-->>UI: { ok: true, filename, path }
    UI->>UI: Show download button + Re-generate option
```

---

## 6. Pre-Run Flow

How live API responses are captured to power correlation and token extraction in generated scripts.

```mermaid
sequenceDiagram
    actor User
    participant UI as Collections.jsx
    participant API as ai.js Route
    participant DB as SQLite
    participant NET as External API Endpoints

    User->>UI: Click "Run Pre-run" on an API Source card
    UI->>API: POST /api/ai/pre-run { collection_id, project_id }

    API->>DB: Verify ownsProject(userId, project_id)
    API->>DB: SELECT * FROM collections WHERE id = collection_id
    API->>API: Parse json_content → endpoints array (max 20)

    Note over API,NET: Phase 1 — Fire all endpoints in parallel (Promise.all)

    loop For each endpoint
        API->>API: isSafeUrl()? Block RFC1918 + loopback (SSRF protection)
        API->>NET: fetch(url, { method, headers, body, signal: AbortController 5s })
        NET-->>API: { status, statusText, headers, body }
        API->>API: extractToken(body, responseHeaders)<br/>Checks token/access_token/jwt/bearer keys
        API->>API: extractCookies(set-cookie header)
    end

    API->>API: Find first extracted auth token from successful responses

    Note over API,NET: Phase 2 — Retry any 401s with extracted token

    loop For each 401 response
        API->>NET: fetch(url, { Authorization: Bearer token })
        NET-->>API: { status, body }
        API->>API: Mark tokenInjected: true
    end

    API->>API: simpleHash(collection.json_content) → freshness hash
    API->>DB: UPDATE collections SET pre_run_data = responses, pre_run_collection_hash = hash
    API-->>UI: { responses[], extractedToken: '(present)' }

    UI->>UI: setPreRunData({ [collectionId]: responses })
    UI->>UI: Re-fetch collections to get updated pre_run_collection_hash
    UI->>UI: Show pass/fail counts + "Show Logs" button

    Note over UI: Freshness gate in Test Plans:<br/>simpleHash(json_content) === pre_run_collection_hash<br/>→ only then enable "Generate Script"
```

---

## 7. Test Execution Flow

How a test run is triggered, streamed, and reported.

```mermaid
flowchart TD
    A([User clicks Run Test]) --> B[POST /api/execution/:projectId/:suiteId]
    B --> C[Create execution_runs record\nstatus: running]
    C --> D[Resolve user workspace path\ngetUserProjectPath]
    D --> E[patchJmx.js — inject runtime params\nvusers · rampup · duration · URLs into JMX]
    E --> F[ruleEvaluator.js — load rules\nfor pass/fail evaluation]

    F --> G{Engine}
    G -->|JMeter| H["docker run -v project_path:/data\nperf-studio-runner\njmeter -n -t /data/script.jmx\n-l /data/results.jtl -e -o /data/report/"]
    G -->|K6| I["docker run -v project_path:/data\nperf-studio-runner\nk6 run /data/script.js"]

    H & I --> J["SSE stream → frontend\ndata: {type, message} per log line\nheartbeat ping every 1s"]

    J --> K[Process exits]
    K --> L[Parse results.jtl / results.json]
    L --> M[ruleEvaluator → check each rule\nResponse Time · Error Rate · Throughput]
    M --> N{All rules pass?}

    N -->|Pass| O[status: passed]
    N -->|Fail| P{auto_heal enabled?}
    P -->|Yes — attempt ≤ 3| Q[Auto Healer — see flow 8]
    P -->|No| R[status: failed]
    Q -->|Healed| O
    Q -->|Max attempts| R

    O & R --> S[Save logs + result_dir to DB]
    S --> T[generateAnalyticsPdf.js\nCharts: response times · throughput · error rate]
    T --> U[sendAlertEmail:\nPDF analytics + HTML report ZIP\nto all alert_recipients]
    U --> V([Results shown in Analytics + Reports panels])
```

---

## 8. Auto-Heal Flow

How failed test scripts are automatically diagnosed and fixed by AI.

```mermaid
sequenceDiagram
    participant Exec as Test Executor
    participant Healer as autoHealer.js
    participant DB as SQLite
    participant AI as aiClient.js
    participant LLM as LLM Provider
    participant FS as File System

    Exec->>Healer: triggerHeal(runId, suiteId, projectId, errorLog)

    loop Up to 3 attempts
        Healer->>DB: INSERT auto_heal_logs (attempt, run_id)
        Healer->>FS: Read current JMX/K6 script
        Healer->>DB: Read ai_settings (heal_model)
        Healer->>AI: callAi(userId, healSystemPrompt,\n"Fix this script given errors:\n" + errorLog + "\nScript:\n" + scriptContent)
        AI->>LLM: generateText(heal prompt)
        LLM-->>AI: Fixed script content
        AI-->>Healer: Fixed script
        Healer->>Healer: cleanScript() → validate output
        Healer->>FS: Overwrite script file with fix
        Healer->>DB: UPDATE auto_heal_logs SET fix_applied = diff

        Healer->>Exec: Re-run test suite (new execution_run)
        Exec-->>Healer: { passed, error }

        alt passed
            Healer->>DB: UPDATE auto_heal_logs SET result = healed
            Healer->>DB: UPDATE execution_runs SET heal_status = healed
            Healer->>Healer: sendAlertEmail (heal success report)
            Healer-->>Exec: done
        else still failing
            Healer->>DB: UPDATE auto_heal_logs SET result = failed
            Note over Healer: Continue to next attempt
        end
    end

    Healer->>DB: UPDATE execution_runs SET heal_status = exhausted
```

---

## 9. Git & CI Integration Flow

How test scripts are versioned, pushed, and merged via Git.

```mermaid
sequenceDiagram
    actor OrgAdmin as Org Admin
    actor RegUser as Regular User
    participant UI as GitPanel.jsx
    participant API as git.js Route
    participant FS as Local Workspace
    participant Git as simple-git
    participant Remote as GitHub / GitLab
    participant CI as GitHub Actions / GitLab CI

    OrgAdmin->>UI: Configure git settings\n(remote URL · PAT · base branch)
    UI->>API: POST /api/projects/:id/git/init
    API->>API: Encrypt PAT (AES-256-CBC)
    API->>FS: mkdir git-workspaces/admin/ProjectName
    API->>Git: git init · git remote add origin
    API-->>UI: Repository initialized

    RegUser->>UI: Set personal git identity\n(branch name · author · personal PAT)
    UI->>API: POST /api/projects/:id/git/user-config
    API->>API: Encrypt personal PAT (AES-256-CBC)
    API->>FS: mkdir git-workspaces/user-{id}/ProjectName
    API-->>UI: User workspace ready

    Note over UI,Remote: Daily workflow — commit & push

    RegUser->>UI: View changed files in GitPanel\n(file list with scroll · max 320px)
    UI->>API: GET /api/projects/:id/git/status
    API->>Git: git status in user workspace
    API-->>UI: { files[], branch, ahead, behind }

    RegUser->>UI: Enter commit message · click Commit & Push
    UI->>API: POST /api/projects/:id/git/push\n{ message, files[] }
    API->>Git: git add <selected files>
    API->>Git: git commit --author="name <email>"
    API->>Git: git push origin users/name (PAT in URL at runtime)
    Git->>Remote: Push to users/name branch
    API->>DB: INSERT git_commits record
    API-->>UI: { ok, hash, branch }

    RegUser->>UI: Raise Pull Request
    UI->>API: POST /api/projects/:id/git/pr\n{ title, from: users/name, to: main }
    API->>Remote: GitHub/GitLab API — create PR
    API->>DB: INSERT git_prs (pr_number, status: open)
    API-->>UI: PR created

    OrgAdmin->>UI: Review & merge PR
    UI->>API: POST /api/projects/:id/git/merge/:prId
    API->>Git: git merge --no-ff --allow-unrelated-histories
    API->>Git: git push origin main (org admin PAT)
    API->>Remote: GitHub/GitLab API — merge PR
    API->>DB: UPDATE git_prs SET status = merged
    Remote->>CI: Push to main triggers CI workflow
    CI-->>Remote: Test pipeline runs
```

---

## 10. CI Pipeline Flow

How sequential performance test pipelines are configured, triggered, and tracked.

```mermaid
sequenceDiagram
    actor User
    participant UI as PipelineConfig.jsx
    participant API as pipelines.js + ciPipeline.js
    participant DB as SQLite
    participant FS as File System
    participant Git as Git Workspace
    participant CI as GitHub Actions / GitLab CI

    Note over User,CI: Setup — configure pipeline

    User->>UI: Create pipeline (name · test plan steps · stop_on_failure)
    UI->>API: POST /api/projects/:id/pipelines
    API->>DB: INSERT pipeline_configs (steps as JSON array)
    API-->>UI: Pipeline saved

    User->>UI: Generate CI YAML file
    UI->>API: POST /api/projects/:id/ci/generate-yaml
    API->>DB: Fetch test suites to get script paths
    API->>DB: Resolve user role → select workspace\norg_admin → git-workspaces/admin/\nregular user → git-workspaces/user-id/
    API->>DB: Fetch user branch from user_git_configs
    API->>FS: Write gitlab-ci.yml / github-actions.yml\nwith correct branch refs auto-populated
    API-->>UI: { message: "Generated — push to <branch>" }

    User->>UI: Commit & push YAML via GitPanel
    Git->>CI: CI provider detects workflow file

    Note over User,CI: Runtime — trigger pipeline run

    User->>UI: Click Run Pipeline
    UI->>API: POST /api/projects/:id/pipelines/:id/run
    API->>DB: INSERT pipeline_runs (status: running)
    API->>API: Setup SSE stream → frontend

    loop For each step (sequential)
        API->>API: runSuite(suiteId, projectId, userId)
        API->>API: docker run JMeter/K6 for this step
        API->>API: Evaluate rules → pass/fail
        API->>DB: UPDATE pipeline_runs steps_result[i]
        API-->>UI: SSE { step_update: { index, status } }
        alt stop_on_failure = true AND step failed
            API->>API: Mark remaining steps as skipped
            Note over API: Break loop
        end
    end

    API->>DB: UPDATE pipeline_runs SET status = completed/failed
    API->>API: sendAlertEmail (pipeline summary)
    API-->>UI: SSE { done: true, passed, failed, skipped }
```

---

## 11. Alert & Email Flow

How test results trigger email notifications with analytics.

```mermaid
sequenceDiagram
    participant Exec as Test Executor
    participant Email as emailUtils.js
    participant PDF as generateAnalyticsPdf.js
    participant SMTP as SMTP Server
    participant Rcpt as Alert Recipients

    Exec->>Email: sendAlertEmail(runId, userId, projectId, reportData)
    Email->>DB: getAlertConfig(userId) — SMTP credentials\ndecrypt smtp_pass (AES-256-CBC)
    Email->>DB: getRecipients(userId, projectId) — email list
    Email->>PDF: generateAnalyticsPdf(reportData)

    PDF->>PDF: Build charts:\n- Response time distribution\n- Throughput over time\n- Error rate trend\n- Rule violations table
    PDF->>PDF: Puppeteer → HTML → PDF buffer
    PDF-->>Email: PDF buffer

    Email->>Email: Build HTML email template\n- Run summary (pass/fail/duration)\n- Rule violations highlighted\n- Org branding

    alt JMeter HTML report exists on disk
        Email->>Email: archiver → ZIP HTML report folder
        Email->>Email: Attach ZIP as jmeter-report.zip
    end

    Email->>Email: Attach analytics.pdf
    Email->>SMTP: nodemailer.sendMail()\ntransport: host · port · auth · TLS
    SMTP->>Rcpt: Email delivered
```

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
flowchart LR
    subgraph Auth["Authentication"]
        JWT["JWT HS256\n14-day expiry\nstored in localStorage"]
        BCrypt["bcrypt\n10 rounds\npassword hashing"]
        Reset["Password Reset\n30-min token\nexpires on use"]
    end

    subgraph AuthZ["Authorization"]
        Middleware["auth middleware\nverifies JWT on every route"]
        RoleCheck["Role checks\nsuper_admin · org_admin · user"]
        OwnsProject["ownsProject()\nowner · assigned · org scope"]
    end

    subgraph Crypto["Encryption at Rest"]
        AES["AES-256-CBC\nall secrets in SQLite"]
        Keys["Encrypted fields:\nAI API keys · Git PATs\nSMTP passwords · CI tokens"]
    end

    subgraph Network["Network Security"]
        CORS["Strict CORS\nCORS_ORIGIN env var"]
        SSRF["SSRF Protection\nBlock RFC1918 + loopback\nin pre-run endpoint"]
        PAT["PAT injection\nURL at runtime only\nnever in .git/config"]
    end

    subgraph Docker["Container Security"]
        NonRoot["Non-root user\nin JMeter + K6 containers"]
        ReadOnly["Read-only source mounts\nfor script files"]
    end
```

| Concern | Implementation |
|---|---|
| **Authentication** | JWT HS256, 14-day expiry, `auth` middleware on all routes |
| **Password storage** | bcrypt, 10 rounds |
| **Password reset** | Single-use token, 30-minute expiry |
| **API keys / PATs / SMTP passwords** | AES-256-CBC encrypted in SQLite — never returned via API |
| **Git push authentication** | PAT injected into HTTPS URL at runtime only, never persisted in `.git/config` |
| **Route authorization** | Role checks per operation; `ownsProject()` for all project-scoped routes |
| **SSRF protection** | Pre-run blocks RFC1918 IPs, loopback, and requires http/https scheme |
| **CORS** | Strict origin whitelist via `CORS_ORIGIN` env var |
| **Docker containers** | Non-root user; read-only source mounts |
| **Invite system** | Scoped token per email+org+role; expires 7 days after creation |

---

## 14. Technology Stack

| Layer | Technology |
|---|---|
| **Frontend** | React 18, Vite 5, axios, react-chartjs-2 / chart.js |
| **Backend** | Node.js, Express 4, nodemon (dev) |
| **Database** | SQLite via `node:sqlite` (built-in, no native deps) |
| **AI Generation** | OpenAI GPT-4o (`openai` SDK) · Anthropic Claude (`@anthropic-ai/sdk`) |
| **Test Engines** | Apache JMeter · Grafana K6 — both run inside the `perf-studio-runner` Docker image (Java · Node.js pre-installed) |
| **Git Integration** | `simple-git` (local ops) · `@octokit/rest` (GitHub API) · GitLab REST API |
| **Email** | `nodemailer` (SMTP transport, TLS) |
| **PDF Reports** | `puppeteer` (HTML → PDF) · `pdfkit` |
| **Excel / CSV** | `xlsx` (frontend parsing) · custom CSV parser (backend) |
| **Encryption** | `crypto` (Node built-in AES-256-CBC) · `bcryptjs` |
| **File uploads** | `multer` (memory + disk storage) |
| **Backups** | `archiver` (ZIP on project delete) |
| **Containerisation** | Docker · Docker Compose (all-in-one + multi-service modes) |
| **CI/CD** | GitHub Actions (`workflow_dispatch`) · GitLab CI (`pipeline_trigger`) |
| **Deployment** | Single Docker image (`Dockerfile`) or Compose stack |
