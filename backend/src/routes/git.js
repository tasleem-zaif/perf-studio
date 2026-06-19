/**
 * git.js — Project-level Git integration
 *
 * Org Admin  → main branch, can push/pull/merge PRs
 * Regular User → users/<username> branch, can push & raise PRs
 *
 * Routes (all under /api/projects/:projectId/git):
 *   GET    /config            — get git config for project
 *   PUT    /config            — save git config (org_admin only)
 *   POST   /init              — init repo + set remote + first commit
 *   GET    /status            — git status (modified/untracked files)
 *   POST   /commit            — stage all + commit
 *   POST   /push              — push current branch to remote
 *   POST   /pull              — pull latest from remote
 *   GET    /branches          — list all branches
 *   GET    /log               — recent commit log
 *   GET    /prs               — list PRs (stored locally)
 *   POST   /prs               — create PR (raises on GitHub/GitLab + stores locally)
 *   PUT    /prs/:prId/merge   — merge PR (org_admin only)
 *   PUT    /prs/:prId/close   — close PR
 */

const router        = require('express').Router({ mergeParams: true });
const simpleGit     = require('simple-git');
const { Octokit }   = require('@octokit/rest');
const path          = require('path');
const fs            = require('fs');
const os            = require('os');
const { randomBytes } = require('crypto');
const db            = require('../db');
const auth          = require('../middleware/auth');
const ownsProject   = require('../utils/ownsProject');
const { encrypt, decrypt } = require('../utils/encryption');

router.use(auth);

// ── Helpers ───────────────────────────────────────────────────────────────────

function getProject(userId, projectId) {
  return ownsProject(userId, projectId);
}

function getCaller(userId) {
  return db.prepare('SELECT id, name, email, role, org_id FROM users WHERE id = ?').get(userId);
}

function getGitConfig(projectId) {
  return db.prepare('SELECT * FROM git_configs WHERE project_id = ?').get(projectId);
}

function getBaseBranch(cfg) {
  return cfg?.base_branch || 'main';
}

function getBranchForUser(user, cfg) {
  if (user.role === 'org_admin' || user.role === 'super_admin') return getBaseBranch(cfg);
  const safe = user.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-');
  return `users/${safe}`;
}

// Always suppress git credential prompts — failures surface as errors, never as OS popups
const NO_PROMPT_ENV = {
  // Suppress terminal credential prompts
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
  GIT_SSH_ASKPASS: 'echo',
  // Suppress Windows Git Credential Manager (GCM) GUI account-picker dialogs.
  // GCM shows these even when a PAT is embedded in the URL unless we explicitly
  // tell it to never open interactive windows.
  GCM_INTERACTIVE: 'never',
  GCM_NO_INTERACTIVE: '1',
  // Override credential.helper to empty via git env config (Git 2.31+).
  // This prevents GCM from intercepting HTTPS operations where the PAT is
  // already present in the remote URL — so git uses the URL credentials directly.
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'credential.helper',
  GIT_CONFIG_VALUE_0: '',
};

function gitInstance(projectPath, extraEnv = {}) {
  return simpleGit({
    baseDir: projectPath,
    env: { ...process.env, ...NO_PROMPT_ENV, ...extraEnv },
  });
}

/**
 * Write credential.helper='' into the repo's local .git/config.
 * This overrides Windows Git Credential Manager (GCM) at every config level
 * (system → global → local) so git uses the PAT already embedded in the
 * remote URL without ever opening the GCM account-picker GUI.
 * Call this once after init and once at the start of every push flow.
 */
async function disableGcm(git) {
  try {
    await git.addConfig('credential.helper', '', false, 'local');
    // Also kill the GitHub-specific helper entry GCM sometimes writes
    await git.addConfig('credential.https://github.com.helper', '', false, 'local');
  } catch {}
}

// Write SSH private key to a temp file and return GIT_SSH_COMMAND env + cleanup fn
function createSshEnv(privateKey) {
  if (!privateKey?.trim()) return { env: {}, cleanup: () => {} };
  const tmpPath = path.join(os.tmpdir(), `ps_ssh_${randomBytes(8).toString('hex')}`);
  fs.writeFileSync(tmpPath, privateKey.trim() + '\n', { mode: 0o600 });
  // Use forward slashes — required for ssh on Windows with Git for Windows
  const sshPath = tmpPath.replace(/\\/g, '/');
  const env = { GIT_SSH_COMMAND: `ssh -i "${sshPath}" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null` };
  const cleanup = () => { try { fs.unlinkSync(tmpPath); } catch {} };
  return { env, cleanup };
}

// Resolve effective auth (SSH or PAT) for a user on a project
function getAuth(cfg, userId, projectId) {
  const identity = db.prepare('SELECT * FROM user_git_configs WHERE user_id = ? AND project_id = ?')
    .get(userId, projectId);
  const authMethod = identity?.auth_method || cfg?.auth_method || 'pat';

  if (authMethod === 'ssh') {
    const rawKey = identity?.ssh_key ? decrypt(identity.ssh_key) : '';
    if (rawKey) {
      const { env, cleanup } = createSshEnv(rawKey);
      return { isSSH: true, remoteUrl: cfg.remote_url, sshEnv: env, cleanup };
    }
    return { isSSH: true, remoteUrl: cfg.remote_url, sshEnv: {}, cleanup: () => {} };
  }

  // PAT mode
  const projectToken  = cfg.auth_token      ? decrypt(cfg.auth_token)      : '';
  const personalToken = identity?.auth_token ? decrypt(identity.auth_token) : '';
  const effectiveToken = personalToken || projectToken;
  return {
    isSSH: false,
    remoteUrl: buildRemoteWithAuth(cfg.remote_url, cfg.username, effectiveToken),
    sshEnv: {},
    cleanup: () => {},
  };
}

// ── Per-project, per-user workspace path ─────────────────────────────────────
// Each project has its own isolated git workspace — pushing never leaks other projects.
// Structure:
//   git-workspaces/
//   ├── Project_Demo/
//   │   ├── admin/          ← org admin workspace (main branch)
//   │   │   ├── .git/
//   │   │   ├── Collection1/
//   │   │   └── README.md
//   │   └── user-3/         ← user-3's clone (users/<name> branch)
//   │       ├── .git/
//   │       └── Collection1/
//   └── Demo1/
//       ├── admin/
//       └── user-3/
const GIT_WORKSPACES_ROOT = path.join(__dirname, '..', '..', '..', 'git-workspaces');

function getCleanProjectName(proj) {
  return proj.name.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

function userNameSlug(name) {
  return (name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || null;
}

function getUserWorkspace(proj, user) {
  const userFolder = userNameSlug(user.name) || `user-${user.id}`;
  const cleanProjectName = getCleanProjectName(proj);
  return path.join(GIT_WORKSPACES_ROOT, cleanProjectName, userFolder);
}

// Clone or pull-update a user's workspace from the remote
async function ensureUserWorkspace(gitRoot, cfg, user) {
  const identity = db.prepare('SELECT * FROM user_git_configs WHERE user_id = ? AND project_id = ?')
    .get(user.id, cfg.project_id);

  const authMethod = identity?.auth_method || cfg?.auth_method || 'pat';
  const isSSHMode  = authMethod === 'ssh';

  let remoteForOps, sshEnv = {}, sshCleanup = () => {};

  if (isSSHMode) {
    const rawKey = identity?.ssh_key ? decrypt(identity.ssh_key) : '';
    if (rawKey) {
      const r = createSshEnv(rawKey);
      sshEnv    = r.env;
      sshCleanup = r.cleanup;
    }
    remoteForOps = cfg.remote_url;
  } else {
    const token         = cfg.auth_token      ? decrypt(cfg.auth_token)      : '';
    const personalToken = identity?.auth_token ? decrypt(identity.auth_token) : token;
    remoteForOps = buildRemoteWithAuth(cfg.remote_url, cfg.username, personalToken || token);
  }

  if (!fs.existsSync(path.join(gitRoot, '.git'))) {
    const dirExists = fs.existsSync(gitRoot);
    const isEmpty   = !dirExists || fs.readdirSync(gitRoot).length === 0;
    const cloneGit  = simpleGit({ env: { ...process.env, ...NO_PROMPT_ENV, ...sshEnv } });

    if (isEmpty) {
      fs.mkdirSync(gitRoot, { recursive: true });
      await cloneGit.clone(remoteForOps, gitRoot);
    } else {
      const tmpDir = gitRoot + '_clone_tmp';
      if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
      await cloneGit.clone(remoteForOps, tmpDir);
      fs.renameSync(path.join(tmpDir, '.git'), path.join(gitRoot, '.git'));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  const git = gitInstance(gitRoot, sshEnv);

  const authorName  = identity?.author_name  || user.name;
  const authorEmail = identity?.author_email || user.email || cfg.email || 'noreply@perfstudio.com';
  await git.addConfig('user.name',  authorName);
  await git.addConfig('user.email', authorEmail);
  await git.addConfig('core.longpaths', 'true');

  const remotes = await git.getRemotes();
  if (remotes.find(r => r.name === 'origin')) {
    await git.remote(['set-url', 'origin', remoteForOps]);
  }

  // Rebuild collection folder structure from DB — the remote may not have these
  // folders if they were created after the last push, or this is a fresh clone.
  try {
    const { ensureAllEnvFolders, cleanName: cn } = require('../utils/projectFolders');
    const projectRow = db.prepare('SELECT folder_path, name FROM projects WHERE id = ?').get(cfg.project_id);
    // Collections go inside the project subfolder within the git workspace root:
    // gitRoot/<ProjectName>/<CollectionName>/<Env>/
    const gitProjectPath = path.join(gitRoot, cn(projectRow?.name || ''));
    const collections = db.prepare('SELECT * FROM collections WHERE project_id = ?').all(cfg.project_id);
    for (const col of collections) {
      let envs = [];
      try { envs = JSON.parse(col.environments || '[]'); } catch {}
      if (!envs.length && col.environment) envs = [col.environment];
      if (!envs.length) envs = ['Default'];
      ensureAllEnvFolders(gitProjectPath, col.name, envs);
    }

    // Copy JMX/JS scripts from admin workspace if they don't exist here yet.
    // Scripts are generated into the admin workspace; users need them locally
    // so they can commit to their branch and CI can find the file.
    const adminWorkspace = path.join(GIT_WORKSPACES_ROOT, getCleanProjectName({ name: cfg.project_id_name || '' }), 'admin');
    const adminRoot  = projectRow?.folder_path || '';
    if (adminRoot && fs.existsSync(adminRoot)) {
      const suites = db.prepare("SELECT jmx_path, js_path FROM test_suites WHERE project_id = ? AND (jmx_path IS NOT NULL OR js_path IS NOT NULL)").all(cfg.project_id);
      for (const suite of suites) {
        const srcAbs = suite.jmx_path || suite.js_path;
        if (!srcAbs || !fs.existsSync(srcAbs)) continue;
        // Map admin path to equivalent user workspace path
        const relToAdmin = path.relative(adminRoot, srcAbs);
        const destAbs    = path.join(gitRoot, relToAdmin);
        if (!fs.existsSync(destAbs)) {
          fs.mkdirSync(path.dirname(destAbs), { recursive: true });
          fs.copyFileSync(srcAbs, destAbs);
        }
      }
    }
  } catch (_) { /* non-fatal — workspace still usable */ }

  return { git, remoteWithAuth: remoteForOps, authorName, authorEmail, identity, sshCleanup };
}

function buildRemoteWithAuth(url, username, token) {
  // Inject PAT into HTTPS URL for GitHub authentication.
  // Most reliable format: https://TOKEN@github.com/owner/repo.git
  // This works for both classic PATs (ghp_...) and fine-grained tokens (github_pat_...)
  if (!token) return url;
  try {
    // Strip any existing credentials first
    const clean = url.replace(/^(https?:\/\/)[^@]+@/, '$1');
    // Inject token — use token as username, empty password
    return clean.replace(/^(https?:\/\/)/, `$1${encodeURIComponent(token)}@`);
  } catch {
    return url;
  }
}

// ── Parse GitHub owner/repo from remote URL ───────────────────────────────────
function parseGitHubOwnerRepo(remoteUrl) {
  if (!remoteUrl) return null;
  // HTTPS: https://github.com/owner/repo.git  (may contain token@ prefix)
  const httpsMatch = remoteUrl.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\s|$)/);
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };
  // SSH: git@github.com:owner/repo.git
  const sshMatch = remoteUrl.match(/git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };
  return null;
}

// ── Apply branch protection rules via GitHub API ──────────────────────────────
// Silently skips if:  non-GitHub provider, no token, or rate-limited.
async function applyBranchProtection(cfg, branch = 'main') {
  if (!cfg?.auth_token || cfg.provider !== 'github') return;
  try {
    const token  = decrypt(cfg.auth_token);
    const parsed = parseGitHubOwnerRepo(cfg.remote_url);
    if (!parsed) return;

    const octokit = new Octokit({ auth: token });
    const isFeatureBranch = cfg._featureBranch === true;
    await octokit.repos.updateBranchProtection({
      owner:  parsed.owner,
      repo:   parsed.repo,
      branch,
      required_status_checks:        null,
      enforce_admins:                false,  // admins can always bypass
      required_pull_request_reviews: null,   // no review requirement — admins merge freely
      restrictions:                  null,
      allow_force_pushes:            false,  // prevent accidental force-push
      allow_deletions:               false,  // prevent branch deletion
    });
    console.log(`[Git] Branch protection applied to "${branch}" on ${parsed.owner}/${parsed.repo}`);
    return { ok: true };
  } catch (e) {
    // Never block the main flow — log and move on
    const msg = e.message || 'Unknown error';
    console.warn(`[Git] Branch protection skipped for "${branch}": ${msg}`);
    // Return the error so callers can surface it to the user
    return { ok: false, error: msg };
  }
}

// ── GET /config ───────────────────────────────────────────────────────────────

router.get('/config', (req, res) => {
  const proj = getProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  const cfg = getGitConfig(req.params.projectId);
  if (!cfg) return res.json({ config: null });

  const rawToken = cfg.auth_token ? decrypt(cfg.auth_token) : '';
  const tokenPreview = rawToken.length > 8 ? rawToken.slice(0, 4) + '••••' + rawToken.slice(-4) : (rawToken ? '••••••••' : '');
  res.json({
    config: {
      ...cfg,
      auth_token:   cfg.auth_token ? '••••••••' : '',
      token_preview: tokenPreview,
      auth_method:  cfg.auth_method || 'pat',
    }
  });
});

// ── Helper: check if current user is the project owner ────────────────────────
function isProjectOwner(userId, projectId) {
  const proj = db.prepare('SELECT user_id FROM projects WHERE id = ?').get(projectId);
  return proj && String(proj.user_id) === String(userId);
}

// ── PUT /config ───────────────────────────────────────────────────────────────

router.put('/config', (req, res) => {
  const caller = getCaller(req.userId);
  if (!['org_admin', 'super_admin'].includes(caller.role)) {
    return res.status(403).json({ error: 'Only org admins can configure git.' });
  }
  const proj = getProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  // Only the project owner can change git setup
  if (!isProjectOwner(req.userId, req.params.projectId)) {
    return res.status(403).json({
      error: 'Only the project owner can modify the Git repository configuration.',
      owner_only: true,
    });
  }

  const { provider, remote_url, username, email, auth_token, auth_method, base_branch } = req.body;
  const existing = getGitConfig(req.params.projectId);

  // Repo is permanently locked after initialization — cannot change remote_url or base_branch
  if (existing?.is_initialized && remote_url && remote_url !== existing.remote_url) {
    return res.status(403).json({
      error: 'Repository is already initialized. The remote URL cannot be changed after initialization.',
      locked: true,
    });
  }

  const finalToken = (auth_token && auth_token !== '••••••••')
    ? encrypt(auth_token)
    : (existing?.auth_token || '');

  const finalMethod = auth_method || existing?.auth_method || 'pat';
  const finalBaseBranch = base_branch || existing?.base_branch || 'main';

  if (existing) {
    db.prepare(`UPDATE git_configs SET provider=?,remote_url=?,username=?,email=?,auth_token=?,auth_method=?,base_branch=? WHERE project_id=?`)
      .run(provider||'github', remote_url||'', username||'', email||'', finalToken, finalMethod, finalBaseBranch, req.params.projectId);
  } else {
    db.prepare(`INSERT INTO git_configs (project_id,provider,remote_url,username,email,auth_token,auth_method,base_branch) VALUES (?,?,?,?,?,?,?,?)`)
      .run(req.params.projectId, provider||'github', remote_url||'', username||'', email||'', finalToken, finalMethod, finalBaseBranch);
  }
  res.json({ ok: true });
});

// ── POST /init ────────────────────────────────────────────────────────────────

router.post('/init', async (req, res) => {
  const caller = getCaller(req.userId);
  if (!['org_admin', 'super_admin'].includes(caller.role)) {
    return res.status(403).json({ error: 'Only org admins can initialize git.' });
  }
  const proj = getProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  // Only the project owner can initialize the repository
  if (!isProjectOwner(req.userId, req.params.projectId)) {
    return res.status(403).json({
      error: 'Only the project owner can initialize the Git repository.',
      owner_only: true,
    });
  }

  const cfg = getGitConfig(req.params.projectId);
  if (!cfg || !cfg.remote_url) return res.status(400).json({ error: 'Configure git remote URL first.' });

  // folder_path is null before first init — that's expected.
  // The project folder will be created inside git-workspaces during this init.

  let sshCleanup = () => {};
  try {
    const { isSSH, remoteUrl: remoteWithAuth, sshEnv, cleanup } = getAuth(cfg, req.userId, req.params.projectId);
    sshCleanup = cleanup;

    if (!isSSH) {
      // PAT mode — require a token
      const identity = db.prepare('SELECT * FROM user_git_configs WHERE user_id = ? AND project_id = ?').get(req.userId, req.params.projectId);
      const personalToken = identity?.auth_token ? decrypt(identity.auth_token) : '';
      const projectToken  = cfg.auth_token       ? decrypt(cfg.auth_token)       : '';
      if (!personalToken && !projectToken) {
        return res.status(400).json({
          error: 'No Personal Access Token found. Save your PAT in Git Identity (Configuration → Git → Your Git Identity) before initializing.',
        });
      }
    } else if (!sshEnv.GIT_SSH_COMMAND) {
      return res.status(400).json({
        error: 'No SSH key found. Paste your private key in Git Identity (Configuration → Git → Your Git Identity) before initializing.',
      });
    }

    // ── Resolve workspace paths ───────────────────────────────────────────────
    // Each project has its own isolated workspace:
    //   git-workspaces/<ProjectName>/admin/
    //
    // Project files go DIRECTLY at the workspace root — no projects/ subdirectory.
    // This means pushing to GitHub only includes THIS project's files.
    //
    // GitHub structure:
    //   <repo_root>/
    //   ├── <CollectionName>/
    //   │   └── <Env>/
    //   │       ├── config/
    //   │       ├── script/
    //   │       ├── testData/
    //   │       └── results/  (gitignored)
    //   ├── .gitignore
    //   └── README.md
    const cleanProjectName = getCleanProjectName(proj);
    const gitRoot = getUserWorkspace(proj, caller);  // git-workspaces/<ProjectName>/admin/
    const gitProjectPath = path.join(gitRoot, cleanProjectName);  // project content in named subfolder

    // Create the workspace directories (gitRoot = repo root, gitProjectPath = content subfolder)
    fs.mkdirSync(gitRoot, { recursive: true });
    fs.mkdirSync(gitProjectPath, { recursive: true });

    const { ensureAllEnvFolders, cleanName } = require('../utils/projectFolders');

    // Create collection subfolders for all existing collections
    const existingCols = db.prepare('SELECT * FROM collections WHERE project_id = ?').all(proj.id);
    for (const col of existingCols) {
      let envs = [];
      try { envs = JSON.parse(col.environments || '[]'); } catch {}
      if (!envs.length && col.environment) envs = [col.environment];
      if (!envs.length) envs = ['Default'];
      ensureAllEnvFolders(gitProjectPath, col.name, envs);
    }

    // Update folder_path in DB to the project workspace root
    db.prepare('UPDATE projects SET folder_path = ? WHERE id = ?').run(gitProjectPath, proj.id);

    const git = gitInstance(gitRoot, sshEnv);

    // Init git at workspace root (not inside project subfolder)
    const isRepo = fs.existsSync(path.join(gitRoot, '.git'));
    if (!isRepo) {
      await git.init();
    }
    await disableGcm(git);

    // Enable long paths — required on Windows where default limit is 260 chars
    await git.addConfig('core.longpaths', 'true');

    // Configure user identity
    await git.addConfig('user.name', cfg.username || caller.name);
    await git.addConfig('user.email', cfg.email || caller.email || 'noreply@perfstudio.com');

    // Create .gitignore at workspace root
    const gitignore = path.join(gitRoot, '.gitignore');
    fs.writeFileSync(gitignore, [
      '# PerfStudio — ignore large binary files and temp artifacts',
      '*_workspace/',
      '*.log',
      '*.tmp',
      'node_modules/',
      '.env',
    ].join('\n'));

    // Create / update README inside the project subfolder
    const readme = path.join(gitProjectPath, 'README.md');
    fs.writeFileSync(readme,
`# ${proj.name}

Performance test project managed by **PerfStudio** — AI-Powered Performance Testing.

## Folder Structure

\`\`\`
${proj.name}/
├── config/                  # Project-level configuration
├── <CollectionName>_<id>/   # One folder per API Source
│   ├── QA/
│   │   ├── testData/        # CSV files for QA environment
│   │   ├── scripts/         # Generated JMeter (.jmx) / K6 (.js) scripts
│   │   ├── results/         # Test run output & reports
│   │   └── config/          # Environment-specific config (URLs, ports)
│   ├── Staging/
│   │   └── ...              # Same structure as QA
│   └── UAT/
│       └── ...              # Same structure as QA
└── README.md
\`\`\`

## Branch Strategy

| Role      | Branch              | Can merge to main |
|-----------|---------------------|-------------------|
| Org Admin | \`main\`              | ✅ Direct push    |
| User      | \`users/<name>\`     | Via Pull Request  |

---
*Generated by PerfStudio*
`);

    // ── Build complete folder structure from DB ──────────────────────────────
    // Git ignores empty dirs — we add .gitkeep so GitHub shows the full tree.

    function mkKeep(dir) {
      fs.mkdirSync(dir, { recursive: true });
      const gitkeep = path.join(dir, '.gitkeep');
      if (!fs.existsSync(gitkeep)) fs.writeFileSync(gitkeep, '');
    }

    // 1. Build collection/env structure from DB — only real data, no placeholders
    const collections = db.prepare(
      'SELECT * FROM collections WHERE project_id = ?'
    ).all(req.params.projectId);

    // Remove stale folders created by earlier incorrect code
    ['_collections_placeholder', 'config'].forEach(sf => {
      const p = path.join(gitProjectPath, sf);
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    });

    // Remove stale 'scripts' (plural) dirs — app uses 'script' (singular) for generated files
    function removeStaleScriptsDir(dir) {
      if (!fs.existsSync(dir)) return;
      fs.readdirSync(dir).forEach(entry => {
        const full = path.join(dir, entry);
        if (fs.statSync(full).isDirectory()) {
          if (entry === 'scripts') fs.rmSync(full, { recursive: true, force: true });
          else removeStaleScriptsDir(full);
        }
      });
    }
    removeStaleScriptsDir(gitProjectPath);

    if (collections.length > 0) {
      for (const col of collections) {
        // Clean name only — no ID suffix (IDs are stored in DB, not needed in folder names)
        const colFolderName = col.name.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
        const colDir = path.join(gitProjectPath, colFolderName);

        // .gitkeep directly in collection folder so GitHub shows it as its own folder
        // (without this, GitHub collapses colFolder/env into a single path)
        mkKeep(colDir);

        let envs = [];
        try { envs = JSON.parse(col.environments || '[]'); } catch {}
        if (!envs.length && col.environment) envs = [col.environment];
        if (!envs.length) envs = ['Default'];
        for (const env of envs) {
          const base = path.join(colDir, env);

          // .gitkeep directly in env folder so GitHub shows it as its own folder
          mkKeep(base);

          mkKeep(path.join(base, 'testData'));
          mkKeep(path.join(base, 'script'));
          mkKeep(path.join(base, 'results'));
          mkKeep(path.join(base, 'config'));
        }
      }
    }

    // 3. Recursively add .gitkeep to EVERY folder in the workspace
    // (empty or not) so GitHub always shows the full folder tree.
    function ensureGitkeepAll(dir) {
      if (!fs.existsSync(dir) || path.basename(dir) === '.git') return;
      // Add .gitkeep to this directory
      const gk = path.join(dir, '.gitkeep');
      if (!fs.existsSync(gk)) fs.writeFileSync(gk, '');
      // Recurse into all subdirectories
      fs.readdirSync(dir).forEach(entry => {
        if (entry === '.git' || entry === '.gitkeep') return;
        const full = path.join(dir, entry);
        if (fs.statSync(full).isDirectory()) ensureGitkeepAll(full);
      });
    }
    // Apply to the full workspace tree (covers collections, envs, and all subfolders)
    ensureGitkeepAll(gitRoot);

    // Set or update remote
    const remotes = await git.getRemotes();
    if (remotes.find(r => r.name === 'origin')) {
      await git.remote(['set-url', 'origin', remoteWithAuth]);
    } else {
      await git.addRemote('origin', remoteWithAuth);
    }

    // ── Clean up nested .git dirs and stale _workspace folders ───────────────
    // Previous failed inits can leave nested git repos / workspace folders
    // inside gitRoot. Remove them before staging to prevent git errors.
    function cleanNestedGit(dir, isRoot = false) {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir)) {
        const full = path.join(dir, entry);
        try {
          const stat = fs.statSync(full);
          if (!stat.isDirectory()) continue;
          if (entry === '.git' && !isRoot) {
            // Nested .git — remove it
            fs.rmSync(full, { recursive: true, force: true });
          } else if (entry.endsWith('_workspace') && !isRoot) {
            // Stale nested workspace folder — remove it
            fs.rmSync(full, { recursive: true, force: true });
          } else {
            cleanNestedGit(full, false);
          }
        } catch (_) {}
      }
    }
    cleanNestedGit(gitRoot, true); // true = don't remove the top-level .git

    // Clean up any in-progress merge/rebase left over from a previous failed attempt.
    // Without this, git add/checkout fails with "needs merge — resolve index first".
    try { await git.raw(['merge', '--abort']); } catch {}
    try { await git.raw(['reset', '--hard', 'HEAD']); } catch {}

    const baseBranch = getBaseBranch(cfg);

    // Stage everything and make initial commit on base branch
    await git.checkout(['-B', baseBranch]);
    await git.add('.');
    const status = await git.status();
    if (status.staged.length > 0 || status.not_added.length > 0 || status.modified.length > 0) {
      await git.add('.');
      await git.commit('Initialize: PerfStudio project structure');
    }

    // Push to remote — handle non-fast-forward by temporarily disabling
    // branch protection, force-pushing, then re-enabling protection.
    const parsed   = parseGitHubOwnerRepo(cfg.remote_url);
    const rawToken = cfg.auth_token ? decrypt(cfg.auth_token) : '';

    // 1. Temporarily remove branch protection so force-push is allowed
    if (parsed && rawToken && cfg.provider === 'github') {
      try {
        const octokit = new Octokit({ auth: rawToken });
        await octokit.repos.deleteBranchProtection({ owner: parsed.owner, repo: parsed.repo, branch: baseBranch });
      } catch (_) { /* branch may not be protected yet — that's fine */ }
    }

    // 2. Push — handle remote that was created with a README or other initial content.
    //    Strategy:
    //      a) If remote already has the base branch: fetch + merge (--allow-unrelated-histories).
    //         If the merge produces conflicts (e.g. both sides have README/.gitignore),
    //         resolve by keeping our version, then regular push.
    //      b) If remote is empty: force-push to seed it.
    let pushed = false;
    const remoteRefs = await git.raw(['ls-remote', '--heads', 'origin']).catch(() => '');
    if (remoteRefs.includes(`refs/heads/${baseBranch}`)) {
      // Remote already has the base branch — must use merge path
      await git.fetch(['origin', baseBranch]);
      try {
        await git.merge(['FETCH_HEAD', '--allow-unrelated-histories', '--no-edit', '-m', 'Initialize: merge remote state']);
      } catch (_mergeErr) {
        // Merge produced conflicts — keep our version
        await git.raw(['checkout', '--ours', '--', '.']);
        await git.add('.');
        await git.commit('Initialize: PerfStudio project structure (resolved merge)');
      }
      await disableGcm(git);
      await git.push(['--set-upstream', 'origin', baseBranch]);
      pushed = true;
    }

    if (!pushed) {
      // Remote is empty — seed it with a force-push
      await git.raw(['push', '--force', '--set-upstream', 'origin', baseBranch]);
    }

    // 3. Apply branch protection after push
    const protectionResult = await applyBranchProtection(cfg);

    // Mark as initialized and save git_root (workspace directory)
    db.prepare('UPDATE git_configs SET is_initialized=1, git_root=? WHERE project_id=?')
      .run(gitRoot, req.params.projectId);

    db.prepare('INSERT INTO git_commits (project_id,user_id,branch,message,pushed) VALUES (?,?,?,?,?)')
      .run(req.params.projectId, req.userId, baseBranch, 'Initial commit: PerfStudio project structure', 1);

    const protectionWarning = protectionResult?.ok === false
      ? ` Note: Branch protection could not be applied (${protectionResult.error}). Add "Administration: Read & Write" permission to your GitHub token and re-initialize.`
      : '';
    res.json({ ok: true, message: `Repository initialized and pushed to ${baseBranch}.${protectionWarning}`, branch_protection: protectionResult?.ok !== false });
  } catch (e) {
    console.error('[Git] Init error:', e.message);
    res.status(500).json({ error: `Repository initialization failed: ${e.message}. Verify your remote URL, access token, and that the repository exists and is accessible.` });
  } finally {
    sshCleanup();
  }
});

// ── GET /status ───────────────────────────────────────────────────────────────

router.get('/status', async (req, res) => {
  const proj = getProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  const cfg = getGitConfig(req.params.projectId);
  if (!cfg?.is_initialized) return res.json({ initialized: false });

  const caller = getCaller(req.userId);

  try {
    const gitDir = getUserWorkspace(proj, caller);
    const git = gitInstance(gitDir);
    const status = await git.status();
    const branch = status.current;

    // Get line-level additions/deletions for tracked changed files
    let totalAdded = 0, totalDeleted = 0;
    try {
      // --numstat gives: <added>\t<deleted>\t<file> for each changed tracked file
      const numstatTracked = await git.raw(['diff', 'HEAD', '--numstat']);
      for (const line of numstatTracked.trim().split('\n').filter(Boolean)) {
        const [a, d] = line.split('\t');
        if (!isNaN(parseInt(a))) totalAdded   += parseInt(a);
        if (!isNaN(parseInt(d))) totalDeleted += parseInt(d);
      }
    } catch {}

    // Count lines in untracked files as additions (they are entirely new)
    for (const uf of status.not_added) {
      try {
        const absPath = path.join(gitDir, uf);
        if (fs.existsSync(absPath)) {
          const content = fs.readFileSync(absPath, 'utf8');
          totalAdded += content.split('\n').length;
        }
      } catch {}
    }

    res.json({
      initialized: true,
      branch,
      modified: status.modified,
      not_added: status.not_added,
      deleted: status.deleted,
      staged: status.staged,
      is_clean: status.isClean(),
      ahead: status.ahead,
      behind: status.behind,
      additions: totalAdded,
      deletions: totalDeleted,
    });
  } catch (e) {
    res.status(500).json({ error: `Failed to read git status: ${e.message}. The workspace may need to be re-initialized.` });
  }
});

// ── POST /commit ──────────────────────────────────────────────────────────────

router.post('/commit', async (req, res) => {
  const proj = getProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  const cfg = getGitConfig(req.params.projectId);
  if (!cfg?.is_initialized) return res.status(400).json({ error: 'Git not initialized for this project.' });

  const caller = getCaller(req.userId);
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Commit message required.' });

  let sshCleanup = () => {};
  try {
    const gitDir = getUserWorkspace(proj, caller);
    // Auto-clone repo into user's workspace if this is their first commit
    const result = await ensureUserWorkspace(gitDir, { ...cfg, project_id: req.params.projectId }, caller);
    const { git, identity } = result;
    sshCleanup = result.sshCleanup || (() => {});
    const branch = identity?.branch_name || getBranchForUser(caller, cfg);

    const baseBranch = getBaseBranch(cfg);
    // Pull latest base branch then switch to user's branch
    try { await git.fetch('origin', baseBranch); } catch {}
    const branches = await git.branchLocal();
    if (branches.all.includes(branch)) {
      await git.checkout(branch);
    } else {
      await git.checkout(['-b', branch, `origin/${baseBranch}`]).catch(() => git.checkout(['-b', branch]));
    }

    // Stage all changes
    await git.add('.');
    const status = await git.status();

    if (status.staged.length === 0) {
      return res.json({ ok: true, message: 'Nothing to commit — working tree clean.', hash: null });
    }

    const commitResult = await git.commit(message.trim());
    const hash = commitResult.commit || '';

    db.prepare('INSERT INTO git_commits (project_id,user_id,branch,message,hash) VALUES (?,?,?,?,?)')
      .run(req.params.projectId, req.userId, branch, message.trim(), hash);

    res.json({ ok: true, hash, branch, message: `Committed to branch "${branch}".` });
  } catch (e) {
    console.error('[Git] Commit error:', e.message);
    res.status(500).json({ error: `Commit failed: ${e.message}. Ensure there are staged changes and your Git identity (name/email) is configured in Git Identity settings.` });
  } finally {
    sshCleanup();
  }
});

// ── POST /push ────────────────────────────────────────────────────────────────

router.post('/push', async (req, res) => {
  const proj = getProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  const cfg = getGitConfig(req.params.projectId);
  if (!cfg?.is_initialized) return res.status(400).json({ error: 'Git not initialized.' });

  const caller = getCaller(req.userId);

  const { remoteUrl, sshEnv, cleanup: sshCleanup } = getAuth(cfg, caller.id, req.params.projectId);
  try {
    const gitDir = getUserWorkspace(proj, caller);
    const git = gitInstance(gitDir, sshEnv);
    const userIdentity = db.prepare('SELECT * FROM user_git_configs WHERE user_id = ? AND project_id = ?').get(caller.id, req.params.projectId);

    const branch = userIdentity?.branch_name || getBranchForUser(caller, cfg);
    await git.addConfig('user.name',  userIdentity?.author_name  || caller.name);
    await git.addConfig('user.email', userIdentity?.author_email || caller.email || cfg.email || 'noreply@perfstudio.com');

    const baseBranch = getBaseBranch(cfg);
    // Ensure on correct branch
    await git.checkout(branch).catch(async () => {
      await git.checkout(['-b', branch, baseBranch]).catch(() => git.checkout(['-b', branch]));
    });

    // Update remote URL
    await git.remote(['set-url', 'origin', remoteUrl]);

    await disableGcm(git);
    await git.push(['--set-upstream', 'origin', branch]);

    // Mark commits as pushed
    db.prepare("UPDATE git_commits SET pushed=1 WHERE project_id=? AND branch=? AND pushed=0")
      .run(req.params.projectId, branch);

    res.json({ ok: true, branch, message: `Pushed to origin/${branch} successfully.` });
  } catch (e) {
    console.error('[Git] Push error:', e.message);
    res.status(500).json({ error: `Push failed: ${e.message}. Check that your access token has write permission to the repository and is not expired.` });
  } finally {
    sshCleanup();
  }
});

// ── POST /pull ────────────────────────────────────────────────────────────────

router.post('/pull', async (req, res) => {
  const proj = getProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  const cfg = getGitConfig(req.params.projectId);
  if (!cfg?.is_initialized) return res.status(400).json({ error: 'Git not initialized.' });

  const caller = getCaller(req.userId);

  const { remoteUrl, sshEnv, cleanup: sshCleanup } = getAuth(cfg, caller.id, req.params.projectId);
  try {
    const gitDir = getUserWorkspace(proj, caller);
    const git = gitInstance(gitDir, sshEnv);
    const branch = getBranchForUser(caller, cfg);

    await git.remote(['set-url', 'origin', remoteUrl]);

    // Check if the user's branch exists on the remote
    let remoteBranches = [];
    try {
      const lsRemote = await git.listRemote(['--heads', 'origin']);
      remoteBranches = lsRemote.split('\n')
        .map(l => l.replace(/.*refs\/heads\//, '').trim())
        .filter(Boolean);
    } catch (_) {}

    const branchExistsOnRemote = remoteBranches.includes(branch);

    if (branchExistsOnRemote) {
      // Branch exists on remote — pull directly from it
      await git.checkout(branch).catch(() => git.checkout(['-b', branch, `origin/${branch}`]));
      await git.pull('origin', branch, { '--rebase': 'false' });
      res.json({ ok: true, message: `Pulled latest from origin/${branch}.` });
    } else {
      // Branch doesn't exist on remote yet:
      // 1. Fetch latest base branch from remote
      // 2. Create local branch from it (or sync if it already exists locally)
      // 3. Push the branch to remote immediately — so it exists for future pulls
      const baseBranch = getBaseBranch(cfg);
      await git.fetch('origin', baseBranch);

      const localBranches = await git.branchLocal();
      if (!localBranches.all.includes(branch)) {
        await git.checkout(['-b', branch, `origin/${baseBranch}`]);
      } else {
        await git.checkout(branch);
        await git.merge([`origin/${baseBranch}`, '--no-edit']).catch(() => {});
      }

      // Auto-push to create the remote branch so future pulls work seamlessly
      await disableGcm(git);
      await git.push(['--set-upstream', 'origin', branch]);

      // Protect feature branch: no force-push, no deletion (but no PR review required)
      await applyBranchProtection({ ...cfg, _featureBranch: true }, branch);

      res.json({
        ok: true,
        message: `Branch "${branch}" created from ${baseBranch} and pushed to remote. Branch protection applied.`,
      });
    }
  } catch (e) {
    res.status(500).json({ error: `Branch setup failed: ${e.message}. Verify the branch name is valid and the repository is accessible with your access token.` });
  } finally {
    sshCleanup();
  }
});

// ── GET /branches ─────────────────────────────────────────────────────────────

router.get('/branches', async (req, res) => {
  const proj = getProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  const cfg = getGitConfig(req.params.projectId);
  if (!cfg?.is_initialized) return res.json({ branches: [], current: null });

  const caller = getCaller(req.userId);
  try {
    const gitDir = getUserWorkspace(proj, caller);
    const git = gitInstance(gitDir);

    // Only return LOCAL branches — no remotes/origin/... tracking refs.
    // Also exclude the base branch (main) since users never work directly on it.
    const summary = await git.branchLocal();
    const baseBranch = getBaseBranch(cfg);
    const userBranches = summary.all.filter(b => b !== baseBranch);

    res.json({
      branches: userBranches,
      current: summary.current,
    });
  } catch (e) {
    res.status(500).json({ error: `Failed to list branches: ${e.message}. The git workspace may need to be re-initialized.` });
  }
});

// ── GET /log ──────────────────────────────────────────────────────────────────

router.get('/log', async (req, res) => {
  const proj = getProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  const cfg = getGitConfig(req.params.projectId);
  if (!cfg?.is_initialized) return res.json({ commits: [] });

  const caller = getCaller(req.userId);
  try {
    const gitDir = getUserWorkspace(proj, caller);
    const git = gitInstance(gitDir);
    const log = await git.log(['--max-count=20']);
    res.json({ commits: log.all });
  } catch (e) {
    res.status(500).json({ error: `Failed to load commit log: ${e.message}.` });
  }
});

// ── GET /prs ──────────────────────────────────────────────────────────────────

router.get('/prs', (req, res) => {
  const proj = getProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  const prs = db.prepare(`
    SELECT p.*, u.name as author_name, u.email as author_email
    FROM git_prs p LEFT JOIN users u ON u.id = p.created_by
    WHERE p.project_id = ? ORDER BY p.created_at DESC
  `).all(req.params.projectId);

  res.json({ prs });
});

// ── POST /prs — create PR ─────────────────────────────────────────────────────

router.post('/prs', async (req, res) => {
  const proj = getProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  const caller = getCaller(req.userId);
  const { title, description } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'PR title required.' });

  const cfg = getGitConfig(req.params.projectId);
  if (!cfg?.is_initialized) return res.status(400).json({ error: 'Git not initialized.' });

  const baseBranch = getBaseBranch(cfg);
  const branch = getBranchForUser(caller, cfg);
  if (branch === baseBranch) return res.status(400).json({ error: `Org admins push directly to ${baseBranch} — no PR needed.` });

  let remotePrUrl = '';

  // Try to create PR on GitHub/GitLab
  try {
    if (cfg.provider === 'github' && cfg.auth_token) {
      const token = decrypt(cfg.auth_token);
      const octokit = new Octokit({ auth: token });

      // Extract owner/repo from remote URL
      const match = cfg.remote_url.match(/github\.com[:/](.+?)\/(.+?)(?:\.git)?$/);
      if (match) {
        const [, owner, repo] = match;
        const pr = await octokit.pulls.create({
          owner, repo,
          title: title.trim(),
          body: description || '',
          head: branch,
          base: baseBranch,
        });
        remotePrUrl = pr.data.html_url;
      }
    }
  } catch (e) {
    console.error('[Git] Remote PR creation failed:', e.message);
    // Continue — store PR locally even if remote fails
  }

  const result = db.prepare(`
    INSERT INTO git_prs (project_id, title, description, from_branch, to_branch, created_by, remote_pr_url)
    VALUES (?,?,?,?,?,?,?)
  `).run(req.params.projectId, title.trim(), description||'', branch, baseBranch, req.userId, remotePrUrl);

  const pr = db.prepare('SELECT * FROM git_prs WHERE id = ?').get(result.lastInsertRowid);
  res.json({ ok: true, pr, remote_pr_url: remotePrUrl });
});

// ── PUT /prs/:prId/merge ──────────────────────────────────────────────────────

router.put('/prs/:prId/merge', async (req, res) => {
  const caller = getCaller(req.userId);
  if (!['org_admin', 'super_admin'].includes(caller.role)) {
    return res.status(403).json({ error: 'Only org admins can merge PRs.' });
  }
  const proj = getProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  const pr = db.prepare('SELECT * FROM git_prs WHERE id = ? AND project_id = ?')
    .get(req.params.prId, req.params.projectId);
  if (!pr) return res.status(404).json({ error: 'PR not found.' });
  if (pr.status !== 'open') return res.status(400).json({ error: `PR is already ${pr.status}.` });

  const cfg = getGitConfig(req.params.projectId);

  const { remoteUrl: mergeRemoteUrl, sshEnv: mergeSshEnv, cleanup: mergeSshCleanup } = getAuth(cfg, req.userId, req.params.projectId);
  try {
    const gitDir = getUserWorkspace(proj, caller);
    const git = gitInstance(gitDir, mergeSshEnv);

    await git.addConfig('user.name', cfg.username || caller.name);
    await git.addConfig('user.email', cfg.email || caller.email || 'noreply@perfstudio.com');
    await git.remote(['set-url', 'origin', mergeRemoteUrl]);

    // Fetch the feature branch
    await git.fetch('origin', pr.from_branch);

    const baseBranch = getBaseBranch(cfg);
    // Switch to base branch
    await git.checkout(baseBranch);
    await git.pull('origin', baseBranch, { '--rebase': 'false' });

    // Merge feature branch
    await git.merge([`origin/${pr.from_branch}`, '--no-ff', '--allow-unrelated-histories', '-m', `Merge PR: ${pr.title}`]);

    // Push merged base branch
    await disableGcm(git);
    await git.push('origin', baseBranch);

    // ── Also merge on GitHub if PR has a remote URL ─────────────────────────
    if (pr.remote_pr_url) {
      try {
        const rawToken = cfg?.auth_token ? decrypt(cfg.auth_token) : '';
        const prNumMatch = pr.remote_pr_url.match(/\/pull\/(\d+)/);
        const parsed     = parseGitHubOwnerRepo(cfg?.remote_url || '');
        if (rawToken && prNumMatch && parsed && cfg?.provider === 'github') {
          const octokit = new Octokit({ auth: rawToken });
          await octokit.pulls.merge({
            owner:        parsed.owner,
            repo:         parsed.repo,
            pull_number:  parseInt(prNumMatch[1]),
            merge_method: 'merge',
            commit_title: `Merge PR: ${pr.title}`,
          });
        }
      } catch (e) {
        console.warn('[Git] GitHub merge PR failed (local merge still applied):', e.message);
      }
    }

    // Mark PR as merged
    db.prepare("UPDATE git_prs SET status='merged' WHERE id=?").run(pr.id);

    db.prepare('INSERT INTO git_commits (project_id,user_id,branch,message,pushed) VALUES (?,?,?,?,?)')
      .run(req.params.projectId, req.userId, baseBranch, `Merge PR: ${pr.title}`, 1);

    res.json({ ok: true, message: `PR "${pr.title}" merged into ${baseBranch}.` });
  } catch (e) {
    console.error('[Git] Merge error:', e.message);
    res.status(500).json({ error: `Merge failed: ${e.message}. There may be merge conflicts or your token lacks write access to the ${getBaseBranch(cfg)} branch.` });
  } finally {
    mergeSshCleanup();
  }
});

// ── PUT /prs/:prId/close ──────────────────────────────────────────────────────

router.put('/prs/:prId/close', async (req, res) => {
  const caller = getCaller(req.userId);
  const pr = db.prepare('SELECT * FROM git_prs WHERE id = ? AND project_id = ?')
    .get(req.params.prId, req.params.projectId);
  if (!pr) return res.status(404).json({ error: 'PR not found.' });

  // PR author or org admin can close
  if (pr.created_by !== req.userId && !['org_admin','super_admin'].includes(caller.role)) {
    return res.status(403).json({ error: 'Not authorized.' });
  }

  // ── Close on GitHub if we have a remote PR URL ────────────────────────────
  if (pr.remote_pr_url) {
    try {
      const cfg = getGitConfig(req.params.projectId);

      // Prefer the closer's personal PAT, fall back to project config token
      const userIdentity = db.prepare('SELECT auth_token FROM user_git_configs WHERE user_id = ? AND project_id = ?')
        .get(req.userId, req.params.projectId);
      const rawToken = userIdentity?.auth_token
        ? decrypt(userIdentity.auth_token)
        : (cfg?.auth_token ? decrypt(cfg.auth_token) : '');

      // Extract PR number from URL: https://github.com/owner/repo/pull/42
      const prNumMatch = pr.remote_pr_url.match(/\/pull\/(\d+)/);
      const parsed     = parseGitHubOwnerRepo(cfg?.remote_url || '');

      if (rawToken && prNumMatch && parsed && cfg?.provider === 'github') {
        const octokit   = new Octokit({ auth: rawToken });
        await octokit.pulls.update({
          owner:        parsed.owner,
          repo:         parsed.repo,
          pull_number:  parseInt(prNumMatch[1]),
          state:        'closed',
        });
      }
    } catch (e) {
      console.warn('[Git] GitHub close PR failed:', e.message);
      // Don't block local update on GitHub API failure
    }
  }

  db.prepare("UPDATE git_prs SET status='closed' WHERE id=?").run(pr.id);
  res.json({ ok: true });
});

// ── GET /identity ─────────────────────────────────────────────────────────────
router.get('/identity', (req, res) => {
  const proj = getProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  const caller = getCaller(req.userId);
  const identity = db.prepare('SELECT * FROM user_git_configs WHERE user_id = ? AND project_id = ?')
    .get(req.userId, req.params.projectId);
  const safe = caller.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-');
  const defaultBranch = `feature/${safe}`;
  res.json({
    identity: {
      branch_name:  identity?.branch_name  || defaultBranch,
      author_name:  identity?.author_name  || caller.name,
      author_email: identity?.author_email || caller.email || '',
      auth_token:   identity?.auth_token   ? '••••••••' : '',
      auth_method:  identity?.auth_method  || 'pat',
      ssh_key_set:  !!(identity?.ssh_key),
    }
  });
});

// ── PUT /identity ─────────────────────────────────────────────────────────────
router.put('/identity', (req, res) => {
  const proj = getProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  const { branch_name, author_name, author_email, auth_token, auth_method, ssh_key } = req.body;
  const existing = db.prepare('SELECT * FROM user_git_configs WHERE user_id = ? AND project_id = ?')
    .get(req.userId, req.params.projectId);

  const finalToken = (auth_token && auth_token !== '••••••••')
    ? encrypt(auth_token)
    : (existing?.auth_token || '');

  const finalMethod = auth_method || existing?.auth_method || 'pat';

  // SSH key: encrypt new value if provided, keep existing otherwise
  const finalSshKey = (ssh_key && ssh_key !== '••••••••')
    ? encrypt(ssh_key)
    : (existing?.ssh_key || '');

  if (existing) {
    db.prepare('UPDATE user_git_configs SET branch_name=?,author_name=?,author_email=?,auth_token=?,auth_method=?,ssh_key=? WHERE user_id=? AND project_id=?')
      .run(branch_name||'', author_name||'', author_email||'', finalToken, finalMethod, finalSshKey, req.userId, req.params.projectId);
  } else {
    db.prepare('INSERT INTO user_git_configs (user_id,project_id,branch_name,author_name,author_email,auth_token,auth_method,ssh_key) VALUES (?,?,?,?,?,?,?,?)')
      .run(req.userId, req.params.projectId, branch_name||'', author_name||'', author_email||'', finalToken, finalMethod, finalSshKey);
  }
  res.json({ ok: true });
});

// ── POST /branch — create/switch to user's personal branch from main ──────────
router.post('/branch', async (req, res) => {
  const proj = getProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  const cfg = getGitConfig(req.params.projectId);
  if (!cfg?.remote_url) return res.status(400).json({ error: 'Repository not configured.' });
  if (!cfg?.is_initialized) return res.status(400).json({ error: 'Repository not initialized. Ask an admin to initialize it first.' });
  const caller = getCaller(req.userId);
  const identity = db.prepare('SELECT * FROM user_git_configs WHERE user_id = ? AND project_id = ?')
    .get(req.userId, req.params.projectId);

  // Prefer branch name from request body (current form value) over the saved DB value
  const branchName = (req.body.branch_name || '').trim() || identity?.branch_name;
  if (!branchName) return res.status(400).json({ error: 'Enter a branch name in Git Identity first.' });

  // For regular users, require a personal PAT/SSH key so the push is attributed to their account
  const isAdmin = caller.role === 'org_admin' || caller.role === 'super_admin';
  if (!isAdmin) {
    const authMethod = identity?.auth_method || cfg?.auth_method || 'pat';
    const hasPersonalToken = identity?.auth_token && identity.auth_token.trim();
    const hasPersonalSshKey = identity?.ssh_key && identity.ssh_key.trim();
    if (authMethod === 'ssh' && !hasPersonalSshKey) {
      return res.status(400).json({
        error: 'Please save your SSH key in Git Identity before creating a branch.',
      });
    }
    if (authMethod !== 'ssh' && !hasPersonalToken) {
      return res.status(400).json({
        error: 'Please save your Personal Access Token in Git Identity before creating a branch. Without it, the branch would be pushed under the org admin\'s GitHub account.',
      });
    }
  }

  // Use the per-user workspace (clones from remote if not yet set up)
  const gitRoot = getUserWorkspace(proj, caller);
  let sshCleanup = () => {};
  try {
    const r = await ensureUserWorkspace(gitRoot, { ...cfg, project_id: req.params.projectId }, caller);
    const { git } = r;
    sshCleanup = r.sshCleanup || (() => {});

    const branchSummary = await git.branchLocal();
    if (branchSummary.all.includes(branchName)) {
      await git.checkout(branchName);
      return res.json({ message: `Switched to existing branch: ${branchName}`, branch: branchName });
    }
    const baseBranch = getBaseBranch(cfg);
    // Create from latest base branch
    try { await git.fetch('origin', baseBranch); } catch {}
    try { await git.checkout(baseBranch); } catch {}
    await git.checkoutLocalBranch(branchName);

    // Push branch to remote and apply protection
    await disableGcm(git);
    await git.push(['--set-upstream', 'origin', branchName]);
    await applyBranchProtection({ ...cfg, _featureBranch: true }, branchName);

    res.json({ message: `Branch "${branchName}" created from ${baseBranch} and pushed to remote.`, branch: branchName });
  } catch (err) {
    console.error('Branch error:', err);
    res.status(500).json({ error: `Failed to create user branch: ${err.message}. Verify the repository is accessible and the branch does not already exist remotely.` });
  } finally {
    sshCleanup();
  }
});

// ── PUT /prs/:prId/push-close — force-close on GitHub for already-closed-locally PRs ──

router.put('/prs/:prId/push-close', async (req, res) => {
  const caller = getCaller(req.userId);
  const pr = db.prepare('SELECT * FROM git_prs WHERE id = ? AND project_id = ?')
    .get(req.params.prId, req.params.projectId);
  if (!pr) return res.status(404).json({ error: 'PR not found.' });
  if (pr.created_by !== req.userId && !['org_admin','super_admin'].includes(caller.role)) {
    return res.status(403).json({ error: 'Not authorized.' });
  }
  if (!pr.remote_pr_url) return res.status(400).json({ error: 'No remote PR URL found.' });

  try {
    const cfg = getGitConfig(req.params.projectId);
    const userIdentity = db.prepare('SELECT auth_token FROM user_git_configs WHERE user_id = ? AND project_id = ?')
      .get(req.userId, req.params.projectId);
    const rawToken = userIdentity?.auth_token
      ? decrypt(userIdentity.auth_token)
      : (cfg?.auth_token ? decrypt(cfg.auth_token) : '');
    const prNumMatch = pr.remote_pr_url.match(/\/pull\/(\d+)/);
    const parsed     = parseGitHubOwnerRepo(cfg?.remote_url || '');
    if (!rawToken || !prNumMatch || !parsed || cfg?.provider !== 'github') {
      return res.status(400).json({ error: 'GitHub token or repo info missing.' });
    }
    const octokit = new Octokit({ auth: rawToken });
    await octokit.pulls.update({
      owner:       parsed.owner,
      repo:        parsed.repo,
      pull_number: parseInt(prNumMatch[1]),
      state:       'closed',
    });
    db.prepare("UPDATE git_prs SET status='closed' WHERE id=?").run(pr.id);
    res.json({ ok: true, message: 'PR closed on GitHub.' });
  } catch (e) {
    console.error('[Git] push-close error:', e.message);
    res.status(500).json({ error: `Failed to close PR on GitHub: ${e.message}. Verify your GitHub token has pull request write permissions.` });
  }
});

// ── PUT /prs/:prId/mark-merged — admin marks PR merged (when merged outside PerfStudio) ──

router.put('/prs/:prId/mark-merged', (req, res) => {
  const caller = getCaller(req.userId);
  if (!['org_admin', 'super_admin'].includes(caller.role)) {
    return res.status(403).json({ error: 'Only org admins can mark PRs as merged.' });
  }
  const pr = db.prepare('SELECT * FROM git_prs WHERE id = ? AND project_id = ?')
    .get(req.params.prId, req.params.projectId);
  if (!pr) return res.status(404).json({ error: 'PR not found.' });

  db.prepare("UPDATE git_prs SET status='merged' WHERE id=?").run(pr.id);
  res.json({ ok: true });
});

// ── POST /prs/sync — sync all open PR statuses from GitHub ───────────────────

router.post('/prs/sync', async (req, res) => {
  const proj = getProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  const cfg = getGitConfig(req.params.projectId);
  if (!cfg?.auth_token) return res.json({ ok: true, synced: 0, message: 'No GitHub token configured.' });

  const openPrs = db.prepare(
    "SELECT * FROM git_prs WHERE project_id = ? AND status = 'open' AND remote_pr_url != ''"
  ).all(req.params.projectId);

  if (!openPrs.length) return res.json({ ok: true, synced: 0, message: 'No open PRs to sync.' });

  let synced = 0;
  try {
    const token = cfg.auth_token ? require('../utils/encryption').decrypt(cfg.auth_token) : '';
    const octokit = new Octokit({ auth: token });
    const match = cfg.remote_url.match(/github\.com[:/](.+?)\/(.+?)(?:\.git)?$/);
    if (!match) return res.json({ ok: true, synced: 0, message: 'Could not parse GitHub repo URL.' });
    const [, owner, repo] = match;

    for (const pr of openPrs) {
      try {
        // Extract PR number from URL: https://github.com/owner/repo/pull/123
        const prNumMatch = pr.remote_pr_url.match(/\/pull\/(\d+)$/);
        if (!prNumMatch) continue;
        const prNumber = parseInt(prNumMatch[1]);

        const { data } = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
        let newStatus = null;
        if (data.state === 'closed' && data.merged) newStatus = 'merged';
        else if (data.state === 'closed') newStatus = 'closed';

        if (newStatus) {
          db.prepare("UPDATE git_prs SET status=? WHERE id=?").run(newStatus, pr.id);
          synced++;
        }
      } catch (_) {}
    }
  } catch (e) {
    console.error('[Git] PR sync error:', e.message);
  }

  res.json({ ok: true, synced, message: synced > 0 ? `Synced ${synced} PR(s) from GitHub.` : 'All PRs already up to date.' });
});

// ── GET /diff — get diff for a specific file ──────────────────────────────────
router.get('/diff', async (req, res) => {
  const proj = getProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  const cfg = getGitConfig(req.params.projectId);
  if (!cfg?.is_initialized) return res.status(400).json({ error: 'Git not initialized.' });
  const caller = getCaller(req.userId);
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'path query param required' });
  try {
    const gitDir = getUserWorkspace(proj, caller);
    const git = gitInstance(gitDir);

    let diff = '';
    let isNewFile = false;
    try {
      // Use -U999999 to get the ENTIRE file content as context (not just changed hunks)
      diff = await git.diff(['HEAD', '-U999999', '--', filePath]);
      if (!diff) diff = await git.diff(['--cached', '-U999999', '--', filePath]);
      if (!diff) diff = await git.diff(['-U999999', '--', filePath]);
    } catch {}

    // If diff is still empty the file is untracked — read full content and
    // format every line as an addition so the viewer shows the whole file.
    if (!diff) {
      const absPath = path.resolve(gitDir, filePath);
      if (fs.existsSync(absPath)) {
        isNewFile = true;
        const content = fs.readFileSync(absPath, 'utf8');
        const lines = content.split('\n');
        const header = [
          `diff --git a/${filePath} b/${filePath}`,
          `new file mode 100644`,
          `--- /dev/null`,
          `+++ b/${filePath}`,
          `@@ -0,0 +0,${lines.length} @@`,
        ].join('\n');
        diff = header + '\n' + lines.map(l => '+' + l).join('\n');
      }
    }

    res.json({ diff, path: filePath, isNewFile });
  } catch (e) {
    res.status(500).json({ error: `Failed to generate diff: ${e.message}.` });
  }
});

// ── POST /discard — discard changes to specific files ────────────────────────
router.post('/discard', async (req, res) => {
  const proj = getProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  const cfg = getGitConfig(req.params.projectId);
  if (!cfg?.is_initialized) return res.status(400).json({ error: 'Git not initialized.' });
  const caller = getCaller(req.userId);
  const { paths } = req.body; // array of file paths
  if (!paths?.length) return res.status(400).json({ error: 'paths array required' });
  try {
    const gitDir = getUserWorkspace(proj, caller);
    const git = gitInstance(gitDir);

    for (const p of paths) {
      const absPath = path.join(gitDir, p);
      // Check if file is tracked (committed) or untracked (new)
      let isTracked = false;
      try {
        await git.raw(['ls-files', '--error-unmatch', p]);
        isTracked = true;
      } catch {}

      if (isTracked) {
        // Tracked file: restore to last committed state
        try { await git.checkout(['--', p]); } catch {}
      } else {
        // Untracked file: delete directly from disk (git clean unreliable for nested dirs)
        try {
          if (fs.existsSync(absPath)) {
            const stat = fs.statSync(absPath);
            if (stat.isDirectory()) {
              fs.rmSync(absPath, { recursive: true, force: true });
            } else {
              fs.unlinkSync(absPath);
            }
          }
        } catch (delErr) {
          console.warn('[Git] Discard delete failed:', delErr.message);
        }
      }
    }

    res.json({ ok: true, message: `Discarded changes in ${paths.length} file(s)` });
  } catch (e) {
    res.status(500).json({ error: `Failed to discard changes: ${e.message}. Some files may be locked or the workspace may be in an inconsistent state.` });
  }
});

// ── POST /fetch — fetch from remote ─────────────────────────────────────────
router.post('/fetch', async (req, res) => {
  const proj = getProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  const cfg = getGitConfig(req.params.projectId);
  if (!cfg?.is_initialized) return res.status(400).json({ error: 'Git not initialized.' });
  const caller = getCaller(req.userId);
  let sshCleanup = () => {};
  try {
    const gitDir = getUserWorkspace(proj, caller);
    const r = await ensureUserWorkspace(gitDir, { ...cfg, project_id: req.params.projectId }, caller);
    sshCleanup = r.sshCleanup || (() => {});
    const result = await r.git.fetch(r.remoteWithAuth);
    res.json({ ok: true, message: 'Fetched latest from remote successfully.', output: result });
  } catch (e) {
    res.status(500).json({ error: `Fetch failed: ${e.message}. Verify your access token and network connectivity.` });
  } finally {
    sshCleanup();
  }
});

// ── POST /test — test remote connection ──────────────────────────────────────
router.post('/test', async (req, res) => {
  const proj = getProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  const cfg = getGitConfig(req.params.projectId);
  if (!cfg?.remote_url) return res.status(400).json({ error: 'Remote URL not configured.' });

  const { isSSH, remoteUrl, sshEnv, cleanup: sshCleanup } = getAuth(cfg, req.userId, req.params.projectId);

  try {
    if (isSSH) {
      if (!sshEnv.GIT_SSH_COMMAND) {
        return res.status(400).json({ error: 'No SSH key configured. Add your private key in Git Identity first.' });
      }
      const git = simpleGit({ env: { ...process.env, ...sshEnv } });
      await git.listRemote(['--heads', remoteUrl]);
      res.json({ ok: true, message: 'SSH connection successful! Repository is accessible.', token_preview: 'SSH key' });
    } else {
      const identity = db.prepare('SELECT * FROM user_git_configs WHERE user_id = ? AND project_id = ?').get(req.userId, req.params.projectId);
      const rawToken = identity?.auth_token ? decrypt(identity.auth_token) : (cfg.auth_token ? decrypt(cfg.auth_token) : '');
      if (!rawToken) return res.status(400).json({ error: 'No authentication token configured.' });
      const git = simpleGit();
      await git.listRemote(['--heads', remoteUrl]);
      const tokenPreview = rawToken.length > 8 ? rawToken.slice(0, 4) + '••••' + rawToken.slice(-4) : '••••••••';
      res.json({ ok: true, message: 'Connection successful! Repository is accessible.', token_preview: tokenPreview });
    }
  } catch (e) {
    res.status(400).json({ ok: false, error: 'Connection failed: ' + (e.message || 'Unable to reach remote.') });
  } finally {
    sshCleanup();
  }
});

// ── POST /sync — sync user branch with latest base branch ────────────────────
router.post('/sync', async (req, res) => {
  const proj = getProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  const cfg = getGitConfig(req.params.projectId);
  if (!cfg?.is_initialized) return res.status(400).json({ error: 'Git not initialized.' });
  const caller = getCaller(req.userId);
  let sshCleanup = () => {};
  try {
    const gitDir = getUserWorkspace(proj, caller);
    const r = await ensureUserWorkspace(gitDir, { ...cfg, project_id: req.params.projectId }, caller);
    sshCleanup = r.sshCleanup || (() => {});
    const branch = r.identity?.branch_name || getBranchForUser(caller, cfg);
    const baseBranch = getBaseBranch(cfg);
    await r.git.fetch(r.remoteWithAuth, baseBranch);
    const currentBranch = (await r.git.status()).current;
    if (currentBranch !== branch) {
      const branches = await r.git.branchLocal();
      if (branches.all.includes(branch)) await r.git.checkout(branch);
    }
    await r.git.merge([`origin/${baseBranch}`, '--no-edit', '--allow-unrelated-histories']);
    res.json({ ok: true, message: `Branch "${branch}" synced with latest ${baseBranch}.` });
  } catch (e) {
    res.status(500).json({ error: `Sync failed: ${e.message}. There may be merge conflicts between your branch and the base branch — resolve conflicts manually or contact your admin.` });
  } finally {
    sshCleanup();
  }
});

// ── POST /exec — run allowed git command in terminal ─────────────────────────
const EXEC_ALLOWLIST = new Set([
  'status', 'log', 'diff', 'branch', 'stash', 'show', 'ls-files',
  'remote', 'tag', 'shortlog', 'describe', 'rev-parse', 'cat-file',
  'check-ignore', 'config --list', 'fetch', 'merge-base',
]);

router.post('/exec', async (req, res) => {
  const proj = getProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  const cfg = getGitConfig(req.params.projectId);
  if (!cfg?.is_initialized) return res.status(400).json({ error: 'Git not initialized.' });
  const caller = getCaller(req.userId);
  let { command } = req.body;
  if (!command?.trim()) return res.status(400).json({ error: 'command required' });
  // Strip leading "git " if present
  command = command.trim().replace(/^git\s+/, '');
  const subcommand = command.split(/\s+/)[0];
  if (!EXEC_ALLOWLIST.has(subcommand)) {
    return res.status(403).json({ error: `Command "${subcommand}" is not allowed. Permitted: ${[...EXEC_ALLOWLIST].join(', ')}` });
  }
  try {
    const gitDir = getUserWorkspace(proj, caller);
    const { execSync } = require('child_process');
    const output = execSync(`git ${command}`, { cwd: gitDir, timeout: 10000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    res.json({ ok: true, output: output || '(no output)' });
  } catch (e) {
    res.json({ ok: false, output: e.stderr || e.stdout || e.message });
  }
});

module.exports = router;
