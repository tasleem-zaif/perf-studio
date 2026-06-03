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
  // Regular users get their own branch: users/<sanitized-username>
  const safe = user.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-');
  return `users/${safe}`;
}

function gitInstance(projectPath) {
  return simpleGit(projectPath);
}

function buildRemoteWithAuth(url, username, token) {
  // Inject token into HTTPS URL for authentication
  // https://github.com/org/repo.git → https://<token>@github.com/org/repo.git
  if (!token) return url;
  try {
    const u = new URL(url);
    u.username = username || token;
    u.password = token;
    return u.toString();
  } catch {
    return url;
  }
}

// ── GET /config ───────────────────────────────────────────────────────────────

router.get('/config', (req, res) => {
  const proj = getProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  const cfg = getGitConfig(req.params.projectId);
  if (!cfg) return res.json({ config: null });

  res.json({
    config: {
      ...cfg,
      auth_token: cfg.auth_token ? '••••••••' : '',  // never expose token
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

  const projectPath = proj.folder_path;
  if (!projectPath || !fs.existsSync(projectPath)) {
    return res.status(400).json({ error: 'Project folder not found on disk.' });
  }

  try {
    const token = cfg.auth_token ? decrypt(cfg.auth_token) : '';
    const remoteWithAuth = buildRemoteWithAuth(cfg.remote_url, cfg.username, token);

    // ── Create workspace one level above project folder ──────────────────────
    // Structure: <projects_root>/<project_name>_workspace/
    //                └── <project_folder_name>/   ← visible subfolder on GitHub
    const projectFolderName = path.basename(projectPath);
    const gitRoot = path.join(path.dirname(projectPath), `${projectFolderName}_workspace`);
    // The project subfolder inside the workspace
    const gitProjectPath = path.join(gitRoot, projectFolderName);

    // Create the workspace and project subfolder
    fs.mkdirSync(gitProjectPath, { recursive: true });

    // Copy existing project files into the workspace subfolder
    function copyDir(src, dest) {
      if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
      fs.readdirSync(src).forEach(entry => {
        if (entry === '.git') return; // skip any existing .git
        const srcFull = path.join(src, entry);
        const destFull = path.join(dest, entry);
        if (fs.statSync(srcFull).isDirectory()) {
          copyDir(srcFull, destFull);
        } else {
          fs.copyFileSync(srcFull, destFull);
        }
      });
    }
    copyDir(projectPath, gitProjectPath);

    // Update project folder_path to point to the workspace subfolder
    db.prepare('UPDATE projects SET folder_path = ? WHERE id = ?').run(gitProjectPath, proj.id);

    const git = gitInstance(gitRoot);

    // Init git at workspace root (not inside project subfolder)
    const isRepo = fs.existsSync(path.join(gitRoot, '.git'));
    if (!isRepo) {
      await git.init();
    }

    // Configure user identity
    await git.addConfig('user.name', cfg.username || caller.name);
    await git.addConfig('user.email', cfg.email || caller.email || 'noreply@perfstudio.com');

    // Create .gitignore at workspace root
    const gitignore = path.join(gitRoot, '.gitignore');
    fs.writeFileSync(gitignore, [
      '# PerfStudio — ignore large run artifacts',
      `${projectFolderName}/results/`,
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
        const colFolderName = `${col.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_${col.id}`;
        let envs = [];
        try { envs = JSON.parse(col.environments || '[]'); } catch {}
        if (!envs.length && col.environment) envs = [col.environment];
        if (!envs.length) envs = ['Default'];
        for (const env of envs) {
          const base = path.join(gitProjectPath, colFolderName, env);
          mkKeep(path.join(base, 'testData'));
          mkKeep(path.join(base, 'script'));   // singular — matches app's script generation path
          mkKeep(path.join(base, 'results'));
          mkKeep(path.join(base, 'config'));
        }
      }
    }

    // 3. Ensure all existing subdirs in the workspace have .gitkeep
    function ensureGitkeepExisting(dir) {
      if (!fs.existsSync(dir) || path.basename(dir) === '.git') return;
      const entries = fs.readdirSync(dir).filter(e => e !== '.git' && e !== '.gitkeep');
      if (entries.length === 0) {
        const gk = path.join(dir, '.gitkeep');
        if (!fs.existsSync(gk)) fs.writeFileSync(gk, '');
      } else {
        entries.forEach(e => {
          const full = path.join(dir, e);
          if (fs.statSync(full).isDirectory()) ensureGitkeepExisting(full);
        });
      }
    }
    ensureGitkeepExisting(gitProjectPath);

    // Set or update remote
    const remotes = await git.getRemotes();
    if (remotes.find(r => r.name === 'origin')) {
      await git.remote(['set-url', 'origin', remoteWithAuth]);
    } else {
      await git.addRemote('origin', remoteWithAuth);
    }

    // Stage everything and make initial commit on main
    await git.checkout(['-B', 'main']);
    await git.add('.');
    const status = await git.status();
    if (status.staged.length > 0 || status.not_added.length > 0 || status.modified.length > 0) {
      await git.add('.');
      await git.commit('Initial commit: PerfStudio project structure');
    }

    // Push main — never force push (respects branch protection rules)
    // If remote main exists, pull first to avoid rejected pushes
    try {
      await git.pull('origin', 'main', { '--rebase': 'false', '--allow-unrelated-histories': null }).catch(() => {});
    } catch (_) {}
    await git.push(['--set-upstream', 'origin', 'main']);

    // Mark as initialized and save git_root (workspace directory)
    db.prepare('UPDATE git_configs SET is_initialized=1, git_root=? WHERE project_id=?')
      .run(gitRoot, req.params.projectId);

    db.prepare('INSERT INTO git_commits (project_id,user_id,branch,message,pushed) VALUES (?,?,?,?,?)')
      .run(req.params.projectId, req.userId, 'main', 'Initial commit: PerfStudio project structure', 1);

    res.json({ ok: true, message: 'Repository initialized and pushed to main.' });
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

  try {
    const gitDir = cfg?.git_root && fs.existsSync(cfg.git_root) ? cfg.git_root : proj.folder_path;
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
    const gitDir = cfg?.git_root && fs.existsSync(cfg.git_root) ? cfg.git_root : proj.folder_path;
    const git = gitInstance(gitDir);
    const token = cfg.auth_token ? decrypt(cfg.auth_token) : '';
    const branch = getBranchForUser(caller, proj);

    // Configure identity
    await git.addConfig('user.name', cfg.username || caller.name);
    await git.addConfig('user.email', cfg.email || caller.email || 'noreply@perfstudio.com');

    // Switch to user's branch (create if needed)
    const branches = await git.branchLocal();
    if (branches.all.includes(branch)) {
      await git.checkout(branch);
    } else {
      // Create branch from main
      await git.checkout(['-b', branch, 'main']).catch(() => git.checkout(['-b', branch]));
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
    const gitDir = cfg?.git_root && fs.existsSync(cfg.git_root) ? cfg.git_root : proj.folder_path;
    const git = gitInstance(gitDir);
    const token = cfg.auth_token ? decrypt(cfg.auth_token) : '';
    const remoteWithAuth = buildRemoteWithAuth(cfg.remote_url, cfg.username, token);
    const branch = getBranchForUser(caller, proj);

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
    const gitDir = cfg?.git_root && fs.existsSync(cfg.git_root) ? cfg.git_root : proj.folder_path;
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

      res.json({
        ok: true,
        message: `Branch "${branch}" created from main and pushed to remote. You're all set — future pulls will work normally.`,
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

  try {
    const gitDir = cfg?.git_root && fs.existsSync(cfg.git_root) ? cfg.git_root : proj.folder_path;
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

  try {
    const gitDir = cfg?.git_root && fs.existsSync(cfg.git_root) ? cfg.git_root : proj.folder_path;
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
    const gitDir = cfg?.git_root && fs.existsSync(cfg.git_root) ? cfg.git_root : proj.folder_path;
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

router.put('/prs/:prId/close', (req, res) => {
  const caller = getCaller(req.userId);
  const pr = db.prepare('SELECT * FROM git_prs WHERE id = ? AND project_id = ?')
    .get(req.params.prId, req.params.projectId);
  if (!pr) return res.status(404).json({ error: 'PR not found.' });

  // PR author or org admin can close
  if (pr.created_by !== req.userId && !['org_admin','super_admin'].includes(caller.role)) {
    return res.status(403).json({ error: 'Not authorized.' });
  }

  db.prepare("UPDATE git_prs SET status='closed' WHERE id=?").run(pr.id);
  res.json({ ok: true });
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

module.exports = router;
