const router = require('express').Router();
const path   = require('path');
const fs     = require('fs');
const db     = require('../db');
const auth   = require('../middleware/auth');
const resetSequence = require('../utils/resetSequence');
const { writeProjectSnapshot } = require('../utils/configWriter');
const { ensureProjectFolders, deleteProjectFolder, backupAndDeleteProjectFolder, BACKUPS_ROOT } = require('../utils/projectFolders');
const { getOrgLicenseStatus } = require('../utils/license');
const { decrypt } = require('../utils/encryption');
const ownsProject = require('../utils/ownsProject');

const COLORS = ['#1a6bff','#00c896','#ef9f27','#e24b4a','#8b5cf6','#06b6d4'];
const BKGS   = ['#e8f0ff','#e0faf3','#faeeda','#fcebeb','#ede9fe','#e0f2fe'];

router.use(auth);

async function getCaller(userId) {
  return db.prepare('SELECT role, org_id FROM users WHERE id = ?').get(userId);
}

router.get('/', async (req, res) => {
  const caller = await getCaller(req.userId);

  let projects;
  if (caller.role === 'super_admin') {
    projects = await db.prepare(`
      SELECT p.*, u.name as owner_name, o.name as org_name, o.id as org_id,
             COALESCE(gc.is_initialized, 0) as git_initialized
      FROM projects p
      JOIN users u ON p.user_id = u.id
      LEFT JOIN organizations o ON u.org_id = o.id
      LEFT JOIN git_configs gc ON gc.project_id = p.id
      ORDER BY o.name ASC, p.created_at DESC
    `).all();
  } else if (caller.role === 'org_admin') {
    projects = await db.prepare(`
      SELECT p.*, u.name as owner_name, o.name as org_name, o.id as org_id,
             COALESCE(gc.is_initialized, 0) as git_initialized
      FROM projects p
      JOIN users u ON p.user_id = u.id
      LEFT JOIN organizations o ON u.org_id = o.id
      LEFT JOIN git_configs gc ON gc.project_id = p.id
      WHERE u.org_id = ?
      ORDER BY p.created_at DESC
    `).all(caller.org_id);
  } else if (caller.role === 'user') {
    // Regular users see only projects explicitly assigned to them
    projects = await db.prepare(`
      SELECT p.*, u.name as owner_name, o.name as org_name, o.id as org_id,
             COALESCE(gc.is_initialized, 0) as git_initialized
      FROM projects p
      JOIN project_assignments pa ON pa.project_id = p.id AND pa.user_id = ?
      JOIN users u ON p.user_id = u.id
      LEFT JOIN organizations o ON u.org_id = o.id
      LEFT JOIN git_configs gc ON gc.project_id = p.id
      ORDER BY p.created_at DESC
    `).all(req.userId);
  } else {
    projects = await db.prepare(`
      SELECT p.*, COALESCE(gc.is_initialized, 0) as git_initialized
      FROM projects p
      LEFT JOIN git_configs gc ON gc.project_id = p.id
      WHERE p.user_id = ?
      ORDER BY p.created_at DESC
    `).all(req.userId);
  }

  res.json({ projects });
});

router.post('/', async (req, res) => {
  const caller = await getCaller(req.userId);
  if (caller.role === 'user') return res.status(403).json({ error: 'Regular users cannot create projects. Contact your org admin.' });

  // Org admins are capped by their org's plan. Super admins create projects
  // outside any org's license, so they're unaffected.
  if (caller.role === 'org_admin') {
    const license = await getOrgLicenseStatus(caller.org_id);
    if (license.projectsAtLimit) {
      return res.status(400).json({
        error: 'project_limit_reached',
        message: `Your organization has reached its project limit (${license.maxProjects}) for the ${license.plan} plan. Upgrade the plan to create more projects.`,
      });
    }
  }

  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const count = (await db.prepare('SELECT COUNT(*) as n FROM projects WHERE user_id = ?').get(req.userId)).n;
  const idx   = count % COLORS.length;
  // Generate unique 6-digit numeric ID; retry if already taken
  let uuid;
  do {
    uuid = String(Math.floor(100000 + Math.random() * 900000));
  } while (await db.prepare('SELECT id FROM projects WHERE uuid = ?').get(uuid));

  const result = await db.prepare(
    'INSERT INTO projects (user_id, name, description, color, bg, uuid) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(req.userId, name, description || '', COLORS[idx], BKGS[idx], uuid);

  // folder_path is null until Org Admin initializes the Git repository.
  // The folder structure is created inside git-workspaces during git init.
  const project = await db.prepare('SELECT * FROM projects WHERE id = ?').get(result.lastInsertRowid);
  res.json({ project });
});

router.put('/:id', async (req, res) => {
  const caller = await getCaller(req.userId);
  if (caller.role === 'user') return res.status(403).json({ error: 'Regular users cannot edit projects.' });
  const project = caller.role === 'super_admin'
    ? await db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id)
    : await db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!project) return res.status(404).json({ error: 'Project not found or you do not have permission to edit it.' });
  const { name, description } = req.body;
  await db.prepare('UPDATE projects SET name = ?, description = ? WHERE id = ?')
    .run(name || project.name, description ?? project.description, req.params.id);
  const updated = await db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  // no-op: collection config.json contains effective project data
  res.json({ project: updated });
});

router.delete('/:id', async (req, res) => {
  try {
    const caller = await getCaller(req.userId);
    if (caller.role === 'user') return res.status(403).json({ error: 'Regular users cannot delete projects.' });
    let project;
    if (caller.role === 'super_admin') {
      project = await db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    } else if (caller.role === 'org_admin') {
      project = await db.prepare(`
        SELECT p.* FROM projects p
        JOIN users u ON p.user_id = u.id
        WHERE p.id = ? AND u.org_id = ?
      `).get(req.params.id, caller.org_id);
    } else {
      project = await db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
    }
    if (!project) return res.status(404).json({ error: 'Project not found or you do not have permission to delete it.' });

    // Capture git config BEFORE deleting from DB — CASCADE will delete it
    const gitCfg = await db.prepare('SELECT * FROM git_configs WHERE project_id = ?').get(project.id);

    // Delete from DB immediately and respond — git cleanup + folder backup run in background
    await db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
    resetSequence('projects');
    res.json({ ok: true });

    // Background: push project removal to GitHub (if git initialized), then backup + delete
    setImmediate(async () => {
      try {
        // ── Git cleanup: remove project folder from GitHub repo ──────────────
        // (gitCfg captured above before DB cascade-delete)
        if (gitCfg?.is_initialized && gitCfg?.git_root && fs.existsSync(gitCfg.git_root)) {
          try {
            const simpleGit = require('simple-git');
            const { decrypt } = require('../utils/encryption');
            const git = simpleGit(gitCfg.git_root);

            const token = gitCfg.auth_token ? decrypt(gitCfg.auth_token) : '';
            // Rebuild remote URL with auth token
            const u = new URL(gitCfg.remote_url);
            if (token) { u.username = gitCfg.username || token; u.password = token; }
            const remoteWithAuth = u.toString();

            await git.addConfig('user.name', gitCfg.username || 'PerfStudio');
            await git.addConfig('user.email', gitCfg.email || 'noreply@perfstudio.com');
            const baseBranch = gitCfg.base_branch || 'main';
            await git.checkout(baseBranch);
            await git.pull('origin', baseBranch, { '--rebase': 'false' }).catch(() => {});

            // Remove the project subfolder from git tracking
            const projectSubfolder = path.basename(project.folder_path);
            await git.rm(['-r', '--cached', '--ignore-unmatch', projectSubfolder]).catch(() => {});

            // Also remove the folder physically from workspace
            const projInWorkspace = path.join(gitCfg.git_root, projectSubfolder);
            if (fs.existsSync(projInWorkspace)) {
              fs.rmSync(projInWorkspace, { recursive: true, force: true });
            }

            // Commit the removal
            const status = await git.status();
            if (!status.isClean()) {
              await git.add('.');
              await git.commit(`Remove project: ${project.name}`);
              await git.remote(['set-url', 'origin', remoteWithAuth]);
              await git.push('origin', baseBranch);
              console.log(`[Git] Project "${project.name}" removed from GitHub.`);
            }

            // Delete the entire workspace folder
            fs.rmSync(gitCfg.git_root, { recursive: true, force: true });
            console.log(`[Git] Workspace deleted: ${gitCfg.git_root}`);
          } catch (gitErr) {
            console.error('[Git] Failed to remove project from repo:', gitErr.message);
          }
        }

        // ── Backup: use workspace root if git was initialized, else project folder ──
        // Workspace root contains .git + project subfolder = complete backup
        const backupPath = (gitCfg?.git_root && fs.existsSync(gitCfg.git_root))
          ? gitCfg.git_root          // git workspace (already cleaned of project subfolder above)
          : project.folder_path;    // fallback: plain project folder (no git)

        await backupAndDeleteProjectFolder(backupPath, project.name, project.id);
        console.log(`[Projects] Backup created for "${project.name}"`);
      } catch (e) {
        console.error('[Projects] Backup/delete folder failed:', e.message);
      }
    });
  } catch (e) {
    console.error('[Projects] Delete failed:', e.message);
    if (!res.headersSent) res.status(500).json({ error: `Failed to delete project: ${e.message}. The project may have active runs or locked files.` });
  }
});

router.post('/:id/ensure-folders', async (req, res) => {
  const project = await db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!project) return res.status(404).json({ error: 'Project not found — please refresh the page and try again.' });
  const folderPath = ensureProjectFolders(project.name, project.id, project.uuid || project.environment);
  await db.prepare('UPDATE projects SET folder_path = ? WHERE id = ?').run(folderPath, req.params.id);
  res.json({ ok: true, folder_path: folderPath });
});

// ── GET /backups — list all project backup ZIPs (admin only) ─────────────────
router.get('/backups', async (req, res) => {
  const caller = await getCaller(req.userId);
  if (!['org_admin', 'super_admin'].includes(caller?.role)) {
    return res.status(403).json({ error: 'Admin only' });
  }
  try {
    if (!fs.existsSync(BACKUPS_ROOT)) return res.json({ backups: [] });
    const files = fs.readdirSync(BACKUPS_ROOT)
      .filter(f => f.endsWith('.zip'))
      .map(f => {
        const stat = fs.statSync(path.join(BACKUPS_ROOT, f));
        return { filename: f, size_bytes: stat.size, created_at: stat.mtime.toISOString() };
      })
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json({ backups: files, backups_dir: BACKUPS_ROOT });
  } catch (e) {
    res.status(500).json({ error: `Failed to list project backups: ${e.message}. The backups directory may be inaccessible.` });
  }
});

// ── GET /backups/:filename — download a backup ZIP (admin only) ───────────────
router.get('/backups/:filename', async (req, res) => {
  const caller = await getCaller(req.userId);
  if (!['org_admin', 'super_admin'].includes(caller?.role)) {
    return res.status(403).json({ error: 'Admin only' });
  }
  // Prevent path traversal
  const safe = path.basename(req.params.filename);
  if (!safe.endsWith('.zip')) return res.status(400).json({ error: 'Invalid filename' });
  const filePath = path.join(BACKUPS_ROOT, safe);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Backup not found' });
  res.download(filePath, safe);
});

// GET /projects/:id/registry-token — org's npm registry token, for local/CI use
router.get('/:id/registry-token', async (req, res) => {
  try {
    const project = await ownsProject(req.userId, req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const caller = await getCaller(req.userId);
    const org = caller.org_id
      ? await db.prepare('SELECT registry_token_enc FROM organizations WHERE id = ?').get(caller.org_id)
      : null;

    res.json({
      token: org?.registry_token_enc ? decrypt(org.registry_token_enc) : null,
      registryUrl: `${process.env.ARTIFACT_KEEPER_URL || 'https://artifact-keeper.qtsolvdev.com'}/npm/@peako/`,
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load registry token' });
  }
});

module.exports = router;
