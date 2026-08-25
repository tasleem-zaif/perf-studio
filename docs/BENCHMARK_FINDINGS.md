# Benchmark & API Sweep Findings — 2026-08-03/04

Found while answering DevOps sizing questions (concurrent users, response time, RPS) by
benchmarking Peako's own API — first locally, then against the deployed pre-launch server
(`peako.qtsolvdev.com`), then via two full-endpoint coverage sweeps (v1: admin-only; v2:
fresh org with a real regular-user + git/CI flow). Each item below is what was actually
observed, with the exact request/response where available, so it can be re-verified before
being scheduled as a fix.

---

## Confirmed bugs

### 1. Invite acceptance issues a session token that fails immediately
**File:** `backend/src/routes/invites.js:361`
**What happens:** `POST /invites/accept/:token` signs a JWT with only `{ userId }` — no `jti`.
`middleware/auth.js` requires every token to carry a `jti` matching a row in `user_sessions`;
a token without one is rejected with `401 { error: 'Session expired. Please sign in again.' }`
on the very next authenticated request.
**Impact:** Every real new hire who clicks "Accept Invitation" gets what looks like immediate
session expiry and has to log in a second time, unprompted, to actually get in. Reproduced
twice (once per test org) — 100% repro rate.
**Fix direction:** `accept/:token` should create a `user_sessions` row and include a `jti` in
the signed token, the same way `POST /auth/login` does.

### 2. `PUT /api/projects/:id` and `POST /api/projects/:id/ensure-folders` hang for ~5 minutes on an invalid id
**File:** `backend/src/routes/projects.js` (PUT `/:id`, POST `/:id/ensure-folders`)
**What happens:** Called with a non-numeric/undefined `:id` (e.g. `/api/projects/undefined`),
both routes hung for **303,591ms and 304,182ms** respectively before the client's fetch gave
up with "fetch failed" — no fast 400/404. Compare `GET /api/projects/:id/registry-token` with
the same bad id, which correctly fails in 21ms.
**Impact:** A malformed id shouldn't be able to hold a request open for 5 minutes. On a server
already shown to have limited concurrency headroom (see Performance section), a client bug or
a handful of bad requests could tie up connections for minutes each.
**Fix direction:** Validate `:id` is a real project (owned by the caller) up front and fail
fast, consistent with how the other `/:id/*` routes on the same file already behave.

### 3. `POST /ai/pre-run` 500s with a duplicate-key error on a freshly created collection
**File:** likely `backend/src/routes/ai.js`'s `/pre-run` handler, writing to `collection_env_config`
**What happens:** Creating a collection auto-seeds a `collection_env_config` row (via
`syncCollectionEnvConfig`). Calling `POST /ai/pre-run` against that same collection right
after immediately 500s:
`duplicate key value violates unique constraint "collection_env_config_collection_id_env_key"`.
**Impact:** Pre-run is a core, frequently-used feature — this fires whenever pre-run's own
config-sync step tries to insert a row that already exists. `POST /ai/pre-run/heal` still
worked afterward, so the 500 doesn't fully block the feature, but it's a real unhandled error
on a common path.
**Fix direction:** Use `INSERT ... ON CONFLICT (collection_id, env) DO UPDATE` (or check-then-update)
wherever pre-run writes this row, matching how `collections.js`'s own collection-creation path
already avoids the same race (see the `seedEnvVariables`/`autoPopulateProjectConfig` sequencing
comment in `configWriter.js`).

### 4. Git branch creation fails right after a fresh repo init/push
**File:** `backend/src/routes/git.js` (`POST /branch`)
**What happened:** On a repo that was `git/init` + first `git/push`'d only seconds earlier:
- `Failed to create user branch: Could not find origin/users/benchmark2-user.`
- On a second attempt: `Failed to create user branch: Could not find origin/main.`

Both say the remote branch it's trying to branch from doesn't exist yet, immediately after
that exact branch was supposedly just pushed.
**Impact:** Blocks the entire regular-user branch → commit → PR flow on a brand-new repo.
**Fix direction:** Likely a missing fetch/refresh of remote refs before branch creation reads
`origin/*` — worth checking whether `git/push`'s success response is returned before the
local session's view of `origin/*` refs is updated, or whether GitHub's own ref propagation
needs a short retry/backoff.

### 5. PR merge rejected with "conflicts" on what should be a clean merge
**File:** `backend/src/routes/git.js` (`PUT /prs/:id/merge`)
**What happened:** `Merge failed: Merges with conflicts are not supported yet. There may be
merge conflicts or your token lacks write access to the main branch.`
**Impact:** Unclear yet whether this is a real conflict (plausible, given finding #4 suggests
the branch state was already inconsistent) or a false positive in conflict detection / a
token-scope issue being misreported as a merge conflict. Needs re-testing once #4 is fixed,
since a branch created against a stale `origin` ref would legitimately diverge.

### 6. CI runs complete but `sync-results` can never find their artifacts
**File:** `backend/src/routes/ciPipeline.js` (`POST /runs/:id/sync-results`)
**What happened:** Two real GitHub Actions runs were triggered (run ids 31, 32) against the
provided repo's existing workflow. Both finished with `status=failed` on GitHub's side, and
`sync-results` 404'd for both: *"No artifacts found for this run. The pipeline may still be
running or artifacts may have expired."*
**Impact:** Trend-analysis's run-dependent endpoints (`/trend`, `/rca`, `/recommendations`,
`/ai-summary`, `/forecast`, `/export-pdf`) can never show real data if this is a systemic
mismatch, not a one-off. Needs the actual GitHub Actions job log to see whether the workflow
failed before producing an artifact (e.g. JMeter/K6 install step, wrong script path/engine
name) — I only had API-level visibility, not the raw Actions log.

---

## Security / operational hygiene (not bugs, but should be fixed before wider rollout)

### 7. Deployed server still has the default seeded super-admin credential active
`admin@perfstudio.com` / `Admin@123` logged in successfully on the deployed pre-launch server.
Your own `docs/DEPLOYMENT.md` already calls out rotating this immediately post-deploy — it
hadn't been done as of this testing. Anyone who knows (or guesses) this default can log in as
super admin right now.

---

## Needs re-verification (contradicts a manual test)

### 8. Collection/config.json/testData not appearing in S3 for either admin or regular-user actions
During the earlier S3 investigation, neither an org-admin-created collection nor a
regular-user's real file-upload collection produced a `config.json` or `testData` file in the
S3 bucket — only empty `.gitkeep` placeholders showed up
(`git-workspaces/<org-slug>/.../<Collection>/.gitkeep`). Root cause traced to
`configWriter.js:96-98`'s `if (await isAdminUser(userId)) return;` for the admin case, but the
regular-user case (which should not hit that skip) also came up empty and wasn't explained
before you said your own manual test showed data landing in S3 correctly. **This is
unresolved** — worth re-running side-by-side with a manual UI action to see exactly what
differs (my API-only calls vs. clicking through the UI) before treating either result as
authoritative.

---

## Performance / infrastructure findings (not code bugs — capacity planning input)

### 9. Postgres pool capped at 10 connections becomes the real throughput ceiling
`backend/src/db/pg.js:23` — `max: 10`. Local benchmark showed aggregate throughput *peak* at
15 concurrent connections (~1,129 req/s) then *fall* as concurrency rose further (786 req/s at
30, 555 req/s at 50), while latency kept climbing — classic pool-exhaustion signature, not a
CPU ceiling. Relevant if you expect orgs with many simultaneous heavy users; the pool size
should probably scale with expected concurrent load before wider sale.

### 10. The deployed server saturates at far lower concurrency than local
At just 5 concurrent connections, the deployed server averaged **456ms** latency (923ms P95)
on read-only dashboard endpoints — a single sequential request to the same endpoint measured
~25-30ms, and network RTT alone measured ~55-70ms. Local hardware (10-core/12-thread) didn't
reach comparable latency until 50 concurrent connections (90ms avg). No errors occurred either
way — the deployed instance just appears meaningfully more resource-constrained than local.
Worth checking the actual deployed VM's vCPU/RAM against the 4 vCPU/8GB your architecture doc
recommends, since I don't have SSH/infra access to confirm directly.

---

## Sources
Everything above came from disposable test orgs/projects created via the real API against
`peako.qtsolvdev.com` (Super Admin credentials provided by the user), plus a local benchmark
against the same codebase running locally. No production customer data was involved. Disposable
test orgs (`Benchmark Org (disposable)`, `Benchmark Org 2 (disposable)`) and their projects/users
are still present on the deployed server as of this writing — see chat history for cleanup status.
