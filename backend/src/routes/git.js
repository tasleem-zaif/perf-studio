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

function getBranchForUser(user, project) {
  if (user.role === 'org_admin' || user.role === 'super_admin') return 'main';
  const safe = user.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-');
  return `users/${safe}`;
}

function gitInstance(projectPath) {
  return simpleGit(projectPath);
}

// ── Per-user workspace path ───────────────────────────────────────────────────
// Structure:
//   git-workspaces/
//   ├── admin/          ← org admin workspace
//   │   ├── .git/
//   │   └── projects/
//   │       └── Demo-1/
//   ├── user-3/         ← regular user ID 3
//   │   ├── .git/
//   │   └── projects/
//   │       └── Demo-1/
//   └── user-7/         ← regular user ID 7
//       ├── .git/
//       └── projects/
//           └── Demo-1/
const GIT_WORKSPACES_ROOT = path.join(__dirname, '..', '..', '..', 'git-workspaces');

function getCleanProjectName(proj) {
  return proj.name.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

function getUserWorkspace(proj, user) {
  // No project-name level — workspace is per user only
  const userFolder = (user.role === 'org_admin' || user.role === 'super_admin')
    ? 'admin'
    : `user-${user.id}`;
  return path.join(GIT_WORKSPACES_ROOT, userFolder);
}

// Clone or pull-update a user's workspace from the remote
async function ensureUserWorkspace(gitRoot, cfg, user) {
  const token  = cfg.auth_token ? decrypt(cfg.auth_token) : '';

  // Use user's personal PAT if available, otherwise fall back to project config token
  const identity = db.prepare('SELECT * FROM user_git_configs WHERE user_id = ? AND project_id = ?')
    .get(user.id, cfg.project_id);
  const personalToken = identity?.auth_token ? decrypt(identity.auth_token) : token;
  const effectiveToken = personalToken || token;

  const remoteWithAuth = buildRemoteWithAuth(cfg.remote_url, cfg.username, effectiveToken);

  if (!fs.existsSync(path.join(gitRoot, '.git'))) {
    const dirExists = fs.existsSync(gitRoot);
    const isEmpty   = !dirExists || fs.readdirSync(gitRoot).length === 0;

    if (isEmpty) {
      // Empty or missing — clone directly
      fs.mkdirSync(gitRoot, { recursive: true });
      const git = simpleGit();
      await git.clone(remoteWithAuth, gitRoot);
    } else {
      // Directory has pre-existing files (e.g. collection folders created before clone)
      // Save them, clone into temp, move .git across, then restore files
      const tmpDir = gitRoot + '_clone_tmp';
      if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
      const git = simpleGit();
      await git.clone(remoteWithAuth, tmpDir);
      // Move .git from temp clone into existing workspace
      fs.renameSync(path.join(tmpDir, '.git'), path.join(gitRoot, '.git'));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  const git = gitInstance(gitRoot);

  // Set user identity
  const authorName  = identity?.author_name  || user.name;
  const authorEmail = identity?.author_email || user.email || cfg.email || 'noreply@perfstudio.com';
  await git.addConfig('user.name',  authorName);
  await git.addConfig('user.email', authorEmail);
  await git.addConfig('core.longpaths', 'true');

  // Update remote URL with latest token
  const remotes = await git.getRemotes();
  if (remotes.find(r => r.name === 'origin')) {
    await git.remote(['set-url', 'origin', remoteWithAuth]);
  }

  return { git, remoteWithAuth, authorName, authorEmail, identity };
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
      required_status_checks: null,
      enforce_admins: false,
      // Main branch: require 1 PR approval before merge
      // Feature branches: no PR review required (users push freely)
      required_pull_request_reviews: isFeatureBranch ? null : {
        dismiss_stale_reviews:           true,
        require_code_owner_reviews:      false,
        required_approving_review_count: 1,
      },
      restrictions: null,
      allow_force_pushes: false,   // never allow force-push on any protected branch
      allow_deletions:    false,   // never allow deletion of protected branch
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
      auth_token: cfg.auth_token ? '••••••••' : '',
      token_preview: tokenPreview,
    }
  });
});

// ── PUT /config ───────────────────────────────────────────────────────────────

router.put('/config', (req, res) => {
  const caller = getCaller(req.userId);
  if (!['org_admin', 'super_admin'].includes(caller.role)) {
    return res.status(403).json({ error: 'Only org admins can configure git.' });
  }
  const proj = getProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  const { provider, remote_url, username, email, auth_token } = req.body;
  const existing = getGitConfig(req.params.projectId);

  const finalToken = (auth_token && auth_token !== '••••••••')
    ? encrypt(auth_token)
    : (existing?.auth_token || '');

  if (existing) {
    db.prepare(`UPDATE git_configs SET provider=?,remote_url=?,username=?,email=?,auth_token=? WHERE project_id=?`)
      .run(provider||'github', remote_url||'', username||'', email||'', finalToken, req.params.projectId);
  } else {
    db.prepare(`INSERT INTO git_configs (project_id,provider,remote_url,username,email,auth_token) VALUES (?,?,?,?,?,?)`)
      .run(req.params.projectId, provider||'github', remote_url||'', username||'', email||'', finalToken);
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

  const cfg = getGitConfig(req.params.projectId);
  if (!cfg || !cfg.remote_url) return res.status(400).json({ error: 'Configure git remote URL first.' });

  // folder_path is null before first init — that's expected.
  // The project folder will be created inside git-workspaces during this init.

  try {
    const token = cfg.auth_token ? decrypt(cfg.auth_token) : '';
    const remoteWithAuth = buildRemoteWithAuth(cfg.remote_url, cfg.username, token);

    // ── Resolve workspace paths ───────────────────────────────────────────────
    // Workspaces live in a DEDICATED isolated directory:
    //   <perf-studio-root>/git-workspaces/<projectId>/
    //
    // This is completely separate from project data folders — no nesting possible,
    // safe to re-init any number of times.
    //
    // GitHub structure:
    //   <repo_root>/
    //   ├── projects/
    //   │   └── <ProjectName>/   ← clean name, no IDs
    //   ├── .gitignore
    //   └── README.md
    const cleanProjectName = getCleanProjectName(proj);
    // Admin always uses the 'admin' workspace for init
    const gitRoot        = getUserWorkspace(proj, caller);
    const gitProjectsDir = path.join(gitRoot, 'projects');
    const gitProjectPath = path.join(gitProjectsDir, cleanProjectName);

    // Create the workspace → projects/ → project subfolder
    fs.mkdirSync(gitProjectPath, { recursive: true });

    // Add a README.md in projects/ so git tracks it as a real folder
    // (git ignores empty directories — without this GitHub collapses the path)
    fs.writeFileSync(path.join(gitProjectsDir, 'README.md'),
      `# Projects\n\nAll PerfStudio performance test projects are stored here.\nEach sub-folder is one project managed by PerfStudio.\n`
    );

    // Create the project folder structure in the git workspace
    const { ensureProjectFolders, ensureAllEnvFolders, cleanName } = require('../utils/projectFolders');
    fs.mkdirSync(gitProjectPath, { recursive: true });
    ensureProjectFolders(proj.name); // creates gitProjectPath with .gitkeep

    // Create collection subfolders for all existing collections
    const existingCols = db.prepare('SELECT * FROM collections WHERE project_id = ?').all(proj.id);
    for (const col of existingCols) {
      let envs = [];
      try { envs = JSON.parse(col.environments || '[]'); } catch {}
      if (!envs.length && col.environment) envs = [col.environment];
      if (!envs.length) envs = ['Default'];
      ensureAllEnvFolders(gitProjectPath, col.name, envs);
    }

    // Update folder_path in DB to point to git-workspaces/admin/projects/<name>/
    db.prepare('UPDATE projects SET folder_path = ? WHERE id = ?').run(gitProjectPath, proj.id);

    const git = gitInstance(gitRoot);

    // Init git at workspace root (not inside project subfolder)
    const isRepo = fs.existsSync(path.join(gitRoot, '.git'));
    if (!isRepo) {
      await git.init();
    }

    // Enable long paths — required on Windows where default limit is 260 chars
    await git.addConfig('core.longpaths', 'true');

    // Configure user identity
    await git.addConfig('user.name', cfg.username || caller.name);
    await git.addConfig('user.email', cfg.email || caller.email || 'noreply@perfstudio.com');

    // Create .gitignore at workspace root
    const gitignore = path.join(gitRoot, '.gitignore');
    fs.writeFileSync(gitignore, [
      '# PerfStudio — ignore large run artifacts',
      `projects/${cleanProjectName}/results/`,
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
    // Apply to the full workspace tree (covers project, collections, envs, and all subfolders)
    ensureGitkeepAll(gitProjectsDir);

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

    // Stage everything and make initial commit on main
    await git.checkout(['-B', 'main']);
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
        await octokit.repos.deleteBranchProtection({ owner: parsed.owner, repo: parsed.repo, branch: 'main' });
      } catch (_) { /* branch may not be protected yet — that's fine */ }
    }

    // 2. Force-push (needed on re-init when remote has diverged history)
    try {
      await git.push(['--force', '--set-upstream', 'origin', 'main']);
    } catch (pushErr) {
      // Fallback: try regular push (first-time init, no remote history)
      await git.push(['--set-upstream', 'origin', 'main']);
    }

    // 3. Apply branch protection after push
    const protectionResult = await applyBranchProtection(cfg);

    // Mark as initialized and save git_root (workspace directory)
    db.prepare('UPDATE git_configs SET is_initialized=1, git_root=? WHERE project_id=?')
      .run(gitRoot, req.params.projectId);

    db.prepare('INSERT INTO git_commits (project_id,user_id,branch,message,pushed) VALUES (?,?,?,?,?)')
      .run(req.params.projectId, req.userId, 'main', 'Initial commit: PerfStudio project structure', 1);

    const protectionWarning = protectionResult?.ok === false
      ? ` Note: Branch protection could not be applied (${protectionResult.error}). Add "Administration: Read & Write" permission to your GitHub token and re-initialize.`
      : '';
    res.json({ ok: true, message: `Repository initialized and pushed to main.${protectionWarning}`, branch_protection: protectionResult?.ok !== false });
  } catch (e) {
    console.error('[Git] Init error:', e.message);
    res.status(500).json({ error: e.message });
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
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
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

  try {
    const gitDir = getUserWorkspace(proj, caller);
    // Auto-clone repo into user's workspace if this is their first commit
    const { git, identity } = await ensureUserWorkspace(gitDir, { ...cfg, project_id: req.params.projectId }, caller);
    const branch = identity?.branch_name || getBranchForUser(caller, proj);

    // Pull latest main then switch to user's branch
    try { await git.fetch('origin', 'main'); } catch {}
    const branches = await git.branchLocal();
    if (branches.all.includes(branch)) {
      await git.checkout(branch);
    } else {
      await git.checkout(['-b', branch, 'origin/main']).catch(() => git.checkout(['-b', branch]));
    }

    // Stage all changes
    await git.add('.');
    const status = await git.status();

    if (status.staged.length === 0) {
      return res.json({ ok: true, message: 'Nothing to commit — working tree clean.', hash: null });
    }

    const result = await git.commit(message.trim());
    const hash = result.commit || '';

    db.prepare('INSERT INTO git_commits (project_id,user_id,branch,message,hash) VALUES (?,?,?,?,?)')
      .run(req.params.projectId, req.userId, branch, message.trim(), hash);

    res.json({ ok: true, hash, branch, message: `Committed to branch "${branch}".` });
  } catch (e) {
    console.error('[Git] Commit error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /push ────────────────────────────────────────────────────────────────

router.post('/push', async (req, res) => {
  const proj = getProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  const cfg = getGitConfig(req.params.projectId);
  if (!cfg?.is_initialized) return res.status(400).json({ error: 'Git not initialized.' });

  const caller = getCaller(req.userId);

  try {
    const gitDir = getUserWorkspace(proj, caller);
    const git = gitInstance(gitDir);
    const token = cfg.auth_token ? decrypt(cfg.auth_token) : '';
    const remoteWithAuth = buildRemoteWithAuth(cfg.remote_url, cfg.username, token);
    const userIdentity = db.prepare('SELECT * FROM user_git_configs WHERE user_id = ? AND project_id = ?').get(caller.id, req.params.projectId);
    const branch = userIdentity?.branch_name || getBranchForUser(caller, proj);
    await git.addConfig('user.name',  userIdentity?.author_name  || caller.name);
    await git.addConfig('user.email', userIdentity?.author_email || caller.email || cfg.email || 'noreply@perfstudio.com');

    // Ensure on correct branch
    await git.checkout(branch).catch(async () => {
      await git.checkout(['-b', branch, 'main']).catch(() => git.checkout(['-b', branch]));
    });

    // Update remote URL with auth token
    await git.remote(['set-url', 'origin', remoteWithAuth]);

    // Push
    await git.push(['--set-upstream', 'origin', branch]);

    // Mark commits as pushed
    db.prepare("UPDATE git_commits SET pushed=1 WHERE project_id=? AND branch=? AND pushed=0")
      .run(req.params.projectId, branch);

    res.json({ ok: true, branch, message: `Pushed to origin/${branch} successfully.` });
  } catch (e) {
    console.error('[Git] Push error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /pull ────────────────────────────────────────────────────────────────

router.post('/pull', async (req, res) => {
  const proj = getProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  const cfg = getGitConfig(req.params.projectId);
  if (!cfg?.is_initialized) return res.status(400).json({ error: 'Git not initialized.' });

  const caller = getCaller(req.userId);

  try {
    const gitDir = getUserWorkspace(proj, caller);
    const git = gitInstance(gitDir);
    const token = cfg.auth_token ? decrypt(cfg.auth_token) : '';
    const remoteWithAuth = buildRemoteWithAuth(cfg.remote_url, cfg.username, token);
    const branch = getBranchForUser(caller, proj);

    await git.remote(['set-url', 'origin', remoteWithAuth]);

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
      // 1. Fetch latest main from remote
      // 2. Create local branch from main (or sync if it already exists locally)
      // 3. Push the branch to remote immediately — so it exists for future pulls
      await git.fetch('origin', 'main');

      const localBranches = await git.branchLocal();
      if (!localBranches.all.includes(branch)) {
        await git.checkout(['-b', branch, 'origin/main']);
      } else {
        await git.checkout(branch);
        await git.merge(['origin/main', '--no-edit']).catch(() => {});
      }

      // Auto-push to create the remote branch so future pulls work seamlessly
      await git.push(['--set-upstream', 'origin', branch]);

      // Protect feature branch: no force-push, no deletion (but no PR review required)
      await applyBranchProtection({ ...cfg, _featureBranch: true }, branch);

      res.json({
        ok: true,
        message: `Branch "${branch}" created from main and pushed to remote. Branch protection applied.`,
      });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
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
    const summary = await git.branch(['-a']);
    res.json({
      branches: summary.all,
      current: summary.current,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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

  const branch = getBranchForUser(caller, proj);
  if (branch === 'main') return res.status(400).json({ error: 'Org admins push directly to main — no PR needed.' });

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
          base: 'main',
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
  `).run(req.params.projectId, title.trim(), description||'', branch, 'main', req.userId, remotePrUrl);

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

  try {
    const gitDir = getUserWorkspace(proj, caller);
    const git = gitInstance(gitDir);
    const token = cfg.auth_token ? decrypt(cfg.auth_token) : '';
    const remoteWithAuth = buildRemoteWithAuth(cfg.remote_url, cfg.username, token);

    await git.addConfig('user.name', cfg.username || caller.name);
    await git.addConfig('user.email', cfg.email || caller.email || 'noreply@perfstudio.com');
    await git.remote(['set-url', 'origin', remoteWithAuth]);

    // Fetch the feature branch
    await git.fetch('origin', pr.from_branch);

    // Switch to main
    await git.checkout('main');
    await git.pull('origin', 'main', { '--rebase': 'false' });

    // Merge feature branch
    await git.merge([`origin/${pr.from_branch}`, '--no-ff', '--allow-unrelated-histories', '-m', `Merge PR: ${pr.title}`]);

    // Push merged main
    await git.push('origin', 'main');

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
      .run(req.params.projectId, req.userId, 'main', `Merge PR: ${pr.title}`, 1);

    res.json({ ok: true, message: `PR "${pr.title}" merged into main.` });
  } catch (e) {
    console.error('[Git] Merge error:', e.message);
    res.status(500).json({ error: e.message });
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
    }
  });
});

// ── PUT /identity ─────────────────────────────────────────────────────────────
router.put('/identity', (req, res) => {
  const proj = getProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  const { branch_name, author_name, author_email, auth_token } = req.body;
  const existing = db.prepare('SELECT * FROM user_git_configs WHERE user_id = ? AND project_id = ?')
    .get(req.userId, req.params.projectId);
  const finalToken = (auth_token && auth_token !== '••••••••')
    ? encrypt(auth_token)
    : (existing?.auth_token || '');
  if (existing) {
    db.prepare('UPDATE user_git_configs SET branch_name=?,author_name=?,author_email=?,auth_token=? WHERE user_id=? AND project_id=?')
      .run(branch_name||'', author_name||'', author_email||'', finalToken, req.userId, req.params.projectId);
  } else {
    db.prepare('INSERT INTO user_git_configs (user_id,project_id,branch_name,author_name,author_email,auth_token) VALUES (?,?,?,?,?,?)')
      .run(req.userId, req.params.projectId, branch_name||'', author_name||'', author_email||'', finalToken);
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
  const branchName = identity?.branch_name || req.body.branch_name;
  if (!branchName) return res.status(400).json({ error: 'Save your Git Identity first to set a branch name.' });

  // Use the per-user workspace (clones from remote if not yet set up)
  const gitRoot = getUserWorkspace(proj, caller);
  try {
    const { git } = await ensureUserWorkspace(gitRoot, { ...cfg, project_id: req.params.projectId }, caller);

    const branchSummary = await git.branchLocal();
    if (branchSummary.all.includes(branchName)) {
      await git.checkout(branchName);
      return res.json({ message: `Switched to existing branch: ${branchName}`, branch: branchName });
    }
    // Create from latest main
    try { await git.fetch('origin', 'main'); } catch {}
    try { await git.checkout('main'); } catch {}
    await git.checkoutLocalBranch(branchName);

    // Push branch to remote and apply protection
    await git.push(['--set-upstream', 'origin', branchName]);
    await applyBranchProtection({ ...cfg, _featureBranch: true }, branchName);

    res.json({ message: `Branch "${branchName}" created from main and pushed to remote.`, branch: branchName });
  } catch (err) {
    console.error('Branch error:', err);
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: e.message });
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
      const absPath = path.join(gitDir, filePath);
      if (fs.existsSync(absPath)) {
        isNewFile = true;
        const content = fs.readFileSync(absPath, 'utf8');
        const lines = content.split('\n');
        // Build pseudo-diff: all lines as additions (0-based line numbers in hunk)
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
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
  }
});

// ── POST /fetch — fetch from remote ─────────────────────────────────────────
router.post('/fetch', async (req, res) => {
  const proj = getProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  const cfg = getGitConfig(req.params.projectId);
  if (!cfg?.is_initialized) return res.status(400).json({ error: 'Git not initialized.' });
  const caller = getCaller(req.userId);
  try {
    const gitDir = getUserWorkspace(proj, caller);
    const { git, remoteWithAuth } = await ensureUserWorkspace(gitDir, { ...cfg, project_id: req.params.projectId }, caller);
    const result = await git.fetch(remoteWithAuth);
    res.json({ ok: true, message: 'Fetched latest from remote successfully.', output: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /test — test remote connection ──────────────────────────────────────
router.post('/test', async (req, res) => {
  const proj = getProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  const cfg = getGitConfig(req.params.projectId);
  if (!cfg?.remote_url) return res.status(400).json({ error: 'Remote URL not configured.' });
  const caller = getCaller(req.userId);
  try {
    const identity = db.prepare('SELECT * FROM user_git_configs WHERE user_id = ? AND project_id = ?').get(caller.id, req.params.projectId);
    const rawToken = identity?.auth_token ? decrypt(identity.auth_token) : (cfg.auth_token ? decrypt(cfg.auth_token) : '');
    if (!rawToken) return res.status(400).json({ error: 'No authentication token configured.' });
    const remoteWithAuth = buildRemoteWithAuth(cfg.remote_url, cfg.username, rawToken);
    const git = simpleGit();
    await git.listRemote(['--heads', remoteWithAuth]);
    const tokenPreview = rawToken.length > 8 ? rawToken.slice(0, 4) + '••••' + rawToken.slice(-4) : '••••••••';
    res.json({ ok: true, message: 'Connection successful! Repository is accessible.', token_preview: tokenPreview });
  } catch (e) {
    res.status(400).json({ ok: false, error: 'Connection failed: ' + (e.message || 'Unable to reach remote.') });
  }
});

// ── POST /sync — sync user branch with latest base branch ────────────────────
router.post('/sync', async (req, res) => {
  const proj = getProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  const cfg = getGitConfig(req.params.projectId);
  if (!cfg?.is_initialized) return res.status(400).json({ error: 'Git not initialized.' });
  const caller = getCaller(req.userId);
  try {
    const gitDir = getUserWorkspace(proj, caller);
    const { git, remoteWithAuth, identity } = await ensureUserWorkspace(gitDir, { ...cfg, project_id: req.params.projectId }, caller);
    const branch = identity?.branch_name || getBranchForUser(caller, proj);
    await git.fetch(remoteWithAuth, 'main');
    const currentBranch = (await git.status()).current;
    if (currentBranch !== branch) {
      const branches = await git.branchLocal();
      if (branches.all.includes(branch)) await git.checkout(branch);
    }
    await git.merge(['origin/main', '--no-edit', '--allow-unrelated-histories']);
    res.json({ ok: true, message: `Branch "${branch}" synced with latest main.` });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
