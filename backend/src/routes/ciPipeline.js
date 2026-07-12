/**
 * ciPipeline.js — GitLab & GitHub Actions CI/CD pipeline integration
 *
 * Routes (all under /api/projects/:projectId/ci):
 *   GET    /config                — get CI config for project
 *   PUT    /config                — save CI config
 *   POST   /config/test           — test connection to GitLab/GitHub
 *   POST   /config/trigger-token  — create a GitLab trigger token via API
 *   POST   /generate-yaml         — generate + commit YAML files to git repo
 *   POST   /trigger               — trigger pipeline on GitLab or GitHub
 *   GET    /runs                  — list CI run history
 *   GET    /runs/:runId/status    — poll live status from external provider
 */

const router  = require('express').Router({ mergeParams: true });
const db      = require('../db');
const auth    = require('../middleware/auth');
const ownsProject = require('../utils/ownsProject');
const { encrypt, decrypt } = require('../utils/encryption');
const https   = require('https');
const http    = require('http');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const { randomBytes } = require('crypto');
const { spawnSync } = require('child_process');

// Guards against overlapping status-poll requests for the same CI run both passing the
// "not yet synced" check before either INSERT commits — without this, two concurrent
// polls (e.g. a backgrounded browser tab's throttled timers firing in a burst) can each
// create their own execution_runs row for the same ci_run_id, which then LEFT JOINs into
// duplicate-looking rows in CI Run History. Backed by a DB-level unique index too
// (schema.sql) as a second line of defense across process restarts/multiple workers.
const ciSyncInProgress = new Set();

// ── Shared patcher script content ─────────────────────────────────────────────
// Written to .PerfStudio/patch_jmx.py in every Bitbucket workspace before push.
// Uses double-quoted raw strings to avoid character-class escaping issues in re.
const BB_PATCHER_PY = `# PerfStudio JMX parameter patcher
# Usage: python3 patch_jmx.py <script> <users> <rampup> <loops> <duration>
import re, sys

script, users, rampup, loops, duration = sys.argv[1:6]
use_duration = duration != "-1" and int(duration) > 0

with open(script, "r", encoding="utf-8") as f:
    content = f.read()

def sp(xml, name, val):
    pat = r'(<(?:string|int|long|bool)Prop\\s+name="' + re.escape(name) + r'">)[^<]*'
    new, n = re.subn(pat, r'\\g<1>' + str(val), xml)
    print(("  SET " if n else "  WARN ") + name + "=" + str(val))
    return new

# Fix absolute local Windows paths -> CI /workspace/ paths
# Handles two-level structure: git-workspaces/<project>/<user>/
path_pattern = r"[A-Za-z]:[/\\\\][^'\\"<>]*?git-workspaces[/\\\\][^/\\\\]+[/\\\\][^/\\\\]+[/\\\\]"
fixed_content, path_fixes = re.subn(path_pattern, "/workspace/", content)
if path_fixes:
    fixed_content = fixed_content.replace("\\\\", "/")
    content = fixed_content
    print("  FIXED " + str(path_fixes) + " absolute path(s) -> /workspace/")
else:
    path_pattern_old = r"[A-Za-z]:[/\\\\][^'\\"<>]*?git-workspaces[/\\\\][^/\\\\]+[/\\\\]"
    fixed_content, path_fixes = re.subn(path_pattern_old, "/workspace/", content)
    if path_fixes:
        fixed_content = fixed_content.replace("\\\\", "/")
        content = fixed_content
        print("  FIXED " + str(path_fixes) + " absolute path(s) (old structure) -> /workspace/")
    else:
        print("  No absolute paths to fix")

content = sp(content, "ThreadGroup.num_threads", users)
content = sp(content, "ThreadGroup.ramp_time", rampup)

if use_duration:
    print("  Mode: Duration " + duration + "s")
    content = sp(content, "ThreadGroup.scheduler", "true")
    content = sp(content, "ThreadGroup.duration", duration)
    content = sp(content, "LoopController.loops", "-1")
    if 'name="ThreadGroup.duration"' not in content:
        content = content.replace("</ThreadGroup>",
            '<stringProp name="ThreadGroup.duration">' + duration + '</stringProp>\\n'
            '<boolProp name="ThreadGroup.scheduler">true</boolProp>\\n</ThreadGroup>')
        print("  INJECTED duration+scheduler")
else:
    print("  Mode: Loops " + loops)
    content = sp(content, "ThreadGroup.scheduler", "false")
    content = sp(content, "LoopController.loops", loops)

with open(script, "w") as f:
    f.write(content)
print("Patch complete")
`;

router.use(auth);

// ── helpers ───────────────────────────────────────────────────────────────────

// Per-user CI config: first try (project_id, user_id), fall back to legacy (project_id, NULL)
async function getConfig(projectId, userId) {
  if (userId) {
    const own = await db.prepare('SELECT * FROM ci_pipeline_configs WHERE project_id = ? AND user_id = ?').get(projectId, userId);
    if (own) return own;
    // Fall back to the project admin's config so regular users inherit SSH keys/tokens set up at admin level
    const adminCfg = await db.prepare(`
      SELECT cpc.* FROM ci_pipeline_configs cpc
      JOIN users u ON u.id = cpc.user_id
      WHERE cpc.project_id = ? AND u.role IN ('org_admin','super_admin')
      ORDER BY cpc.updated_at DESC LIMIT 1
    `).get(projectId);
    if (adminCfg) return adminCfg;
  }
  // Legacy shared config (user_id IS NULL)
  return (await db.prepare('SELECT * FROM ci_pipeline_configs WHERE project_id = ? AND user_id IS NULL').get(projectId)) || null;
}

/**
 * Build the canonical repo paths for a script following the defined folder structure:
 *   Project_Name/Collection_Name/Env/script/file.jmx
 *   Project_Name/Collection_Name/Env/testData
 *   Project_Name/Collection_Name/Env/results
 */
async function buildCanonicalRepoPaths(projectId, scriptName) {
  const clean = s => (s || '').replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'Default';
  const scriptFile = (scriptName || '').replace(/\\/g, '/').split('/').pop() || scriptName || '';
  const project    = await db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId);
  const suite      = scriptFile
    ? await db.prepare(`
        SELECT ts.jmx_path, ts.js_path, ts.env, c.name AS col_name
        FROM test_suites ts
        LEFT JOIN collections c ON c.id = ts.collection_id
        WHERE ts.project_id = ? AND (ts.jmx_path LIKE ? OR ts.js_path LIKE ?)
        LIMIT 1
      `).get(projectId, `%${scriptFile}`, `%${scriptFile}`)
    : null;

  const projectDir    = clean(project?.name);
  const collectionDir = clean(suite?.col_name);
  const envDir        = clean(suite?.env) || 'QA';

  return {
    projectDir,
    collectionDir,
    envDir,
    scriptRepoPath:  `${projectDir}/${collectionDir}/${envDir}/script/${scriptFile}`,
    testDataPath:    `${projectDir}/${collectionDir}/${envDir}/testData`,
    resultsPath:     `${projectDir}/${collectionDir}/${envDir}/results`,
    jmxDiskPath:     suite?.jmx_path || suite?.js_path || '',
  };
}

// Resolves a Bitbucket branch name to its latest commit hash.
// Branch names with '/' (e.g. feature/quarks-user) cannot be used directly in
// the /src/{node}/{path} URL because servers decode %2F → / before routing,
// turning "feature%2Fquarks-user" into branch "feature" (404).
// Using the commit hash avoids any path-separator ambiguity.
// Returns true when any individual API has 100% failure rate with HTTP 400 or 401.
// This indicates a broken test plan (bad request body or missing/invalid auth token)
// and must trigger healing regardless of the overall run error rate.
function hasCritical400Or401(reportData) {
  if (!reportData?.by_api) return false;
  return reportData.by_api.some(api => {
    if ((api.error_rate || 0) < 100) return false;
    const codes = api.response_codes || {};
    return (codes['400'] || 0) > 0 || (codes['401'] || 0) > 0;
  });
}

// Returns true when ANY individual API has a 100% failure rate, regardless of status
// code (500s, timeouts, connection errors, etc — not just 400/401). Per product
// requirement, a single fully-failing endpoint must always trigger auto-heal.
function hasAnyApiFullFailure(reportData) {
  if (!reportData?.by_api) return false;
  return reportData.by_api.some(api => (api.error_rate || 0) >= 100);
}

// Builds a targeted heal instruction from JTL errors so the AI knows exactly what to fix.
// 400 → wrong/missing request body parameters; 401 → broken auth token extraction or passing.
function buildErrorHealInstruction(errors) {
  if (!errors || errors.length === 0) return null;
  const instructions = [];

  const errors400 = errors.filter(e => String(e.response_code) === '400');
  const errors401 = errors.filter(e => String(e.response_code) === '401');

  if (errors400.length > 0) {
    const apis = [...new Set(errors400.map(e => e.label))].join(', ');
    instructions.push(
      `APIs returning 400 Bad Request: ${apis}.\n` +
      `Fix request body parameters: verify all required fields are present with correct names, ` +
      `data types, and values. Compare against the pre-run execution data / previous successful run ` +
      `to identify what changed. Also check Content-Type header is correct (application/json vs form-encoded).`
    );
  }

  if (errors401.length > 0) {
    const apis = [...new Set(errors401.map(e => e.label))].join(', ');
    instructions.push(
      `APIs returning 401 Unauthorized: ${apis}.\n` +
      `Fix authorization: verify the auth token or session cookie extracted from the login/auth response ` +
      `is correctly captured (check the variable extractor — regex or JSONPath — and the variable name used), ` +
      `and that it is passed in the Authorization header (e.g., "Bearer \${token}") or the appropriate ` +
      `auth field for every request that returns 401.`
    );
  }

  return instructions.length > 0 ? instructions.join('\n\n') : null;
}

async function resolveBranchToCommit(ws, slug, branch, authHeader) {
  // Try refs/branches?q= filter — branch name is safe in the query string (no %2F encoding issues)
  const q = `name="${branch}"`;
  const r = await apiRequest(
    `https://api.bitbucket.org/2.0/repositories/${ws}/${slug}/refs/branches?q=${encodeURIComponent(q)}&pagelen=1`,
    'GET', null, { Authorization: authHeader, 'User-Agent': 'PerfStudio' }
  );
  if (r.status === 200 && r.body?.values?.[0]?.target?.hash) {
    return r.body.values[0].target.hash;
  }
  // Fallback: direct branch lookup with each segment encoded separately (%2F stays encoded)
  const encodedBranch = branch.split('/').map(encodeURIComponent).join('%2F');
  const r2 = await apiRequest(
    `https://api.bitbucket.org/2.0/repositories/${ws}/${slug}/refs/branches/${encodedBranch}`,
    'GET', null, { Authorization: authHeader, 'User-Agent': 'PerfStudio' }
  );
  if (r2.status === 200 && r2.body?.target?.hash) return r2.body.target.hash;
  throw new Error(`Branch "${branch}" not found (HTTP ${r.status}/${r2.status})`);
}

function decryptConfig(cfg) {
  if (!cfg) return null;
  return {
    ...cfg,
    gitlab_token:           cfg.gitlab_token           ? decrypt(cfg.gitlab_token)           : '',
    gitlab_trigger_token:   cfg.gitlab_trigger_token   ? decrypt(cfg.gitlab_trigger_token)   : '',
    github_token:           cfg.github_token           ? decrypt(cfg.github_token)           : '',
    bitbucket_app_password: cfg.bitbucket_app_password ? decrypt(cfg.bitbucket_app_password) : '',
    ssh_private_key:        cfg.ssh_private_key        ? decrypt(cfg.ssh_private_key)        : '',
  };
}

/** Build correct Bitbucket Basic auth — ATATT tokens require email:token, not username:token */
async function bbBasicAuth(cfg, lookupUserId) {
  const tok  = (cfg.bitbucket_app_password || '').trim();
  const user = cfg.bitbucket_username || cfg.bitbucket_workspace || '';
  // If it already looks like an email, use it directly
  if (user.includes('@')) return `Basic ${Buffer.from(`${user}:${tok}`).toString('base64')}`;
  // Not an email — look it up from the users table
  const email = lookupUserId
    ? ((await db.prepare('SELECT email FROM users WHERE id = ?').get(lookupUserId))?.email || user)
    : user;
  return `Basic ${Buffer.from(`${email}:${tok}`).toString('base64')}`;
}

/** Minimal JSON HTTP request using Node built-ins (no axios/node-fetch needed) */
function apiRequest(urlStr, method, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url    = new URL(urlStr);
    const isHttps = url.protocol === 'https:';
    const options = {
      hostname: url.hostname,
      port:     url.port || (isHttps ? 443 : 80),
      path:     url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      rejectUnauthorized: false,
    };
    const payload = body ? JSON.stringify(body) : null;
    if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload);

    const req = (isHttps ? https : http).request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data), headers: res.headers }); }
        catch { resolve({ status: res.statusCode, body: data, headers: res.headers }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Helper: fetch Bitbucket pipeline step logs as a single text string ────────
async function fetchBbPipelineLogs(authHeader, ws, slug, pipelineUuid) {
  try {
    const encodedUuid = encodeURIComponent(pipelineUuid);
    const stepsR = await apiRequest(
      `https://api.bitbucket.org/2.0/repositories/${ws}/${slug}/pipelines/${encodedUuid}/steps/`,
      'GET', null, { Authorization: authHeader, 'User-Agent': 'PerfStudio' }
    );
    if (stepsR.status !== 200 || !Array.isArray(stepsR.body?.values)) return '';
    const parts = [];
    for (const step of stepsR.body.values) {
      const stepUuid = encodeURIComponent(step.uuid || '');
      if (!stepUuid) continue;
      const logR = await apiRequest(
        `https://api.bitbucket.org/2.0/repositories/${ws}/${slug}/pipelines/${encodedUuid}/steps/${stepUuid}/log`,
        'GET', null, { Authorization: authHeader, 'User-Agent': 'PerfStudio', Accept: 'text/plain' }
      );
      if (logR.status === 200) {
        const body = typeof logR.body === 'string' ? logR.body : JSON.stringify(logR.body);
        parts.push(`=== Step: ${step.name || step.uuid} ===\n${body.slice(0, 8000)}`);
      }
    }
    return parts.join('\n\n').slice(0, 15000);
  } catch (_) { return ''; }
}

// ── Helper: parse "owner/repo" from any GitHub remote URL ────────────────────
function parseOwnerRepo(url) {
  if (!url) return '';
  // HTTPS: https://github.com/owner/repo.git  (may have token@ prefix)
  const m = url.match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?(?:\s|$)/);
  return m ? m[1] : '';
}

// ── Helper: get github_repo from git config remote URL (fallback) ─────────────
async function getRepoFromGit(projectId) {
  const gitCfg = await db.prepare('SELECT remote_url FROM git_configs WHERE project_id = ?').get(projectId);
  return gitCfg?.remote_url ? parseOwnerRepo(gitCfg.remote_url) : '';
}

// ── Helper: extract PAT from the git remote URL (ghp_... embedded in URL) ─────
async function getTokenFromGitRemote(projectId) {
  try {
    const { GIT_WORKSPACES_ROOT, cleanName } = require('../utils/projectFolders');
    const proj = await db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId);
    if (!proj) return null;
    // Check both admin and any user-N workspace for a remote URL with an embedded token
    const wsBase = path.join(GIT_WORKSPACES_ROOT, cleanName(proj.name));
    const dirs = [path.join(wsBase, 'admin')];
    const fs2 = require('fs');
    if (fs2.existsSync(wsBase)) {
      for (const d of fs2.readdirSync(wsBase)) {
        const full = path.join(wsBase, d);
        if (d !== 'admin' && fs2.statSync(full).isDirectory()) dirs.push(full);
      }
    }
    for (const dir of dirs) {
      const configPath = path.join(dir, '.git', 'config');
      if (!fs2.existsSync(configPath)) continue;
      const content = fs2.readFileSync(configPath, 'utf8');
      const m = content.match(/https?:\/\/(ghp_[^@\s]+|github_pat_[^@\s]+)@github\.com/);
      if (m) return m[1];
    }
  } catch {}
  return null;
}

// ── Helper: sanitise and validate a github_repo value ─────────────────────────
// Accepts:  "owner/repo"  or  "https://github.com/owner/repo.git"
// Rejects:  email addresses, bare names without a slash, etc.
function sanitizeGithubRepo(raw) {
  if (!raw) return '';
  let v = raw.trim();
  // Strip full URL down to owner/repo
  v = v.replace(/^https?:\/\/[^@]*@?github\.com\//, '').replace(/\.git$/, '').trim();
  // Must look like  word/word  — no @ signs allowed
  return /^[\w.-]+\/[\w.-]+$/.test(v) ? v : '';
}

// ── GET /config — returns the CALLING USER's own CI config ───────────────────
router.get('/config', async (req, res) => {
  if (!await ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const cfg = await getConfig(req.params.projectId, req.userId);
  if (!cfg) return res.json({ config: null });

  // Auto-derive github_repo from the project's git remote URL if the stored
  // value is missing or invalid (e.g. user accidentally entered their email).
  let github_repo = sanitizeGithubRepo(cfg.github_repo);
  if (!github_repo) github_repo = await getRepoFromGit(req.params.projectId);

  res.json({
    config: {
      ...cfg,
      github_repo,
      gitlab_token:              cfg.gitlab_token           ? '••••••••' : '',
      gitlab_trigger_token:      cfg.gitlab_trigger_token   ? '••••••••' : '',
      github_token:              cfg.github_token           ? '••••••••' : '',
      bitbucket_app_password:    cfg.bitbucket_app_password ? '••••••••' : '',
      ssh_private_key:           cfg.ssh_private_key        ? '••••••••' : '',
      gitlab_token_set:          !!cfg.gitlab_token,
      gitlab_trigger_token_set:  !!cfg.gitlab_trigger_token,
      github_token_set:          !!cfg.github_token,
      bitbucket_app_password_set: !!cfg.bitbucket_app_password,
      ssh_private_key_set:       !!cfg.ssh_private_key,
    },
  });
});

// ── Helper: project owner check ───────────────────────────────────────────────
async function isProjectOwner(userId, projectId) {
  const proj = await db.prepare('SELECT user_id FROM projects WHERE id = ?').get(projectId);
  return proj && String(proj.user_id) === String(userId);
}

// ── PUT /config ───────────────────────────────────────────────────────────────
router.put('/config', async (req, res) => {
  if (!await ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  // Each user saves their OWN CI config — no owner restriction needed
  const {
    gitlab_enabled, gitlab_url, gitlab_project_id, gitlab_token, gitlab_trigger_token, gitlab_ref,
    gitlab_auth_method,
    github_enabled, github_token, github_workflow_file, github_ref, github_auth_method,
    bitbucket_enabled, bitbucket_workspace, bitbucket_username, bitbucket_app_password, bitbucket_repo_slug, bitbucket_ref,
    bitbucket_auth_method,
    ssh_private_key,
  } = req.body;

  // Sanitize github_repo: strip full URLs, reject email addresses
  const github_repo = sanitizeGithubRepo(req.body.github_repo)
    || await getRepoFromGit(req.params.projectId);

  // Look up THIS user's own config row (project_id + user_id)
  const existing = await db.prepare('SELECT * FROM ci_pipeline_configs WHERE project_id = ? AND user_id = ?').get(req.params.projectId, req.userId);
  const gitCfgDefault = await db.prepare('SELECT base_branch FROM git_configs WHERE project_id = ?').get(req.params.projectId);
  const defaultBranch = gitCfgDefault?.base_branch || 'main';

  const encGitlabToken        = gitlab_token && gitlab_token !== '••••••••'                     ? encrypt(gitlab_token)           : existing?.gitlab_token              || '';
  const encGitlabTriggerToken = gitlab_trigger_token && gitlab_trigger_token !== '••••••••'     ? encrypt(gitlab_trigger_token)   : existing?.gitlab_trigger_token       || '';
  const encGithubToken        = github_token && github_token !== '••••••••'                     ? encrypt(github_token)           : existing?.github_token              || '';
  const encBitbucketPassword  = bitbucket_app_password && bitbucket_app_password !== '••••••••' ? encrypt(bitbucket_app_password) : existing?.bitbucket_app_password     || '';
  const normalizedSshKey      = ssh_private_key && ssh_private_key !== '••••••••'
    ? ssh_private_key.trim().replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    : null;
  const encSshKey             = normalizedSshKey ? encrypt(normalizedSshKey) : (existing?.ssh_private_key || '');

  if (existing) {
    await db.prepare(`UPDATE ci_pipeline_configs SET
      gitlab_enabled=?, gitlab_url=?, gitlab_project_id=?, gitlab_token=?,
      gitlab_trigger_token=?, gitlab_ref=?, gitlab_auth_method=?,
      github_enabled=?, github_repo=?, github_token=?, github_workflow_file=?, github_ref=?, github_auth_method=?,
      bitbucket_enabled=?, bitbucket_workspace=?, bitbucket_username=?, bitbucket_app_password=?, bitbucket_repo_slug=?, bitbucket_ref=?, bitbucket_auth_method=?,
      ssh_private_key=?, updated_at=NOW()
      WHERE project_id=? AND user_id=?`
    ).run(
      gitlab_enabled ? 1 : 0, gitlab_url || 'https://gitlab.com', gitlab_project_id || '',
      encGitlabToken, encGitlabTriggerToken, gitlab_ref || defaultBranch, gitlab_auth_method || 'pat',
      github_enabled ? 1 : 0, github_repo || '', encGithubToken,
      github_workflow_file || 'perf-test.yml', github_ref || defaultBranch, github_auth_method || 'pat',
      bitbucket_enabled ? 1 : 0, bitbucket_workspace || '', bitbucket_username || '',
      encBitbucketPassword, bitbucket_repo_slug || '', bitbucket_ref || defaultBranch, bitbucket_auth_method || 'pat',
      encSshKey,
      req.params.projectId, req.userId
    );
  } else {
    await db.prepare(`INSERT INTO ci_pipeline_configs
      (project_id, user_id, gitlab_enabled, gitlab_url, gitlab_project_id, gitlab_token, gitlab_trigger_token, gitlab_ref, gitlab_auth_method,
       github_enabled, github_repo, github_token, github_workflow_file, github_ref, github_auth_method,
       bitbucket_enabled, bitbucket_workspace, bitbucket_username, bitbucket_app_password, bitbucket_repo_slug, bitbucket_ref, bitbucket_auth_method,
       ssh_private_key)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      req.params.projectId, req.userId,
      gitlab_enabled ? 1 : 0, gitlab_url || 'https://gitlab.com', gitlab_project_id || '',
      encGitlabToken, encGitlabTriggerToken, gitlab_ref || defaultBranch, gitlab_auth_method || 'pat',
      github_enabled ? 1 : 0, github_repo || '', encGithubToken,
      github_workflow_file || 'perf-test.yml', github_ref || defaultBranch, github_auth_method || 'pat',
      bitbucket_enabled ? 1 : 0, bitbucket_workspace || '', bitbucket_username || '',
      encBitbucketPassword, bitbucket_repo_slug || '', bitbucket_ref || defaultBranch, bitbucket_auth_method || 'pat',
      encSshKey
    );
  }

  res.json({ ok: true });
});

// ── SSH test helper ───────────────────────────────────────────────────────────
function testSshConnection(privateKey, host) {
  const id = randomBytes(8).toString('hex');
  const keyPath = path.join(os.tmpdir(), `ps_ci_ssh_${id}`);
  const khPath  = path.join(os.tmpdir(), `ps_ci_kh_${id}`);
  try {
    const normalizedKey = privateKey.trim().replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    fs.writeFileSync(keyPath, normalizedKey + '\n', { mode: 0o600 });

    // Windows: strip inherited ACLs and grant only the current user — SSH rejects world-readable keys
    if (os.platform() === 'win32') {
      const username = process.env.USERNAME || process.env.USER || 'User';
      spawnSync('icacls', [keyPath, '/inheritance:r', '/grant:r', `${username}:F`], { windowsHide: true });
    }

    // Pre-populate known_hosts so StrictHostKeyChecking=yes works
    const scan = spawnSync('ssh-keyscan', ['-H', '-t', 'ed25519,rsa,ecdsa', host], {
      timeout: 10000, windowsHide: true, encoding: 'utf8',
    });
    const khContent = (scan.stdout || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    fs.writeFileSync(khPath, khContent ? khContent + '\n' : '', { mode: 0o600 });

    const strictCheck = khContent ? 'yes' : 'no';
    const sshArgs = [
      '-T', `git@${host}`,
      '-i', keyPath.replace(/\\/g, '/'),
      '-o', `StrictHostKeyChecking=${strictCheck}`,
      '-o', `UserKnownHostsFile=${khPath.replace(/\\/g, '/')}`,
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
    ];

    const result = spawnSync('ssh', sshArgs, {
      timeout: 15000, windowsHide: true, encoding: 'utf8',
    });

    // SSH -T exits non-zero but prints success message to stderr
    const output = (result.stderr || '') + (result.stdout || '');
    if (/successfully authenticated|welcome to gitlab|logged in as/i.test(output)) {
      const match = output.match(/Hi ([^!]+)!|welcome to gitlab.*?([a-z0-9_.-]+)/i);
      const user = match ? (match[1] || match[2]) : 'unknown';
      return { ok: true, message: `SSH authenticated as: ${user.trim()}` };
    }
    return { ok: false, message: output.trim() || `SSH exit code ${result.status}` };
  } finally {
    try { fs.unlinkSync(keyPath); } catch {}
    try { fs.unlinkSync(khPath); } catch {}
  }
}

// ── POST /config/test — test connection ───────────────────────────────────────
router.post('/config/test', async (req, res) => {
  if (!await ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const { provider } = req.body;
  const cfg = decryptConfig(await getConfig(req.params.projectId, req.userId));
  if (!cfg) return res.status(400).json({ error: 'Save CI configuration first.' });

  try {
    if (provider === 'gitlab') {
      if (cfg.gitlab_auth_method === 'ssh') {
        if (!cfg.ssh_private_key) return res.status(400).json({ error: 'SSH private key not set. Save it in Settings first.' });
        const gitlabHost = (() => { try { return new URL(cfg.gitlab_url || 'https://gitlab.com').hostname; } catch { return 'gitlab.com'; } })();
        const r = testSshConnection(cfg.ssh_private_key, gitlabHost);
        return r.ok ? res.json(r) : res.status(400).json({ error: r.message });
      }
      if (!cfg.gitlab_token) return res.status(400).json({ error: 'GitLab access token not set.' });
      const gitlabUrl = (cfg.gitlab_url || 'https://gitlab.com').replace(/\/$/, '');
      const r = await apiRequest(`${gitlabUrl}/api/v4/user`, 'GET', null, { 'PRIVATE-TOKEN': cfg.gitlab_token });
      if (r.status === 200) return res.json({ ok: true, message: `Connected as: ${r.body.username} (${r.body.name})` });
      return res.status(400).json({ error: `GitLab returned ${r.status}: ${r.body?.message || 'Authentication failed'}` });
    }

    if (provider === 'github') {
      if (cfg.github_auth_method === 'ssh') {
        if (!cfg.ssh_private_key) return res.status(400).json({ error: 'SSH private key not set. Save it in Settings first.' });
        const r = testSshConnection(cfg.ssh_private_key, 'github.com');
        return r.ok ? res.json(r) : res.status(400).json({ error: r.message });
      }
      if (!cfg.github_token) return res.status(400).json({ error: 'GitHub token not set.' });
      const r = await apiRequest('https://api.github.com/user', 'GET', null, {
        Authorization: `token ${cfg.github_token}`,
        'User-Agent': 'PerfStudio',
        Accept: 'application/vnd.github+json',
      });
      if (r.status === 200) return res.json({ ok: true, message: `Connected as: ${r.body.login} (${r.body.name || ''})` });
      return res.status(400).json({ error: `GitHub returned ${r.status}: ${r.body?.message || 'Authentication failed'}` });
    }

    if (provider === 'bitbucket') {
      if (cfg.bitbucket_auth_method === 'ssh') {
        if (!cfg.ssh_private_key) return res.status(400).json({ error: 'SSH private key not set. Save it in Settings first.' });
        const r = testSshConnection(cfg.ssh_private_key, 'bitbucket.org');
        return r.ok ? res.json(r) : res.status(400).json({ error: r.message });
      }
      if (!cfg.bitbucket_app_password) return res.status(400).json({ error: 'Bitbucket App Password / API Token not set.' });
      if (!cfg.bitbucket_workspace)    return res.status(400).json({ error: 'Bitbucket workspace not set.' });
      if (!cfg.bitbucket_repo_slug)    return res.status(400).json({ error: 'Bitbucket repository slug not set.' });
      {
        // Personal API tokens (ATATT) are rejected by the Bitbucket REST API but
        // work perfectly for git HTTPS. Test connectivity via git ls-remote instead
        // of a REST API call so the same token that was used to init the repo works here.
        const bbToken = cfg.bitbucket_app_password;
        const bbUser  = cfg.bitbucket_username || cfg.bitbucket_workspace;
        const repoBase = `https://bitbucket.org/${cfg.bitbucket_workspace}/${cfg.bitbucket_repo_slug}.git`;
        const authedUrl = bbToken.startsWith('ATATT')
          ? repoBase.replace('https://', `https://${encodeURIComponent(bbUser)}:${encodeURIComponent(bbToken)}@`)
          : repoBase.replace('https://', `https://${encodeURIComponent(bbUser)}:${encodeURIComponent(bbToken)}@`);
        const NO_PROMPT = {
          GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', GCM_INTERACTIVE: 'never',
          GCM_NO_INTERACTIVE: '1', GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
        };
        const lsResult = spawnSync('git', ['ls-remote', '--heads', authedUrl], {
          env: { ...process.env, ...NO_PROMPT },
          timeout: 15000, encoding: 'utf8', windowsHide: true,
        });
        if (lsResult.status === 0) {
          return res.json({ ok: true, message: `Connected — ${cfg.bitbucket_workspace}/${cfg.bitbucket_repo_slug}` });
        }
        const errMsg = (lsResult.stderr || '').trim();
        if (/Authentication failed|not.*access|could not read/i.test(errMsg)) {
          return res.status(400).json({ error: 'Authentication failed. Check your username and API token.' });
        }
        if (/not found|does not exist/i.test(errMsg)) {
          return res.status(400).json({ error: `Repository not found: ${cfg.bitbucket_workspace}/${cfg.bitbucket_repo_slug}` });
        }
        return res.status(400).json({ error: errMsg || 'Could not connect to Bitbucket repository.' });
      }
    }

    res.status(400).json({ error: 'Unknown provider. Use gitlab, github, or bitbucket.' });
  } catch (e) {
    res.status(500).json({ error: `Connection failed: ${e.message}` });
  }
});

// ── POST /config/trigger-token — create GitLab trigger token ─────────────────
router.post('/config/trigger-token', async (req, res) => {
  if (!await ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const cfg = decryptConfig(await getConfig(req.params.projectId, req.userId));
  if (!cfg?.gitlab_token)         return res.status(400).json({ error: 'Save GitLab access token first.' });
  if (!cfg?.gitlab_project_id)    return res.status(400).json({ error: 'GitLab project ID/path not set.' });

  const gitlabUrl = (cfg.gitlab_url || 'https://gitlab.com').replace(/\/$/, '');
  const encodedId = encodeURIComponent(cfg.gitlab_project_id);

  try {
    const r = await apiRequest(
      `${gitlabUrl}/api/v4/projects/${encodedId}/triggers`,
      'POST',
      { description: 'PerfStudio trigger token' },
      { 'PRIVATE-TOKEN': cfg.gitlab_token }
    );

    if (r.status === 201) {
      const token = r.body.token;
      // Save encrypted trigger token
      await db.prepare('UPDATE ci_pipeline_configs SET gitlab_trigger_token=? WHERE project_id=?')
        .run(encrypt(token), req.params.projectId);
      return res.json({ ok: true, message: 'Trigger token created and saved.', token_preview: token.slice(0, 6) + '••••••' });
    }
    res.status(400).json({ error: `GitLab returned ${r.status}: ${JSON.stringify(r.body)}` });
  } catch (e) {
    res.status(500).json({ error: `Failed to create trigger token: ${e.message}` });
  }
});

// ── POST /generate-yaml — generate + commit YAML files ───────────────────────
router.post('/generate-yaml', async (req, res) => {
  if (!await ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const cfg     = decryptConfig(await getConfig(req.params.projectId, req.userId));
  const project = await db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { providers = ['gitlab', 'github'] } = req.body;

  // Docker image — read from user's global config, fall back to admin's config, then default
  const globalCfgRow = await db.prepare('SELECT config_json FROM global_config WHERE user_id = ?').get(req.userId);
  const globalCfgAdmin = !globalCfgRow
    ? await db.prepare(`SELECT gc.config_json FROM global_config gc JOIN users u ON u.id = gc.user_id WHERE u.role IN ('org_admin','super_admin') ORDER BY gc.user_id LIMIT 1`).get()
    : null;
  const globalCfg = JSON.parse((globalCfgRow || globalCfgAdmin)?.config_json || '{}');
  const dockerImage = (globalCfg.jmeter_docker_image || 'tasleemzaif/perfstudio:latest').trim().toLowerCase();

  // Use per-project workspace (new structure: git-workspaces/<ProjectName>/admin/)
  const callerRow = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  const isAdmin   = ['org_admin', 'super_admin'].includes(callerRow?.role);
  const { GIT_WORKSPACES_ROOT, cleanName, resolveUserFolder } = require('../utils/projectFolders');
  const userFolder   = await resolveUserFolder(req.userId);
  const cleanProject = (project.name || '').replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  const gitRoot      = path.join(GIT_WORKSPACES_ROOT, cleanProject, userFolder);
  fs.mkdirSync(gitRoot, { recursive: true });

  // Get all generated test plans for this project to include as YAML comments
  const suites = await db.prepare("SELECT * FROM test_suites WHERE project_id = ? AND (jmx_path IS NOT NULL OR js_path IS NOT NULL)").all(req.params.projectId);

  const gitCfgBase = await db.prepare('SELECT base_branch FROM git_configs WHERE project_id = ?').get(req.params.projectId);
  const baseBranch = gitCfgBase?.base_branch || 'main';

  const created = [];
  const errors  = [];

  // ── Generate .gitlab-ci.yml ──────────────────────────────────────────────
  if (providers.includes('gitlab')) {
    const defaultScript = suites.length > 0
      ? path.basename(suites[0].jmx_path || suites[0].js_path || 'test.jmx')
      : 'test.jmx';
    const ref = cfg?.gitlab_ref || baseBranch;

    const scriptList = suites.map(s => {
      const file = path.basename(s.jmx_path || s.js_path || '');
      const relPath = s.jmx_path
        ? path.relative(gitRoot, s.jmx_path).replace(/\\/g, '/')
        : path.relative(gitRoot, s.js_path || '').replace(/\\/g, '/');
      return `  # ${s.name} → ${relPath}`;
    }).join('\n');

    const gitlabHasSsh = !!cfg?.ssh_private_key;
    const gitlabSshVars = gitlabHasSsh ? `\n  # SSH key — add SSH_PRIVATE_KEY as a masked CI/CD variable in GitLab → Settings → CI/CD → Variables` : '';
    const gitlabSshSetup = gitlabHasSsh ? `
    - which ssh-agent || apt-get install -y openssh-client
    - eval $(ssh-agent -s)
    - echo "$SSH_PRIVATE_KEY" | tr -d '\\r' | ssh-add -
    - mkdir -p ~/.ssh && chmod 700 ~/.ssh
    - ssh-keyscan github.com gitlab.com bitbucket.org >> ~/.ssh/known_hosts 2>/dev/null` : '';

    const gitlabYaml = `# ============================================================
# PerfStudio — GitLab CI/CD Performance Test Pipeline
# Generated by PerfStudio on ${new Date().toISOString().slice(0, 19).replace('T', ' ')}
#
# Available test scripts:
${scriptList || '  # (no generated scripts yet — generate from Test Plans first)'}
#${gitlabHasSsh ? '\n# SSH: Add SSH_PRIVATE_KEY as a masked variable in GitLab → Settings → CI/CD → Variables' : ''}
# ============================================================

workflow:
  rules:
    - when: always

image: docker:latest

services:
  - docker:dind

variables:
  DOCKER_DRIVER: overlay2
  SCRIPT_NAME: "${defaultScript}"
  JMETER_USERS: "10"
  JMETER_RAMPUP: "30"
  JMETER_LOOPS: "1"
  JMETER_DURATION: "300"${gitlabSshVars}

stages:
  - test

run_jmeter:
  stage: test
  before_script:${gitlabSshSetup}
    - echo "PerfStudio Pipeline Execution"
    - echo "Script   : \${SCRIPT_NAME}"
    - echo "VUsers   : \${JMETER_USERS}"
    - echo "Ramp-up  : \${JMETER_RAMPUP}s"
    - echo "Duration : \${JMETER_DURATION}s"
  script:
    - mkdir -p reports
    - |
      docker run --rm \\
        -v "\$CI_PROJECT_DIR":/workspace \\
        -v "\$CI_PROJECT_DIR/reports":/output \\
        justb4/jmeter \\
        -Dlog4j2.formatMsgNoLookups=true \\
        -n -t "/workspace/\${SCRIPT_PATH:-\${SCRIPT_NAME}}" \\
        -Jusers="\${JMETER_USERS}" \\
        -Jrampup="\${JMETER_RAMPUP}" \\
        -Jloops="\${JMETER_LOOPS}" \\
        -Jduration="\${JMETER_DURATION}" \\
        -l /output/results.jtl \\
        -e -o /output/html
    - |
      JTL="\$CI_PROJECT_DIR/reports/results.jtl"
      if [ ! -f "\$JTL" ]; then
        echo "ERROR: results.jtl not found — JMeter may have crashed before producing output."
        exit 1
      fi
      TOTAL=\$(( \$(wc -l < "\$JTL") - 1 ))
      echo "Total requests: \$TOTAL"
      if [ "\$TOTAL" -le 0 ]; then
        echo "ERROR: 0 requests executed - check thread group config"
        exit 1
      fi
      # Fail the job immediately on 100% error rate — don't wait for PerfStudio's own
      # results sync to notice. Header-based column lookup since JMeter's CSV field
      # order isn't guaranteed fixed.
      SUCCESS_COL=\$(head -1 "\$JTL" | tr -d '"' | tr ',' '\\n' | grep -nx 'success' | head -1 | cut -d: -f1)
      if [ -n "\$SUCCESS_COL" ]; then
        FAILED=\$(tail -n +2 "\$JTL" | awk -F',' -v col="\$SUCCESS_COL" '{gsub(/"/,"",\$col)} \$col!="true"{c++} END{print c+0}')
        echo "Failed requests: \$FAILED / \$TOTAL"
        if [ "\$FAILED" -eq "\$TOTAL" ]; then
          echo "ERROR: 100% of requests failed (\$FAILED/\$TOTAL) - failing the job so CI history reflects this immediately"
          exit 1
        fi
      else
        echo "WARN: could not locate 'success' column in JTL header - skipping error-rate check"
      fi
      echo "Validation passed: \$TOTAL requests"
  artifacts:
    paths:
      - reports/
    expire_in: 7 days
    when: always
  rules:
    - when: manual
`;
    try {
      const dest = path.join(gitRoot, '.gitlab-ci.yml');
      fs.writeFileSync(dest, gitlabYaml, 'utf8');
      created.push('.gitlab-ci.yml');
    } catch (e) { errors.push(`.gitlab-ci.yml: ${e.message}`); }
  }

  // ── Generate .github/workflows/perf-test.yml ─────────────────────────────
  if (providers.includes('github')) {
    const workflowFile = cfg?.github_workflow_file || 'perf-test.yml';
    const defaultScript = suites.length > 0
      ? path.basename(suites[0].jmx_path || suites[0].js_path || 'test.jmx')
      : 'test.jmx';

    // The branch where user scripts live — passed as a workflow input so the
    // checkout step fetches the right branch even when the workflow file lives on main.
    // For regular users always use their saved git identity branch (user_git_configs.branch_name)
    // so the YAML targets their personal branch, not the base branch saved in cfg.github_ref.
    const userGitIdYaml = !isAdmin
      ? await db.prepare('SELECT branch_name FROM user_git_configs WHERE user_id = ? AND project_id = ?').get(req.userId, req.params.projectId)
      : null;
    const userBranch = isAdmin
      ? (cfg?.github_ref || baseBranch)
      : (userGitIdYaml?.branch_name || `feature/${(callerRow?.name || 'user').toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`);

    const scriptList = suites.map(s => {
      const relPath = s.jmx_path
        ? path.relative(gitRoot, s.jmx_path).replace(/\\/g, '/')
        : path.relative(gitRoot, s.js_path || '').replace(/\\/g, '/');
      return `      # ${s.name}: ${relPath}`;
    }).join('\n');

    const githubYaml = `# ============================================================
# PerfStudio — GitHub Actions Performance Test Pipeline
# Generated by PerfStudio on ${new Date().toISOString().slice(0, 19).replace('T', ' ')}
# ============================================================

name: PerfStudio Performance Test

on:
  workflow_dispatch:
    inputs:
      script_name:
        description: 'JMX script filename (relative to repo root)'
        required: true
        default: '${defaultScript}'
      script_path:
        description: 'Full relative path to script (overrides script_name if set)'
        required: false
        default: ''
      jmeter_users:
        description: 'Number of virtual users'
        required: true
        default: '10'
      jmeter_rampup:
        description: 'Ramp-up period in seconds'
        required: true
        default: '30'
      jmeter_loops:
        description: 'Number of iterations (used when not duration mode)'
        required: true
        default: '1'
      jmeter_duration:
        description: 'Test duration in seconds'
        required: true
        default: '300'
      branch:
        description: 'Branch containing the test scripts (user workspace branch)'
        required: false
        default: '${userBranch}'

# Available test scripts:
${scriptList || '      # (no generated scripts yet)'}

jobs:
  jmeter:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          ref: \${{ inputs.branch || github.ref_name }}

      - name: Patch JMX parameters
        run: |
          SCRIPT="\${{ inputs.script_path }}"
          [ -z "\$SCRIPT" ] && SCRIPT="\${{ inputs.script_name }}"
          echo "Patching \$SCRIPT  users=\${{ inputs.jmeter_users }} rampup=\${{ inputs.jmeter_rampup }} duration=\${{ inputs.jmeter_duration }}"
          python3 .PerfStudio/patch_jmx.py "\$SCRIPT" "\${{ inputs.jmeter_users }}" "\${{ inputs.jmeter_rampup }}" "\${{ inputs.jmeter_loops }}" "\${{ inputs.jmeter_duration }}"
          echo "=== ThreadGroup after patch ==="
          grep -A 30 "ThreadGroup" "\$SCRIPT" | head -50
          echo "=== HTTP Samplers ==="
          grep -c "HTTPSamplerProxy\|HTTPSampler" "\$SCRIPT" || echo "0 samplers found"
          echo "=== Enabled elements ==="
          grep "enabled=" "\$SCRIPT" | head -10

      - name: Cache CI Docker image
        uses: actions/cache@v4
        with:
          path: /tmp/docker-cache
          key: docker-perf-\${{ runner.os }}
          restore-keys: docker-perf-

      - name: Load cached image or pull
        run: |
          if [ -f /tmp/docker-cache/perf-image.tar ]; then
            echo "Loading cached image..."
            docker load -i /tmp/docker-cache/perf-image.tar
          else
            echo "Pulling ${dockerImage} (first run on this runner)..."
            docker pull ${dockerImage}
            mkdir -p /tmp/docker-cache
            docker save ${dockerImage} -o /tmp/docker-cache/perf-image.tar
          fi

      - name: Verify patch and CSV files
        run: |
          SCRIPT="\${{ inputs.script_path }}"
          [ -z "\$SCRIPT" ] && SCRIPT="\${{ inputs.script_name }}"
          echo "=== ThreadGroup after patch ==="
          grep -E "num_threads|ramp_time|scheduler|duration|continue_forever|LoopController.loops" "\$SCRIPT" || echo "WARN: no matches found"
          echo "=== CSV paths in JMX ==="
          grep -i "CSV_PATH\\|Argument.value.*testData\\|filename.*CSV\\|CSVDataSet" "\$SCRIPT" | head -10
          echo "=== CSV files in workspace ==="
          TESTDATA="\$(grep -o 'Argument.value>[^<]*testData' \$SCRIPT | head -1 | sed 's/Argument.value>//')"
          [ -n "\$TESTDATA" ] && ls -la "\$TESTDATA/" 2>/dev/null || echo "testData dir: \$TESTDATA (checking /workspace prefix)"
          ls -la "/workspace/projects/Demo1/Demo1_API_Collection/QA/testData/" 2>/dev/null || echo "Path not found"

      - name: Run JMeter
        run: |
          SCRIPT="\${{ inputs.script_path }}"
          [ -z "\$SCRIPT" ] && SCRIPT="\${{ inputs.script_name }}"
          mkdir -p reports
          docker run --rm \\
            -v "\${{ github.workspace }}":/workspace \\
            -v "\${{ github.workspace }}/reports":/output \\
            ${dockerImage} \\
            jmeter \\
            -n -t "/workspace/\$SCRIPT" \\
            -j /output/jmeter.log \\
            -l /output/results.jtl \\
            -e -o /output/html || true
          echo "=== JMeter Log (last 50 lines) ==="
          tail -50 reports/jmeter.log 2>/dev/null || echo "No jmeter.log found"

      - name: Validate results
        run: |
          JTL="reports/results.jtl"
          [ ! -f "\$JTL" ] && echo "ERROR: results.jtl not found" && exit 1
          TOTAL=\$(( \$(wc -l < "\$JTL") - 1 ))
          echo "Total requests: \$TOTAL"
          [ "\$TOTAL" -le 0 ] && echo "ERROR: 0 requests executed - check thread group config" && exit 1
          # Fail the job immediately on 100% error rate — don't wait for PerfStudio's own
          # results sync to notice. Header-based column lookup since JMeter's CSV field
          # order isn't guaranteed fixed.
          SUCCESS_COL=\$(head -1 "\$JTL" | tr -d '"' | tr ',' '\\n' | grep -nx 'success' | head -1 | cut -d: -f1)
          if [ -n "\$SUCCESS_COL" ]; then
            FAILED=\$(tail -n +2 "\$JTL" | awk -F',' -v col="\$SUCCESS_COL" '{gsub(/"/,"",\$col)} \$col!="true"{c++} END{print c+0}')
            echo "Failed requests: \$FAILED / \$TOTAL"
            if [ "\$FAILED" -eq "\$TOTAL" ]; then
              echo "ERROR: 100% of requests failed (\$FAILED/\$TOTAL) - failing the job so CI history reflects this immediately"
              exit 1
            fi
          else
            echo "WARN: could not locate 'success' column in JTL header - skipping error-rate check"
          fi
          echo "Validation passed: \$TOTAL requests"

      - name: Upload report
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: jmeter-report-\${{ github.run_number }}
          path: reports/
          retention-days: 7
`;

    // Write Python patcher as a separate committed file — avoids heredoc/YAML nesting issues
    const patcherPy = `# PerfStudio JMX parameter patcher
# Usage: python3 patch_jmx.py <script> <users> <rampup> <loops> <duration>
import re, sys

script, users, rampup, loops, duration = sys.argv[1:6]
use_duration = duration != "-1" and int(duration) > 0

with open(script, "r", encoding="utf-8") as f:
    content = f.read()

def sp(xml, name, val):
    pat = r'(<(?:string|int|long|bool)Prop\\s+name="' + re.escape(name) + r'">)[^<]*'
    new, n = re.subn(pat, r'\\g<1>' + str(val), xml)
    print(("  SET " if n else "  WARN ") + name + "=" + str(val))
    return new

# Fix absolute local paths -> CI workspace paths
# Strips Windows paths up to and including git-workspaces/<project>/<user>/
# so JMeter finds files relative to /workspace (the Docker-mounted repo root).
path_pattern = r'[A-Za-z]:[/\\\\][^\\'\\'"<>]*?git-workspaces[/\\\\][^/\\\\]+[/\\\\][^/\\\\]+[/\\\\]'
fixed_content, path_fixes = re.subn(path_pattern, '/workspace/', content)
if path_fixes:
    fixed_content = fixed_content.replace('\\\\', '/')
    content = fixed_content
    print("  FIXED " + str(path_fixes) + " absolute path(s) -> /workspace/")
else:
    # Fallback: old single-level structure git-workspaces/<user>/
    path_pattern_old = r'[A-Za-z]:[/\\\\][^\\'\\'"<>]*?git-workspaces[/\\\\][^/\\\\]+[/\\\\]'
    fixed_content, path_fixes = re.subn(path_pattern_old, '/workspace/', content)
    if path_fixes:
        fixed_content = fixed_content.replace('\\\\', '/')
        content = fixed_content
        print("  FIXED " + str(path_fixes) + " absolute path(s) (old structure) -> /workspace/")
    else:
        print("  No absolute paths to fix")

content = sp(content, "ThreadGroup.num_threads", users)
content = sp(content, "ThreadGroup.ramp_time", rampup)

if use_duration:
    print("  Mode: Duration " + duration + "s")
    content = sp(content, "ThreadGroup.scheduler", "true")
    content = sp(content, "ThreadGroup.duration", duration)
    content = sp(content, "LoopController.loops", "-1")
    if 'name="ThreadGroup.duration"' not in content:
        content = content.replace("</ThreadGroup>",
            '<stringProp name="ThreadGroup.duration">' + duration + '</stringProp>\\n'
            '<boolProp name="ThreadGroup.scheduler">true</boolProp>\\n</ThreadGroup>')
        print("  INJECTED duration+scheduler")
else:
    print("  Mode: Loops " + loops)
    content = sp(content, "ThreadGroup.scheduler", "false")
    content = sp(content, "LoopController.loops", loops)

with open(script, "w") as f:
    f.write(content)
print("Patch complete")
`;

    try {
      const workflowDir = path.join(gitRoot, '.github', 'workflows');
      fs.mkdirSync(workflowDir, { recursive: true });
      fs.writeFileSync(path.join(workflowDir, workflowFile), githubYaml, 'utf8');
      created.push(`.github/workflows/${workflowFile}`);

      // Commit the Python patcher alongside the YAML
      const patcherDir = path.join(gitRoot, '.PerfStudio');
      fs.mkdirSync(patcherDir, { recursive: true });
      fs.writeFileSync(path.join(patcherDir, 'patch_jmx.py'), patcherPy, 'utf8');
      created.push(`.PerfStudio/patch_jmx.py`);
    } catch (e) { errors.push(`${e.message}`); }
  }

  // ── Generate bitbucket-pipelines.yml ────────────────────────────────────────
  if (providers.includes('bitbucket')) {
    const defaultScript = suites.length > 0
      ? path.basename(suites[0].jmx_path || suites[0].js_path || 'test.jmx')
      : 'test.jmx';

    const scriptList = suites.map(s => {
      const file = path.basename(s.jmx_path || s.js_path || '');
      return `  # ${s.name} → ${file}`;
    }).join('\n');

    const bbYaml = `# ============================================================
# Peako — Bitbucket Pipelines Performance Test
# Generated by Peako on ${new Date().toISOString().slice(0, 19).replace('T', ' ')}
#
# REQUIRED SETUP (Bitbucket → Repository Settings → Repository Variables):
#   BB_USERNAME     — your Bitbucket username  (mark as Secured)
#   BB_APP_PASSWORD — Bitbucket App Password / API Token (mark as Secured)
#
# Available test scripts:
${scriptList || '  # (no generated scripts yet — generate from Test Plans first)'}
# ============================================================

image: docker:latest

definitions:
  services:
    docker:
      memory: 2048

pipelines:
  custom:
    Peako-Performance-Test:
      - variables:
          - name: SCRIPT_NAME
            default: "${defaultScript}"
          - name: SCRIPT_PATH
            default: ""
          - name: RESULTS_PATH
            default: ""
          - name: TESTDATA_PATH
            default: "testData"
          - name: JMETER_USERS
            default: "10"
          - name: JMETER_RAMPUP
            default: "30"
          - name: JMETER_LOOPS
            default: "-1"
          - name: JMETER_DURATION
            default: "300"
      - step:
          name: Run JMeter Performance Test
          size: 2x
          services:
            - docker
          script:
            - apk add --no-cache curl zip bash python3
            - PIPELINE_ID=$(echo "$BITBUCKET_PIPELINE_UUID" | tr -d '{}')
            - echo "Peako Performance Test"
            - echo "Script    | \${SCRIPT_PATH:-\$SCRIPT_NAME}"
            - echo "VUsers    | $JMETER_USERS"
            - echo "Ramp-up   | $JMETER_RAMPUP s"
            - echo "Duration  | $JMETER_DURATION s"
            - |
              SCRIPT="\${SCRIPT_PATH:-\$SCRIPT_NAME}"
              echo "=== Patching JMX parameters and fixing paths ==="
              python3 .PerfStudio/patch_jmx.py "\$SCRIPT" "\$JMETER_USERS" "\$JMETER_RAMPUP" "\$JMETER_LOOPS" "\$JMETER_DURATION"
              echo "=== JMX state after patch ==="
              grep -E "num_threads|ramp_time|scheduler|duration|LoopController.loops|CSV_PATH|Argument.value" "\$SCRIPT" | head -20 || true
            - |
              docker run --rm \\
                -e JVM_ARGS="-Dlog4j2.formatMsgNoLookups=true" \\
                -v "$BITBUCKET_CLONE_DIR:/workspace" \\
                ${dockerImage} \\
                jmeter \\
                -n -t "/workspace/\${SCRIPT_PATH:-\$SCRIPT_NAME}" \\
                -l "/workspace/results.jtl" \\
                -e -o "/workspace/html" || true
            - |
              if [ -n "$BB_USERNAME" ] && [ -n "$BB_APP_PASSWORD" ]; then
                cd "$BITBUCKET_CLONE_DIR"
                [ -d html ] && zip -r html.zip html/ 2>/dev/null || true
                DEST_BASE="\${RESULTS_PATH:-ci-results}/Run\${BITBUCKET_BUILD_NUMBER}"
                # Always upload results.jtl — create header stub if JMeter crashed without output
                # so auto-sync can always download it and detect 0 samples to trigger auto-heal
                [ ! -f results.jtl ] && printf 'timeStamp,elapsed,label,responseCode,responseMessage,threadName,dataType,success,failureMessage,bytes,sentBytes,grpThreads,allThreads,URL,Latency,IdleTime,Connect\\n' > results.jtl || true
                curl -s -X POST \\
                  "https://api.bitbucket.org/2.0/repositories/$BITBUCKET_REPO_FULL_NAME/src" \\
                  -u "$BB_USERNAME:$BB_APP_PASSWORD" \\
                  -F "message=ci-results: \${PIPELINE_ID} [auto]" \\
                  -F "branch=$BITBUCKET_BRANCH" \\
                  -F "\${DEST_BASE}/results.jtl=@results.jtl" \\
                  && echo "JTL committed to $BITBUCKET_BRANCH" || echo "JTL commit failed (non-fatal)"
                if [ -f html.zip ]; then
                  curl -s -X POST \\
                    "https://api.bitbucket.org/2.0/repositories/$BITBUCKET_REPO_FULL_NAME/src" \\
                    -u "$BB_USERNAME:$BB_APP_PASSWORD" \\
                    -F "message=ci-results html: \${PIPELINE_ID} [auto]" \\
                    -F "branch=$BITBUCKET_BRANCH" \\
                    -F "\${DEST_BASE}/html.zip=@html.zip" \\
                    && echo "HTML report committed to $BITBUCKET_BRANCH" || echo "HTML commit failed (non-fatal)"
                fi
              else
                echo "BB_USERNAME / BB_APP_PASSWORD not set — skipping results commit"
              fi
            - |
              JTL="$BITBUCKET_CLONE_DIR/results.jtl"
              if [ ! -f "$JTL" ]; then
                echo "ERROR: results.jtl not found — JMeter may have crashed before producing output."
                exit 1
              fi
              TOTAL=$(( $(wc -l < "$JTL") - 1 ))
              echo "JMeter sample count: $TOTAL"
              if [ "$TOTAL" -le 0 ]; then
                echo "ERROR: JMeter produced 0 requests — check that thread groups are enabled and the test plan is valid."
                exit 1
              fi
              # Fail the job immediately on 100% error rate — don't wait for PerfStudio's own
              # results sync to notice. Header-based column lookup since JMeter's CSV field
              # order isn't guaranteed fixed.
              SUCCESS_COL=$(head -1 "$JTL" | tr -d '"' | tr ',' '\n' | grep -nx 'success' | head -1 | cut -d: -f1)
              if [ -n "$SUCCESS_COL" ]; then
                FAILED=$(tail -n +2 "$JTL" | awk -F',' -v col="$SUCCESS_COL" '{gsub(/"/,"",$col)} $col!="true"{c++} END{print c+0}')
                echo "Failed requests: $FAILED / $TOTAL"
                if [ "$FAILED" -eq "$TOTAL" ]; then
                  echo "ERROR: 100% of requests failed ($FAILED/$TOTAL) — failing the job so CI history reflects this immediately."
                  exit 1
                fi
              else
                echo "WARN: could not locate 'success' column in JTL header — skipping error-rate check."
              fi
              echo "Validation passed: $TOTAL requests executed."
`;
    try {
      const dest = path.join(gitRoot, 'bitbucket-pipelines.yml');
      fs.writeFileSync(dest, bbYaml.replace(/\r\n/g, '\n'), 'utf8');
      created.push('bitbucket-pipelines.yml');

      // Write the Python patcher alongside the YAML
      const bbPatcherDir = path.join(gitRoot, '.PerfStudio');
      fs.mkdirSync(bbPatcherDir, { recursive: true });
      fs.writeFileSync(path.join(bbPatcherDir, 'patch_jmx.py'), BB_PATCHER_PY.replace(/\r\n/g, '\n'), 'utf8');
      created.push('.PerfStudio/patch_jmx.py');
    } catch (e) { errors.push(`bitbucket-pipelines.yml: ${e.message}`); }
  }

  if (created.length === 0) return res.status(500).json({ error: errors.join('; ') || 'Nothing generated' });

  // Auto-commit and push to remote so the workflow is immediately available on GitHub.
  // The perf-test.yml MUST be on the remote default branch (main) for workflow_dispatch to work.
  let pushMessage = '';
  try {
    const gitCfg = await db.prepare('SELECT * FROM git_configs WHERE project_id = ?').get(req.params.projectId);
    if (gitCfg?.is_initialized && fs.existsSync(path.join(gitRoot, '.git'))) {
      const NO_PROMPT = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', GIT_SSH_ASKPASS: 'echo', GCM_INTERACTIVE: 'never', GCM_NO_INTERACTIVE: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '' };

      // Detect SSH auth: any enabled provider using SSH key auth
      const providerInRequest = (providers[0] || 'github');
      const authMethodKey = `${providerInRequest}_auth_method`;
      const useSsh = cfg?.[authMethodKey] === 'ssh' && !!cfg?.ssh_private_key;

      // Build SSH env or token-based remote URL
      let sshEnv = {};
      let sshCleanup = () => {};
      let remoteUrl = gitCfg.remote_url;

      if (useSsh) {
        // Write temp key and set GIT_SSH_COMMAND (same approach as git.js gitExec)
        const sshId = randomBytes(8).toString('hex');
        const sshKeyPath = path.join(os.tmpdir(), `ps_ci_push_${sshId}`);
        const sshKhPath  = path.join(os.tmpdir(), `ps_ci_kh_push_${sshId}`);
        const normalizedKey = cfg.ssh_private_key.trim().replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        fs.writeFileSync(sshKeyPath, normalizedKey + '\n', { mode: 0o600 });
        if (os.platform() === 'win32') {
          const username = process.env.USERNAME || process.env.USER || 'User';
          spawnSync('icacls', [sshKeyPath, '/inheritance:r', '/grant:r', `${username}:F`], { windowsHide: true });
        }
        // Scan known_hosts
        const extractHost = url => { const m = url.match(/(?:git@|ssh:\/\/[^@]+@?)([^:/]+)/); return m?.[1] || null; };
        const sshHost = extractHost(gitCfg.remote_url);
        let khContent = '';
        if (sshHost) {
          const scan = spawnSync('ssh-keyscan', ['-H', '-t', 'ed25519,rsa,ecdsa', sshHost], { timeout: 10000, windowsHide: true, encoding: 'utf8' });
          khContent = (scan.stdout || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
        }
        fs.writeFileSync(sshKhPath, khContent ? khContent + '\n' : '', { mode: 0o600 });
        const strictCheck = khContent ? 'yes' : 'no';
        const sshKeyFwd = sshKeyPath.replace(/\\/g, '/');
        const sshKhFwd  = sshKhPath.replace(/\\/g, '/');
        sshEnv = { GIT_SSH_COMMAND: `ssh -i "${sshKeyFwd}" -o StrictHostKeyChecking=${strictCheck} -o UserKnownHostsFile="${sshKhFwd}" -o BatchMode=yes` };
        sshCleanup = () => { try { fs.unlinkSync(sshKeyPath); } catch {} try { fs.unlinkSync(sshKhPath); } catch {} };
      } else {
        // Token-based HTTPS URL — prefer user's personal token, fall back to project-level
        const { decrypt: dec } = require('../utils/encryption');
        const userIdentity = await db.prepare('SELECT auth_token FROM user_git_configs WHERE user_id = ? AND project_id = ?')
          .get(req.userId, req.params.projectId);
        const rawToken = (userIdentity?.auth_token ? dec(userIdentity.auth_token) : '')
          || (gitCfg.auth_token ? dec(gitCfg.auth_token) : '');
        if (rawToken) {
          const isBb = /bitbucket\.org/i.test(gitCfg.remote_url);
          if (isBb) {
            const embMatch = gitCfg.remote_url.match(/^https?:\/\/([^:@]+)@/);
            const bbUser = gitCfg.username || (embMatch ? embMatch[1] : null);
            const base = gitCfg.remote_url.replace(/^(https?:\/\/)[^@]*@?/, '$1');
            remoteUrl = bbUser
              ? base.replace(/^(https?:\/\/)/, `$1${encodeURIComponent(bbUser)}:${encodeURIComponent(rawToken)}@`)
              : base.replace(/^(https?:\/\/)/, `$1x-token-auth:${encodeURIComponent(rawToken)}@`);
          } else {
            // Strip any existing user@ prefix then inject token before the hostname.
            // [^@\/]+ stops at the first / so it never eats the hostname when there is no user@ part.
            remoteUrl = gitCfg.remote_url.replace(/^(https?:\/\/)(?:[^@\/]+@)?/, `$1${encodeURIComponent(rawToken)}@`);
          }
        }
      }

      // Helper: run git via spawnSync so env vars (GIT_SSH_COMMAND) are reliably forwarded
      const gitRun = (args) => {
        const r = spawnSync('git', args, {
          cwd: gitRoot,
          env: { ...process.env, ...NO_PROMPT, ...sshEnv },
          timeout: 30000, encoding: 'utf8', windowsHide: true,
        });
        if (r.status !== 0) throw new Error((r.stderr || r.stdout || `git ${args[0]} failed`).trim());
        return (r.stdout || '').trim();
      };

      try {
        const autoCommitBranch = gitCfg?.base_branch || baseBranch;

        // Configure identity
        gitRun(['config', 'user.name',  callerRow.name  || 'PerfStudio']);
        gitRun(['config', 'user.email', callerRow.email || 'noreply@perfstudio.com']);
        // Keep 'origin' on the CLEAN url — the actual fetch/push below pass remoteUrl
        // (authenticated) directly as the command's URL argument, so the token never
        // needs to sit in .git/config at rest (readable via `git remote -v` indefinitely).
        gitRun(['remote', 'set-url', 'origin', gitCfg.remote_url]);

        // Never silently proceed on whatever branch happens to already be checked out —
        // that's exactly how a generated file once ended up committed to a stale personal
        // branch instead of main with zero indication anything went wrong. Try a plain
        // checkout (existing local branch), then a remote-tracking checkout (branch exists
        // on origin but was never fetched locally), then finally create it fresh.
        try {
          gitRun(['checkout', autoCommitBranch]);
        } catch {
          try {
            // Explicit refspec so this populates refs/remotes/origin/<branch> exactly like
            // a by-name `fetch origin` would — a bare URL fetch with no refspec only sets
            // FETCH_HEAD, which the checkout below wouldn't find.
            gitRun(['fetch', remoteUrl, `+${autoCommitBranch}:refs/remotes/origin/${autoCommitBranch}`]);
            gitRun(['checkout', '-b', autoCommitBranch, `origin/${autoCommitBranch}`]);
          } catch {
            gitRun(['checkout', '-b', autoCommitBranch]);
          }
        }
        // Defensive: a checkout that "succeeds" onto the wrong ref must never silently
        // result in a commit landing in the wrong place — verify before committing anything.
        const actualBranch = gitRun(['rev-parse', '--abbrev-ref', 'HEAD']);
        if (actualBranch !== autoCommitBranch) {
          throw new Error(`Expected to be on branch "${autoCommitBranch}" before committing the generated CI config, but git reports "${actualBranch}" — aborting instead of committing to the wrong branch.`);
        }

        // Stage only the generated CI files
        gitRun(['add', ...created.map(f => path.join(gitRoot, f))]);

        // Check if anything staged
        const statusOut = spawnSync('git', ['status', '--porcelain'], {
          cwd: gitRoot, env: { ...process.env, ...NO_PROMPT }, timeout: 10000, encoding: 'utf8', windowsHide: true,
        });
        const hasStagedChanges = (statusOut.stdout || '').split('\n').some(l => l.match(/^[MADRCU]/));

        if (hasStagedChanges) {
          gitRun(['commit', '-m', 'ci: add Peako Performance Test workflow [auto]']);
          gitRun(['push', '--set-upstream', remoteUrl, autoCommitBranch]);
          pushMessage = ` Committed and pushed to ${autoCommitBranch} automatically.`;
        } else {
          pushMessage = ` Files unchanged — already up to date on ${autoCommitBranch}.`;
        }
      } finally {
        sshCleanup();
      }
    }
  } catch (pushErr) {
    errors.push(`Auto-push failed: ${pushErr.message} — go to Configuration → Git and push manually.`);
  }

  // ── Bitbucket API fallback: commit YAML directly via Files API ────────────────
  // Used when the admin workspace has no local .git (never cloned), or when the
  // git push above was skipped. The Files API needs no local repo at all.
  if (providers.includes('bitbucket') && !pushMessage.includes('pushed') && cfg?.bitbucket_workspace && cfg?.bitbucket_repo_slug && cfg?.bitbucket_app_password) {
    try {
      const _bbAuth   = await bbBasicAuth(cfg, req.userId);
      const _bbWs     = cfg.bitbucket_workspace;
      const _bbSlug   = cfg.bitbucket_repo_slug;
      const gitCfgBb  = await db.prepare('SELECT * FROM git_configs WHERE project_id = ?').get(req.params.projectId);
      const _bbBranch = gitCfgBb?.base_branch || baseBranch || 'main';
      const _boundary = `bbpush${randomBytes(8).toString('hex')}`;

      const yamlDest    = path.join(gitRoot, 'bitbucket-pipelines.yml');
      const yamlContent = fs.existsSync(yamlDest) ? fs.readFileSync(yamlDest) : Buffer.from(bbYaml || '', 'utf8');
      const patcherDest  = path.join(gitRoot, '.PerfStudio', 'patch_jmx.py');
      const patcherContent = fs.existsSync(patcherDest) ? fs.readFileSync(patcherDest) : null;

      const _chunks = [];
      const _add = s => _chunks.push(Buffer.isBuffer(s) ? s : Buffer.from(s, 'utf8'));
      _add(`--${_boundary}\r\nContent-Disposition: form-data; name="message"\r\n\r\nci: update Peako Performance Test YAML [auto]\r\n`);
      _add(`--${_boundary}\r\nContent-Disposition: form-data; name="branch"\r\n\r\n${_bbBranch}\r\n`);
      _add(`--${_boundary}\r\nContent-Disposition: form-data; name="bitbucket-pipelines.yml"\r\n\r\n`);
      _add(yamlContent);
      _add('\r\n');
      if (patcherContent) {
        _add(`--${_boundary}\r\nContent-Disposition: form-data; name=".PerfStudio/patch_jmx.py"\r\n\r\n`);
        _add(patcherContent);
        _add('\r\n');
      }
      _add(`--${_boundary}--\r\n`);
      const _bodyBuf = Buffer.concat(_chunks);

      await new Promise((resolve, reject) => {
        const _opts = {
          hostname: 'api.bitbucket.org', port: 443,
          path: `/2.0/repositories/${_bbWs}/${_bbSlug}/src`,
          method: 'POST',
          headers: {
            Authorization: _bbAuth,
            'Content-Type': `multipart/form-data; boundary=${_boundary}`,
            'Content-Length': _bodyBuf.length,
            'User-Agent': 'PerfStudio',
          },
          rejectUnauthorized: false,
        };
        const _r = https.request(_opts, _res => {
          let _d = ''; _res.on('data', c => _d += c);
          _res.on('end', () => {
            if (_res.statusCode === 201) resolve();
            else reject(new Error(`Bitbucket API ${_res.statusCode}: ${_d.slice(0, 200)}`));
          });
        });
        _r.on('error', reject);
        _r.write(_bodyBuf);
        _r.end();
      });

      pushMessage = ` Pushed bitbucket-pipelines.yml to ${_bbBranch} via Bitbucket API.`;
      console.log(`[generate-yaml] bitbucket-pipelines.yml committed to ${_bbBranch} via API`);
    } catch (bbApiErr) {
      errors.push(`Bitbucket API push failed: ${bbApiErr.message}`);
      console.error('[generate-yaml] Bitbucket API push error:', bbApiErr.message);
    }
  }

  res.json({ ok: true, created, errors, message: `Generated: ${created.join(', ')}.${pushMessage}` });
});

// ── POST /trigger — trigger pipeline on GitLab or GitHub ─────────────────────
router.post('/trigger', async (req, res) => {
  if (!await ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  // Workspace/repo/ref are project-level settings — always from the admin's config.
  // Auth credentials (token, username/email) come from the triggering user's own config,
  // falling back to the admin's config if the user hasn't set their own.
  const adminRawCfg = await db.prepare(`
    SELECT cpc.* FROM ci_pipeline_configs cpc
    JOIN users u ON u.id = cpc.user_id
    WHERE cpc.project_id = ? AND u.role IN ('org_admin','super_admin')
    ORDER BY cpc.updated_at DESC LIMIT 1
  `).get(req.params.projectId);
  const userRawCfg  = await getConfig(req.params.projectId, req.userId);
  const adminCfg    = decryptConfig(adminRawCfg);
  const userCfg     = decryptConfig(userRawCfg);
  if (!adminCfg && !userCfg) return res.status(400).json({ error: 'CI configuration not saved yet.' });
  // Merge: project-level settings from admin, auth credentials from user (or admin as fallback)
  const cfg = {
    ...(adminCfg || userCfg),
    bitbucket_username:    userCfg?.bitbucket_username    || adminCfg?.bitbucket_username    || '',
    bitbucket_app_password: userCfg?.bitbucket_app_password || adminCfg?.bitbucket_app_password || '',
    github_token:          userCfg?.github_token          || adminCfg?.github_token          || '',
    gitlab_token:          userCfg?.gitlab_token          || adminCfg?.gitlab_token          || '',
    gitlab_trigger_token:  userCfg?.gitlab_trigger_token  || adminCfg?.gitlab_trigger_token  || '',
  };

  const { provider, script_name, script_path, jmeter_users, jmeter_rampup, jmeter_loops, jmeter_duration,
          auto_heal = 0, auto_heal_mode = 'auto', auto_heal_instruction = '' } = req.body;
  if (!provider) return res.status(400).json({ error: 'provider required (gitlab or github)' });

  // Build human-readable run_name: {SuiteName}_{N}Users_{D}sDuration (no Run# yet — added on sync)
  const { buildRunDirName } = require('../utils/buildRunName');
  const scriptFile2 = (script_name || '').replace(/\\/g, '/').split('/').pop();
  const matchedSuite2 = await db.prepare("SELECT name FROM test_suites WHERE project_id = ? AND (jmx_path LIKE ? OR js_path LIKE ?) LIMIT 1")
    .get(req.params.projectId, `%${scriptFile2}`, `%${scriptFile2}`);
  const ciRunDisplayName = buildRunDirName(
    matchedSuite2?.name || scriptFile2.replace(/\.jmx$|\.js$/, ''),
    jmeter_users, 'duration', jmeter_loops, jmeter_duration, ''
  ).replace(/_Run$/, ''); // strip trailing _Run (no seq# at trigger time)

  // Token priority for CI triggers:
  // 1. CI config token (saved specifically for CI/CD under Configuration → Pipeline)
  // 2. User's Git Identity PAT as fallback
  // The CI config token should have both `repo` + `workflow` scopes.
  const userIdentity = await db.prepare('SELECT auth_token FROM user_git_configs WHERE user_id = ? AND project_id = ?')
    .get(req.userId, req.params.projectId);
  const userToken = userIdentity?.auth_token ? decrypt(userIdentity.auth_token) : null;

  const effectiveGithubToken = cfg.github_token || userToken || getTokenFromGitRemote(req.params.projectId);
  const effectiveGitlabToken = cfg.gitlab_token || cfg.gitlab_trigger_token || userToken;

  // Resolve script name from DB when not provided by the caller (frontend omits it on some flows)
  let resolvedScriptName = script_name;
  if (!resolvedScriptName) {
    const suiteRow = await db.prepare('SELECT jmx_path, js_path FROM test_suites WHERE project_id = ? LIMIT 1').get(req.params.projectId);
    const suiteFile = suiteRow?.jmx_path || suiteRow?.js_path || '';
    resolvedScriptName = suiteFile.replace(/\\/g, '/').split('/').pop() || '';
  }
  const canonicalPaths = await buildCanonicalRepoPaths(req.params.projectId, resolvedScriptName || script_name);
  const variables = {
    script_name: resolvedScriptName || script_name,
    script_path:   canonicalPaths.scriptRepoPath,
    results_path:  canonicalPaths.resultsPath,
    testdata_path: canonicalPaths.testDataPath,
    jmeter_users:    String(jmeter_users    || 10),
    jmeter_rampup:   String(jmeter_rampup   || 30),
    jmeter_loops:    String(jmeter_loops    || 1),
    jmeter_duration: String(jmeter_duration || 300),
  };

  // ── Compute targetRef here so it is in scope for both auto-push and dispatch ─
  const callerRow2  = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  const isAdmin2    = ['org_admin', 'super_admin'].includes(callerRow2?.role);
  const gitCfgTrigger = await db.prepare('SELECT base_branch FROM git_configs WHERE project_id = ?').get(req.params.projectId);
  const baseBranch2 = gitCfgTrigger?.base_branch || 'main';
  // For Bitbucket non-admin users, always use feature/<username> branch regardless of
  // cfg.bitbucket_ref — that field defaults to 'main' from the admin config spread and
  // would clobber the user's branch (which holds testData and personal config).
  const bbUserBranch = isAdmin2
    ? (cfg.bitbucket_ref || baseBranch2)
    : `feature/${(callerRow2?.name || '').toLowerCase().replace(/[^a-z0-9_/-]/g, '-')}`;
  // For GitHub non-admin users, prefer their saved git identity branch so the trigger
  // targets their personal branch (where scripts live), not the base branch in cfg.github_ref.
  const ghUserGitId = !isAdmin2
    ? await db.prepare('SELECT branch_name FROM user_git_configs WHERE user_id = ? AND project_id = ?').get(req.userId, req.params.projectId)
    : null;
  const ghUserBranch = isAdmin2
    ? (cfg.github_ref || baseBranch2)
    : (ghUserGitId?.branch_name || `feature/${(callerRow2?.name || '').toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`);
  const targetRef   = provider === 'gitlab'
    ? (cfg.gitlab_ref || baseBranch2)
    : provider === 'bitbucket'
    ? bbUserBranch
    : ghUserBranch;

  // Store bb_branch so autoSyncCiRun can fetch results from the right branch
  variables.bb_branch = targetRef;

  // ── Auto-push script file to the target branch before dispatching ──────────
  // The CI runner checks out this branch — the JMX file must exist there or
  // the Patch JMX step will fail with FileNotFoundError.
  try {
    const { GIT_WORKSPACES_ROOT, cleanName, resolveUserFolder: resolveUF } = require('../utils/projectFolders');
    const projectRow = await db.prepare('SELECT name FROM projects WHERE id = ?').get(req.params.projectId);
    const gitCfg = await db.prepare('SELECT * FROM git_configs WHERE project_id = ?').get(req.params.projectId);
    // Always use the project's initialized git_root (set by admin) for auto-push,
    // not the triggering user's workspace — the user's workspace may lack .git.
    const wsRoot = (gitCfg?.git_root && fs.existsSync(path.join(gitCfg.git_root, '.git')))
      ? gitCfg.git_root
      : path.join(GIT_WORKSPACES_ROOT, cleanName(projectRow?.name || ''), resolveUF(req.userId));

    if (gitCfg?.is_initialized && fs.existsSync(path.join(wsRoot, '.git'))) {
      const simpleGit2 = require('simple-git');
      const NO_PROMPT2 = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', GIT_SSH_ASKPASS: 'echo', GCM_INTERACTIVE: 'never', GCM_NO_INTERACTIVE: '1', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '' };

      // Build authenticated remote URL based on provider.
      // For Bitbucket: always use the ADMIN credentials for git push — the repo belongs
      // to the admin account and only that token has repository:write scope.
      // Using the triggering user's ATATT token with the admin's embedded username causes
      // "Authentication failed" because ATATT tokens are account-specific.
      let authUrl = gitCfg.remote_url;
      if (provider === 'bitbucket') {
        const bbPass = adminCfg?.bitbucket_app_password || cfg.bitbucket_app_password;
        if (bbPass) {
          const base2 = gitCfg.remote_url.replace(/^(https?:\/\/)[^@]*@?/, '$1');
          // ATATT personal access tokens must use x-token-auth as the username for HTTPS git.
          // App Passwords (ATBB) use username:password. Detect by prefix.
          const isATATT = bbPass.trimStart().startsWith('ATATT');
          if (isATATT) {
            authUrl = base2.replace(/^(https?:\/\/)/, `$1x-token-auth:${encodeURIComponent(bbPass)}@`);
          } else {
            const embMatch2 = gitCfg.remote_url.match(/^https?:\/\/([^:@]+)@/);
            const bbUser2 = adminCfg?.bitbucket_username || gitCfg.username || (embMatch2 ? embMatch2[1] : null);
            authUrl = bbUser2
              ? base2.replace(/^(https?:\/\/)/, `$1${encodeURIComponent(bbUser2)}:${encodeURIComponent(bbPass)}@`)
              : base2.replace(/^(https?:\/\/)/, `$1x-token-auth:${encodeURIComponent(bbPass)}@`);
          }
        }
      } else if (provider === 'gitlab') {
        const glTok = cfg.gitlab_token || userToken || (gitCfg.auth_token ? decrypt(gitCfg.auth_token) : '');
        if (glTok) {
          authUrl = gitCfg.remote_url.replace(/^(https?:\/\/)[^@]*@?/, `$1oauth2:${encodeURIComponent(glTok)}@`);
        }
      } else {
        // GitHub (and any other provider): token-based auth
        const rawTok = userToken || (gitCfg.auth_token ? decrypt(gitCfg.auth_token) : '');
        if (rawTok) {
          authUrl = gitCfg.remote_url.replace(/^(https?:\/\/)[^@]*@?/, `$1${encodeURIComponent(rawTok)}@`);
        }
      }

      const git2 = simpleGit2({ baseDir: wsRoot, env: { ...process.env, ...NO_PROMPT2 } });
      await git2.addConfig('user.name',  callerRow2?.name  || 'PerfStudio');
      await git2.addConfig('user.email', callerRow2?.email || 'noreply@perfstudio.com');
      await git2.remote(['set-url', 'origin', authUrl]);
      await git2.fetch(['origin']).catch(() => {});
      try {
        await git2.checkout(targetRef);
      } catch {
        // Branch may exist on remote but not locally — try to track it
        try { await git2.raw(['checkout', '-b', targetRef, `origin/${targetRef}`]); }
        catch { await git2.checkoutLocalBranch(targetRef); }
      }
      // Sync with remote BEFORE committing new files so the push is fast-forward.
      // Without this, if origin/main has new commits (workflow file updates, CI artifacts, etc.)
      // the push would be rejected as non-fast-forward and the JMX would never reach GitHub.
      // Stash ONLY tracked modifications (not untracked files like testData).
      // git reset --hard does not touch untracked files, so testData survives naturally.
      // Using --include-untracked caused testData to be stashed then lost on pop failure.
      let stashed = false;
      try { const r = await git2.raw(['stash', '-m', 'peako-auto-stash']); stashed = !r.includes('No local changes'); } catch {}
      try { await git2.raw(['merge', '--ff-only', `origin/${targetRef}`]); } catch {
        // ff-only failed (diverged) — hard reset to remote and restore stash on top
        try { await git2.raw(['reset', '--hard', `origin/${targetRef}`]); } catch {}
      }
      // Restore stashed tracked-file changes after syncing
      if (stashed) { try { await git2.raw(['stash', 'pop']); } catch {} }

      // Always regenerate bitbucket-pipelines.yml from the canonical template so that
      // git reset/merge never reverts to an outdated version lacking the explicit `jmeter` entrypoint.
      if (provider === 'bitbucket') {
        try {
          const _gcRow = await db.prepare('SELECT config_json FROM global_config WHERE user_id = ?').get(req.userId)
            || await db.prepare(`SELECT gc.config_json FROM global_config gc JOIN users u ON u.id = gc.user_id WHERE u.role IN ('org_admin','super_admin') ORDER BY gc.user_id LIMIT 1`).get();
          const _dockerImage = (JSON.parse(_gcRow?.config_json || '{}').jmeter_docker_image || 'tasleemzaif/perfstudio:latest').trim();
          const _suites = await db.prepare('SELECT jmx_path, js_path FROM test_suites WHERE project_id = ?').all(req.params.projectId);
          const _defScript = _suites.length ? path.basename(_suites[0].jmx_path || _suites[0].js_path || 'test.jmx') : 'test.jmx';
          const _scriptList = _suites.map(s => {
            const f = path.basename(s.jmx_path || s.js_path || '');
            return `  # ${path.basename(s.jmx_path || s.js_path || f)} → ${f}`;
          }).join('\n');
          const _bbYaml = `# ============================================================
# Peako — Bitbucket Pipelines Performance Test
# Generated by Peako on ${new Date().toISOString().slice(0, 19).replace('T', ' ')}
#
# REQUIRED SETUP (Bitbucket → Repository Settings → Repository Variables):
#   BB_USERNAME     — your Bitbucket username  (mark as Secured)
#   BB_APP_PASSWORD — Bitbucket App Password / API Token (mark as Secured)
#
# Available test scripts:
${_scriptList || '  # (no generated scripts yet — generate from Test Plans first)'}
# ============================================================

image: docker:latest

definitions:
  services:
    docker:
      memory: 2048

pipelines:
  custom:
    Peako-Performance-Test:
      - variables:
          - name: SCRIPT_NAME
            default: "${_defScript}"
          - name: SCRIPT_PATH
            default: ""
          - name: RESULTS_PATH
            default: ""
          - name: TESTDATA_PATH
            default: "testData"
          - name: JMETER_USERS
            default: "10"
          - name: JMETER_RAMPUP
            default: "30"
          - name: JMETER_LOOPS
            default: "-1"
          - name: JMETER_DURATION
            default: "300"
      - step:
          name: Run JMeter Performance Test
          size: 2x
          services:
            - docker
          script:
            - apk add --no-cache curl zip bash python3
            - PIPELINE_ID=$(echo "$BITBUCKET_PIPELINE_UUID" | tr -d '{}')
            - echo "Peako Performance Test"
            - echo "Script    | \${SCRIPT_PATH:-\$SCRIPT_NAME}"
            - echo "VUsers    | $JMETER_USERS"
            - echo "Ramp-up   | $JMETER_RAMPUP s"
            - echo "Duration  | $JMETER_DURATION s"
            - |
              SCRIPT="\${SCRIPT_PATH:-\$SCRIPT_NAME}"
              echo "=== Patching JMX parameters and fixing paths ==="
              python3 .PerfStudio/patch_jmx.py "\$SCRIPT" "\$JMETER_USERS" "\$JMETER_RAMPUP" "\$JMETER_LOOPS" "\$JMETER_DURATION"
              echo "=== JMX state after patch ==="
              grep -E "num_threads|ramp_time|scheduler|duration|LoopController.loops|CSV_PATH|Argument.value" "\$SCRIPT" | head -20 || true
            - |
              docker run --rm \\
                -e JVM_ARGS="-Dlog4j2.formatMsgNoLookups=true" \\
                -v "$BITBUCKET_CLONE_DIR:/workspace" \\
                ${_dockerImage} \\
                jmeter \\
                -n -t "/workspace/\${SCRIPT_PATH:-\$SCRIPT_NAME}" \\
                -l "/workspace/results.jtl" \\
                -e -o "/workspace/html" || true
            - |
              if [ -n "$BB_USERNAME" ] && [ -n "$BB_APP_PASSWORD" ]; then
                cd "$BITBUCKET_CLONE_DIR"
                [ -d html ] && zip -r html.zip html/ 2>/dev/null || true
                DEST_BASE="\${RESULTS_PATH:-ci-results}/Run\${BITBUCKET_BUILD_NUMBER}"
                # Always upload results.jtl — create header stub if JMeter crashed without output
                # so auto-sync can always download it and detect 0 samples to trigger auto-heal
                [ ! -f results.jtl ] && printf 'timeStamp,elapsed,label,responseCode,responseMessage,threadName,dataType,success,failureMessage,bytes,sentBytes,grpThreads,allThreads,URL,Latency,IdleTime,Connect\\n' > results.jtl || true
                curl -s -X POST \\
                  "https://api.bitbucket.org/2.0/repositories/$BITBUCKET_REPO_FULL_NAME/src" \\
                  -u "$BB_USERNAME:$BB_APP_PASSWORD" \\
                  -F "message=ci-results: \${PIPELINE_ID} [auto]" \\
                  -F "branch=$BITBUCKET_BRANCH" \\
                  -F "\${DEST_BASE}/results.jtl=@results.jtl" \\
                  && echo "JTL committed to $BITBUCKET_BRANCH" || echo "JTL commit failed (non-fatal)"
                if [ -f html.zip ]; then
                  curl -s -X POST \\
                    "https://api.bitbucket.org/2.0/repositories/$BITBUCKET_REPO_FULL_NAME/src" \\
                    -u "$BB_USERNAME:$BB_APP_PASSWORD" \\
                    -F "message=ci-results html: \${PIPELINE_ID} [auto]" \\
                    -F "branch=$BITBUCKET_BRANCH" \\
                    -F "\${DEST_BASE}/html.zip=@html.zip" \\
                    && echo "HTML report committed to $BITBUCKET_BRANCH" || echo "HTML commit failed (non-fatal)"
                fi
              else
                echo "BB_USERNAME / BB_APP_PASSWORD not set — skipping results commit"
              fi
            - |
              JTL="$BITBUCKET_CLONE_DIR/results.jtl"
              if [ ! -f "$JTL" ]; then
                echo "ERROR: results.jtl not found — JMeter may have crashed before producing output."
                exit 1
              fi
              TOTAL=$(( $(wc -l < "$JTL") - 1 ))
              echo "JMeter sample count: $TOTAL"
              if [ "$TOTAL" -le 0 ]; then
                echo "ERROR: JMeter produced 0 requests — check that thread groups are enabled and the test plan is valid."
                exit 1
              fi
              # Fail the job immediately on 100% error rate — don't wait for PerfStudio's own
              # results sync to notice. Header-based column lookup since JMeter's CSV field
              # order isn't guaranteed fixed.
              SUCCESS_COL=$(head -1 "$JTL" | tr -d '"' | tr ',' '\n' | grep -nx 'success' | head -1 | cut -d: -f1)
              if [ -n "$SUCCESS_COL" ]; then
                FAILED=$(tail -n +2 "$JTL" | awk -F',' -v col="$SUCCESS_COL" '{gsub(/"/,"",$col)} $col!="true"{c++} END{print c+0}')
                echo "Failed requests: $FAILED / $TOTAL"
                if [ "$FAILED" -eq "$TOTAL" ]; then
                  echo "ERROR: 100% of requests failed ($FAILED/$TOTAL) — failing the job so CI history reflects this immediately."
                  exit 1
                fi
              else
                echo "WARN: could not locate 'success' column in JTL header — skipping error-rate check."
              fi
              echo "Validation passed: $TOTAL requests executed."
`;
          fs.writeFileSync(path.join(wsRoot, 'bitbucket-pipelines.yml'), _bbYaml.replace(/\r\n/g, '\n'), 'utf8');
          console.log('[CI trigger] bitbucket-pipelines.yml regenerated from canonical template');
        } catch (e) {
          console.warn('[CI trigger] YAML regen failed:', e.message);
        }
      }

      // Ensure .PerfStudio/patch_jmx.py is present on the branch being pushed/dispatched —
      // for EVERY provider, not just Bitbucket. It's normally committed to main via
      // /generate-yaml, but a user's branch may have been created before that, or may
      // never have merged it in, leaving GitHub Actions unable to find it at checkout
      // ("python3: can't open file '.../.PerfStudio/patch_jmx.py'").
      try {
        const _patcherDir = path.join(wsRoot, '.PerfStudio');
        const _patcherPath = path.join(_patcherDir, 'patch_jmx.py');
        if (!fs.existsSync(_patcherPath)) {
          fs.mkdirSync(_patcherDir, { recursive: true });
          fs.writeFileSync(_patcherPath, BB_PATCHER_PY.replace(/\r\n/g, '\n'), 'utf8');
          console.log('[CI trigger] .PerfStudio/patch_jmx.py written (was missing)');
        }
      } catch (e) {
        console.warn('[CI trigger] patch_jmx.py ensure failed:', e.message);
      }

      // Copy the JMX/JS file into the workspace if it only exists in admin workspace.
      // Look up the absolute path from test_suites (jmx_path / js_path) — don't rely on
      // project.folder_path + script_path which points to the wrong location for new plans.
      if (script_name) {
        const scriptFile = (script_name || '').replace(/\\/g, '/').split('/').pop();
        const suiteRow   = await db.prepare(
          "SELECT jmx_path, js_path FROM test_suites WHERE project_id = ? AND (jmx_path LIKE ? OR js_path LIKE ?) LIMIT 1"
        ).get(req.params.projectId, `%${scriptFile}`, `%${scriptFile}`);

        // Determine the absolute source path from the suite record
        let srcAbs = suiteRow?.jmx_path || suiteRow?.js_path || '';
        // Fallback: search all workspace roots for the file
        if (!srcAbs || !fs.existsSync(srcAbs)) {
          const { GIT_WORKSPACES_ROOT: _wsRoot2, cleanName: _cn2 } = require('../utils/projectFolders');
          const pName   = (await db.prepare('SELECT name FROM projects WHERE id = ?').get(req.params.projectId))?.name || '';
          // Search dirs: project-named subfolder AND root-level workspace dirs (covers legacy paths)
          const searchBases = [];
          try { searchBases.push(...fs.readdirSync(path.join(_wsRoot2, _cn2(pName)), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(_wsRoot2, _cn2(pName), d.name))); } catch {}
          try { searchBases.push(...fs.readdirSync(_wsRoot2, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(_wsRoot2, d.name))); } catch {}
          for (const base of searchBases) {
            const candidate = path.join(base, script_path ? script_path.replace(/\//g, path.sep) : scriptFile);
            if (fs.existsSync(candidate)) { srcAbs = candidate; break; }
          }
        }

        // Place JMX at canonical path inside workspace
        const canonicalDest = path.join(wsRoot, canonicalPaths.scriptRepoPath.replace(/\//g, path.sep));
        if (srcAbs && fs.existsSync(srcAbs)) {
          fs.mkdirSync(path.dirname(canonicalDest), { recursive: true });
          if (!fs.existsSync(canonicalDest)) fs.copyFileSync(srcAbs, canonicalDest);
        }
      }

      // Always write a trigger-info file so every pipeline run gets a clean commit
      // with the test name as the message — this is what Bitbucket shows as the pipeline title.
      const runLabel = (script_name || '').replace(/\.(jmx|js|yml)$/i, '').replace(/\\/g, '/').split('/').pop() || 'test';
      const triggerFile = path.join(wsRoot, '.peako', 'last-run.json');
      fs.mkdirSync(path.dirname(triggerFile), { recursive: true });
      fs.writeFileSync(triggerFile, JSON.stringify({
        triggered_at: new Date().toISOString(),
        script: script_name || '',
        users: jmeter_users, rampup: jmeter_rampup, duration: jmeter_duration,
      }, null, 2), 'utf8');
      await git2.add('.');
      try { await git2.commit(`Peako Performance Test: ${runLabel} [auto]`); } catch (ce) {
        if (!ce.message.includes('nothing to commit') && !ce.message.includes('nothing added')) throw ce;
      }

      if (provider === 'bitbucket') {
        // ATATT tokens require Basic auth with the Atlassian account EMAIL (not Bitbucket username).
        // Use Bitbucket Files API (REST) to commit files — same scope as pipeline trigger.
        const _bbWs   = cfg.bitbucket_workspace;
        const _bbSlug = cfg.bitbucket_repo_slug;
        // Use admin token for write operations — admin's token has repository:write scope.
        // IMPORTANT: pair admin token with admin's username/email, NOT the triggering user's email.
        const _adminTok = (adminCfg?.bitbucket_app_password || cfg.bitbucket_app_password || '').trim();
        const _adminCfgForAuth = {
          ...cfg,
          bitbucket_app_password: _adminTok,
          bitbucket_username: adminCfg?.bitbucket_username || adminRawCfg?.bitbucket_username || cfg.bitbucket_username || '',
        };
        const _bbAuth = await bbBasicAuth(_adminCfgForAuth, adminRawCfg?.user_id);
        const _boundary = 'PeakoBoundary7x3f9z';
        const _fileParts = [];

        // Always include the pipeline YAML so the jmeter fix reaches Bitbucket
        const _yamlDisk = path.join(wsRoot, 'bitbucket-pipelines.yml');
        if (fs.existsSync(_yamlDisk)) {
          _fileParts.push({ name: 'bitbucket-pipelines.yml', content: fs.readFileSync(_yamlDisk) });
        }
        // Always include the trigger file — its commit message becomes the pipeline display name
        if (fs.existsSync(triggerFile)) {
          _fileParts.push({ name: '.peako/last-run.json', content: fs.readFileSync(triggerFile) });
        }
        // Include JMX at canonical repo path
        if (script_name) {
          const _canonDest = path.join(wsRoot, canonicalPaths.scriptRepoPath.replace(/\//g, path.sep));
          if (fs.existsSync(_canonDest)) {
            _fileParts.push({ name: canonicalPaths.scriptRepoPath, content: fs.readFileSync(_canonDest) });
          }
        }

        // Include patcher so the pipeline step can run python3 .PerfStudio/patch_jmx.py
        const _patcherFilePath = path.join(wsRoot, '.PerfStudio', 'patch_jmx.py');
        if (fs.existsSync(_patcherFilePath)) {
          _fileParts.push({ name: '.PerfStudio/patch_jmx.py', content: fs.readFileSync(_patcherFilePath) });
        } else {
          _fileParts.push({ name: '.PerfStudio/patch_jmx.py', content: Buffer.from(BB_PATCHER_PY, 'utf8') });
        }

        // Include testData CSV files so pipeline can read them at /workspace/testData/
        // Search recursively within wsRoot for any 'testData' directory containing CSV files
        const _findTestDataDir = (dir, depth) => {
          if (depth > 6) return null;
          try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const e of entries) {
              if (e.isDirectory() && e.name === 'testData') {
                const full = path.join(dir, e.name);
                const files = fs.readdirSync(full);
                if (files.some(f => f.endsWith('.csv'))) return full;
              }
            }
            for (const e of entries) {
              if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'results' && e.name !== 'node_modules') {
                const found = _findTestDataDir(path.join(dir, e.name), depth + 1);
                if (found) return found;
              }
            }
          } catch {}
          return null;
        };
        const _testDataDir = _findTestDataDir(wsRoot, 0);
        if (_testDataDir) {
          try {
            fs.readdirSync(_testDataDir).forEach(async f => {
              if (!f.startsWith('.') && (f.endsWith('.csv') || f.endsWith('.txt') || f.endsWith('.json'))) {
                _fileParts.push({ name: `${canonicalPaths.testDataPath}/${f}`, content: fs.readFileSync(path.join(_testDataDir, f)) });
              }
            });
            console.log('[CI trigger] testData files pushed from:', _testDataDir);
          } catch {}
        } else {
          console.warn('[CI trigger] No testData directory with CSV files found in', wsRoot);
        }

        // Build multipart body as a Buffer
        const _chunks = [];
        const _add = s => _chunks.push(Buffer.isBuffer(s) ? s : Buffer.from(s, 'utf8'));
        _add(`--${_boundary}\r\nContent-Disposition: form-data; name="message"\r\n\r\nPeako Performance Test: ${runLabel} [auto]\r\n`);
        _add(`--${_boundary}\r\nContent-Disposition: form-data; name="branch"\r\n\r\n${targetRef}\r\n`);
        for (const fp of _fileParts) {
          _add(`--${_boundary}\r\nContent-Disposition: form-data; name="${fp.name}"\r\n\r\n`);
          _add(fp.content);
          _add('\r\n');
        }
        _add(`--${_boundary}--\r\n`);
        const _bodyBuf = Buffer.concat(_chunks);

        await new Promise((resolve, reject) => {
          const _opts = {
            hostname: 'api.bitbucket.org',
            port: 443,
            path: `/2.0/repositories/${_bbWs}/${_bbSlug}/src`,
            method: 'POST',
            headers: {
              Authorization: _bbAuth,
              'Content-Type': `multipart/form-data; boundary=${_boundary}`,
              'Content-Length': _bodyBuf.length,
              'User-Agent': 'PerfStudio',
            },
            rejectUnauthorized: false,
          };
          const _req2 = https.request(_opts, _res2 => {
            let _d = '';
            _res2.on('data', c => _d += c);
            _res2.on('end', () => {
              if (_res2.statusCode === 201) {
                console.log('[CI trigger] Bitbucket Files API committed YAML + JMX to branch', targetRef);
                resolve();
              } else {
                console.warn('[CI trigger] Bitbucket Files API HTTP', _res2.statusCode, _d.slice(0, 400));
                reject(new Error(`Bitbucket Files API returned ${_res2.statusCode}: ${_d.slice(0, 200)}`));
              }
            });
          });
          _req2.on('error', reject);
          _req2.write(_bodyBuf);
          _req2.end();
        });
      } else {
        // GitHub / GitLab — standard git push
        try { await git2.addConfig('credential.helper', '', false, 'local'); } catch {}
        await git2.push(['--set-upstream', 'origin', targetRef]);
      }
    }
  } catch (syncErr) {
    console.warn('[CI trigger] Auto-push script failed:', syncErr.message);
    // Non-fatal — proceed with dispatch anyway; user may have pushed manually
  }

  try {
    // ── GitLab trigger ─────────────────────────────────────────────────────
    if (provider === 'gitlab') {
      if (!cfg.gitlab_trigger_token) return res.status(400).json({ error: 'GitLab trigger token not set. Create one in CI settings.' });
      if (!cfg.gitlab_project_id)    return res.status(400).json({ error: 'GitLab project ID not set.' });

      const gitlabUrl = (cfg.gitlab_url || 'https://gitlab.com').replace(/\/$/, '');
      const encodedId = encodeURIComponent(cfg.gitlab_project_id);
      const ref       = cfg.gitlab_ref || baseBranch2;

      // Build form-encoded body (GitLab trigger API uses form data)
      const params = new URLSearchParams();
      params.append('token', cfg.gitlab_trigger_token);
      params.append('ref',   ref);
      params.append('variables[SCRIPT_NAME]',     script_name || 'test.jmx');
      params.append('variables[SCRIPT_PATH]',     script_path || '');
      params.append('variables[JMETER_USERS]',    String(jmeter_users || 10));
      params.append('variables[JMETER_RAMPUP]',   String(jmeter_rampup || 30));
      params.append('variables[JMETER_LOOPS]',    String(jmeter_loops || 1));
      params.append('variables[JMETER_DURATION]', String(jmeter_duration || 300));

      const formBody = params.toString();
      const url = new URL(`${gitlabUrl}/api/v4/projects/${encodedId}/trigger/pipeline`);
      const isHttps = url.protocol === 'https:';
      const r = await new Promise((resolve, reject) => {
        const options = {
          hostname: url.hostname,
          port:     url.port || (isHttps ? 443 : 80),
          path:     url.pathname,
          method:   'POST',
          headers:  { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(formBody) },
          rejectUnauthorized: false,
        };
        const req2 = (isHttps ? https : http).request(options, res2 => {
          let data = '';
          res2.on('data', c => data += c);
          res2.on('end', () => resolve({ status: res2.statusCode, body: JSON.parse(data || '{}') }));
        });
        req2.on('error', reject);
        req2.write(formBody);
        req2.end();
      });

      if (r.status === 201) {
        const run = await db.prepare('INSERT INTO ci_pipeline_runs (project_id, provider, external_id, web_url, status, script_name, run_name, variables, triggered_by, auto_heal, auto_heal_mode, auto_heal_instruction) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(req.params.projectId, 'gitlab', String(r.body.id), r.body.web_url || '', r.body.status || 'pending', script_name, ciRunDisplayName, JSON.stringify(variables), req.userId, auto_heal ? 1 : 0, auto_heal_mode, auto_heal_instruction);
        return res.json({ ok: true, run_id: run.lastInsertRowid, run_name: ciRunDisplayName, external_id: r.body.id, web_url: r.body.web_url, status: r.body.status, message: 'Pipeline triggered on GitLab' });
      }
      return res.status(400).json({ error: `GitLab returned ${r.status}: ${JSON.stringify(r.body)}` });
    }

    // ── GitHub Actions trigger ─────────────────────────────────────────────
    if (provider === 'github') {
      if (!effectiveGithubToken) return res.status(400).json({ error: 'No GitHub token available. Save your Personal Access Token in Git Identity (Configuration → Git).' });

      // Sanitize at trigger time — catches any stale invalid values in the DB
      const githubRepo = sanitizeGithubRepo(cfg.github_repo) || await getRepoFromGit(req.params.projectId);
      if (!githubRepo) return res.status(400).json({ error: 'GitHub repo not set. Open CI Configuration and set it to "owner/repo" (e.g. tasleemzaif85/Project-Demo).' });
      cfg.github_repo = githubRepo;

      const workflowFile = cfg.github_workflow_file || 'perf-test.yml';
      // Dispatch to the base branch — perf-test.yml with workflow_dispatch trigger lives on the default branch.
      // cfg.github_ref is the user's scripts branch, but the workflow file must be on the base branch.
      const ref = baseBranch2;
      const ghHeaders    = {
        Authorization:          `token ${effectiveGithubToken}`,
        'User-Agent':           'PerfStudio',
        Accept:                 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      };
      const dispatchBody = {
        ref,  // base branch — GitHub requires workflow_dispatch ref to be the branch where perf-test.yml lives
        inputs: {
          script_name:     script_name || 'test.jmx',
          script_path:     script_path || '',
          jmeter_users:    String(jmeter_users || 10),
          jmeter_rampup:   String(jmeter_rampup || 30),
          jmeter_loops:    String(jmeter_loops || 1),
          jmeter_duration: String(jmeter_duration || 300),
          // Tell the workflow which branch to checkout for scripts/data.
          // For regular users this is their personal branch (users/<name>);
          // for admins it is the base branch. This is separate from the dispatch ref above.
          branch: targetRef,
        },
      };

      // Try filename first, then full path as fallback (both are valid per GitHub docs)
      let r = await apiRequest(
        `https://api.github.com/repos/${cfg.github_repo}/actions/workflows/${workflowFile}/dispatches`,
        'POST', dispatchBody, ghHeaders
      );

      if (r.status === 404) {
        // Fallback: try with full path
        r = await apiRequest(
          `https://api.github.com/repos/${cfg.github_repo}/actions/workflows/.github%2Fworkflows%2F${workflowFile}/dispatches`,
          'POST', dispatchBody, ghHeaders
        );
      }

      if (r.status === 404) {
        // Last resort: look up the numeric workflow ID and use that
        const wfList = await apiRequest(
          `https://api.github.com/repos/${cfg.github_repo}/actions/workflows`,
          'GET', null, ghHeaders
        );
        const wf = (wfList.body?.workflows || []).find(w =>
          w.path === `.github/workflows/${workflowFile}` || w.name === 'PerfStudio Performance Test'
        );
        if (wf?.id) {
          r = await apiRequest(
            `https://api.github.com/repos/${cfg.github_repo}/actions/workflows/${wf.id}/dispatches`,
            'POST', dispatchBody, ghHeaders
          );
        }
      }

      if (r.status === 404) {
        return res.status(404).json({
          error: `Workflow not found. Verify: 1) perf-test.yml is merged to "${ref}" branch. 2) The repo in CI settings is exactly "${cfg.github_repo}". 3) Your PAT has "repo" scope.`,
        });
      }

      // 422 — workflow found but either disabled or ref mismatch
      // Try to get workflow details to diagnose
      if (r.status === 422) {
        const wfList = await apiRequest(
          `https://api.github.com/repos/${cfg.github_repo}/actions/workflows`,
          'GET', null, ghHeaders
        );
        const wf = (wfList.body?.workflows || []).find(w =>
          w.path === `.github/workflows/${workflowFile}` || w.name === 'PerfStudio Performance Test'
        );

        console.log('[CI Trigger] 422 debug — workflow state:', wf?.state, '| ref:', ref, '| wf found:', !!wf);

        if (wf && wf.state === 'disabled_manually') {
          // Re-enable the workflow
          await apiRequest(
            `https://api.github.com/repos/${cfg.github_repo}/actions/workflows/${wf.id}/enable`,
            'PUT', null, ghHeaders
          );
          // Retry dispatch
          r = await apiRequest(
            `https://api.github.com/repos/${cfg.github_repo}/actions/workflows/${wf.id}/dispatches`,
            'POST', dispatchBody, ghHeaders
          );
        } else if (wf) {
          // Try dispatching by numeric ID with the default branch
          const repoInfo = await apiRequest(`https://api.github.com/repos/${cfg.github_repo}`, 'GET', null, ghHeaders);
          const defaultBranch = repoInfo.body?.default_branch || 'main';
          r = await apiRequest(
            `https://api.github.com/repos/${cfg.github_repo}/actions/workflows/${wf.id}/dispatches`,
            'POST', { ...dispatchBody, ref: defaultBranch }, ghHeaders
          );
          console.log('[CI Trigger] Retried with default branch:', defaultBranch, '| status:', r.status);
        }

        if (r.status !== 204) {
          return res.status(422).json({
            error: `GitHub 422: ${r.body?.message || 'Workflow dispatch failed'}. ` +
              `Workflow state: ${wf?.state || 'unknown'}. ` +
              `Try opening GitHub → your repo → Actions → ${workflowFile} → click "Enable workflow" if it appears disabled.`,
          });
        }
      }

      if (r.status === 204) {
        // Wait for GitHub to create the run record, then look for it.
        // We must verify the run was created AFTER we dispatched (within 30 s)
        // to avoid picking up a stale completed run from the history.
        const dispatchedAt = new Date();
        let latestRun = null;
        for (let attempt = 0; attempt < 5; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          const runsResp = await apiRequest(
            `https://api.github.com/repos/${cfg.github_repo}/actions/runs?event=workflow_dispatch&per_page=5`,
            'GET', null,
            { Authorization: `token ${effectiveGithubToken}`, 'User-Agent': 'PerfStudio', Accept: 'application/vnd.github+json' }
          );
          const recentRun = (runsResp.body?.workflow_runs || []).find(wr => {
            const createdAt = new Date(wr.created_at);
            return createdAt >= new Date(dispatchedAt.getTime() - 5000); // allow 5 s clock skew
          });
          if (recentRun) { latestRun = recentRun; break; }
        }

        const run = await db.prepare('INSERT INTO ci_pipeline_runs (project_id, provider, external_id, web_url, status, script_name, run_name, variables, triggered_by, auto_heal, auto_heal_mode, auto_heal_instruction) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(
            req.params.projectId, 'github',
            latestRun ? String(latestRun.id) : null,
            latestRun?.html_url || `https://github.com/${cfg.github_repo}/actions`,
            latestRun?.status || 'queued',
            script_name, ciRunDisplayName, JSON.stringify(variables), req.userId,
            auto_heal ? 1 : 0, auto_heal_mode, auto_heal_instruction
          );
        return res.json({ ok: true, run_id: run.lastInsertRowid, run_name: ciRunDisplayName, external_id: latestRun?.id, web_url: latestRun?.html_url || `https://github.com/${cfg.github_repo}/actions`, status: latestRun?.status || 'queued', message: 'Workflow dispatched on GitHub Actions' });
      }
      return res.status(400).json({ error: `GitHub returned ${r.status}: ${JSON.stringify(r.body)}` });
    }

    // ── Bitbucket Pipelines trigger ────────────────────────────────────────────
    if (provider === 'bitbucket') {
      if (!cfg.bitbucket_workspace)    return res.status(400).json({ error: 'Bitbucket workspace not set.' });
      if (!cfg.bitbucket_repo_slug)    return res.status(400).json({ error: 'Bitbucket repository slug not set.' });
      if (!cfg.bitbucket_app_password) return res.status(400).json({ error: 'Bitbucket App Password / API Token not set.' });

      const bbToken = cfg.bitbucket_app_password.trim();
      const bbAuthHeader = await bbBasicAuth(cfg, req.userId);
      // targetRef = feature/<username> for non-admin users (holds testData + JMX).
      // The correct YAML (with Peako-Performance-Test + jmeter) is committed to this branch
      // by the Files API auto-push above, so the pipeline trigger will find it.
      const bbRef  = targetRef;

      const bbBody = {
        target: {
          ref_type: 'branch',
          type: 'pipeline_ref_target',
          ref_name: bbRef,
          selector: { type: 'custom', pattern: 'Peako-Performance-Test' },
        },
        variables: [
          ...Object.entries(variables).map(([key, value]) => ({ key: key.toUpperCase(), value: String(value), secured: false })),
          // Inject upload credentials so the YAML's curl can push results to Bitbucket Downloads
          // BB_USERNAME must be the Atlassian account email for ATATT token auth in the pipeline curl
          { key: 'BB_USERNAME', value: callerRow2?.email || cfg.bitbucket_username || cfg.bitbucket_workspace || '', secured: false },
          { key: 'BB_APP_PASSWORD', value: bbToken, secured: true },
        ],
      };

      const bbResp = await apiRequest(
        `https://api.bitbucket.org/2.0/repositories/${cfg.bitbucket_workspace}/${cfg.bitbucket_repo_slug}/pipelines/`,
        'POST', bbBody, { Authorization: bbAuthHeader, 'User-Agent': 'PerfStudio', Accept: 'application/json' }
      );

      if (bbResp.status === 201) {
        const pipelineUuid   = bbResp.body.uuid;
        const bbBuildNumber  = bbResp.body.build_number || null;
        const variablesWithBuild = { ...variables, ...(bbBuildNumber ? { bb_build_number: bbBuildNumber } : {}) };
        const bbRunInsert = await db.prepare('INSERT INTO ci_pipeline_runs (project_id, provider, external_id, web_url, status, script_name, run_name, variables, triggered_by, auto_heal, auto_heal_mode, auto_heal_instruction) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(
            req.params.projectId, 'bitbucket', pipelineUuid,
            `https://bitbucket.org/${cfg.bitbucket_workspace}/${cfg.bitbucket_repo_slug}/pipelines/results/${pipelineUuid}`,
            'pending', script_name || '', ciRunDisplayName,
            JSON.stringify(variablesWithBuild), req.userId,
            auto_heal ? 1 : 0, auto_heal_mode, auto_heal_instruction
          );
        return res.json({ ok: true, run_id: bbRunInsert.lastInsertRowid, run_name: ciRunDisplayName, external_id: pipelineUuid, web_url: `https://bitbucket.org/${cfg.bitbucket_workspace}/${cfg.bitbucket_repo_slug}/pipelines/results/${pipelineUuid}`, status: 'pending', message: 'Pipeline triggered on Bitbucket Pipelines' });
      }
      return res.status(400).json({ error: `Bitbucket returned ${bbResp.status}: ${bbResp.body?.error?.message || JSON.stringify(bbResp.body)}` });
    }

    res.status(400).json({ error: `Unknown provider: ${provider}` });
  } catch (e) {
    res.status(500).json({ error: `Trigger failed: ${e.message}` });
  }
});

// ── GET /runs — run history ───────────────────────────────────────────────────
router.get('/runs', async (req, res) => {
  if (!await ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const runs = await db.prepare(`
    SELECT c.*, e.result_dir AS exec_result_dir
    FROM ci_pipeline_runs c
    LEFT JOIN execution_runs e ON e.ci_run_id = c.id
    WHERE c.project_id = ?
    ORDER BY c.started_at DESC
    LIMIT 30
  `).all(req.params.projectId);
  res.json({ runs });
});

// ── Auto-sync helper — called when status poll detects completion ─────────────
// Creates an execution_runs record from CI artifacts so Analytics shows the run.
async function autoSyncCiRun(run, cfg, projectId, userId) {
  const os      = require('os');
  const AdmZip  = require('adm-zip');
  const { parseJtl } = require('../utils/parseJtl');
  const { getUserProjectPath, getCollectionPath, resolveSuiteEnv } = require('../utils/projectFolders');

  const project = await db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) return;

  // Guard: never create duplicate execution_runs for the same CI run
  const alreadySynced = await db.prepare('SELECT id FROM execution_runs WHERE ci_run_id = ?').get(run.id);
  if (alreadySynced) { console.log(`[Auto-sync] CI run #${run.id} already synced → skipping`); return; }

  const callerUser0 = await db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
  const callerRole = callerUser0?.role;
  const userProjPath = await getUserProjectPath(userId, callerRole, project.name);
  const { buildRunDirName, extractRunNumber } = require('../utils/buildRunName');

  // Parse CI parameters for the run name
  const ciVars    = (() => { try { return JSON.parse(run.variables || '{}'); } catch { return {}; } })();
  const ciUsers   = ciVars.jmeter_users   || ciVars.script_users   || null;
  const ciLoops   = ciVars.jmeter_loops   || null;
  const ciDur     = ciVars.jmeter_duration|| null;

  // Determine result directory
  let resultDir = null;
  let suiteName = null;
  if (run.script_name) {
    const scriptFile = run.script_name.replace(/\\/g, '/').split('/').pop();
    const suite = await db.prepare(`
      SELECT ts.*, c.name as col_name, c.environment as col_environment, c.environments as col_environments
      FROM test_suites ts
      LEFT JOIN collections c ON c.id = ts.collection_id
      WHERE ts.project_id = ? AND (ts.jmx_path LIKE ? OR ts.js_path LIKE ?) LIMIT 1
    `).get(projectId, `%${scriptFile}`, `%${scriptFile}`);
    suiteName = suite?.name || null;
    // resolveSuiteEnv falls back to the collection's own default env when ts.env is
    // blank, so a collection-scoped suite never drops to the project-level fallback
    // below just because its env wasn't explicitly recorded.
    const resolvedEnv = suite?.col_name
      ? resolveSuiteEnv({ environment: suite.col_environment, environments: suite.col_environments }, suite)
      : null;
    if (suite?.col_name && resolvedEnv) {
      const envPath = getCollectionPath(userProjPath, suite.col_name, resolvedEnv);
      try { require('fs').mkdirSync(path.join(envPath, 'results'), { recursive: true }); } catch {}
      let nums = [];
      try { nums = require('fs').readdirSync(path.join(envPath, 'results'), { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('Heal_')).map(d => extractRunNumber(d.name)).filter(n => n > 0); } catch {}
      const nextRun = nums.length ? Math.max(...nums) + 1 : 1;
      const runDirName = buildRunDirName(suiteName || scriptFile.replace(/\.jmx$/, ''), ciUsers, 'duration', ciLoops, ciDur, nextRun);
      resultDir = path.join(envPath, 'results', runDirName);
    }
  }
  // Project-level fallback is only legitimate for a run whose script couldn't be
  // matched to any collection-scoped test suite at all.
  if (!resultDir) {
    console.warn(`[Auto-sync] CI run #${run.id} (script "${run.script_name}") — no matching collection-scoped test suite found, falling back to project-level results`);
    try {
      const nums = fs.readdirSync(path.join(userProjPath, 'results'), { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('Heal_')).map(d => extractRunNumber(d.name)).filter(n => n > 0);
      const next = nums.length ? Math.max(...nums) + 1 : 1;
      const scriptBase = run.script_name ? run.script_name.replace(/\\/g, '/').split('/').pop().replace(/\.jmx$/, '') : 'CIRun';
      resultDir = path.join(userProjPath, 'results', buildRunDirName(suiteName || scriptBase, ciUsers, 'duration', ciLoops, ciDur, next));
    } catch {
      resultDir = path.join(userProjPath, 'results', `CI_Run_${run.id}`);
    }
  }

  const tmpZip = path.join(os.tmpdir(), `ci_auto_${run.id}_${Date.now()}.zip`);

  try {
    if (run.provider === 'github') {
      if (!cfg.github_token) throw new Error('No GitHub token');
      const ghHeaders = { Authorization: `token ${cfg.github_token}`, 'User-Agent': 'PerfStudio', Accept: 'application/vnd.github+json' };
      const artifactsResp = await apiRequest(`https://api.github.com/repos/${cfg.github_repo}/actions/runs/${run.external_id}/artifacts`, 'GET', null, ghHeaders);
      if (artifactsResp.status !== 200 || !artifactsResp.body?.artifacts?.length) throw new Error('No artifacts yet');
      const artifact = artifactsResp.body.artifacts[0];
      const dlResp = await apiRequest(`https://api.github.com/repos/${cfg.github_repo}/actions/artifacts/${artifact.id}/zip`, 'GET', null, ghHeaders);
      const downloadUrl = dlResp.headers?.location || dlResp.headers?.Location;
      if (!downloadUrl) throw new Error('No download URL');
      await new Promise((resolve, reject) => {
        const fileStream = fs.createWriteStream(tmpZip);
        https.get(downloadUrl, { rejectUnauthorized: false }, response => {
          if (response.statusCode === 302 || response.statusCode === 301) {
            https.get(response.headers.location, { rejectUnauthorized: false }, r2 => { r2.pipe(fileStream); fileStream.on('finish', () => { fileStream.close(); resolve(); }); }).on('error', reject);
          } else { response.pipe(fileStream); fileStream.on('finish', () => { fileStream.close(); resolve(); }); }
        }).on('error', reject);
      });
    } else if (run.provider === 'gitlab') {
      if (!cfg.gitlab_token) throw new Error('No GitLab token');
      const gitlabUrl = (cfg.gitlab_url || 'https://gitlab.com').replace(/\/$/, '');
      const encodedId = encodeURIComponent(cfg.gitlab_project_id);
      const jobsResp = await apiRequest(`${gitlabUrl}/api/v4/projects/${encodedId}/pipelines/${run.external_id}/jobs`, 'GET', null, { 'PRIVATE-TOKEN': cfg.gitlab_token });
      if (jobsResp.status !== 200 || !jobsResp.body?.length) throw new Error('No jobs found');
      const job = jobsResp.body.find(j => j.artifacts_file) || jobsResp.body[0];
      if (!job?.id) throw new Error('No artifact job');
      await new Promise((resolve, reject) => {
        const artifactUrl = `${gitlabUrl}/api/v4/projects/${encodedId}/jobs/${job.id}/artifacts`;
        const urlObj = new URL(artifactUrl);
        const fileStream = fs.createWriteStream(tmpZip);
        https.request({ hostname: urlObj.hostname, port: urlObj.port || 443, path: urlObj.pathname, method: 'GET', headers: { 'PRIVATE-TOKEN': cfg.gitlab_token }, rejectUnauthorized: false }, response => {
          if (response.statusCode !== 200 && response.statusCode !== 206) {
            fileStream.close();
            return reject(new Error(`GitLab artifact download failed with HTTP ${response.statusCode}`));
          }
          response.pipe(fileStream); fileStream.on('finish', () => { fileStream.close(); resolve(); });
        }).on('error', reject).end();
      });
    } else if (run.provider === 'bitbucket') {
      if (!cfg.bitbucket_app_password) throw new Error('No Bitbucket App Password / API Token');
      const bbAuth2Header = await bbBasicAuth(cfg, userId);
      const pipelineId2 = (run.external_id || '').replace(/[{}]/g, '');
      const ws2   = cfg.bitbucket_workspace;
      const slug2 = cfg.bitbucket_repo_slug;

      // Download results.jtl from the canonical path: branch/results_path/Run{N}/results.jtl
      // bb_build_number stored at trigger time; fall back to UUID for old runs, then legacy path
      const _ciVars2     = (() => { try { return JSON.parse(run.variables || '{}'); } catch { return {}; } })();
      const _jtlBranch   = _ciVars2.bb_branch || 'perf-results';
      const _runFolder2  = _ciVars2.bb_build_number ? `Run${_ciVars2.bb_build_number}` : pipelineId2;
      const _jtlBasePath = _ciVars2.results_path ? `${_ciVars2.results_path}/${_runFolder2}` : `ci-results/${_runFolder2}`;
      // Branches with '/' (e.g. feature/quarks-user) cannot be %2F-encoded in the path —
      // servers decode it before routing, so resolve the branch to a commit hash instead.
      const _jtlBranchNode = _jtlBranch.includes('/')
        ? await resolveBranchToCommit(ws2, slug2, _jtlBranch, bbAuth2Header)
        : encodeURIComponent(_jtlBranch);
      const jtlApiPath   = `/2.0/repositories/${ws2}/${slug2}/src/${_jtlBranchNode}/${_jtlBasePath}/results.jtl`;

      let jtlMissing = false;
      try {
        await new Promise((resolve, reject) => {
          const fileStream = fs.createWriteStream(tmpZip); // reusing tmpZip path for the JTL
          const options = { hostname: 'api.bitbucket.org', path: jtlApiPath, method: 'GET', headers: { Authorization: bbAuth2Header, 'User-Agent': 'PerfStudio' }, rejectUnauthorized: false };
          https.request(options, response => {
            if (response.statusCode === 301 || response.statusCode === 302) {
              https.get(response.headers.location, { rejectUnauthorized: false }, r2 => {
                if (r2.statusCode !== 200) { fileStream.close(); return reject(new Error(`JTL not found on perf-results branch (HTTP ${r2.statusCode})`)); }
                r2.pipe(fileStream); fileStream.on('finish', () => { fileStream.close(); resolve(); });
              }).on('error', reject);
            } else if (response.statusCode === 200) {
              response.pipe(fileStream); fileStream.on('finish', () => { fileStream.close(); resolve(); });
            } else {
              fileStream.close();
              reject(new Error(`JTL not found on perf-results branch (HTTP ${response.statusCode})`));
            }
          }).on('error', reject).end();
        });
        if (!fs.existsSync(tmpZip) || fs.statSync(tmpZip).size === 0) jtlMissing = true;
      } catch (jtlErr) {
        console.warn(`[Auto-sync] Bitbucket JTL unavailable for CI run #${run.id}: ${jtlErr.message}`);
        jtlMissing = true;
      }

      if (jtlMissing) {
        // Pipeline failed before uploading results — fetch pipeline logs for AI context, create execRun, trigger heal
        let bbPipeLogs = '';
        try { bbPipeLogs = await fetchBbPipelineLogs(bbAuth2Header, ws2, slug2, run.external_id || pipelineId2); } catch (_) {}

        fs.mkdirSync(resultDir, { recursive: true });
        const noJtlLogs = [{ type: 'error', message: 'JMeter results not uploaded — pipeline failed before JMeter could produce output.' }];
        if (bbPipeLogs) noJtlLogs.push({ type: 'info', message: `Bitbucket pipeline output:\n${bbPipeLogs}` });

        await db.prepare(`
          INSERT INTO execution_runs (project_id, suite_id, engine, status, result_dir, report_path, logs, started_at, finished_at, report_data, ci_run_id)
          VALUES (?, ?, 'jmeter', 'failed', ?, NULL, ?, ?, NOW(), NULL, ?)
        `).run(projectId, suiteId, resultDir, JSON.stringify(noJtlLogs), run.started_at || new Date().toISOString(), run.id);

        const healUserId = run.triggered_by || userId;
        if (run.auto_heal && !run.is_heal_run) {
          setImmediate(async () => {
            try {
              startAutoHealCI(healUserId, run.id, projectId, {
                mode: run.auto_heal_mode || 'auto',
                customInstruction: run.auto_heal_instruction || null,
              });
            } catch (e) { console.error('[Auto-sync] Failed to start CI auto heal (no JTL):', e.message); }
          });
        }
        setImmediate(async () => {
          try {
            const { sendAlertEmail } = require('../utils/emailUtils');
            await sendAlertEmail(null, healUserId, projectId, {
              meta: { suite_name: run.run_name || run.script_name || 'CI Run', engine: 'jmeter', started_at: run.started_at, status: 'failed', ci_provider: run.provider },
              summary: { total_requests: 0, total_success: 0, total_failed: 0, error_rate: 0, avg_response_time: 0, overall_tps: 0 },
              by_api: [], timeline: [],
              errors: [{ type: 'Pipeline Error', message: 'Pipeline failed before JMeter produced results. Check pipeline logs.' }],
              rule_violations: [],
            }, null, null);
          } catch (_) {}
        });
        return;
      }
    }

    if (!fs.existsSync(tmpZip) || fs.statSync(tmpZip).size === 0) throw new Error('Empty zip');

    fs.mkdirSync(resultDir, { recursive: true });

    if (run.provider === 'bitbucket') {
      // tmpZip holds the raw results.jtl — copy it directly
      const jtlDest = path.join(resultDir, 'results.jtl');
      fs.copyFileSync(tmpZip, jtlDest);
      fs.unlinkSync(tmpZip);

      // Download html.zip separately from perf-results branch (non-fatal if missing)
      const _bbAuth3 = await bbBasicAuth(cfg, userId);
      const _pid3    = (run.external_id || '').replace(/[{}]/g, '');
      const _ws3     = cfg.bitbucket_workspace;
      const _slug3   = cfg.bitbucket_repo_slug;
      const _jtlBasePath2 = _ciVars2.results_path ? `${_ciVars2.results_path}/${_runFolder2}` : `ci-results/${_runFolder2}`;
      const _htmlZipPath  = `/2.0/repositories/${_ws3}/${_slug3}/src/${_jtlBranchNode}/${_jtlBasePath2}/html.zip`;
      const _tmpHtml = path.join(os.tmpdir(), `ci_html_${run.id}_${Date.now()}.zip`);
      try {
        await new Promise((resolve) => {
          const fs2 = fs.createWriteStream(_tmpHtml);
          const opts3 = { hostname: 'api.bitbucket.org', path: _htmlZipPath, method: 'GET', headers: { Authorization: _bbAuth3, 'User-Agent': 'PerfStudio' }, rejectUnauthorized: false };
          https.request(opts3, res3 => {
            const follow = (r) => {
              if (r.statusCode === 200) { r.pipe(fs2); fs2.on('finish', () => { fs2.close(); resolve(); }); }
              else { fs2.close(); resolve(); }
            };
            if (res3.statusCode === 301 || res3.statusCode === 302) {
              https.get(res3.headers.location, { rejectUnauthorized: false }, follow).on('error', () => { fs2.close(); resolve(); });
            } else { follow(res3); }
          }).on('error', () => { fs2.close(); resolve(); }).end();
        });
        if (fs.existsSync(_tmpHtml) && fs.statSync(_tmpHtml).size > 0) {
          const _reportDir = path.join(resultDir, 'report');
          fs.mkdirSync(_reportDir, { recursive: true });
          new AdmZip(_tmpHtml).extractAllTo(_reportDir, true);
          fs.unlinkSync(_tmpHtml);
        }
      } catch (_e) {
        console.warn('[CI sync] html.zip download failed (non-fatal):', _e.message);
        try { if (fs.existsSync(_tmpHtml)) fs.unlinkSync(_tmpHtml); } catch {}
      }
    } else {
      const zip = new AdmZip(tmpZip);
      zip.extractAllTo(resultDir, true);
      fs.unlinkSync(tmpZip);

      // Normalise html → report folder
      const ciHtmlDir = path.join(resultDir, 'html');
      if (fs.existsSync(ciHtmlDir) && !fs.existsSync(path.join(resultDir, 'report'))) fs.renameSync(ciHtmlDir, path.join(resultDir, 'report'));
    }

    const jtlPath    = path.join(resultDir, 'results.jtl');
    const reportPath = path.join(resultDir, 'report', 'index.html');

    // Resolve suite_id
    let suiteId = null;
    if (run.script_name) {
      const sf = run.script_name.split('/').pop();
      const s = await db.prepare("SELECT id FROM test_suites WHERE project_id = ? AND (jmx_path LIKE ? OR js_path LIKE ?) LIMIT 1").get(projectId, `%${sf}`, `%${sf}`);
      suiteId = s?.id || null;
    }

    const reportData = fs.existsSync(jtlPath) ? parseJtl(jtlPath, {
      suite_name: suiteId ? (await db.prepare('SELECT name FROM test_suites WHERE id=?').get(suiteId))?.name : (run.script_name || 'CI Run'),
      engine: 'jmeter', started_at: run.started_at,
    }) : null;

    const totalRequests = reportData?.summary?.total_requests || 0;
    if (totalRequests === 0) {
      console.warn(`[Auto-sync] CI run #${run.id}: JTL has 0 samples — marking run as failed`);
      await db.prepare("UPDATE ci_pipeline_runs SET status='failed' WHERE id=?").run(run.id);

      // Fetch pipeline logs for AI context (helps diagnose why JMeter produced 0 requests)
      let zeroBbLogs = '';
      if (run.provider === 'bitbucket' && cfg.bitbucket_app_password) {
        try {
          zeroBbLogs = await fetchBbPipelineLogs(
            await bbBasicAuth(cfg, userId), cfg.bitbucket_workspace, cfg.bitbucket_repo_slug,
            run.external_id || ''
          );
        } catch (_) {}
      }

      const zeroLogs = [{ type: 'error', message: 'JTL file contains no data rows — JMeter produced 0 samples. The test plan may be malformed or all thread groups are disabled.' }];
      if (zeroBbLogs) zeroLogs.push({ type: 'info', message: `Bitbucket pipeline output:\n${zeroBbLogs}` });

      const zeroInsert = await db.prepare(`
        INSERT INTO execution_runs (project_id, suite_id, engine, status, result_dir, report_path, logs, started_at, finished_at, report_data, ci_run_id)
        VALUES (?, ?, 'jmeter', 'failed', ?, NULL, ?, ?, NOW(), NULL, ?)
      `).run(projectId, suiteId, resultDir, JSON.stringify(zeroLogs), run.started_at || new Date().toISOString(), run.id);
      const zeroRunId = zeroInsert.lastInsertRowid;

      const healUserId0 = run.triggered_by || userId;
      if (run.auto_heal && !run.is_heal_run) {
        setImmediate(async () => {
          try {
            startAutoHealCI(healUserId0, run.id, projectId, {
              mode: run.auto_heal_mode || 'auto',
              customInstruction: run.auto_heal_instruction || null,
            });
          } catch (e) {
            console.error('[Auto-sync] Failed to start CI auto heal (0-sample):', e.message);
          }
        });
      }
      setImmediate(async () => {
        try {
          const { sendAlertEmail } = require('../utils/emailUtils');
          const suiteName0 = suiteId
            ? ((await db.prepare('SELECT name FROM test_suites WHERE id=?').get(suiteId))?.name || run.script_name || 'CI Run')
            : (run.script_name || 'CI Run');
          await sendAlertEmail(zeroRunId, healUserId0, projectId, {
            meta: { suite_name: suiteName0, engine: 'jmeter', started_at: run.started_at, status: 'failed', ci_provider: run.provider },
            summary: { total_requests: 0, total_success: 0, total_failed: 0, error_rate: 0, avg_response_time: 0, overall_tps: 0 },
            by_api: [], timeline: [],
            errors: [{ type: 'Zero Samples', message: 'JMeter produced 0 requests. The test plan may be malformed or all thread groups are disabled.' }],
            rule_violations: [],
          }, null, null);
          console.log(`[Auto-sync] Failure email sent for 0-sample CI run #${run.id}`);
        } catch (e) {
          console.error('[Auto-sync] Failure email failed (0-sample):', e.message);
        }
      });
      return;
    }

    // Evaluate rule violations before PDF so the PDF shows correct PASSED/FAILED status
    let autoViolations = [];
    let autoRuleResult = null;
    if (fs.existsSync(jtlPath)) {
      try {
        const { evaluateRules } = require('../utils/ruleEvaluator');
        autoRuleResult = await evaluateRules(projectId, jtlPath);
        autoViolations = autoRuleResult?.violations || [];
      } catch (_) {}
    }
    if (reportData) reportData.rule_violations = autoViolations;

    const suiteLookup = suiteId ? await db.prepare('SELECT name FROM test_suites WHERE id = ?').get(suiteId) : null;
    const emailData = {
      ...(reportData || {
        meta: { suite_name: suiteLookup?.name || run.script_name || 'CI Run', engine: 'jmeter', started_at: run.started_at, status: 'completed' },
        summary: { total_requests: 0, total_success: 0, total_failed: 0, avg_response_time: 0, overall_tps: 0 },
        by_api: [], timeline: [], errors: [],
      }),
      rule_violations: autoViolations,
    };
    if (suiteLookup?.name) emailData.meta.suite_name = suiteLookup.name;

    // Fire rule violation alert immediately — before PDF generation so it arrives early
    if (autoViolations.length > 0) {
      setImmediate(async () => {
        try {
          const { sendRuleViolationEmail } = require('../utils/emailUtils');
          await sendRuleViolationEmail(null, userId, projectId, autoViolations, emailData.meta.suite_name, project.name);
          console.log(`[Auto-sync] Rule violation email sent for CI run #${run.id}`);
        } catch (e) {
          console.error('[Auto-sync] Rule violation email failed:', e.message);
        }
      });
    }

    // Generate analytics PDF
    let autoPdfPath = null;
    if (reportData && fs.existsSync(jtlPath)) {
      try {
        const { generateAnalyticsPdfToFile } = require('../utils/generateAnalyticsPdf');
        const runNum = (resultDir.match(/Run_?(\d+)/) || [])[1] || run.id;
        const tmpPdf = path.join(resultDir, `Analytics_CI_Run_${runNum}.pdf`);
        await generateAnalyticsPdfToFile(reportData, runNum, tmpPdf);
        autoPdfPath = tmpPdf;
        console.log(`[Auto-sync] PDF generated: ${path.basename(tmpPdf)}`);
      } catch (e) {
        console.error('[Auto-sync] PDF generation failed:', e.message);
      }
    }

    // Any individual API at 100% failure → always trigger heal regardless of the auto_heal flag.
    const autoApiFullFailure = hasAnyApiFullFailure(reportData);
    // Overall pass/fail mirrors the rule engine (what the alert email/PDF already show) —
    // falls back to raw failure count when the project has no rules configured.
    const autoRunFailed = autoApiFullFailure || autoRuleResult?.passed === false ||
      (autoRuleResult?.noRules && (reportData?.summary?.total_failed || 0) > 0);
    const autoSyncRunStatus = autoRunFailed ? 'failed' : 'completed';
    if (autoRunFailed) {
      await db.prepare("UPDATE ci_pipeline_runs SET status='failed' WHERE id=?").run(run.id);
    }

    const execInsert = await db.prepare(`
      INSERT INTO execution_runs (project_id, suite_id, engine, status, result_dir, report_path, logs, started_at, finished_at, report_data, ci_run_id)
      VALUES (?, ?, 'jmeter', ?, ?, ?, ?, ?, NOW(), ?, ?)
    `).run(
      projectId, suiteId, autoSyncRunStatus, resultDir,
      fs.existsSync(reportPath) ? reportPath : null,
      JSON.stringify([{ type: 'info', message: `Results synced from CI pipeline run #${run.external_id} (${run.provider})` }]),
      run.started_at || new Date().toISOString(),
      reportData ? JSON.stringify(reportData) : null,
      run.id
    );
    const newRunId = execInsert.lastInsertRowid;

    console.log(`[Auto-sync] CI run #${run.id} synced → ${path.basename(resultDir)}`);

    // Auto-heal logic:
    // • 100% failure (all requests errored) → always heal, regardless of auto_heal flag.
    //   Build targeted 400/401 instruction so AI knows exactly what to fix.
    // • Partial failure → only heal if auto_heal was enabled at trigger time (existing behaviour).
    if (!run.is_heal_run) {
      const totalReqs = reportData?.summary?.total_requests || 0;
      const hasViolations = (reportData?.rule_violations || []).length > 0;
      const hasFailed = totalReqs === 0 || hasViolations ||
        (reportData?.summary?.error_rate != null && reportData.summary.error_rate > 0);

      const shouldHeal = autoApiFullFailure || (run.auto_heal && hasFailed);

      if (shouldHeal) {
        const healInstruction = buildErrorHealInstruction(reportData?.errors) || run.auto_heal_instruction || null;
        console.log(`[Auto-sync] CI run #${run.id} — triggering heal (apiFullFailure=${autoApiFullFailure}, mode: ${healInstruction ? 'custom' : (run.auto_heal_mode || 'auto')})`);
        const healUserId2 = run.triggered_by || userId;
        setImmediate(async () => {
          try {
            startAutoHealCI(healUserId2, run.id, projectId, {
              mode: healInstruction ? 'custom' : (run.auto_heal_mode || 'auto'),
              customInstruction: healInstruction,
            });
          } catch (e) {
            console.error('[Auto-sync] Failed to start CI auto heal:', e.message);
          }
        });
      }
    }

    // Send final report email (with PDF) after run is fully processed
    setImmediate(async () => {
      try {
        const { sendAlertEmail } = require('../utils/emailUtils');
        await sendAlertEmail(newRunId, userId, projectId, emailData, autoPdfPath, null);
        console.log(`[Auto-sync] Final report email sent for CI run #${run.id} → exec run #${newRunId}`);
      } catch (e) {
        console.error('[Auto-sync] Final report email failed:', e.message);
      }
    });
  } catch (e) {
    try { if (fs.existsSync(tmpZip)) fs.unlinkSync(tmpZip); } catch {}
    console.warn(`[Auto-sync] CI run #${run.id} failed: ${e.message}`);
  }
}

// ── GET /runs/:runId/status — poll live status from provider ─────────────────
router.get('/runs/:runId/status', async (req, res) => {
  if (!await ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const run = await db.prepare('SELECT * FROM ci_pipeline_runs WHERE id = ? AND project_id = ?').get(req.params.runId, req.params.projectId);
  if (!run) return res.status(404).json({ error: 'Run not found' });

  const cfg = decryptConfig(await getConfig(req.params.projectId, req.userId));
  if (!run.external_id || !cfg) return res.json({ run });

  try {
    let status = run.status;
    let webUrl = run.web_url;

    if (run.provider === 'gitlab') {
      const gitlabUrl = (cfg.gitlab_url || 'https://gitlab.com').replace(/\/$/, '');
      const encodedId = encodeURIComponent(cfg.gitlab_project_id);
      const r = await apiRequest(
        `${gitlabUrl}/api/v4/projects/${encodedId}/pipelines/${run.external_id}`,
        'GET', null, { 'PRIVATE-TOKEN': cfg.gitlab_token }
      );
      if (r.status === 200) { status = r.body.status; webUrl = r.body.web_url || webUrl; }
    }

    if (run.provider === 'github') {
      const r = await apiRequest(
        `https://api.github.com/repos/${cfg.github_repo}/actions/runs/${run.external_id}`,
        'GET', null,
        { Authorization: `token ${cfg.github_token}`, 'User-Agent': 'PerfStudio', Accept: 'application/vnd.github+json' }
      );
      if (r.status === 200) {
        // GitHub: status=queued/in_progress/completed, conclusion=success/failure/cancelled
        status = r.body.status === 'completed' ? (r.body.conclusion || 'completed') : r.body.status;
        webUrl = r.body.html_url || webUrl;
      }
    }

    if (run.provider === 'bitbucket') {
      const r = await apiRequest(
        `https://api.bitbucket.org/2.0/repositories/${cfg.bitbucket_workspace}/${cfg.bitbucket_repo_slug}/pipelines/${run.external_id}`,
        'GET', null, { Authorization: await bbBasicAuth(cfg, req.userId), 'User-Agent': 'PerfStudio' }
      );
      if (r.status === 200) {
        const stName = r.body.state?.name;        // PENDING | IN_PROGRESS | COMPLETED | ERROR
        const result = r.body.state?.result?.name; // SUCCESSFUL | FAILED | ERROR | STOPPED
        if (stName === 'COMPLETED' || stName === 'ERROR') {
          status = result === 'SUCCESSFUL' ? 'success' : result === 'STOPPED' ? 'cancelled' : 'failure';
        } else {
          status = stName === 'IN_PROGRESS' ? 'in_progress' : 'pending';
        }
        webUrl = `https://bitbucket.org/${cfg.bitbucket_workspace}/${cfg.bitbucket_repo_slug}/pipelines/results/${run.external_id}`;
      }
    }

    // Map external statuses to our internal ones
    const statusMap = {
      // GitLab
      created: 'pending', pending: 'pending', running: 'running',
      success: 'completed', failed: 'failed', canceled: 'cancelled', skipped: 'skipped',
      // GitHub
      queued: 'pending', in_progress: 'running',
      'success': 'completed', 'failure': 'failed', 'cancelled': 'cancelled',
      // Bitbucket-specific
      SUCCESSFUL: 'completed', FAILED: 'failed', ERROR: 'failed',
      STOPPED: 'cancelled', HALTED: 'cancelled', PAUSED: 'running',
      IN_PROGRESS: 'running', PENDING: 'pending',
    };
    const mappedStatus = statusMap[status] || status;

    // Update DB — but never overwrite a status the sync process already set.
    // Once an execution_run exists the sync has evaluated the JTL and determined the
    // correct status (e.g. 'failed' for 400/401 full-failure). The CI provider only
    // knows the pipeline exit code, not the JTL error rates, so its 'completed' must
    // not clobber the sync-determined 'failed'.
    const isFinished = ['completed','failed','cancelled','skipped'].includes(mappedStatus);
    const alreadySynced = await db.prepare('SELECT id FROM execution_runs WHERE ci_run_id = ?').get(run.id);
    if (alreadySynced) {
      await db.prepare('UPDATE ci_pipeline_runs SET web_url=? WHERE id=?').run(webUrl, run.id);
    } else {
      await db.prepare('UPDATE ci_pipeline_runs SET status=?, web_url=?' + (isFinished ? ", finished_at=NOW()" : '') + ' WHERE id=?')
        .run(mappedStatus, webUrl, run.id);
    }

    // Auto-sync: whenever this run is in a finished state and has no execution_runs record yet,
    // attempt to download artifacts and create the record. Retry on every poll until it succeeds —
    // the first auto-sync attempt may have failed silently (e.g. JTL not yet on perf-results branch).
    const wasFinished = ['completed','failed','cancelled','skipped'].includes(run.status);
    if (['completed','failed'].includes(mappedStatus)) {
      const alreadySynced = await db.prepare('SELECT id FROM execution_runs WHERE ci_run_id = ?').get(run.id);
      // ciSyncInProgress.add() happens synchronously (same event-loop turn as the check),
      // so two overlapping polls for the same run can't both pass this gate — the second
      // sees the id already in the set and skips, closing the race that used to produce
      // two execution_runs rows for one ci_pipeline_runs row.
      if (!alreadySynced && !ciSyncInProgress.has(run.id)) {
        ciSyncInProgress.add(run.id);
        const runSnapshot = await db.prepare('SELECT * FROM ci_pipeline_runs WHERE id = ?').get(run.id);
        setImmediate(() => autoSyncCiRun(runSnapshot, cfg, req.params.projectId, req.userId)
          .catch(e => console.error('[Auto-sync] failed for run', runSnapshot.id, ':', e.message))
          .finally(() => ciSyncInProgress.delete(run.id)));
      }
    }

    // Send email alert for failed / cancelled runs.
    // For 'failed' with results: auto-sync also fires and sends a more detailed email.
    // For 'failed' without results (infra crash): this is the only notification.
    if (!wasFinished && ['failed','cancelled'].includes(mappedStatus)) {
      setImmediate(async () => {
        try {
          const { sendAlertEmail } = require('../utils/emailUtils');
          const ciVarsF = (() => { try { return JSON.parse(run.variables || '{}'); } catch { return {}; } })();
          const emailData = {
            meta: {
              suite_name: `${run.run_name || run.script_name || 'CI Run'} [${mappedStatus.toUpperCase()}]`,
              engine: 'jmeter',
              started_at: run.started_at,
              duration_s: run.finished_at
                ? Math.round((new Date(run.finished_at) - new Date(run.started_at)) / 1000)
                : 0,
              status: mappedStatus,
              ci_provider: run.provider,
              ci_web_url: webUrl,
            },
            summary: {
              total_requests: 0, total_success: 0, total_failed: 0,
              error_rate: 0, avg_response_time: 0, overall_tps: 0, p90: 0, p95: 0,
            },
            by_api: [], timeline: [], errors: [{ type: 'CI Pipeline', message: `Pipeline ${mappedStatus} on ${run.provider}` }],
            rule_violations: [],
          };
          await sendAlertEmail(null, req.userId, req.params.projectId, emailData, null, null);
          console.log(`[CI Status] Alert email sent for ${mappedStatus} run #${run.id}`);
        } catch (e) {
          console.error('[CI Status] Failed email for', mappedStatus, 'run:', e.message);
        }
      });
    }

    res.json({ run: { ...run, status: mappedStatus, web_url: webUrl } });
  } catch (e) {
    res.json({ run, poll_error: e.message });
  }
});

// ── POST /runs/:runId/sync-results — download artifacts and save to env results folder ──
router.post('/runs/:runId/sync-results', async (req, res) => {
  if (!await ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });

  const run = await db.prepare('SELECT * FROM ci_pipeline_runs WHERE id = ? AND project_id = ?').get(req.params.runId, req.params.projectId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (!run.external_id) return res.status(400).json({ error: 'No external pipeline ID — pipeline may not have started yet.' });

  // Guard: don't create a second execution_runs record for the same CI run
  const alreadySynced = await db.prepare('SELECT id FROM execution_runs WHERE ci_run_id = ?').get(run.id);
  if (alreadySynced) return res.json({ ok: true, already_synced: true, execution_run_id: alreadySynced.id, message: 'Already synced — results are already in Analytics.' });

  const cfg = decryptConfig(await getConfig(req.params.projectId, req.userId));
  if (!cfg) return res.status(400).json({ error: 'CI configuration not found.' });

  const project = await db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const AdmZip = require('adm-zip');
  const os = require('os');
  const { getUserProjectPath, getCollectionPath, resolveSuiteEnv } = require('../utils/projectFolders');
  const { buildRunDirName, extractRunNumber } = require('../utils/buildRunName');

  // ── Determine results directory ────────────────────────────────────────────
  const callerUser1 = await db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId);
  const callerRole  = callerUser1?.role;
  const userProjPath = await getUserProjectPath(req.userId, callerRole, project.name);

  // Parse CI parameters for the run name
  const ciVars2  = (() => { try { return JSON.parse(run.variables || '{}'); } catch { return {}; } })();
  const ciUsers2 = ciVars2.jmeter_users    || null;
  const ciLoops2 = ciVars2.jmeter_loops    || null;
  const ciDur2   = ciVars2.jmeter_duration || null;

  let resultDir = null;
  let syncSuiteName = null;
  if (run.script_name) {
    const scriptFile = run.script_name.replace(/\\/g, '/').split('/').pop();
    const suite = await db.prepare(`
      SELECT ts.*, c.name as col_name, c.environment as col_environment, c.environments as col_environments
      FROM test_suites ts
      LEFT JOIN collections c ON c.id = ts.collection_id
      WHERE ts.project_id = ?
        AND (ts.jmx_path LIKE ? OR ts.js_path LIKE ?)
      LIMIT 1
    `).get(req.params.projectId, `%${scriptFile}`, `%${scriptFile}`);

    syncSuiteName = suite?.name || null;
    // resolveSuiteEnv falls back to the collection's own default env when ts.env is
    // blank, so a collection-scoped suite never drops to the project-level fallback
    // below just because its env wasn't explicitly recorded.
    const syncResolvedEnv = suite?.col_name
      ? resolveSuiteEnv({ environment: suite.col_environment, environments: suite.col_environments }, suite)
      : null;
    if (suite?.col_name && syncResolvedEnv) {
      const envPath = getCollectionPath(userProjPath, suite.col_name, syncResolvedEnv);
      try { fs.mkdirSync(path.join(envPath, 'results'), { recursive: true }); } catch {}
      let nums = [];
      try { nums = fs.readdirSync(path.join(envPath, 'results'), { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('Heal_')).map(d => extractRunNumber(d.name)).filter(n => n > 0); } catch {}
      const nextRun = nums.length ? Math.max(...nums) + 1 : 1;
      const syncScriptBase = scriptFile.replace(/\.jmx$/, '');
      resultDir = path.join(envPath, 'results', buildRunDirName(syncSuiteName || syncScriptBase, ciUsers2, 'duration', ciLoops2, ciDur2, nextRun));
    }
  }

  // Project-level fallback is only legitimate for a run whose script couldn't be
  // matched to any collection-scoped test suite at all.
  if (!resultDir) {
    console.warn(`[CI Sync] Run #${run.id} (script "${run.script_name}") — no matching collection-scoped test suite found, falling back to project-level results`);
    try {
      const nums = fs.readdirSync(path.join(userProjPath, 'results'), { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('Heal_')).map(d => extractRunNumber(d.name)).filter(n => n > 0);
      const next = nums.length ? Math.max(...nums) + 1 : 1;
      const fb = run.script_name ? run.script_name.replace(/\\/g, '/').split('/').pop().replace(/\.jmx$/, '') : 'CIRun';
      resultDir = path.join(userProjPath, 'results', buildRunDirName(syncSuiteName || fb, ciUsers2, 'duration', ciLoops2, ciDur2, next));
    } catch {
      resultDir = path.join(userProjPath, 'results', `CI_Run_${run.id}`);
    }
  }

  fs.mkdirSync(resultDir, { recursive: true });

  // ── Download artifact zip ─────────────────────────────────────────────────
  const tmpZip = path.join(os.tmpdir(), `ci_artifact_${run.id}_${Date.now()}.zip`);
  let bbHandledDirect = false; // Bitbucket: files placed directly, skip generic zip extraction

  try {
    if (run.provider === 'github') {
      if (!cfg.github_token) return res.status(400).json({ error: 'GitHub token not set.' });

      // Get artifact list for this run
      const artifactsResp = await apiRequest(
        `https://api.github.com/repos/${cfg.github_repo}/actions/runs/${run.external_id}/artifacts`,
        'GET', null,
        { Authorization: `token ${cfg.github_token}`, 'User-Agent': 'PerfStudio', Accept: 'application/vnd.github+json' }
      );

      if (artifactsResp.status !== 200 || !artifactsResp.body?.artifacts?.length) {
        return res.status(404).json({ error: 'No artifacts found for this run. The pipeline may still be running or artifacts may have expired.' });
      }

      // Pick the first artifact (jmeter-report-*)
      const artifact = artifactsResp.body.artifacts[0];

      // Get download URL (GitHub returns 302 redirect)
      const dlResp = await apiRequest(
        `https://api.github.com/repos/${cfg.github_repo}/actions/artifacts/${artifact.id}/zip`,
        'GET', null,
        { Authorization: `token ${cfg.github_token}`, 'User-Agent': 'PerfStudio', Accept: 'application/vnd.github+json' }
      );

      // Follow the redirect to get the actual download URL
      const downloadUrl = dlResp.headers?.location || dlResp.headers?.Location;
      if (!downloadUrl) return res.status(500).json({ error: 'Could not get artifact download URL from GitHub.' });

      // Download the zip
      await new Promise((resolve, reject) => {
        const urlObj = new URL(downloadUrl);
        const isHttps = urlObj.protocol === 'https:';
        const fileStream = fs.createWriteStream(tmpZip);
        (isHttps ? https : http).get(downloadUrl, { rejectUnauthorized: false }, response => {
          // Handle another redirect if needed
          if (response.statusCode === 302 || response.statusCode === 301) {
            const redirectUrl = response.headers.location;
            (isHttps ? https : http).get(redirectUrl, { rejectUnauthorized: false }, r2 => {
              r2.pipe(fileStream);
              fileStream.on('finish', () => { fileStream.close(); resolve(); });
            }).on('error', reject);
          } else {
            response.pipe(fileStream);
            fileStream.on('finish', () => { fileStream.close(); resolve(); });
          }
        }).on('error', reject);
      });
    }

    if (run.provider === 'gitlab') {
      if (!cfg.gitlab_token) return res.status(400).json({ error: 'GitLab token not set.' });
      const gitlabUrl = (cfg.gitlab_url || 'https://gitlab.com').replace(/\/$/, '');
      const encodedId = encodeURIComponent(cfg.gitlab_project_id);

      // Get jobs for this pipeline
      const jobsResp = await apiRequest(
        `${gitlabUrl}/api/v4/projects/${encodedId}/pipelines/${run.external_id}/jobs`,
        'GET', null, { 'PRIVATE-TOKEN': cfg.gitlab_token }
      );
      if (jobsResp.status !== 200 || !jobsResp.body?.length) {
        return res.status(404).json({ error: 'No jobs found for this GitLab pipeline.' });
      }

      const job = jobsResp.body.find(j => j.artifacts_file) || jobsResp.body[0];
      if (!job?.id) return res.status(404).json({ error: 'No artifact-producing job found.' });

      // Download artifacts zip
      await new Promise((resolve, reject) => {
        const artifactUrl = `${gitlabUrl}/api/v4/projects/${encodedId}/jobs/${job.id}/artifacts`;
        const urlObj = new URL(artifactUrl);
        const isHttps = urlObj.protocol === 'https:';
        const fileStream = fs.createWriteStream(tmpZip);
        const options = { hostname: urlObj.hostname, port: urlObj.port || (isHttps ? 443 : 80), path: urlObj.pathname, method: 'GET', headers: { 'PRIVATE-TOKEN': cfg.gitlab_token }, rejectUnauthorized: false };
        (isHttps ? https : http).request(options, response => {
          if (response.statusCode !== 200 && response.statusCode !== 206) {
            fileStream.close();
            return reject(new Error(`GitLab artifact download failed with HTTP ${response.statusCode}. The pipeline may still be running or artifacts may have expired.`));
          }
          response.pipe(fileStream);
          fileStream.on('finish', () => { fileStream.close(); resolve(); });
        }).on('error', reject).end();
      });
    }

    if (run.provider === 'bitbucket') {
      if (!cfg.bitbucket_app_password) return res.status(400).json({ error: 'Bitbucket App Password / API Token not set.' });
      const bbAuthHdr3 = await bbBasicAuth(cfg, req.userId);
      const pid3       = (run.external_id || '').replace(/[{}]/g, '');
      const ciVars3    = (() => { try { return JSON.parse(run.variables || '{}'); } catch { return {}; } })();
      const branch3      = ciVars3.bb_branch || 'perf-results';
      const runFolder3   = ciVars3.bb_build_number ? `Run${ciVars3.bb_build_number}` : pid3;
      const base3        = ciVars3.results_path ? `${ciVars3.results_path}/${runFolder3}` : `ci-results/${runFolder3}`;
      const ws3        = cfg.bitbucket_workspace;
      const slug3      = cfg.bitbucket_repo_slug;

      // Fetch results.jtl directly from the repo branch.
      // Branches with '/' must be resolved to a commit hash — %2F in a URL path gets
      // decoded by the server before routing, turning "feature%2Fquarks-user" into
      // branch "feature" (non-existent) → 404.
      const branchNode3 = branch3.includes('/')
        ? await resolveBranchToCommit(ws3, slug3, branch3, bbAuthHdr3)
        : encodeURIComponent(branch3);
      const jtlApiPath3 = `/2.0/repositories/${ws3}/${slug3}/src/${branchNode3}/${base3}/results.jtl`;
      const tmpJtl3 = path.join(os.tmpdir(), `ci_jtl_${run.id}_${Date.now()}.jtl`);
      await new Promise((resolve, reject) => {
        const fs3 = fs.createWriteStream(tmpJtl3);
        const opts3 = { hostname: 'api.bitbucket.org', path: jtlApiPath3, method: 'GET', headers: { Authorization: bbAuthHdr3, 'User-Agent': 'PerfStudio' }, rejectUnauthorized: false };
        https.request(opts3, r => {
          const follow = (r2) => {
            if (r2.statusCode === 200 || r2.statusCode === 206) { r2.pipe(fs3); fs3.on('finish', () => { fs3.close(); resolve(); }); }
            else { fs3.close(); reject(new Error(`results.jtl not found on branch "${branch3}" at ${base3} (HTTP ${r2.statusCode}). Ensure the pipeline completed and committed results.`)); }
          };
          if (r.statusCode === 301 || r.statusCode === 302) {
            https.get(r.headers.location, { rejectUnauthorized: false }, follow).on('error', reject);
          } else { follow(r); }
        }).on('error', reject).end();
      });
      fs.copyFileSync(tmpJtl3, path.join(resultDir, 'results.jtl'));
      fs.unlinkSync(tmpJtl3);

      // Fetch html.zip from the repo branch (non-fatal if missing)
      const htmlZipPath3 = `/2.0/repositories/${ws3}/${slug3}/src/${branchNode3}/${base3}/html.zip`;
      const tmpHtml3 = path.join(os.tmpdir(), `ci_html_${run.id}_${Date.now()}.zip`);
      try {
        await new Promise((resolve) => {
          const fsh = fs.createWriteStream(tmpHtml3);
          const opth = { hostname: 'api.bitbucket.org', path: htmlZipPath3, method: 'GET', headers: { Authorization: bbAuthHdr3, 'User-Agent': 'PerfStudio' }, rejectUnauthorized: false };
          https.request(opth, r => {
            const follow = (r2) => {
              if (r2.statusCode === 200) { r2.pipe(fsh); fsh.on('finish', () => { fsh.close(); resolve(); }); }
              else { fsh.close(); resolve(); }
            };
            if (r.statusCode === 301 || r.statusCode === 302) {
              https.get(r.headers.location, { rejectUnauthorized: false }, follow).on('error', () => { fsh.close(); resolve(); });
            } else { follow(r); }
          }).on('error', () => { fsh.close(); resolve(); }).end();
        });
        if (fs.existsSync(tmpHtml3) && fs.statSync(tmpHtml3).size > 0) {
          const reportDir3 = path.join(resultDir, 'report');
          fs.mkdirSync(reportDir3, { recursive: true });
          new AdmZip(tmpHtml3).extractAllTo(reportDir3, true);
          fs.unlinkSync(tmpHtml3);
        }
      } catch (_e) {
        console.warn('[CI sync] html.zip download failed (non-fatal):', _e.message);
        try { if (fs.existsSync(tmpHtml3)) fs.unlinkSync(tmpHtml3); } catch {}
      }

      bbHandledDirect = true;
    }

    // ── Extract zip to resultDir (GitHub / GitLab — Bitbucket writes files directly) ──
    if (!bbHandledDirect) {
      if (!fs.existsSync(tmpZip) || fs.statSync(tmpZip).size === 0) {
        return res.status(500).json({ error: 'Downloaded artifact is empty or missing.' });
      }
      const zip = new AdmZip(tmpZip);
      zip.extractAllTo(resultDir, true);
      fs.unlinkSync(tmpZip);

      // Normalise html → report folder
      const ciHtmlDir = path.join(resultDir, 'html');
      const localHtmlDir = path.join(resultDir, 'report');
      if (fs.existsSync(ciHtmlDir) && !fs.existsSync(localHtmlDir)) {
        fs.renameSync(ciHtmlDir, localHtmlDir);
      }
    }

    const reportPath = path.join(resultDir, 'report', 'index.html');
    const jtlPath    = path.join(resultDir, 'results.jtl');

    // ── Generate analytics PDF from JTL ──────────────────────────────────────
    let pdfPath = null;
    let reportData = null;
    let ruleResult = null;
    if (fs.existsSync(jtlPath)) {
      try {
        const { generateAnalyticsPdfToFile } = require('../utils/generateAnalyticsPdf');
        const runNum  = (resultDir.match(/Run_(\d+)/) || [])[1] || run.id;
        const tmpPdf  = path.join(resultDir, `Analytics_CI_Run_${runNum}.pdf`);

        // Parse JTL with the full parser (timeline, errors, bytes, latency, connect)
        const { parseJtl } = require('../utils/parseJtl');
        const suite = await db.prepare('SELECT name FROM test_suites WHERE id = (SELECT suite_id FROM execution_runs WHERE result_dir LIKE ? LIMIT 1)').get(`%${path.basename(resultDir)}%`);
        reportData = parseJtl(jtlPath, {
          suite_name: suite?.name || run.script_name || 'CI Run',
          engine: 'jmeter',
          started_at: run.started_at,
          status: 'completed',
        });
        if (reportData) {
          // Don't generate PDF or send email for 0-sample runs
          if ((reportData.summary?.total_requests || 0) === 0) {
            console.warn('[CI Sync] JTL has 0 samples — skipping PDF/email.');
            reportData = null;
          } else {
            // Evaluate rules so PDF shows PASSED/FAILED correctly
            try {
              const { evaluateRules } = require('../utils/ruleEvaluator');
              ruleResult = await evaluateRules(req.params.projectId, jtlPath);
              reportData.rule_violations = ruleResult?.violations || [];
            } catch (_) {}

            await generateAnalyticsPdfToFile(reportData, runNum, tmpPdf);
            pdfPath = tmpPdf;
            console.log('[CI Sync] Analytics PDF generated:', pdfPath);
          }
        }
      } catch (e) {
        console.error('[CI Sync] PDF generation failed:', e.message, e.stack?.split('\n')[1] || '');
      }
    }

    // ── Create execution_run record ───────────────────────────────────────────
    let suiteId = null;
    if (run.script_name) {
      const scriptFile = run.script_name.split('/').pop();
      const suite = await db.prepare("SELECT id FROM test_suites WHERE project_id = ? AND (jmx_path LIKE ? OR js_path LIKE ?) LIMIT 1")
        .get(req.params.projectId, `%${scriptFile}`, `%${scriptFile}`);
      suiteId = suite?.id || null;
    }

    // Any individual API at 100% failure → mark run failed and always trigger heal, regardless of status code.
    const syncApiFullFailure = hasAnyApiFullFailure(reportData);
    // Overall pass/fail mirrors the rule engine (what the alert email/PDF already show) —
    // falls back to raw failure count when the project has no rules configured.
    const syncRunFailed = syncApiFullFailure || ruleResult?.passed === false ||
      (ruleResult?.noRules && (reportData?.summary?.total_failed || 0) > 0);
    const syncRunStatus = syncRunFailed ? 'failed' : 'completed';
    if (syncRunFailed) {
      await db.prepare("UPDATE ci_pipeline_runs SET status='failed' WHERE id=?").run(run.id);
    }

    const execRunRow = await db.prepare(`
      INSERT INTO execution_runs
        (project_id, suite_id, engine, status, result_dir, report_path, logs, started_at, finished_at, report_data, ci_run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?)
    `).run(
      req.params.projectId,
      suiteId,
      'jmeter',
      syncRunStatus,
      resultDir,
      fs.existsSync(reportPath) ? reportPath : null,
      JSON.stringify([{ type: 'info', message: `Results synced from CI pipeline run #${run.external_id} (${run.provider})` }]),
      run.started_at || new Date().toISOString(),
      reportData ? JSON.stringify(reportData) : null,
      run.id
    );

    // Update ci_pipeline_run with result_dir reference
    await db.prepare("UPDATE ci_pipeline_runs SET variables = ? WHERE id = ?")
      .run(JSON.stringify({ ...JSON.parse(run.variables || '{}'), result_dir: resultDir }), run.id);

    // ── Send email alert for CI run ───────────────────────────────────────────
    const newRunId = execRunRow.lastInsertRowid;
    const suppressEmail = req.query.suppress_email === 'true' || (reportData?.summary?.total_requests || 0) === 0;
    if (!suppressEmail) setImmediate(async () => {
      try {
        const { sendAlertEmail, sendRuleViolationEmail } = require('../utils/emailUtils');
        const emailData = reportData || {
          meta: { suite_name: run.script_name || 'CI Run', engine: 'jmeter', started_at: run.started_at, duration_s: 0, status: 'completed' },
          summary: { total_requests: 0, total_success: 0, total_failed: 0, error_rate: 0, avg_response_time: 0, overall_tps: 0, p90: 0, p95: 0 },
          by_api: [], timeline: [], errors: [], rule_violations: [],
        };
        // Use the actual suite name from the test_suites table (suiteId resolved above)
        let resolvedSuiteName = emailData.meta.suite_name;
        if (suiteId) {
          const sRow = await db.prepare('SELECT name FROM test_suites WHERE id = ?').get(suiteId);
          if (sRow?.name) { emailData.meta.suite_name = sRow.name; resolvedSuiteName = sRow.name; }
        }
        emailData.meta.run_id = newRunId;
        // Reuse violations already evaluated before PDF generation
        const violations = reportData?.rule_violations || [];
        emailData.rule_violations = violations;
        // Send rule violation email first (as soon as violations are known, before full report)
        if (violations.length > 0) {
          const proj = await db.prepare('SELECT name FROM projects WHERE id = ?').get(req.params.projectId);
          await sendRuleViolationEmail(newRunId, req.userId, req.params.projectId, violations, resolvedSuiteName, proj?.name || '');
        }
        // Send full report email
        await sendAlertEmail(newRunId, req.userId, req.params.projectId, emailData, pdfPath, null);
        console.log(`[CI Sync] Alert email sent for run #${newRunId}`);
      } catch (e) {
        console.error('[CI Sync] Alert email failed:', e.message);
      }
    });

    // Auto-heal: any single API at 100% failure always heals, regardless of the auto_heal flag;
    // otherwise heal only if auto_heal was enabled at trigger time and the run failed.
    const syncShouldHeal = syncApiFullFailure || (run.auto_heal && syncRunFailed);
    if (syncShouldHeal && !run.is_heal_run) {
      const syncHealInstruction = buildErrorHealInstruction(reportData?.errors) || run.auto_heal_instruction || null;
      console.log(`[CI Sync] Run #${run.id} failed (apiFullFailure=${syncApiFullFailure}) — triggering auto-heal`);
      setImmediate(async () => {
        try {
          startAutoHealCI(req.userId, run.id, req.params.projectId, {
            mode: syncHealInstruction ? 'custom' : (run.auto_heal_mode || 'auto'),
            customInstruction: syncHealInstruction,
          });
        } catch (e) {
          console.error('[CI Sync] Failed to start auto-heal:', e.message);
        }
      });
    }

    const savedFiles = fs.readdirSync(resultDir);
    res.json({
      ok: true,
      result_dir: resultDir,
      files: savedFiles,
      has_html_report: fs.existsSync(reportPath),
      has_pdf: !!pdfPath,
      message: `Results saved → ${path.basename(path.dirname(resultDir))}/${path.basename(resultDir)} (JTL + ${fs.existsSync(reportPath)?'HTML report + ':''}${pdfPath?'PDF':'no PDF'})`,
    });

  } catch (e) {
    try { if (fs.existsSync(tmpZip)) fs.unlinkSync(tmpZip); } catch {}
    res.status(500).json({ error: `Failed to sync results: ${e.message}` });
  }
});

// ── GET /runs/:runId/steps — live step details from GitHub/GitLab ─────────────
router.get('/runs/:runId/steps', async (req, res) => {
  if (!await ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const run = await db.prepare('SELECT * FROM ci_pipeline_runs WHERE id = ? AND project_id = ?').get(req.params.runId, req.params.projectId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (!run.external_id) return res.json({ steps: [], status: run.status });

  const cfg = decryptConfig(await getConfig(req.params.projectId, req.userId));
  if (!cfg) return res.json({ steps: [], status: run.status });

  try {
    if (run.provider === 'github') {
      if (!cfg.github_token) return res.json({ steps: [], status: run.status });
      const ghHeaders = {
        Authorization: `token ${cfg.github_token}`,
        'User-Agent': 'PerfStudio',
        Accept: 'application/vnd.github+json',
      };

      // Get jobs for this run
      const jobsResp = await apiRequest(
        `https://api.github.com/repos/${cfg.github_repo}/actions/runs/${run.external_id}/jobs`,
        'GET', null, ghHeaders
      );

      if (jobsResp.status !== 200) return res.json({ steps: [], status: run.status });

      const job = jobsResp.body?.jobs?.[0];
      if (!job) return res.json({ steps: [], status: run.status });

      const steps = (job.steps || []).map(s => ({
        number:       s.number,
        name:         s.name,
        status:       s.status,       // queued | in_progress | completed
        conclusion:   s.conclusion,   // success | failure | skipped | cancelled | null
        started_at:   s.started_at,
        completed_at: s.completed_at,
        duration_s:   s.started_at && s.completed_at
          ? Math.round((new Date(s.completed_at) - new Date(s.started_at)) / 1000)
          : null,
      }));

      // Job-level details
      const jobInfo = {
        id:           job.id,
        name:         job.name,
        status:       job.status,
        conclusion:   job.conclusion,
        started_at:   job.started_at,
        completed_at: job.completed_at,
        html_url:     job.html_url,
        runner_name:  job.runner_name,
      };

      return res.json({ steps, job: jobInfo, status: run.status, provider: 'github' });
    }

    if (run.provider === 'gitlab') {
      if (!cfg.gitlab_token) return res.json({ steps: [], status: run.status });
      const gitlabUrl = (cfg.gitlab_url || 'https://gitlab.com').replace(/\/$/, '');
      const encodedId = encodeURIComponent(cfg.gitlab_project_id);

      const jobsResp = await apiRequest(
        `${gitlabUrl}/api/v4/projects/${encodedId}/pipelines/${run.external_id}/jobs`,
        'GET', null, { 'PRIVATE-TOKEN': cfg.gitlab_token }
      );

      if (jobsResp.status !== 200) return res.json({ steps: [], status: run.status });

      const steps = (jobsResp.body || []).map(j => ({
        number:       j.id,
        name:         j.name,
        status:       j.status,
        conclusion:   j.status === 'success' ? 'success' : j.status === 'failed' ? 'failure' : null,
        started_at:   j.started_at,
        completed_at: j.finished_at,
        duration_s:   j.duration ? Math.round(j.duration) : null,
      }));

      return res.json({ steps, status: run.status, provider: 'gitlab' });
    }

    if (run.provider === 'bitbucket') {
      const mergedCfg = await (async () => {
        const adminRaw = await db.prepare(`
          SELECT cpc.* FROM ci_pipeline_configs cpc
          JOIN users u ON u.id = cpc.user_id
          WHERE cpc.project_id = ? AND u.role IN ('org_admin','super_admin')
          ORDER BY cpc.updated_at DESC LIMIT 1
        `).get(req.params.projectId);
        const adminC = decryptConfig(adminRaw);
        return { ...(adminC || cfg), bitbucket_username: cfg?.bitbucket_username || adminC?.bitbucket_username || '', bitbucket_app_password: cfg?.bitbucket_app_password || adminC?.bitbucket_app_password || '' };
      })();
      const bbToken = (mergedCfg.bitbucket_app_password || '').trim();
      if (!bbToken) return res.json({ steps: [], status: run.status });
      const bbAuth = Buffer.from(`${mergedCfg.bitbucket_username || mergedCfg.bitbucket_workspace}:${bbToken}`).toString('base64');
      const stepsResp = await apiRequest(
        `https://api.bitbucket.org/2.0/repositories/${mergedCfg.bitbucket_workspace}/${mergedCfg.bitbucket_repo_slug}/pipelines/${run.external_id}/steps/`,
        'GET', null, { Authorization: `Basic ${bbAuth}`, 'User-Agent': 'Peako' }
      );
      if (stepsResp.status !== 200) return res.json({ steps: [], status: run.status });
      const steps = (stepsResp.body?.values || []).map((s, i) => {
        const stName = s.state?.name;           // PENDING | IN_PROGRESS | COMPLETED
        const result = s.state?.result?.name;   // SUCCESSFUL | FAILED | STOPPED
        const bbStatus = stName === 'IN_PROGRESS' ? 'in_progress' : stName === 'COMPLETED' ? 'completed' : 'queued';
        const conclusion = result === 'SUCCESSFUL' ? 'success' : result === 'FAILED' ? 'failure' : result === 'STOPPED' ? 'cancelled' : null;
        return {
          number:       i + 1,
          name:         s.name || `Step ${i + 1}`,
          status:       bbStatus,
          conclusion,
          started_at:   s.started_on || null,
          completed_at: s.completed_on || null,
          duration_s:   s.duration_in_seconds || null,
        };
      });
      return res.json({ steps, status: run.status, provider: 'bitbucket' });
    }

    res.json({ steps: [], status: run.status });
  } catch (e) {
    res.json({ steps: [], status: run.status, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// CI AUTO HEAL
// ══════════════════════════════════════════════════════════════════════════════

// Auto-heal gets exactly 1 automatic attempt per session — same reasoning as autoHealer.js's
// local MAX_ATTEMPTS. After that, the "Heal Again" button (Runner.jsx's instruction textarea
// → POST /runs/:runId/heal's auto_heal_instruction) is the intended path for a targeted
// retry rather than more unguided automatic attempts.
const HEAL_CI_MAX_ATTEMPTS = 1;
const HEAL_CI_VUSERS       = 1;
const HEAL_CI_RAMPUP       = 1;
const HEAL_CI_LOOPS        = 1;
// patch_jmx.py treats duration <= 0 (or "-1") as "loop-mode" — anything else forces
// scheduler/duration mode instead, which hardcodes LoopController.loops to -1 and ignores
// jmeter_loops entirely. Must stay "-1" for a true single-user/single-loop quick verify.
const HEAL_CI_DURATION     = '-1';

async function generateHealSummary(ciRunId) {
  // `attempt` on each log row is a GLOBAL counter carried across heal sessions/chained
  // runs (so logs read "Attempt 1, 2, 3…" across separate "Heal Again" clicks) — but this
  // summary only ever sees the rows logged against THIS SPECIFIC ci_run_id, which can be
  // a small slice of that global sequence (e.g. rows numbered 1 and 11). Display a plain
  // local index here instead of the raw global number, since "Attempt 11" right after
  // "Attempt 1" with nothing in between reads as a bug, not as cross-session continuity.
  const logs = await db.prepare('SELECT * FROM ci_auto_heal_logs WHERE ci_run_id = ? ORDER BY attempt ASC').all(ciRunId);
  if (!logs.length) return 'Auto-heal exhausted — no attempt logs found.';
  const run = await db.prepare('SELECT provider FROM ci_pipeline_runs WHERE id = ?').get(ciRunId);
  const providerLabel = { github: 'GitHub Actions', gitlab: 'GitLab CI', bitbucket: 'Bitbucket Pipelines' }[run?.provider] || 'CI';
  const lines = [`Auto-heal exhausted after ${logs.length} attempt(s). The script could not be automatically fixed.\n`];
  logs.forEach((log, i) => {
    lines.push(`Attempt ${i + 1}:`);
    if (log.diagnosis)   lines.push(`  Issue:       ${log.diagnosis}`);
    if (log.fix_applied) lines.push(`  Fix applied: ${log.fix_applied}`);
    lines.push(`  Result:      ${log.result || 'unknown'}`);
    lines.push('');
  });
  const last = logs[logs.length - 1];
  if (last?.diagnosis) {
    lines.push(`Remaining issue: ${last.diagnosis}`);
    lines.push(`\nRecommendation: Review the script manually. Check that ${providerLabel} pipeline variables (jmeter_users, jmeter_rampup, jmeter_duration) are injected, all ThreadGroup elements have enabled="true", and the target host is reachable from the CI runner.`);
  }
  return lines.join('\n');
}

async function setCiHealStatus(ciRunId, status) {
  if (status === 'exhausted') {
    const summary = await generateHealSummary(ciRunId);
    await db.prepare('UPDATE ci_pipeline_runs SET heal_status=?, heal_summary=? WHERE id=?').run(status, summary, ciRunId);
  } else {
    await db.prepare('UPDATE ci_pipeline_runs SET heal_status=? WHERE id=?').run(status, ciRunId);
  }
}

async function logCiHealAttempt(ciRunId, attempt, diagnosis, fix, fixType, newCiRunId = null) {
  const r = await db.prepare(
    'INSERT INTO ci_auto_heal_logs (ci_run_id, attempt, diagnosis, fix_applied, fix_type, new_ci_run_id) VALUES (?,?,?,?,?,?)'
  ).run(ciRunId, attempt, diagnosis, fix, fixType, newCiRunId);
  return r.lastInsertRowid;
}

async function pollBitbucketUntilDone(ws, slug, pipelineUuid, authHeader, maxWaitMs = 35 * 60 * 1000) {
  const POLL_MS = 15_000;
  const uuid    = pipelineUuid.replace(/[{}]/g, '');
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_MS));
    try {
      const resp = await apiRequest(
        `https://api.bitbucket.org/2.0/repositories/${ws}/${slug}/pipelines/${uuid}`,
        'GET', null, { Authorization: authHeader, 'User-Agent': 'PerfStudio' }
      );
      const pipeState = resp.body?.state?.name;
      if (pipeState === 'COMPLETED') {
        const result = resp.body?.state?.result?.name || 'FAILED';
        return { done: true, success: result === 'SUCCESSFUL', result };
      }
    } catch (e) {
      console.warn('[CI Heal] poll error:', e.message);
    }
  }
  return { done: false, success: false, result: 'TIMEOUT' };
}

// Push fixed JMX to Bitbucket Files API and trigger the pipeline.
// overrideVars replaces matching keys from the original run's variables.
async function pushJmxAndTriggerBitbucket(userId, projectId, originalCiRun, overrideVars = {}) {
  const adminRawCfg = await db.prepare(`
    SELECT cpc.* FROM ci_pipeline_configs cpc
    JOIN users u ON u.id = cpc.user_id
    WHERE cpc.project_id = ? AND u.role IN ('org_admin','super_admin')
    ORDER BY cpc.updated_at DESC LIMIT 1
  `).get(projectId);
  const userRawCfg = await db.prepare('SELECT * FROM ci_pipeline_configs WHERE project_id = ? AND user_id = ?').get(projectId, userId) || adminRawCfg;
  const adminCfg = decryptConfig(adminRawCfg);
  const userCfg  = decryptConfig(userRawCfg);
  const cfg = {
    ...(adminCfg || userCfg),
    bitbucket_username:     userCfg?.bitbucket_username     || adminCfg?.bitbucket_username     || '',
    bitbucket_app_password: userCfg?.bitbucket_app_password || adminCfg?.bitbucket_app_password || '',
  };
  const bbWs   = cfg.bitbucket_workspace;
  const bbSlug = cfg.bitbucket_repo_slug;
  if (!bbWs || !bbSlug || !cfg.bitbucket_app_password) throw new Error('Bitbucket CI config incomplete');

  const callerRow = await db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const isAdmin   = ['org_admin', 'super_admin'].includes(callerRow?.role);
  const gitCfg    = await db.prepare('SELECT * FROM git_configs WHERE project_id = ?').get(projectId);
  const baseBranch = gitCfg?.base_branch || 'main';
  const bbBranch = isAdmin
    ? (cfg.bitbucket_ref || baseBranch)
    : `feature/${(callerRow?.name || '').toLowerCase().replace(/[^a-z0-9_/-]/g, '-')}`;

  const origVars = (() => { try { return JSON.parse(originalCiRun.variables || '{}'); } catch { return {}; } })();
  const mergedVars = { ...origVars, ...overrideVars };

  const adminTok = (adminCfg?.bitbucket_app_password || cfg.bitbucket_app_password || '').trim();
  const adminForAuth = { ...cfg, bitbucket_app_password: adminTok, bitbucket_username: adminCfg?.bitbucket_username || cfg.bitbucket_username || '' };
  const authHeader = await bbBasicAuth(adminForAuth, adminRawCfg?.user_id);

  // Locate the fixed JMX on disk and build canonical repo paths
  const scriptName   = originalCiRun.script_name || '';
  const scriptFile   = scriptName.replace(/\\/g, '/').split('/').pop() || scriptName || 'test';
  const healCanonical = await buildCanonicalRepoPaths(projectId, scriptName);
  const jmxDiskPath  = healCanonical.jmxDiskPath;

  // Build multipart file push
  const boundary = 'PeakoHealBoundary9z';
  const fileParts = [];

  // Include pipeline YAML if available
  const wsRoot = (gitCfg?.git_root && fs.existsSync(path.join(gitCfg.git_root, '.git'))) ? gitCfg.git_root : null;
  if (wsRoot) {
    const yamlPath = path.join(wsRoot, 'bitbucket-pipelines.yml');
    if (fs.existsSync(yamlPath)) fileParts.push({ name: 'bitbucket-pipelines.yml', content: fs.readFileSync(yamlPath) });
  }

  // Include fixed JMX at canonical repo path
  if (jmxDiskPath && fs.existsSync(jmxDiskPath)) {
    fileParts.push({ name: healCanonical.scriptRepoPath, content: fs.readFileSync(jmxDiskPath) });
  }

  // Trigger marker so Bitbucket shows a meaningful pipeline title
  const triggerMeta = JSON.stringify({ triggered_at: new Date().toISOString(), script: scriptName, heal: true }, null, 2);
  fileParts.push({ name: '.peako/last-run.json', content: Buffer.from(triggerMeta) });

  const chunks = [];
  const addBuf = s => chunks.push(Buffer.isBuffer(s) ? s : Buffer.from(s, 'utf8'));
  addBuf(`--${boundary}\r\nContent-Disposition: form-data; name="message"\r\n\r\nPeako Auto Heal: ${scriptFile || 'test'} [heal]\r\n`);
  addBuf(`--${boundary}\r\nContent-Disposition: form-data; name="branch"\r\n\r\n${bbBranch}\r\n`);
  for (const fp of fileParts) {
    addBuf(`--${boundary}\r\nContent-Disposition: form-data; name="${fp.name}"\r\n\r\n`);
    addBuf(fp.content);
    addBuf('\r\n');
  }
  addBuf(`--${boundary}--\r\n`);
  const bodyBuf = Buffer.concat(chunks);

  await new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.bitbucket.org', port: 443,
      path: `/2.0/repositories/${bbWs}/${bbSlug}/src`,
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': bodyBuf.length, 'User-Agent': 'PerfStudio' },
      rejectUnauthorized: false,
    };
    const req2 = https.request(opts, res2 => {
      let d = '';
      res2.on('data', c => d += c);
      res2.on('end', () => {
        if (res2.statusCode === 201) resolve();
        else reject(new Error(`Files API ${res2.statusCode}: ${d.slice(0, 200)}`));
      });
    });
    req2.on('error', reject);
    req2.write(bodyBuf);
    req2.end();
  });

  // Trigger pipeline
  const bbBody = {
    target: {
      ref_type: 'branch', type: 'pipeline_ref_target', ref_name: bbBranch,
      selector: { type: 'custom', pattern: 'Peako-Performance-Test' },
    },
    variables: [
      ...Object.entries(mergedVars).map(([k, v]) => ({ key: k.toUpperCase(), value: String(v), secured: false })),
      { key: 'SCRIPT_PATH',    value: healCanonical.scriptRepoPath,  secured: false },
      { key: 'RESULTS_PATH',   value: healCanonical.resultsPath,     secured: false },
      { key: 'TESTDATA_PATH',  value: healCanonical.testDataPath,    secured: false },
      { key: 'BB_USERNAME',    value: callerRow?.email || cfg.bitbucket_username || '', secured: false },
      { key: 'BB_APP_PASSWORD', value: adminTok, secured: true },
    ],
  };
  const bbResp = await apiRequest(
    `https://api.bitbucket.org/2.0/repositories/${bbWs}/${bbSlug}/pipelines/`,
    'POST', bbBody,
    { Authorization: authHeader, 'User-Agent': 'PerfStudio', Accept: 'application/json' }
  );
  if (bbResp.status !== 201) throw new Error(`Bitbucket ${bbResp.status}: ${bbResp.body?.error?.message || JSON.stringify(bbResp.body)}`);

  const pipelineUuid      = bbResp.body.uuid;
  const pipelineBuildNum  = bbResp.body.build_number || null;

  // Store the CORRECT bb_build_number for this new pipeline (not inherited from parent run)
  const healVars = {
    ...mergedVars,
    script_path:  healCanonical.scriptRepoPath,
    results_path: healCanonical.resultsPath,
    testdata_path: healCanonical.testDataPath,
    bb_branch:    bbBranch,
    ...(pipelineBuildNum ? { bb_build_number: pipelineBuildNum } : {}),
  };

  const healRunInsert = await db.prepare(
    'INSERT INTO ci_pipeline_runs (project_id, provider, external_id, web_url, status, script_name, run_name, variables, triggered_by, is_heal_run) VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).run(
    projectId, 'bitbucket', pipelineUuid,
    `https://bitbucket.org/${bbWs}/${bbSlug}/pipelines/results/${pipelineUuid}`,
    'pending', scriptName,
    `Heal_${scriptFile?.replace(/\.jmx$/, '') || 'run'}`,
    JSON.stringify(healVars), userId, 1
  );
  console.log(`[CI Heal] Triggered heal pipeline ${pipelineUuid} (build #${pipelineBuildNum}), new ci_run #${healRunInsert.lastInsertRowid}`);
  return { ciRunId: healRunInsert.lastInsertRowid, pipelineUuid, authHeader, bbWs, bbSlug };
}

// Push fixed JMX to GitHub via Contents API and dispatch workflow_dispatch.
async function pushJmxAndTriggerGitHub(userId, projectId, originalCiRun, overrideVars = {}) {
  const adminRawCfg = await db.prepare(`
    SELECT cpc.* FROM ci_pipeline_configs cpc
    JOIN users u ON u.id = cpc.user_id
    WHERE cpc.project_id = ? AND u.role IN ('org_admin','super_admin')
    ORDER BY cpc.updated_at DESC LIMIT 1
  `).get(projectId);
  const userRawCfg = await db.prepare('SELECT * FROM ci_pipeline_configs WHERE project_id = ? AND user_id = ?').get(projectId, userId) || adminRawCfg;
  const adminCfg = decryptConfig(adminRawCfg);
  const userCfg  = decryptConfig(userRawCfg);

  const effectiveToken = userCfg?.github_token || adminCfg?.github_token || '';
  const githubRepo     = userCfg?.github_repo  || adminCfg?.github_repo  || '';
  if (!githubRepo || !effectiveToken) throw new Error('GitHub CI config incomplete');

  const gitCfg      = await db.prepare('SELECT * FROM git_configs WHERE project_id = ?').get(projectId);
  const baseBranch  = gitCfg?.base_branch || 'main';
  const workflowFile = userCfg?.github_workflow_file || adminCfg?.github_workflow_file || 'perf-test.yml';

  const ghHeaders = {
    Authorization: `token ${effectiveToken}`,
    'User-Agent': 'PerfStudio',
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  const origVars   = (() => { try { return JSON.parse(originalCiRun.variables || '{}'); } catch { return {}; } })();
  const mergedVars = { ...origVars, ...overrideVars };
  const targetRef  = origVars.branch || baseBranch;

  const scriptName    = originalCiRun.script_name || '';
  const scriptFile    = scriptName.replace(/\\/g, '/').split('/').pop() || 'test.jmx';
  const healCanonical = await buildCanonicalRepoPaths(projectId, scriptName);
  const jmxDiskPath   = healCanonical.jmxDiskPath;

  // Push fixed JMX to GitHub via Contents API
  if (jmxDiskPath && fs.existsSync(jmxDiskPath)) {
    const jmxContent    = fs.readFileSync(jmxDiskPath);
    const base64Content = jmxContent.toString('base64');
    const repoFilePath  = healCanonical.scriptRepoPath;
    // Get current SHA (required for updates; absent for new files)
    const shaResp = await apiRequest(
      `https://api.github.com/repos/${githubRepo}/contents/${repoFilePath}?ref=${encodeURIComponent(targetRef)}`,
      'GET', null, ghHeaders
    );
    const existingSha = shaResp.status === 200 ? shaResp.body?.sha : null;
    const commitBody = {
      message: `Peako Auto Heal: ${scriptFile} [heal]`,
      content: base64Content,
      branch: targetRef,
      ...(existingSha ? { sha: existingSha } : {}),
    };
    const pushResp = await apiRequest(
      `https://api.github.com/repos/${githubRepo}/contents/${repoFilePath}`,
      'PUT', commitBody, ghHeaders
    );
    if (pushResp.status !== 200 && pushResp.status !== 201) {
      throw new Error(`GitHub push failed ${pushResp.status}: ${typeof pushResp.body === 'string' ? pushResp.body.slice(0, 300) : JSON.stringify(pushResp.body).slice(0, 300)}`);
    }
    console.log(`[CI Heal] Pushed fixed JMX to GitHub ${githubRepo}/${targetRef}`);
  }

  // Dispatch workflow_dispatch (try filename → full path → numeric ID)
  const dispatchBody = {
    ref: baseBranch,
    inputs: {
      script_name:     scriptFile,
      script_path:     healCanonical.scriptRepoPath || '',
      jmeter_users:    String(mergedVars.jmeter_users    || mergedVars.JMETER_USERS    || HEAL_CI_VUSERS),
      jmeter_rampup:   String(mergedVars.jmeter_rampup   || mergedVars.JMETER_RAMPUP   || HEAL_CI_RAMPUP),
      jmeter_loops:    String(mergedVars.jmeter_loops    || mergedVars.JMETER_LOOPS    || '-1'),
      jmeter_duration: String(mergedVars.jmeter_duration || mergedVars.JMETER_DURATION || HEAL_CI_DURATION),
      branch:          targetRef,
    },
  };
  let r = await apiRequest(
    `https://api.github.com/repos/${githubRepo}/actions/workflows/${workflowFile}/dispatches`,
    'POST', dispatchBody, ghHeaders
  );
  if (r.status === 404) {
    r = await apiRequest(
      `https://api.github.com/repos/${githubRepo}/actions/workflows/.github%2Fworkflows%2F${workflowFile}/dispatches`,
      'POST', dispatchBody, ghHeaders
    );
  }
  if (r.status === 404) {
    const wfList = await apiRequest(`https://api.github.com/repos/${githubRepo}/actions/workflows`, 'GET', null, ghHeaders);
    const wf = (wfList.body?.workflows || []).find(w =>
      w.path === `.github/workflows/${workflowFile}` || w.name === 'PerfStudio Performance Test'
    );
    if (wf?.id) r = await apiRequest(`https://api.github.com/repos/${githubRepo}/actions/workflows/${wf.id}/dispatches`, 'POST', dispatchBody, ghHeaders);
  }
  if (r.status !== 204) throw new Error(`GitHub dispatch failed ${r.status}: ${typeof r.body === 'string' ? r.body.slice(0, 200) : JSON.stringify(r.body).slice(0, 200)}`);

  // Find the new workflow run (poll up to 5 × 2s)
  const dispatchedAt = new Date();
  let latestRun = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    const runsResp = await apiRequest(
      `https://api.github.com/repos/${githubRepo}/actions/runs?event=workflow_dispatch&per_page=5`,
      'GET', null, ghHeaders
    );
    const recentRun = (runsResp.body?.workflow_runs || []).find(wr => {
      const createdAt = new Date(wr.created_at);
      return createdAt >= new Date(dispatchedAt.getTime() - 5000);
    });
    if (recentRun) { latestRun = recentRun; break; }
  }
  if (!latestRun) throw new Error('GitHub: no new workflow run found after dispatch');

  const healVars = { ...mergedVars, branch: targetRef, github_run_number: latestRun.run_number };
  const healRunInsert = await db.prepare(
    'INSERT INTO ci_pipeline_runs (project_id, provider, external_id, web_url, status, script_name, run_name, variables, triggered_by, is_heal_run) VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).run(
    projectId, 'github', String(latestRun.id),
    latestRun.html_url || `https://github.com/${githubRepo}/actions`,
    'pending', scriptName,
    `Heal_${scriptFile.replace(/\.jmx$/, '')}`,
    JSON.stringify(healVars), userId, 1
  );
  console.log(`[CI Heal] GitHub heal workflow dispatched → run #${latestRun.id}, ci_run #${healRunInsert.lastInsertRowid}`);
  return { ciRunId: healRunInsert.lastInsertRowid, ghRunId: latestRun.id, githubRepo, authHeader: `token ${effectiveToken}` };
}

async function pollGitHubUntilDone(githubRepo, ghRunId, authHeader, maxWaitMs = 35 * 60 * 1000) {
  const POLL_MS = 15_000;
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_MS));
    try {
      const resp = await apiRequest(
        `https://api.github.com/repos/${githubRepo}/actions/runs/${ghRunId}`,
        'GET', null,
        { Authorization: authHeader, 'User-Agent': 'PerfStudio', Accept: 'application/vnd.github+json' }
      );
      if (resp.body?.status === 'completed') {
        const success = resp.body.conclusion === 'success';
        return { done: true, success, result: resp.body.conclusion };
      }
    } catch (e) {
      console.warn('[CI Heal] GitHub poll error:', e.message);
    }
  }
  return { done: false, success: false, result: 'TIMEOUT' };
}

// Provider-aware wrappers used by healCycleCI
// Supported: github, bitbucket. Stubs for gitlab, azuredevops, circleci — implement when those providers are added.
async function pushJmxAndTrigger(userId, projectId, originalCiRun, overrideVars = {}) {
  const provider = originalCiRun.provider || 'bitbucket';
  if (provider === 'github')      return pushJmxAndTriggerGitHub(userId, projectId, originalCiRun, overrideVars);
  if (provider === 'bitbucket')   return pushJmxAndTriggerBitbucket(userId, projectId, originalCiRun, overrideVars);
  if (provider === 'gitlab')      throw new Error('GitLab auto-heal trigger not yet implemented');
  if (provider === 'azuredevops') throw new Error('Azure DevOps auto-heal trigger not yet implemented');
  if (provider === 'circleci')    throw new Error('CircleCI auto-heal trigger not yet implemented');
  throw new Error(`Unknown CI provider "${provider}" — auto-heal trigger not implemented`);
}

async function pollCiUntilDone(provider, triggerResult, maxWaitMs) {
  if (provider === 'github')      return pollGitHubUntilDone(triggerResult.githubRepo, triggerResult.ghRunId, triggerResult.authHeader, maxWaitMs);
  if (provider === 'bitbucket')   return pollBitbucketUntilDone(triggerResult.bbWs, triggerResult.bbSlug, triggerResult.pipelineUuid, triggerResult.authHeader, maxWaitMs);
  if (provider === 'gitlab')      throw new Error('GitLab auto-heal polling not yet implemented');
  if (provider === 'azuredevops') throw new Error('Azure DevOps auto-heal polling not yet implemented');
  if (provider === 'circleci')    throw new Error('CircleCI auto-heal polling not yet implemented');
  throw new Error(`Unknown CI provider "${provider}" — auto-heal polling not implemented`);
}

async function healCycleCI(userId, ciRunId, projectId, options, attemptNum, sessionStart) {
  const { buildContext, diagnoseWithAi, classifyErrors, applyEndpointOverrides } = require('../utils/autoHealer');
  // sessionStart is the first attemptNum of this session; limit retries per session not globally
  if (sessionStart === undefined) sessionStart = attemptNum;
  if (attemptNum > sessionStart + HEAL_CI_MAX_ATTEMPTS - 1) {
    setCiHealStatus(ciRunId, 'exhausted');
    return;
  }

  setCiHealStatus(ciRunId, 'diagnosing');

  const ciRun  = await db.prepare('SELECT * FROM ci_pipeline_runs WHERE id = ?').get(ciRunId);
  const execRun = await db.prepare('SELECT * FROM execution_runs WHERE ci_run_id = ? ORDER BY id DESC LIMIT 1').get(ciRunId);
  if (!execRun || !execRun.result_dir) {
    console.warn(`[CI Heal] No execution_run for CI run #${ciRunId}`);
    const lid = await logCiHealAttempt(ciRunId, attemptNum,
      `Could not start diagnosis — no synced results found for this CI run. Try "Sync Results" first, then Heal again.`, '', 'no_fix');
    await db.prepare('UPDATE ci_auto_heal_logs SET result=? WHERE id=?').run('failed', lid);
    setCiHealStatus(ciRunId, 'failed');
    return;
  }

  const scriptFile = (ciRun?.script_name || '').replace(/\\/g, '/').split('/').pop();
  const suite = scriptFile
    ? await db.prepare("SELECT * FROM test_suites WHERE project_id = ? AND (jmx_path LIKE ? OR js_path LIKE ?) LIMIT 1")
        .get(projectId, `%${scriptFile}`, `%${scriptFile}`)
    : null;
  if (!suite) {
    console.warn(`[CI Heal] No test suite for script "${ciRun?.script_name}"`);
    const lid = await logCiHealAttempt(ciRunId, attemptNum,
      `Could not find the test plan for script "${ciRun?.script_name || '(unknown)'}" — it may have been deleted or renamed since this CI run was triggered.`, '', 'no_fix');
    await db.prepare('UPDATE ci_auto_heal_logs SET result=? WHERE id=?').run('failed', lid);
    setCiHealStatus(ciRunId, 'failed');
    return;
  }

  let ctx;
  try { ctx = await buildContext(execRun, suite); }
  catch (e) {
    console.error('[CI Heal] buildContext error:', e.message);
    const lid = await logCiHealAttempt(ciRunId, attemptNum, `Failed to analyze the run: ${e.message}`, '', 'no_fix');
    await db.prepare('UPDATE ci_auto_heal_logs SET result=? WHERE id=?').run('failed', lid);
    setCiHealStatus(ciRunId, 'failed');
    return;
  }

  if (!ctx.hasErrors) { setCiHealStatus(ciRunId, null); return; }

  if (ctx.errorClass.isInfra) {
    const lid = await logCiHealAttempt(ciRunId, attemptNum, `Infrastructure/server failure: ${ctx.errorClass.summary}`, '', 'no_fix');
    await db.prepare('UPDATE ci_auto_heal_logs SET result=? WHERE id=?').run('infra_error', lid);
    setCiHealStatus(ciRunId, 'infra_error');
    return;
  }

  // A transient AI failure (network blip, truncated response, malformed JSON) shouldn't
  // burn the whole heal session on attempt 1 — retry like any other "still_failing" case,
  // up to the same attempt budget, instead of giving up immediately.
  const retryOrGiveUp = async (giveUpStatus) => {
    if (attemptNum < sessionStart + HEAL_CI_MAX_ATTEMPTS - 1) {
      return healCycleCI(userId, ciRunId, projectId, options, attemptNum + 1, sessionStart);
    }
    await setCiHealStatus(ciRunId, giveUpStatus);
  };

  let aiResp;
  try {
    aiResp = await diagnoseWithAi(userId, execRun, suite, ctx, attemptNum, options.customInstruction || null);
  } catch (e) {
    const lid = await logCiHealAttempt(ciRunId, attemptNum, `AI error: ${e.message}`, '', 'no_fix');
    await db.prepare('UPDATE ci_auto_heal_logs SET result=? WHERE id=?').run('failed', lid);
    return retryOrGiveUp('exhausted');
  }

  const lid = await logCiHealAttempt(ciRunId, attemptNum, aiResp.issue || 'Unknown issue', aiResp.fix || '', aiResp.fix_type || 'no_fix');

  const isEndpointPatch = aiResp.fix_type === 'endpoint_overrides' && aiResp.overrides?.length;
  if (aiResp.fix_type !== 'script_rewrite' && !isEndpointPatch) {
    await db.prepare('UPDATE ci_auto_heal_logs SET result=? WHERE id=?').run('no_fix', lid);
    return retryOrGiveUp('exhausted');
  }
  if (aiResp.fix_type === 'script_rewrite' && !aiResp.fixed_script) {
    await db.prepare('UPDATE ci_auto_heal_logs SET result=? WHERE id=?').run('no_fix', lid);
    return retryOrGiveUp('exhausted');
  }

  // Apply fix to the local JMX file
  setCiHealStatus(ciRunId, 'applying_fix');
  const jmxPath = suite.jmx_path || suite.js_path;
  try {
    if (isEndpointPatch) {
      if (jmxPath && fs.existsSync(jmxPath)) fs.copyFileSync(jmxPath, jmxPath + '.bak');
      const applied = await applyEndpointOverrides(userId, projectId, suite, aiResp.overrides);
      if (!applied) throw new Error('None of the proposed overrides matched a real endpoint by name.');
    } else {
      if (jmxPath && fs.existsSync(jmxPath)) fs.copyFileSync(jmxPath, jmxPath + '.bak');
      if (jmxPath) fs.writeFileSync(jmxPath, aiResp.fixed_script, 'utf8');
    }
  } catch (e) {
    await db.prepare('UPDATE ci_auto_heal_logs SET result=? WHERE id=?').run('failed', lid);
    setCiHealStatus(ciRunId, 'failed');
    return;
  }

  // ── Phase 1: Quick verify (1 VUser × 1 loop) ──────────────────────────────
  setCiHealStatus(ciRunId, 'rerunning');
  let quickResult;
  try {
    quickResult = await pushJmxAndTrigger(userId, projectId, ciRun, {
      jmeter_users:    String(HEAL_CI_VUSERS),
      jmeter_rampup:   String(HEAL_CI_RAMPUP),
      jmeter_duration: String(HEAL_CI_DURATION),
      jmeter_loops:    String(HEAL_CI_LOOPS),
    });
  } catch (e) {
    console.error('[CI Heal] Phase 1 trigger error:', e.message);
    await db.prepare('UPDATE ci_auto_heal_logs SET result=? WHERE id=?').run('failed', lid);
    setCiHealStatus(ciRunId, 'failed');
    return;
  }

  const quickCiRunId = quickResult.ciRunId;
  await db.prepare('UPDATE ci_pipeline_runs SET heal_ci_run_id=? WHERE id=?').run(quickCiRunId, ciRunId);
  await db.prepare('UPDATE ci_auto_heal_logs SET new_ci_run_id=? WHERE id=?').run(quickCiRunId, lid);

  const quickPoll = await pollCiUntilDone(ciRun.provider, quickResult, 5 * 60 * 1000);
  await db.prepare('UPDATE ci_pipeline_runs SET status=? WHERE id=?').run(
    quickPoll.done ? (quickPoll.success ? 'completed' : 'failed') : 'failed', quickCiRunId
  );

  if (quickPoll.done && !ciSyncInProgress.has(quickCiRunId)) {
    ciSyncInProgress.add(quickCiRunId);
    try {
      const quickCiRow = await db.prepare('SELECT * FROM ci_pipeline_runs WHERE id = ?').get(quickCiRunId);
      const quickCfg   = decryptConfig(await getConfig(projectId, userId));
      await autoSyncCiRun(quickCiRow, quickCfg, projectId, userId);
    } catch (e) { console.warn('[CI Heal] quick sync error:', e.message); }
    finally { ciSyncInProgress.delete(quickCiRunId); }
  }

  // Guarantee execution_runs exists for quickCiRunId so the next attempt can read context.
  // If autoSyncCiRun failed (JTL missing, wrong path, etc.) create a minimal fallback record.
  const quickExecCheck = await db.prepare('SELECT id FROM execution_runs WHERE ci_run_id = ?').get(quickCiRunId);
  if (!quickExecCheck) {
    const fallbackDir = path.join(os.tmpdir(), `ci_heal_nojtl_${quickCiRunId}`);
    try { fs.mkdirSync(fallbackDir, { recursive: true }); } catch (_) {}
    const quickCiRunRow = await db.prepare('SELECT * FROM ci_pipeline_runs WHERE id = ?').get(quickCiRunId);
    const quickScriptFile2 = (quickCiRunRow?.script_name || '').replace(/\\/g, '/').split('/').pop();
    const quickSuite2 = quickScriptFile2
      ? await db.prepare("SELECT id FROM test_suites WHERE project_id = ? AND (jmx_path LIKE ? OR js_path LIKE ?) LIMIT 1").get(projectId, `%${quickScriptFile2}`, `%${quickScriptFile2}`)
      : null;
    await db.prepare(`
      INSERT INTO execution_runs (project_id, suite_id, engine, status, result_dir, logs, started_at, finished_at, ci_run_id)
      VALUES (?, ?, 'jmeter', 'failed', ?, ?, NOW(), NOW(), ?)
    `).run(
      projectId, quickSuite2?.id || null, fallbackDir,
      JSON.stringify([{ type: 'error', message: `Heal pipeline run ${quickCiRunId} failed — results not uploaded. Re-attempting fix.` }]),
      quickCiRunId
    );
    console.log(`[CI Heal] Created fallback execRun for heal run #${quickCiRunId}`);
  }

  const quickExecRun = await db.prepare('SELECT * FROM execution_runs WHERE ci_run_id = ? ORDER BY id DESC LIMIT 1').get(quickCiRunId);
  const quickTotal   = (() => { try { return JSON.parse(quickExecRun?.report_data || 'null')?.summary?.total_requests || 0; } catch { return 0; } })();
  const quickPassed  = quickPoll.success && quickExecRun?.status === 'completed' && quickTotal > 0;

  if (!quickPassed) {
    await db.prepare('UPDATE ci_auto_heal_logs SET result=? WHERE id=?').run('still_failing', lid);
    if (attemptNum < sessionStart + HEAL_CI_MAX_ATTEMPTS - 1) {
      await healCycleCI(userId, quickCiRunId, projectId, options, attemptNum + 1, sessionStart);
      const latest = await db.prepare('SELECT heal_status FROM ci_pipeline_runs WHERE id = ?').get(quickCiRunId);
      if (latest?.heal_status) setCiHealStatus(ciRunId, latest.heal_status);
    } else {
      setCiHealStatus(ciRunId, 'exhausted');
    }
    return;
  }

  // ── Phase 2: Full run with original params ────────────────────────────────
  setCiHealStatus(ciRunId, 'rerunning_full');
  const origVarsForFull = (() => { try { return JSON.parse(ciRun.variables || '{}'); } catch { return {}; } })();
  let fullResult;
  try {
    fullResult = await pushJmxAndTrigger(userId, projectId, ciRun, origVarsForFull);
  } catch (e) {
    // Quick passed — still count as healed
    await db.prepare('UPDATE ci_auto_heal_logs SET result=? WHERE id=?').run('healed', lid);
    setCiHealStatus(ciRunId, 'healed');
    return;
  }

  const fullCiRunId = fullResult.ciRunId;
  await db.prepare('UPDATE ci_pipeline_runs SET heal_ci_run_id=? WHERE id=?').run(fullCiRunId, ciRunId);

  const origDurationS = parseInt(origVarsForFull.jmeter_duration || '300', 10);
  const fullMaxWaitMs = Math.max(20 * 60 * 1000, origDurationS * 3 * 1000 + 5 * 60 * 1000);
  const fullPoll = await pollCiUntilDone(ciRun.provider, fullResult, fullMaxWaitMs);
  await db.prepare('UPDATE ci_pipeline_runs SET status=? WHERE id=?').run(
    fullPoll.done ? (fullPoll.success ? 'completed' : 'failed') : 'failed', fullCiRunId
  );

  if (fullPoll.done && !ciSyncInProgress.has(fullCiRunId)) {
    ciSyncInProgress.add(fullCiRunId);
    try {
      const fullCiRow = await db.prepare('SELECT * FROM ci_pipeline_runs WHERE id = ?').get(fullCiRunId);
      const fullCfg   = decryptConfig(await getConfig(projectId, userId));
      await autoSyncCiRun(fullCiRow, fullCfg, projectId, userId);
    } catch (e) { console.warn('[CI Heal] full sync error:', e.message); }
    finally { ciSyncInProgress.delete(fullCiRunId); }
  }

  // Guarantee execution_runs for fullCiRunId before any retry
  const fullExecCheck = await db.prepare('SELECT id FROM execution_runs WHERE ci_run_id = ?').get(fullCiRunId);
  if (!fullExecCheck) {
    const fallbackDir2 = path.join(os.tmpdir(), `ci_heal_nojtl_${fullCiRunId}`);
    try { fs.mkdirSync(fallbackDir2, { recursive: true }); } catch (_) {}
    const fullCiRunRow = await db.prepare('SELECT * FROM ci_pipeline_runs WHERE id = ?').get(fullCiRunId);
    const fullScriptFile2 = (fullCiRunRow?.script_name || '').replace(/\\/g, '/').split('/').pop();
    const fullSuite2 = fullScriptFile2
      ? await db.prepare("SELECT id FROM test_suites WHERE project_id = ? AND (jmx_path LIKE ? OR js_path LIKE ?) LIMIT 1").get(projectId, `%${fullScriptFile2}`, `%${fullScriptFile2}`)
      : null;
    await db.prepare(`
      INSERT INTO execution_runs (project_id, suite_id, engine, status, result_dir, logs, started_at, finished_at, ci_run_id)
      VALUES (?, ?, 'jmeter', 'failed', ?, ?, NOW(), NOW(), ?)
    `).run(
      projectId, fullSuite2?.id || null, fallbackDir2,
      JSON.stringify([{ type: 'error', message: `Full heal pipeline run ${fullCiRunId} failed — results not uploaded.` }]),
      fullCiRunId
    );
  }

  const fullExecRun = await db.prepare('SELECT * FROM execution_runs WHERE ci_run_id = ? ORDER BY id DESC LIMIT 1').get(fullCiRunId);
  const fullTotal   = (() => { try { return JSON.parse(fullExecRun?.report_data || 'null')?.summary?.total_requests || 0; } catch { return 0; } })();
  const fullPassed  = fullPoll.success && fullExecRun?.status === 'completed' && fullTotal > 0;

  if (fullPassed) {
    await db.prepare('UPDATE ci_auto_heal_logs SET result=? WHERE id=?').run('healed', lid);
    setCiHealStatus(ciRunId, 'healed');
  } else {
    await db.prepare('UPDATE ci_auto_heal_logs SET result=? WHERE id=?').run('still_failing', lid);
    if (attemptNum < sessionStart + HEAL_CI_MAX_ATTEMPTS - 1) {
      await healCycleCI(userId, fullCiRunId, projectId, options, attemptNum + 1, sessionStart);
      const latest = await db.prepare('SELECT heal_status FROM ci_pipeline_runs WHERE id = ?').get(fullCiRunId);
      if (latest?.heal_status) setCiHealStatus(ciRunId, latest.heal_status);
    } else {
      setCiHealStatus(ciRunId, 'exhausted');
    }
  }
}

async function startAutoHealCI(userId, ciRunId, projectId, options = {}) {
  const ciRun = await db.prepare('SELECT id FROM ci_pipeline_runs WHERE id = ?').get(ciRunId);
  if (!ciRun) { console.warn(`[CI Heal] CI run ${ciRunId} not found`); return; }
  setCiHealStatus(ciRunId, 'pending');
  // Continue attempt numbering across sessions so logs show Attempt 1, 2, 3… globally
  const prevAttempts = (await db.prepare('SELECT COUNT(*) AS cnt FROM ci_auto_heal_logs WHERE ci_run_id = ?').get(ciRunId))?.cnt || 0;
  const startAttempt = prevAttempts + 1;
  setImmediate(async () => {
    try {
      await healCycleCI(userId, ciRunId, projectId, options, startAttempt);
    } catch (e) {
      console.error('[CI Heal] Unexpected error:', e.message);
      setCiHealStatus(ciRunId, 'failed');
    }
  });
}

// ── POST /runs/:runId/heal ─────────────────────────────────────────────────────
router.post('/runs/:runId/heal', async (req, res) => {
  if (!await ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });

  const run = await db.prepare('SELECT * FROM ci_pipeline_runs WHERE id = ? AND project_id = ?')
    .get(req.params.runId, req.params.projectId);
  if (!run) return res.status(404).json({ error: 'CI run not found' });

  let execRun = await db.prepare('SELECT id FROM execution_runs WHERE ci_run_id = ?').get(run.id);
  if (!execRun) {
    // No synced results — create a minimal execution_runs record so healCycleCI can proceed.
    // The AI healer reads the JMX file directly from the test suite; an empty result_dir is fine.
    const scriptFile = (run.script_name || '').replace(/\\/g, '/').split('/').pop();
    const suiteRow = scriptFile
      ? await db.prepare("SELECT id FROM test_suites WHERE project_id = ? AND (jmx_path LIKE ? OR js_path LIKE ?) LIMIT 1")
          .get(run.project_id, `%${scriptFile}`, `%${scriptFile}`)
      : null;
    const resultDir = path.join(os.tmpdir(), `ci_heal_nojtl_${run.id}`);
    fs.mkdirSync(resultDir, { recursive: true });
    await db.prepare(`
      INSERT INTO execution_runs (project_id, suite_id, engine, status, result_dir, report_path, logs, started_at, finished_at, report_data, ci_run_id)
      VALUES (?, ?, 'jmeter', 'failed', ?, NULL, ?, ?, NOW(), NULL, ?)
    `).run(
      run.project_id, suiteRow?.id || null, resultDir,
      JSON.stringify([{ type: 'error', message: `CI pipeline run failed on ${run.provider}. No results were uploaded. Heal triggered manually.` }]),
      run.started_at || new Date().toISOString(),
      run.id
    );
    execRun = await db.prepare('SELECT id FROM execution_runs WHERE ci_run_id = ?').get(run.id);
  }
  if (!execRun) return res.status(400).json({ error: 'Run not synced yet — sync results first, then start heal.' });

  const { instruction = '' } = req.body;

  const alreadyRunning = ['pending', 'diagnosing', 'applying_fix', 'rerunning', 'rerunning_full'].includes(run.heal_status);
  if (alreadyRunning) return res.status(400).json({ error: 'Heal already in progress for this run.' });

  const customInstruction = instruction.trim() || null;
  startAutoHealCI(req.userId, run.id, req.params.projectId, {
    mode: customInstruction ? 'custom' : 'auto',
    customInstruction,
  });

  res.json({ ok: true, message: 'CI auto heal started' });
});

// ── GET /runs/:runId/heal-status ──────────────────────────────────────────────
router.get('/runs/:runId/heal-status', async (req, res) => {
  if (!await ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });

  const run = await db.prepare('SELECT heal_status, heal_ci_run_id, heal_summary FROM ci_pipeline_runs WHERE id = ? AND project_id = ?')
    .get(req.params.runId, req.params.projectId);
  if (!run) return res.status(404).json({ error: 'CI run not found' });

  const logs = await db.prepare('SELECT * FROM ci_auto_heal_logs WHERE ci_run_id = ? ORDER BY attempt ASC').all(req.params.runId);
  res.json({ status: run.heal_status, heal_ci_run_id: run.heal_ci_run_id, logs, heal_summary: run.heal_summary || null });
});

module.exports = router;
