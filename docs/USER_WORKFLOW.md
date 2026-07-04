# Performance Studio — End User Workflow Guide

This guide walks you through using Performance Studio from start to finish — from setting up your account to running performance tests and reading reports.

---

## Table of Contents

1. [Roles Overview](#1-roles-overview)
2. [Getting Started — First Login](#2-getting-started--first-login)
3. [Super Admin — Organisation & Licensing Setup](#3-super-admin--organisation--licensing-setup)
4. [Org Admin — Project Setup](#4-org-admin--project-setup)
5. [Adding an API Source (Collection)](#5-adding-an-api-source-collection)
6. [Running Pre-Run on an API Source](#6-running-pre-run-on-an-api-source)
7. [Uploading Test Data (CSV)](#7-uploading-test-data-csv)
8. [Configuring Performance Rules](#8-configuring-performance-rules)
9. [Configuring Environment URLs](#9-configuring-environment-urls)
10. [Creating a Test Plan](#10-creating-a-test-plan)
11. [Generating a Test Script](#11-generating-a-test-script)
12. [Running Tests via CI Pipeline](#12-running-tests-via-ci-pipeline)
13. [Viewing Analytics & Reports](#13-viewing-analytics--reports)
14. [Exporting Analytics as PDF](#14-exporting-analytics-as-pdf)
15. [Git Workflow — Commit, Push & Pull Request](#15-git-workflow--commit-push--pull-request)

---

## 1. Roles Overview

Performance Studio has three user roles. Each role sees a different set of features.

| Role | Who | Can Do |
|---|---|---|
| **Super Admin** | Platform administrator | Create organisations, set license plans/limits/expiry, invite Org Admins — no project-level access of their own |
| **Org Admin** | Team lead / QA Manager | Create projects (up to the org's license limit), configure AI & Git, invite users, approve PRs |
| **User** | QA Engineer / Developer | Access assigned projects, create test plans, run tests, push to feature branch |

---

## 2. Getting Started — First Login

1. Open the application URL in your browser
2. Enter your **email** and **password** (you will have received an invitation email)
3. Click **Sign In**

> If you are the first person setting up the platform, use the default Super Admin credentials provided by your administrator.

---

## 3. Super Admin — Organisation & Licensing Setup

> This section is for Super Admins only. Super Admins have no Sidebar — the **Organizations** console described below is their only page after login.

### 3.1 The Organizations Console

Stat cards at the top show org and license-plan counts at a glance. Below that is an org list on the left and a detail panel on the right with four tabs once you select an org:

| Tab | Purpose |
|---|---|
| **Overview** | Read-only summary — plan, user/project counts vs. limits, status |
| **Edit Details** | Name, description, website, industry |
| **License & Limits** | Change plan tier, clear/extend expiry, enable or disable the org |
| **Org Admins** | View/manage the org's admin users; configure org-wide SMTP for this org |

### 3.2 Create an Organisation

1. Click **New Organization**
2. Enter the name, description, website, industry
3. Pick a **plan tier** — trial / starter / growth / business / enterprise (see table below); each tier sets max users, max projects, and a default license duration
4. Optionally enter an **admin email** to send the first Org Admin invite immediately — leave blank to invite one later from the **Org Admins** tab
5. Click **Create Organization**

| Plan | Max Users | Max Projects | Duration |
|---|---|---|---|
| Trial (default) | 2 | 1 | 7 days |
| Starter | 5 | 3 | 180 days |
| Growth | 15 | 10 | 180 days |
| Business | 30 | 20 | 180 days |
| Enterprise | Unlimited | Unlimited | 180 days |

### 3.3 Manage an Organisation's License

From the **License & Limits** tab you can:
- Change the plan tier (updates user/project limits and resets the expiry window to that plan's default)
- Disable an org — blocks login/access for every user in that org except super admins, immediately
- Re-enable a disabled org

When an org's license expires or is disabled, non-super-admin users in that org get a clear "license expired" / "organization disabled" error instead of a generic failure.

### 3.4 Manage Org Admins

From the **Org Admins** tab you can view existing org admins for the selected organisation and invite additional ones — same invite-by-email flow as creating the org's first admin.

---

## 4. Org Admin — Project Setup

> This section is for Org Admins.

### 4.1 Configure AI Provider

Before creating projects, set up your AI provider so scripts can be generated.

1. Go to **Settings** in the sidebar
2. Select provider: **OpenAI** or **Anthropic**
3. Paste your API key
4. Click **Save**

> The API key is stored encrypted. It is never shown again after saving.

### 4.2 Create a Project

1. Go to **Dashboard** → click **New Project**
2. Enter project name and description
3. Click **Create Project**

The project workspace folders are created automatically on disk.

### 4.3 Invite Users to a Project

1. Open the project
2. Go to **Settings** (inside the project)
3. Click **Invite User**, enter their email and select a role
4. The user will be able to access this project after accepting

---

## 5. Adding an API Source (Collection)

An API Source is the list of API endpoints you want to performance test. You can import from Postman, Swagger, cURL, or raw JSON.

1. Open your project
2. Click **API Sources** in the sidebar
3. Click **Add API Source**
4. Fill in the details:
   - **Name** — a label for this collection
   - **Source Type** — choose one:
     - **Postman Collection** — upload a `.json` export from Postman
     - **Swagger / OpenAPI** — upload a `.json` or `.yaml` spec file
     - **cURL** — paste a cURL command
     - **Raw JSON** — paste an array of endpoint objects
5. Click **Save**

The endpoints are parsed and stored. You can view and edit them after saving.

---

## 6. Running Pre-Run on an API Source

Pre-Run fires all your API endpoints live to capture real responses, extract authentication tokens, and detect dynamic values. This data is used by the AI to generate accurate test scripts.

> **Pre-Run must be completed before generating a test script.**

1. Open **API Sources**
2. Find your collection and click **Run Pre-run**
3. The application fires every endpoint in the collection (in bounded-concurrency batches, 5-second timeout each)
4. Results appear showing **pass / fail** for each endpoint
5. Click **Show Logs** to see the full response for any endpoint
6. A green indicator confirms the pre-run is fresh

**When to re-run:** If you update the API Source (add/remove/change endpoints), the pre-run becomes stale and the script generation gate will block until you run it again.

---

## 7. Uploading Test Data (CSV)

Test data CSV files allow your scripts to send different data (usernames, product IDs, etc.) for each virtual user.

1. Open your project → click **Test Data** in the sidebar
2. Click **Upload Test Data**
3. Select your `.csv` file
4. Choose the **Collection** and **Environment** this data belongs to
5. Click **Upload**

The columns in your CSV will automatically be available as variables in generated scripts (e.g. `${username}`, `${password}`).

---

## 8. Configuring Performance Rules

Rules define what counts as a pass or fail for your test. The AI uses these rules as thresholds when generating scripts.

1. Open your project → click **Rules** in the sidebar
2. Click **Add Rule**
3. Configure:
   - **Metric** — Response Time, Error Rate, or Throughput
   - **Operator** — less than, greater than, equals
   - **Value** — the threshold number
   - **Unit** — ms, %, req/s
   - **Severity** — Warning or Error
4. Click **Save**

**Examples:**
| Metric | Operator | Value | Meaning |
|---|---|---|---|
| Response Time | less than | 500 | All responses must be under 500ms |
| Error Rate | less than | 1 | Error rate must stay below 1% |
| Throughput | greater than | 100 | Must sustain at least 100 req/s |

---

## 9. Configuring Environment URLs

Each environment (QA, Staging, UAT, Production) can have its own base URL so the same test plan runs against different environments without changing the script.

1. Open your project → click **Configuration** in the sidebar
2. Select the **Collection** and **Environment**
3. Enter the **Base URL**, **Port**, and **Protocol**
4. Click **Save**

---

## 10. Creating a Test Plan

A Test Plan defines how the performance test will run — which collection to test, how many users, for how long, and with what data.

1. Open your project → click **Test Plans** in the sidebar
2. Click **New Test Plan**
3. Fill in the form:

| Field | Description |
|---|---|
| **Name** | A label for this test plan |
| **Test Type** | Load, Stress, Spike, or Endurance |
| **Engine** | JMeter |
| **API Source** | Select the collection to test |
| **Environment** | QA, Staging, UAT, or Production |
| **Virtual Users** | Number of concurrent users to simulate |
| **Ramp-up** | Seconds to gradually reach the target user count |
| **Duration** | Total test duration in seconds |
| **Test Data** | Select CSV files (use the search box to filter by filename) |

4. Click **Save**

---

## 11. Generating a Test Script

Once a Test Plan is saved, you can generate the JMeter script using AI.

1. Open **Test Plans**
2. Find your test plan — if the linked API Source pre-run is **not fresh**, you will see an amber warning:
   > *Pre-run required — Run a pre-run on the [Collection Name] API Source before generating a script*
   
   Click **Go to API Sources** and complete the pre-run first.

3. Once pre-run is fresh, click **Generate Script**
4. The AI assembles the JMX script using:
   - Your API endpoints
   - Environment configuration
   - CSV test data columns
   - Pre-run correlation data (extracted tokens, dynamic values)
   - Performance rules as thresholds
5. When complete, a **Download Script** button appears — you can download the `.jmx` file to inspect it

> To regenerate after changes, click **Re-generate Script** at any time.

---

## 12. Running Tests via CI Pipeline

Performance Studio runs tests through a CI Pipeline — a sequential set of test plans executed one after another.

### 12.1 Create a Pipeline

1. Go to **CI/CD** in the sidebar
2. Click **New Pipeline**
3. Enter a name and add test plan steps in order
4. Toggle **Stop on failure** if you want the pipeline to halt when a step fails
5. Click **Save**

### 12.2 Run the Pipeline

1. Find your pipeline and click **Run**
2. A live log window opens showing real-time output
3. Each step shows its status: **Running → Passed / Failed**
4. If a step fails and auto-heal is enabled, the AI will attempt to fix the script and re-run automatically (up to 3 attempts)
5. When all steps complete, the pipeline shows a summary:
   - ✔ Steps passed
   - ✘ Steps failed
   - ⊘ Steps skipped (if stop on failure triggered)

### 12.3 Understanding Test Types

| Type | Pattern | Use For |
|---|---|---|
| **Load** | Steady load at target users | Baseline performance |
| **Stress** | Gradually increase until system breaks | Finding limits |
| **Spike** | Sudden burst of traffic | Flash sale / event simulation |
| **Endurance** | Sustained load over long period | Memory leak detection |

---

## 13. Viewing Analytics & Reports

After a pipeline run completes, results are available in the Analytics section.

1. Click **Analytics** in the sidebar
2. Select your **Environment**
3. Select a **Run** from the dropdown (format: `Run {id} — Test Plan Name — status — date`)
4. Navigate through the tabs:

| Tab | What it shows |
|---|---|
| **Summary Report** | KPIs — total requests, pass/fail counts, avg/min/max response time, P90, P95, bytes |
| **Performance Dashboard** | Charts — avg response time per API, throughput per API, response time over time |
| **Transaction Breakdown** | Table — P90, P95, error rate per endpoint (sortable) |
| **Trend Analysis** | Charts — response time trend, throughput trend, error rate over time, active threads |
| **Resource Utilization** | Charts — network throughput, thread utilization, response time breakdown |
| **Error Analysis** | Charts — error distribution, error rate per API, error timeline; detailed error log table |
| **Logs / Traces** | Raw execution log output from the test run |

---

## 14. Exporting Analytics as PDF

You can export all analytics tabs as a multi-page PDF report to share with stakeholders.

1. Open **Analytics** and select a run
2. Click **Export PDF** (top right)
3. The application automatically cycles through all 6 report tabs and captures each as a page
4. Progress is shown: *Capturing Summary Report (1/6)…*
5. The PDF downloads automatically when complete

The PDF contains all charts exactly as displayed on screen — Response Time, Throughput, Error Rate, Transaction Breakdown, Resource Utilization, and Error Analysis.

---

## 15. Git Workflow — Commit, Push & Pull Request

All generated scripts, test data, and configs are stored in a git workspace. This allows version control and team collaboration.

### For Regular Users

1. After generating scripts or uploading test data, open the **Git** panel (bottom drawer or sidebar)
2. You will see a list of changed files
3. Enter a **commit message** describing your changes
4. Click **Commit & Push**
   - Your changes are pushed to your personal branch: `users/your-name`
5. Click **Raise Pull Request** to request a review from the Org Admin
6. The Org Admin reviews and merges your changes into the main branch

### For Org Admins

1. Open the **Git** panel
2. Commit and push directly to the **main branch** (no PR required)
3. To review and merge a user's PR:
   - Open the **Pull Requests** tab in the Git panel
   - Review the changes
   - Click **Merge** to approve and merge into main

### Best Practices

- Commit after every significant change (new script generated, test data updated, rules changed)
- Use clear commit messages: `feat: add load test for checkout API` or `fix: update CSV path for QA env`
- Always run pre-run and re-generate the script after changing API endpoints
- Keep one test plan per feature or user story for clarity

---

## Quick Reference — End-to-End Checklist

Use this checklist when setting up a new project from scratch.

- [ ] Super Admin creates organisation and invites Org Admin
- [ ] Org Admin logs in and configures AI provider (Settings)
- [ ] Org Admin creates project
- [ ] Org Admin invites users to the project
- [ ] Add API Source (import Postman / Swagger / cURL)
- [ ] Run Pre-Run on the API Source
- [ ] Upload CSV test data files
- [ ] Configure performance rules (response time, error rate, throughput)
- [ ] Configure environment URLs (QA, Staging, etc.)
- [ ] Create test plan (select collection, users, duration, test data)
- [ ] Generate test script (AI creates JMX from all the above)
- [ ] Create CI pipeline and add test plan as a step
- [ ] Run pipeline and monitor live logs
- [ ] View results in Analytics
- [ ] Export PDF report
- [ ] Commit and push scripts via Git panel

---

*Performance Studio — developed by QTSolv*
