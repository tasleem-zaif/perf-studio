# Performance Studio — Architecture

## System Overview

```mermaid
graph TB
    subgraph Browser["Browser (User)"]
        UI["React Frontend\n(Vite + Nginx)"]
    end

    subgraph Backend["Backend (Node.js)"]
        API["Express API\n:3001"]
        Auth["Auth Middleware\n(JWT)"]
        Routes["Route Handlers"]
        AI["AI Engine\n(OpenAI / Claude)"]
        Healer["Auto Healer"]
        Email["Email Alerts\n(Nodemailer)"]
        Enc["Encryption\n(AES-256-CBC)"]
    end

    subgraph Storage["Persistence"]
        DB["SQLite\n(better-sqlite3)"]
        FS["File System\n/data/projects"]
    end

    subgraph Execution["Test Execution (Docker)"]
        JMeter["JMeter Container\njustb4/jmeter"]
        K6["K6 Container\ngrafana/k6"]
    end

    subgraph External["External Services"]
        GPT["OpenAI GPT-4o"]
        Claude["Anthropic Claude"]
        SMTP["SMTP Server\n(Gmail / Outlook)"]
    end

    UI -->|"REST + SSE"| API
    API --> Auth --> Routes
    Routes --> DB
    Routes --> FS
    Routes --> AI
    AI --> GPT
    AI --> Claude
    Routes -->|"docker run"| JMeter
    Routes -->|"docker run"| K6
    JMeter -->|"results.jtl"| FS
    K6 -->|"results.json"| FS
    Healer --> AI
    Healer -->|"re-run"| JMeter
    Routes --> Email --> SMTP
    Routes --> Enc
```

## Data Model

```mermaid
erDiagram
    organizations ||--o{ users : "has"
    users ||--o{ projects : "owns"
    projects ||--o{ collections : "has"
    projects ||--o{ rules : "has"
    projects ||--o{ project_config : "has"
    collections ||--o{ test_suites : "linked to"
    collections ||--o{ test_data_files : "has"
    collections ||--o{ collection_env_config : "per env"
    test_suites ||--o{ execution_runs : "generates"
    execution_runs ||--o{ auto_heal_logs : "may have"
    users ||--o{ ai_settings : "configures"
    users ||--o{ alert_configs : "configures"
    users ||--o{ alert_recipients : "has"
    users ||--o{ global_config : "has"

    organizations { int id; string name; string slug }
    users { int id; string email; string name; string role; int org_id }
    projects { int id; string name; int user_id; string uuid; string folder_path }
    collections { int id; string name; int project_id; string environments; string json_content }
    collection_env_config { int id; int collection_id; string env; string config_json }
    test_suites { int id; string name; int collection_id; string env; string engine }
    execution_runs { int id; int suite_id; string status; string result_dir }
```

## Multi-Environment Architecture

```mermaid
graph LR
    subgraph Collection["API Collection"]
        QA["QA Environment\nqa-api.company.com"]
        Staging["Staging\nstaging-api.company.com"]
        UAT["UAT\nuat-api.company.com"]
    end

    subgraph QA_Data["QA Data"]
        QA_TD["testData/"]
        QA_SC["script/"]
        QA_RS["results/"]
        QA_CF["config/config.json"]
    end

    subgraph Staging_Data["Staging Data"]
        ST_TD["testData/"]
        ST_SC["script/"]
        ST_RS["results/"]
        ST_CF["config/config.json"]
    end

    QA --> QA_Data
    Staging --> Staging_Data
    UAT --> UAT_Data

    subgraph UAT_Data["UAT Data"]
        UA_TD["testData/"]
        UA_SC["script/"]
    end
```

## Test Execution Flow

```mermaid
sequenceDiagram
    participant User
    participant Frontend
    participant Backend
    participant Docker
    participant AI

    User->>Frontend: Click Run Test (QA)
    Frontend->>Backend: POST /execution/run {suite_id, env}
    Backend->>Backend: Load env config (qa-api.com)
    Backend->>Backend: Patch JMX with env URLs
    Backend->>Docker: docker run justb4/jmeter -n -t script.jmx
    Docker-->>Backend: SSE log stream
    Backend-->>Frontend: Real-time logs
    Docker->>Backend: results.jtl
    Backend->>Backend: Evaluate rules
    alt Rules violated
        Backend->>AI: Diagnose failure
        AI-->>Backend: Fixed JMX
        Backend->>Docker: Re-run (attempt 1/3)
    end
    Backend->>Backend: Generate analytics
    Backend->>Backend: Send alert email (PDF)
    Backend-->>Frontend: Test complete
```

## AI Script Generation Flow

```mermaid
sequenceDiagram
    participant User
    participant Frontend
    participant Backend
    participant AI_Model

    User->>Frontend: Click Generate Script (QA)
    Frontend->>Backend: POST /test-suites/:id/generate
    Backend->>Backend: Load collection endpoints
    Backend->>Backend: Load env config (URLs)
    Backend->>Backend: Load test data files
    Backend->>Backend: Load rules
    Backend->>AI_Model: System + User prompt
    note over AI_Model: GPT-4o or Claude Sonnet\ngenerates JMX/K6 script
    AI_Model-->>Backend: Raw JMX/JS script
    Backend->>Backend: Validate (sampler count check)
    Backend->>Backend: Write to collection/QA/script/
    Backend->>Backend: Update config.json
    Backend-->>Frontend: Script ready
```

## Security Model

```mermaid
graph TB
    Request["HTTP Request"]
    JWT["JWT Middleware\n(validate token)"]
    Ownership["Ownership Check\n(user owns project?)"]
    Handler["Route Handler"]
    Enc["AES-256-CBC\n(API keys, SMTP passwords)"]
    NonRoot["Non-root Docker user\n(uid 1001)"]

    Request --> JWT
    JWT -->|valid| Ownership
    JWT -->|invalid| 401
    Ownership -->|owns| Handler
    Ownership -->|not owner| 403
    Handler --> Enc
    Handler --> NonRoot
```

## Directory Structure

```
perf-studio/
├── backend/                    ← Node.js Express API
│   ├── src/
│   │   ├── db/index.js         ← SQLite schema + migrations
│   │   ├── routes/             ← API route handlers
│   │   ├── middleware/         ← Auth, validation
│   │   └── utils/              ← AI, email, encryption, JMX patching
│   ├── Dockerfile
│   └── docker-entrypoint.sh
├── frontend/                   ← React + Vite → Nginx
│   ├── src/
│   │   ├── components/         ← Shared UI components
│   │   ├── pages/              ← Page components
│   │   └── utils/              ← Display helpers
│   ├── Dockerfile
│   └── nginx.conf
├── projects/                   ← Per-project data (gitignored)
│   └── ProjectName_ID_UUID/
│       └── CollectionName_ID/
│           ├── QA/             ← QA environment (fully isolated)
│           │   ├── testData/
│           │   ├── script/
│           │   ├── results/
│           │   └── config/config.json
│           └── Staging/        ← Staging environment
├── docs/
│   └── ARCHITECTURE.md
├── .github/workflows/
│   └── docker-publish.yml      ← Auto-build on push to main
├── docker-compose.yml
└── .env.example
```
