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

router.use(auth);

// ── helpers ───────────────────────────────────────────────────────────────────

// Per-user CI config: first try (project_id, user_id), fall back to legacy (project_id, NULL)
function getConfig(projectId, userId) {
  if (userId) {
    const own = db.prepare('SELECT * FROM ci_pipeline_configs WHERE project_id = ? AND user_id = ?').get(projectId, userId);
    if (own) return own;
    // Fall back to the project admin's config so regular users inherit SSH keys/tokens set up at admin level
    const adminCfg = db.prepare(`
      SELECT cpc.* FROM ci_pipeline_configs cpc
      JOIN users u ON u.id = cpc.user_id
      WHERE cpc.project_id = ? AND u.role IN ('org_admin','super_admin')
      ORDER BY cpc.updated_at DESC LIMIT 1
    `).get(projectId);
    if (adminCfg) return adminCfg;
  }
  // Legacy shared config (user_id IS NULL)
  return db.prepare('SELECT * FROM ci_pipeline_configs WHERE project_id = ? AND user_id IS NULL').get(projectId) || null;
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

// ── Helper: parse "owner/repo" from any GitHub remote URL ────────────────────
function parseOwnerRepo(url) {
  if (!url) return '';
  // HTTPS: https://github.com/owner/repo.git  (may have token@ prefix)
  const m = url.match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?(?:\s|$)/);
  return m ? m[1] : '';
}

// ── Helper: get github_repo from git config remote URL (fallback) ─────────────
function getRepoFromGit(projectId) {
  const gitCfg = db.prepare('SELECT remote_url FROM git_configs WHERE project_id = ?').get(projectId);
  return gitCfg?.remote_url ? parseOwnerRepo(gitCfg.remote_url) : '';
}

// ── Helper: extract PAT from the git remote URL (ghp_... embedded in URL) ─────
function getTokenFromGitRemote(projectId) {
  try {
    const { GIT_WORKSPACES_ROOT, cleanName } = require('../utils/projectFolders');
    const proj = db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId);
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
router.get('/config', (req, res) => {
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const cfg = getConfig(req.params.projectId, req.userId);
  if (!cfg) return res.json({ config: null });

  // Auto-derive github_repo from the project's git remote URL if the stored
  // value is missing or invalid (e.g. user accidentally entered their email).
  let github_repo = sanitizeGithubRepo(cfg.github_repo);
  if (!github_repo) github_repo = getRepoFromGit(req.params.projectId);

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
function isProjectOwner(userId, projectId) {
  const proj = db.prepare('SELECT user_id FROM projects WHERE id = ?').get(projectId);
  return proj && String(proj.user_id) === String(userId);
}

// ── PUT /config ───────────────────────────────────────────────────────────────
router.put('/config', (req, res) => {
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
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
    || getRepoFromGit(req.params.projectId);

  // Look up THIS user's own config row (project_id + user_id)
  const existing = db.prepare('SELECT * FROM ci_pipeline_configs WHERE project_id = ? AND user_id = ?').get(req.params.projectId, req.userId);
  const gitCfgDefault = db.prepare('SELECT base_branch FROM git_configs WHERE project_id = ?').get(req.params.projectId);
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
    db.prepare(`UPDATE ci_pipeline_configs SET
      gitlab_enabled=?, gitlab_url=?, gitlab_project_id=?, gitlab_token=?,
      gitlab_trigger_token=?, gitlab_ref=?, gitlab_auth_method=?,
      github_enabled=?, github_repo=?, github_token=?, github_workflow_file=?, github_ref=?, github_auth_method=?,
      bitbucket_enabled=?, bitbucket_workspace=?, bitbucket_username=?, bitbucket_app_password=?, bitbucket_repo_slug=?, bitbucket_ref=?, bitbucket_auth_method=?,
      ssh_private_key=?, updated_at=datetime('now')
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
    db.prepare(`INSERT INTO ci_pipeline_configs
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
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const { provider } = req.body;
  const cfg = decryptConfig(getConfig(req.params.projectId, req.userId));
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
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const cfg = decryptConfig(getConfig(req.params.projectId, req.userId));
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
      db.prepare('UPDATE ci_pipeline_configs SET gitlab_trigger_token=? WHERE project_id=?')
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
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const cfg     = decryptConfig(getConfig(req.params.projectId, req.userId));
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { providers = ['gitlab', 'github'] } = req.body;

  // Docker image — read from user's global config, fall back to admin's config, then default
  const globalCfgRow = db.prepare('SELECT config_json FROM global_config WHERE user_id = ?').get(req.userId);
  const globalCfgAdmin = !globalCfgRow
    ? db.prepare(`SELECT gc.config_json FROM global_config gc JOIN users u ON u.id = gc.user_id WHERE u.role IN ('org_admin','super_admin') ORDER BY gc.user_id LIMIT 1`).get()
    : null;
  const globalCfg = JSON.parse((globalCfgRow || globalCfgAdmin)?.config_json || '{}');
  const dockerImage = (globalCfg.jmeter_docker_image || 'tasleemzaif/perfstudio:latest').trim().toLowerCase();

  // Use per-project workspace (new structure: git-workspaces/<ProjectName>/admin/)
  const callerRow = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  const isAdmin   = ['org_admin', 'super_admin'].includes(callerRow?.role);
  const { GIT_WORKSPACES_ROOT, cleanName, resolveUserFolder } = require('../utils/projectFolders');
  const userFolder   = resolveUserFolder(req.userId);
  const cleanProject = (project.name || '').replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  const gitRoot      = path.join(GIT_WORKSPACES_ROOT, cleanProject, userFolder);
  fs.mkdirSync(gitRoot, { recursive: true });

  // Get all generated test plans for this project to include as YAML comments
  const suites = db.prepare("SELECT * FROM test_suites WHERE project_id = ? AND (jmx_path IS NOT NULL OR js_path IS NOT NULL)").all(req.params.projectId);

  const gitCfgBase = db.prepare('SELECT base_branch FROM git_configs WHERE project_id = ?').get(req.params.projectId);
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
  artifacts:
    paths:
      - reports/
    expire_in: 7 days
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
    const userBranch = cfg?.github_ref || (isAdmin ? baseBranch : `feature/${(callerRow?.name || 'user').toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`);

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
            - apk add --no-cache curl zip bash
            - PIPELINE_ID=$(echo "$BITBUCKET_PIPELINE_UUID" | tr -d '{}')
            - echo "Peako Performance Test"
            - echo "Script    | $SCRIPT_NAME"
            - echo "VUsers    | $JMETER_USERS"
            - echo "Ramp-up   | $JMETER_RAMPUP s"
            - echo "Duration  | $JMETER_DURATION s"
            - |
              docker run --rm \\
                -e JVM_ARGS="-Dlog4j2.formatMsgNoLookups=true" \\
                -v "$BITBUCKET_CLONE_DIR:/workspace" \\
                ${dockerImage} \\
                jmeter \\
                -n -t "/workspace/\${SCRIPT_PATH:-\$SCRIPT_NAME}" \\
                -Jusers="$JMETER_USERS" \\
                -Jrampup="$JMETER_RAMPUP" \\
                -Jloops="$JMETER_LOOPS" \\
                -Jduration="$JMETER_DURATION" \\
                -l "/workspace/results.jtl" \\
                -e -o "/workspace/html"
            - cd "$BITBUCKET_CLONE_DIR" && zip -r "perf-results-\${PIPELINE_ID}.zip" results.jtl html/ 2>/dev/null || true
            - |
              if [ -n "$BB_USERNAME" ] && [ -n "$BB_APP_PASSWORD" ]; then
                curl -s -X POST \\
                  "https://api.bitbucket.org/2.0/repositories/$BITBUCKET_REPO_FULL_NAME/downloads" \\
                  -u "$BB_USERNAME:$BB_APP_PASSWORD" \\
                  -F "files=@perf-results-\${PIPELINE_ID}.zip" || echo "Upload to Bitbucket Downloads failed (non-fatal)"
              else
                echo "Skipping Bitbucket Downloads upload — BB_USERNAME / BB_APP_PASSWORD not set as repo variables"
              fi
`;
    try {
      const dest = path.join(gitRoot, 'bitbucket-pipelines.yml');
      fs.writeFileSync(dest, bbYaml, 'utf8');
      created.push('bitbucket-pipelines.yml');
    } catch (e) { errors.push(`bitbucket-pipelines.yml: ${e.message}`); }
  }

  if (created.length === 0) return res.status(500).json({ error: errors.join('; ') || 'Nothing generated' });

  // Auto-commit and push to remote so the workflow is immediately available on GitHub.
  // The perf-test.yml MUST be on the remote default branch (main) for workflow_dispatch to work.
  let pushMessage = '';
  try {
    const gitCfg = db.prepare('SELECT * FROM git_configs WHERE project_id = ?').get(req.params.projectId);
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
        const userIdentity = db.prepare('SELECT auth_token FROM user_git_configs WHERE user_id = ? AND project_id = ?')
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
            remoteUrl = gitCfg.remote_url.replace(/^(https?:\/\/)[^@]*@?/, `$1${encodeURIComponent(rawToken)}@`);
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
        gitRun(['remote', 'set-url', 'origin', remoteUrl]);
        try { gitRun(['checkout', autoCommitBranch]); } catch {}

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

  res.json({ ok: true, created, errors, message: `Generated: ${created.join(', ')}.${pushMessage}` });
});

// ── POST /trigger — trigger pipeline on GitLab or GitHub ─────────────────────
router.post('/trigger', async (req, res) => {
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  // Workspace/repo/ref are project-level settings — always from the admin's config.
  // Auth credentials (token, username/email) come from the triggering user's own config,
  // falling back to the admin's config if the user hasn't set their own.
  const adminRawCfg = db.prepare(`
    SELECT cpc.* FROM ci_pipeline_configs cpc
    JOIN users u ON u.id = cpc.user_id
    WHERE cpc.project_id = ? AND u.role IN ('org_admin','super_admin')
    ORDER BY cpc.updated_at DESC LIMIT 1
  `).get(req.params.projectId);
  const userRawCfg  = getConfig(req.params.projectId, req.userId);
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

  const { provider, script_name, script_path, jmeter_users, jmeter_rampup, jmeter_loops, jmeter_duration } = req.body;
  if (!provider) return res.status(400).json({ error: 'provider required (gitlab or github)' });

  // Build human-readable run_name: {SuiteName}_{N}Users_{D}sDuration (no Run# yet — added on sync)
  const { buildRunDirName } = require('../utils/buildRunName');
  const scriptFile2 = (script_name || '').replace(/\\/g, '/').split('/').pop();
  const matchedSuite2 = db.prepare("SELECT name FROM test_suites WHERE project_id = ? AND (jmx_path LIKE ? OR js_path LIKE ?) LIMIT 1")
    .get(req.params.projectId, `%${scriptFile2}`, `%${scriptFile2}`);
  const ciRunDisplayName = buildRunDirName(
    matchedSuite2?.name || scriptFile2.replace(/\.jmx$|\.js$/, ''),
    jmeter_users, 'duration', jmeter_loops, jmeter_duration, ''
  ).replace(/_Run$/, ''); // strip trailing _Run (no seq# at trigger time)

  // Token priority for CI triggers:
  // 1. CI config token (saved specifically for CI/CD under Configuration → Pipeline)
  // 2. User's Git Identity PAT as fallback
  // The CI config token should have both `repo` + `workflow` scopes.
  const userIdentity = db.prepare('SELECT auth_token FROM user_git_configs WHERE user_id = ? AND project_id = ?')
    .get(req.userId, req.params.projectId);
  const userToken = userIdentity?.auth_token ? decrypt(userIdentity.auth_token) : null;

  const effectiveGithubToken = cfg.github_token || userToken || getTokenFromGitRemote(req.params.projectId);
  const effectiveGitlabToken = cfg.gitlab_token || cfg.gitlab_trigger_token || userToken;

  const variables = { script_name, script_path: script_path || '', jmeter_users: String(jmeter_users || 10), jmeter_rampup: String(jmeter_rampup || 30), jmeter_loops: String(jmeter_loops || 1), jmeter_duration: String(jmeter_duration || 300) };

  // ── Compute targetRef here so it is in scope for both auto-push and dispatch ─
  const callerRow2  = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  const isAdmin2    = ['org_admin', 'super_admin'].includes(callerRow2?.role);
  const gitCfgTrigger = db.prepare('SELECT base_branch FROM git_configs WHERE project_id = ?').get(req.params.projectId);
  const baseBranch2 = gitCfgTrigger?.base_branch || 'main';
  const targetRef   = provider === 'gitlab'
    ? (cfg.gitlab_ref || baseBranch2)
    : provider === 'bitbucket'
    ? (cfg.bitbucket_ref || baseBranch2)
    : (cfg.github_ref || (isAdmin2 ? baseBranch2 : `users/${(callerRow2?.name || '').toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`));

  // ── Auto-push script file to the target branch before dispatching ──────────
  // The CI runner checks out this branch — the JMX file must exist there or
  // the Patch JMX step will fail with FileNotFoundError.
  try {
    const { GIT_WORKSPACES_ROOT, cleanName, resolveUserFolder: resolveUF } = require('../utils/projectFolders');
    const projectRow = db.prepare('SELECT name FROM projects WHERE id = ?').get(req.params.projectId);
    const gitCfg = db.prepare('SELECT * FROM git_configs WHERE project_id = ?').get(req.params.projectId);
    // Always use the project's initialized git_root (set by admin) for auto-push,
    // not the triggering user's workspace — the user's workspace may lack .git.
    const wsRoot = (gitCfg?.git_root && fs.existsSync(path.join(gitCfg.git_root, '.git')))
      ? gitCfg.git_root
      : path.join(GIT_WORKSPACES_ROOT, cleanName(projectRow?.name || ''), resolveUF(req.userId));

    if (gitCfg?.is_initialized && fs.existsSync(path.join(wsRoot, '.git'))) {
      const simpleGit2 = require('simple-git');
      const NO_PROMPT2 = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', GIT_SSH_ASKPASS: 'echo', GCM_INTERACTIVE: 'never', GCM_NO_INTERACTIVE: '1', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '' };

      // Build authenticated remote URL based on provider
      let authUrl = gitCfg.remote_url;
      if (provider === 'bitbucket') {
        // Bitbucket personal API tokens (ATATT) use username:token — same as the
        // App Passwords they replaced. Username comes from the stored remote URL
        // (e.g. https://tasleema85@bitbucket.org/...) or the username field.
        const bbPass = cfg.bitbucket_app_password;
        if (bbPass) {
          const embMatch2 = gitCfg.remote_url.match(/^https?:\/\/([^:@]+)@/);
          const bbUser2 = gitCfg.username || (embMatch2 ? embMatch2[1] : null);
          const base2 = gitCfg.remote_url.replace(/^(https?:\/\/)[^@]*@?/, '$1');
          authUrl = bbUser2
            ? base2.replace(/^(https?:\/\/)/, `$1${encodeURIComponent(bbUser2)}:${encodeURIComponent(bbPass)}@`)
            : base2.replace(/^(https?:\/\/)/, `$1x-token-auth:${encodeURIComponent(bbPass)}@`);
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
      try { await git2.raw(['merge', '--ff-only', `origin/${targetRef}`]); } catch {}
      try { await git2.raw(['reset', '--hard', `origin/${targetRef}`]); } catch {}

      // Copy the JMX/JS file into the workspace if it only exists in admin workspace.
      // Look up the absolute path from test_suites (jmx_path / js_path) — don't rely on
      // project.folder_path + script_path which points to the wrong location for new plans.
      if (script_name) {
        const scriptFile = (script_name || '').replace(/\\/g, '/').split('/').pop();
        const suiteRow   = db.prepare(
          "SELECT jmx_path, js_path FROM test_suites WHERE project_id = ? AND (jmx_path LIKE ? OR js_path LIKE ?) LIMIT 1"
        ).get(req.params.projectId, `%${scriptFile}`, `%${scriptFile}`);

        // Determine the absolute source path from the suite record
        let srcAbs = suiteRow?.jmx_path || suiteRow?.js_path || '';
        // Fallback: search all workspace roots for the file
        if (!srcAbs || !fs.existsSync(srcAbs)) {
          const { GIT_WORKSPACES_ROOT: _wsRoot2, cleanName: _cn2 } = require('../utils/projectFolders');
          const pName   = db.prepare('SELECT name FROM projects WHERE id = ?').get(req.params.projectId)?.name || '';
          // Search dirs: project-named subfolder AND root-level workspace dirs (covers legacy paths)
          const searchBases = [];
          try { searchBases.push(...fs.readdirSync(path.join(_wsRoot2, _cn2(pName)), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(_wsRoot2, _cn2(pName), d.name))); } catch {}
          try { searchBases.push(...fs.readdirSync(_wsRoot2, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(_wsRoot2, d.name))); } catch {}
          for (const base of searchBases) {
            const candidate = path.join(base, script_path ? script_path.replace(/\//g, path.sep) : scriptFile);
            if (fs.existsSync(candidate)) { srcAbs = candidate; break; }
          }
        }

        const destAbs = path.join(wsRoot, script_path ? script_path.replace(/\//g, path.sep) : scriptFile);
        if (srcAbs && fs.existsSync(srcAbs) && !fs.existsSync(destAbs)) {
          fs.mkdirSync(path.dirname(destAbs), { recursive: true });
          fs.copyFileSync(srcAbs, destAbs);
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
      await git2.commit(`Peako Performance Test: ${runLabel} [auto]`);
      // Disable GCM account picker in local .git/config before every push
      try { await git2.addConfig('credential.helper', '', false, 'local'); } catch {}
      // Push branch (set upstream if first time)
      await git2.push(['--set-upstream', 'origin', targetRef]);
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
        const run = db.prepare('INSERT INTO ci_pipeline_runs (project_id, provider, external_id, web_url, status, script_name, run_name, variables, triggered_by) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(req.params.projectId, 'gitlab', String(r.body.id), r.body.web_url || '', r.body.status || 'pending', script_name, ciRunDisplayName, JSON.stringify(variables), req.userId);
        return res.json({ ok: true, run_id: run.lastInsertRowid, run_name: ciRunDisplayName, external_id: r.body.id, web_url: r.body.web_url, status: r.body.status, message: 'Pipeline triggered on GitLab' });
      }
      return res.status(400).json({ error: `GitLab returned ${r.status}: ${JSON.stringify(r.body)}` });
    }

    // ── GitHub Actions trigger ─────────────────────────────────────────────
    if (provider === 'github') {
      if (!effectiveGithubToken) return res.status(400).json({ error: 'No GitHub token available. Save your Personal Access Token in Git Identity (Configuration → Git).' });

      // Sanitize at trigger time — catches any stale invalid values in the DB
      const githubRepo = sanitizeGithubRepo(cfg.github_repo) || getRepoFromGit(req.params.projectId);
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

        const run = db.prepare('INSERT INTO ci_pipeline_runs (project_id, provider, external_id, web_url, status, script_name, run_name, variables, triggered_by) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(
            req.params.projectId, 'github',
            latestRun ? String(latestRun.id) : null,
            latestRun?.html_url || `https://github.com/${cfg.github_repo}/actions`,
            latestRun?.status || 'queued',
            script_name, ciRunDisplayName, JSON.stringify(variables), req.userId
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
      // ATATT personal API tokens require Basic auth with EMAIL:token (Atlassian account email, not Bitbucket username)
      // App Passwords (ATBB) use Basic auth with Bitbucket username:token
      const bbAuthHeader = `Basic ${Buffer.from(`${cfg.bitbucket_username || cfg.bitbucket_workspace}:${bbToken}`).toString('base64')}`;
      const bbRef  = variables.branch || cfg.bitbucket_ref || baseBranch2;

      const bbBody = {
        target: {
          ref_type: 'branch',
          type: 'pipeline_ref_target',
          ref_name: bbRef,
          selector: { type: 'custom', pattern: 'Peako-Performance-Test' },
        },
        variables: Object.entries(variables).map(([key, value]) => ({ key: key.toUpperCase(), value: String(value), secured: false })),
      };

      const bbResp = await apiRequest(
        `https://api.bitbucket.org/2.0/repositories/${cfg.bitbucket_workspace}/${cfg.bitbucket_repo_slug}/pipelines/`,
        'POST', bbBody, { Authorization: bbAuthHeader, 'User-Agent': 'PerfStudio', Accept: 'application/json' }
      );

      if (bbResp.status === 201) {
        const pipelineUuid = bbResp.body.uuid;
        const bbRunInsert = db.prepare('INSERT INTO ci_pipeline_runs (project_id, provider, external_id, web_url, status, script_name, run_name, variables, triggered_by) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(
            req.params.projectId, 'bitbucket', pipelineUuid,
            `https://bitbucket.org/${cfg.bitbucket_workspace}/${cfg.bitbucket_repo_slug}/pipelines/results/${pipelineUuid}`,
            'pending', script_name || '', ciRunDisplayName,
            JSON.stringify(variables), req.userId
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
router.get('/runs', (req, res) => {
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const runs = db.prepare(`
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
  const { getUserProjectPath, getCollectionPath } = require('../utils/projectFolders');

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) return;

  // Guard: never create duplicate execution_runs for the same CI run
  const alreadySynced = db.prepare('SELECT id FROM execution_runs WHERE ci_run_id = ?').get(run.id);
  if (alreadySynced) { console.log(`[Auto-sync] CI run #${run.id} already synced → skipping`); return; }

  const callerRole = db.prepare('SELECT role FROM users WHERE id = ?').get(userId)?.role;
  const userProjPath = getUserProjectPath(userId, callerRole, project.name);
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
    const suite = db.prepare(`
      SELECT ts.*, c.name as col_name FROM test_suites ts
      LEFT JOIN collections c ON c.id = ts.collection_id
      WHERE ts.project_id = ? AND (ts.jmx_path LIKE ? OR ts.js_path LIKE ?) LIMIT 1
    `).get(projectId, `%${scriptFile}`, `%${scriptFile}`);
    suiteName = suite?.name || null;
    if (suite?.col_name && suite?.env) {
      const envPath = getCollectionPath(userProjPath, suite.col_name, suite.env);
      try { require('fs').mkdirSync(path.join(envPath, 'results'), { recursive: true }); } catch {}
      let nums = [];
      try { nums = require('fs').readdirSync(path.join(envPath, 'results'), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => extractRunNumber(d.name)).filter(n => n > 0); } catch {}
      const nextRun = nums.length ? Math.max(...nums) + 1 : 1;
      const runDirName = buildRunDirName(suiteName || scriptFile.replace(/\.jmx$/, ''), ciUsers, 'duration', ciLoops, ciDur, nextRun);
      resultDir = path.join(envPath, 'results', runDirName);
    }
  }
  if (!resultDir) {
    try {
      const nums = fs.readdirSync(path.join(userProjPath, 'results'), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => extractRunNumber(d.name)).filter(n => n > 0);
      const next = nums.length ? Math.max(...nums) + 1 : 1;
      const scriptBase = run.script_name ? run.script_name.replace(/\\/g, '/').split('/').pop().replace(/\.jmx$/, '') : 'CIRun';
      resultDir = path.join(userProjPath, 'results', buildRunDirName(suiteName || scriptBase, ciUsers, 'duration', ciLoops, ciDur, next));
    } catch {
      resultDir = path.join(userProjPath, 'results', `CI_Run_${run.id}`);
    }
  }
  fs.mkdirSync(resultDir, { recursive: true });

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
      const bbAuth2 = Buffer.from(`${cfg.bitbucket_username || cfg.bitbucket_workspace}:${cfg.bitbucket_app_password}`).toString('base64');
      const pipelineId2 = (run.external_id || '').replace(/[{}]/g, '');
      await new Promise((resolve, reject) => {
        const fileStream = fs.createWriteStream(tmpZip);
        const options = { hostname: 'api.bitbucket.org', path: `/2.0/repositories/${cfg.bitbucket_workspace}/${cfg.bitbucket_repo_slug}/downloads/perf-results-${pipelineId2}.zip`, method: 'GET', headers: { Authorization: `Basic ${bbAuth2}`, 'User-Agent': 'PerfStudio' }, rejectUnauthorized: false };
        https.request(options, response => {
          if (response.statusCode === 301 || response.statusCode === 302) {
            https.get(response.headers.location, { rejectUnauthorized: false }, r2 => {
              if (r2.statusCode !== 200 && r2.statusCode !== 206) {
                fileStream.close();
                return reject(new Error(`Bitbucket artifact not found (HTTP ${r2.statusCode})`));
              }
              r2.pipe(fileStream); fileStream.on('finish', () => { fileStream.close(); resolve(); });
            }).on('error', reject);
          } else if (response.statusCode === 200 || response.statusCode === 206) {
            response.pipe(fileStream); fileStream.on('finish', () => { fileStream.close(); resolve(); });
          } else {
            fileStream.close();
            reject(new Error(`Bitbucket artifact not found (HTTP ${response.statusCode})`));
          }
        }).on('error', reject).end();
      });
    }

    if (!fs.existsSync(tmpZip) || fs.statSync(tmpZip).size === 0) throw new Error('Empty zip');

    const zip = new AdmZip(tmpZip);
    zip.extractAllTo(resultDir, true);
    fs.unlinkSync(tmpZip);

    // Normalise html → report folder
    const ciHtmlDir = path.join(resultDir, 'html');
    const localHtmlDir = path.join(resultDir, 'report');
    if (fs.existsSync(ciHtmlDir) && !fs.existsSync(localHtmlDir)) fs.renameSync(ciHtmlDir, localHtmlDir);

    const jtlPath    = path.join(resultDir, 'results.jtl');
    const reportPath = path.join(localHtmlDir, 'index.html');

    // Resolve suite_id
    let suiteId = null;
    if (run.script_name) {
      const sf = run.script_name.split('/').pop();
      const s = db.prepare("SELECT id FROM test_suites WHERE project_id = ? AND (jmx_path LIKE ? OR js_path LIKE ?) LIMIT 1").get(projectId, `%${sf}`, `%${sf}`);
      suiteId = s?.id || null;
    }

    const reportData = fs.existsSync(jtlPath) ? parseJtl(jtlPath, {
      suite_name: suiteId ? db.prepare('SELECT name FROM test_suites WHERE id=?').get(suiteId)?.name : (run.script_name || 'CI Run'),
      engine: 'jmeter', started_at: run.started_at,
    }) : null;

    // Evaluate rule violations before PDF so the PDF shows correct PASSED/FAILED status
    let autoViolations = [];
    if (fs.existsSync(jtlPath)) {
      try {
        const { evaluateRules } = require('../utils/ruleEvaluator');
        const rr = evaluateRules(projectId, jtlPath);
        autoViolations = rr?.violations || [];
      } catch (_) {}
    }
    if (reportData) reportData.rule_violations = autoViolations;

    const suiteLookup = suiteId ? db.prepare('SELECT name FROM test_suites WHERE id = ?').get(suiteId) : null;
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

    const execInsert = db.prepare(`
      INSERT INTO execution_runs (project_id, suite_id, engine, status, result_dir, report_path, logs, started_at, finished_at, report_data, ci_run_id)
      VALUES (?, ?, 'jmeter', 'completed', ?, ?, ?, ?, datetime('now'), ?, ?)
    `).run(
      projectId, suiteId, resultDir,
      fs.existsSync(reportPath) ? reportPath : null,
      JSON.stringify([{ type: 'info', message: `Results synced from CI pipeline run #${run.external_id} (${run.provider})` }]),
      run.started_at || new Date().toISOString(),
      reportData ? JSON.stringify(reportData) : null,
      run.id
    );
    const newRunId = execInsert.lastInsertRowid;

    console.log(`[Auto-sync] CI run #${run.id} synced → ${path.basename(resultDir)}`);

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
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const run = db.prepare('SELECT * FROM ci_pipeline_runs WHERE id = ? AND project_id = ?').get(req.params.runId, req.params.projectId);
  if (!run) return res.status(404).json({ error: 'Run not found' });

  const cfg = decryptConfig(getConfig(req.params.projectId, req.userId));
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
      const bbAuth = Buffer.from(`${cfg.bitbucket_username || cfg.bitbucket_workspace}:${cfg.bitbucket_app_password}`).toString('base64');
      const r = await apiRequest(
        `https://api.bitbucket.org/2.0/repositories/${cfg.bitbucket_workspace}/${cfg.bitbucket_repo_slug}/pipelines/${run.external_id}`,
        'GET', null, { Authorization: `Basic ${bbAuth}`, 'User-Agent': 'PerfStudio' }
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
    };
    const mappedStatus = statusMap[status] || status;

    // Update DB
    const isFinished = ['completed','failed','cancelled','skipped'].includes(mappedStatus);
    db.prepare('UPDATE ci_pipeline_runs SET status=?, web_url=?' + (isFinished ? ", finished_at=datetime('now')" : '') + ' WHERE id=?')
      .run(mappedStatus, webUrl, run.id);

    // Auto-sync: first time this run reaches "completed", download artifacts and
    // create an execution_runs record so it appears in Analytics automatically.
    if (mappedStatus === 'completed' && run.status !== 'completed') {
      const alreadySynced = db.prepare('SELECT id FROM execution_runs WHERE ci_run_id = ?').get(run.id);
      if (!alreadySynced) {
        const runSnapshot = db.prepare('SELECT * FROM ci_pipeline_runs WHERE id = ?').get(run.id);
        setImmediate(() => autoSyncCiRun(runSnapshot, cfg, req.params.projectId, req.userId).catch(() => {}));
      }
    }

    // Send email alert for failed / cancelled runs (completed runs get email via autoSyncCiRun)
    const wasFinished = ['completed','failed','cancelled','skipped'].includes(run.status);
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
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });

  const run = db.prepare('SELECT * FROM ci_pipeline_runs WHERE id = ? AND project_id = ?').get(req.params.runId, req.params.projectId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (!run.external_id) return res.status(400).json({ error: 'No external pipeline ID — pipeline may not have started yet.' });

  // Guard: don't create a second execution_runs record for the same CI run
  const alreadySynced = db.prepare('SELECT id FROM execution_runs WHERE ci_run_id = ?').get(run.id);
  if (alreadySynced) return res.json({ ok: true, already_synced: true, execution_run_id: alreadySynced.id, message: 'Already synced — results are already in Analytics.' });

  const cfg = decryptConfig(getConfig(req.params.projectId, req.userId));
  if (!cfg) return res.status(400).json({ error: 'CI configuration not found.' });

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const AdmZip = require('adm-zip');
  const os = require('os');
  const { getUserProjectPath, getCollectionPath } = require('../utils/projectFolders');
  const { buildRunDirName, extractRunNumber } = require('../utils/buildRunName');

  // ── Determine results directory ────────────────────────────────────────────
  const callerRole  = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId)?.role;
  const userProjPath = getUserProjectPath(req.userId, callerRole, project.name);

  // Parse CI parameters for the run name
  const ciVars2  = (() => { try { return JSON.parse(run.variables || '{}'); } catch { return {}; } })();
  const ciUsers2 = ciVars2.jmeter_users    || null;
  const ciLoops2 = ciVars2.jmeter_loops    || null;
  const ciDur2   = ciVars2.jmeter_duration || null;

  let resultDir = null;
  let syncSuiteName = null;
  if (run.script_name) {
    const scriptFile = run.script_name.replace(/\\/g, '/').split('/').pop();
    const suite = db.prepare(`
      SELECT ts.*, c.name as col_name FROM test_suites ts
      LEFT JOIN collections c ON c.id = ts.collection_id
      WHERE ts.project_id = ?
        AND (ts.jmx_path LIKE ? OR ts.js_path LIKE ?)
      LIMIT 1
    `).get(req.params.projectId, `%${scriptFile}`, `%${scriptFile}`);

    syncSuiteName = suite?.name || null;
    if (suite?.col_name && suite?.env) {
      const envPath = getCollectionPath(userProjPath, suite.col_name, suite.env);
      try { fs.mkdirSync(path.join(envPath, 'results'), { recursive: true }); } catch {}
      let nums = [];
      try { nums = fs.readdirSync(path.join(envPath, 'results'), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => extractRunNumber(d.name)).filter(n => n > 0); } catch {}
      const nextRun = nums.length ? Math.max(...nums) + 1 : 1;
      const syncScriptBase = scriptFile.replace(/\.jmx$/, '');
      resultDir = path.join(envPath, 'results', buildRunDirName(syncSuiteName || syncScriptBase, ciUsers2, 'duration', ciLoops2, ciDur2, nextRun));
    }
  }

  // Fallback to project-level results
  if (!resultDir) {
    try {
      const nums = fs.readdirSync(path.join(userProjPath, 'results'), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => extractRunNumber(d.name)).filter(n => n > 0);
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
      const bbAuth3 = Buffer.from(`${cfg.bitbucket_username || cfg.bitbucket_workspace}:${cfg.bitbucket_app_password}`).toString('base64');
      const pipelineId3 = (run.external_id || '').replace(/[{}]/g, '');
      await new Promise((resolve, reject) => {
        const fileStream = fs.createWriteStream(tmpZip);
        const options = { hostname: 'api.bitbucket.org', path: `/2.0/repositories/${cfg.bitbucket_workspace}/${cfg.bitbucket_repo_slug}/downloads/perf-results-${pipelineId3}.zip`, method: 'GET', headers: { Authorization: `Basic ${bbAuth3}`, 'User-Agent': 'PerfStudio' }, rejectUnauthorized: false };
        https.request(options, response => {
          if (response.statusCode === 301 || response.statusCode === 302) {
            https.get(response.headers.location, { rejectUnauthorized: false }, r2 => {
              if (r2.statusCode !== 200 && r2.statusCode !== 206) {
                fileStream.close();
                return reject(new Error(`Bitbucket artifact not found (HTTP ${r2.statusCode}). Ensure the pipeline uploaded perf-results-${pipelineId3}.zip to Bitbucket Downloads.`));
              }
              r2.pipe(fileStream); fileStream.on('finish', () => { fileStream.close(); resolve(); });
            }).on('error', reject);
          } else if (response.statusCode === 200 || response.statusCode === 206) {
            response.pipe(fileStream); fileStream.on('finish', () => { fileStream.close(); resolve(); });
          } else {
            fileStream.close();
            reject(new Error(`Bitbucket artifact not found (HTTP ${response.statusCode}). Ensure the pipeline uploaded perf-results-${pipelineId3}.zip to Bitbucket Downloads.`));
          }
        }).on('error', reject).end();
      });
    }

    // ── Extract zip to resultDir ─────────────────────────────────────────────
    if (!fs.existsSync(tmpZip) || fs.statSync(tmpZip).size === 0) {
      return res.status(500).json({ error: 'Downloaded artifact is empty or missing.' });
    }

    const zip = new AdmZip(tmpZip);
    zip.extractAllTo(resultDir, true);
    fs.unlinkSync(tmpZip);

    // ── Normalise folder names to match local run structure ───────────────────
    // CI YAML writes HTML to reports/html/ — local runs use resultDir/report/
    const ciHtmlDir    = path.join(resultDir, 'html');
    const localHtmlDir = path.join(resultDir, 'report');
    if (fs.existsSync(ciHtmlDir) && !fs.existsSync(localHtmlDir)) {
      fs.renameSync(ciHtmlDir, localHtmlDir);
    }
    const reportPath = path.join(localHtmlDir, 'index.html');
    const jtlPath    = path.join(resultDir, 'results.jtl');

    // ── Generate analytics PDF from JTL ──────────────────────────────────────
    let pdfPath = null;
    let reportData = null;
    if (fs.existsSync(jtlPath)) {
      try {
        const { generateAnalyticsPdfToFile } = require('../utils/generateAnalyticsPdf');
        const runNum  = (resultDir.match(/Run_(\d+)/) || [])[1] || run.id;
        const tmpPdf  = path.join(resultDir, `Analytics_CI_Run_${runNum}.pdf`);

        // Parse JTL with the full parser (timeline, errors, bytes, latency, connect)
        const { parseJtl } = require('../utils/parseJtl');
        const suite = db.prepare('SELECT name FROM test_suites WHERE id = (SELECT suite_id FROM execution_runs WHERE result_dir LIKE ? LIMIT 1)').get(`%${path.basename(resultDir)}%`);
        reportData = parseJtl(jtlPath, {
          suite_name: suite?.name || run.script_name || 'CI Run',
          engine: 'jmeter',
          started_at: run.started_at,
          status: 'completed',
        });
        if (reportData) {
          // Evaluate rules so PDF shows PASSED/FAILED correctly
          try {
            const { evaluateRules } = require('../utils/ruleEvaluator');
            const rr = evaluateRules(req.params.projectId, jtlPath);
            reportData.rule_violations = rr?.violations || [];
          } catch (_) {}

          await generateAnalyticsPdfToFile(reportData, runNum, tmpPdf);
          pdfPath = tmpPdf;
          console.log('[CI Sync] Analytics PDF generated:', pdfPath);
        }
      } catch (e) {
        console.error('[CI Sync] PDF generation failed:', e.message, e.stack?.split('\n')[1] || '');
      }
    }

    // ── Create execution_run record ───────────────────────────────────────────
    let suiteId = null;
    if (run.script_name) {
      const scriptFile = run.script_name.split('/').pop();
      const suite = db.prepare("SELECT id FROM test_suites WHERE project_id = ? AND (jmx_path LIKE ? OR js_path LIKE ?) LIMIT 1")
        .get(req.params.projectId, `%${scriptFile}`, `%${scriptFile}`);
      suiteId = suite?.id || null;
    }

    const execRunRow = db.prepare(`
      INSERT INTO execution_runs
        (project_id, suite_id, engine, status, result_dir, report_path, logs, started_at, finished_at, report_data, ci_run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)
    `).run(
      req.params.projectId,
      suiteId,
      'jmeter',
      'completed',
      resultDir,
      fs.existsSync(reportPath) ? reportPath : null,
      JSON.stringify([{ type: 'info', message: `Results synced from CI pipeline run #${run.external_id} (${run.provider})` }]),
      run.started_at || new Date().toISOString(),
      reportData ? JSON.stringify(reportData) : null,
      run.id
    );

    // Update ci_pipeline_run with result_dir reference
    db.prepare("UPDATE ci_pipeline_runs SET variables = ? WHERE id = ?")
      .run(JSON.stringify({ ...JSON.parse(run.variables || '{}'), result_dir: resultDir }), run.id);

    // ── Send email alert for CI run ───────────────────────────────────────────
    const newRunId = execRunRow.lastInsertRowid;
    const suppressEmail = req.query.suppress_email === 'true';
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
          const sRow = db.prepare('SELECT name FROM test_suites WHERE id = ?').get(suiteId);
          if (sRow?.name) { emailData.meta.suite_name = sRow.name; resolvedSuiteName = sRow.name; }
        }
        emailData.meta.run_id = newRunId;
        // Reuse violations already evaluated before PDF generation
        const violations = reportData?.rule_violations || [];
        emailData.rule_violations = violations;
        // Send rule violation email first (as soon as violations are known, before full report)
        if (violations.length > 0) {
          const proj = db.prepare('SELECT name FROM projects WHERE id = ?').get(req.params.projectId);
          await sendRuleViolationEmail(newRunId, req.userId, req.params.projectId, violations, resolvedSuiteName, proj?.name || '');
        }
        // Send full report email
        await sendAlertEmail(newRunId, req.userId, req.params.projectId, emailData, pdfPath, null);
        console.log(`[CI Sync] Alert email sent for run #${newRunId}`);
      } catch (e) {
        console.error('[CI Sync] Alert email failed:', e.message);
      }
    });

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
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const run = db.prepare('SELECT * FROM ci_pipeline_runs WHERE id = ? AND project_id = ?').get(req.params.runId, req.params.projectId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (!run.external_id) return res.json({ steps: [], status: run.status });

  const cfg = decryptConfig(getConfig(req.params.projectId, req.userId));
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
      const mergedCfg = (() => {
        const adminRaw = db.prepare(`
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

module.exports = router;
