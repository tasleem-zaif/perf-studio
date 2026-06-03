const router = require('express').Router();
const path   = require('path');
const fs     = require('fs');
const db     = require('../db');
const auth   = require('../middleware/auth');
const resetSequence = require('../utils/resetSequence');
const { writeProjectSnapshot } = require('../utils/configWriter');
const { ensureProjectFolders, deleteProjectFolder, backupAndDeleteProjectFolder } = require('../utils/projectFolders');

const COLORS = ['#1a6bff','#00c896','#ef9f27','#e24b4a','#8b5cf6','#06b6d4'];
const BKGS   = ['#e8f0ff','#e0faf3','#faeeda','#fcebeb','#ede9fe','#e0f2fe'];

router.use(auth);

function getCaller(userId) {
  return db.prepare('SELECT role, org_id FROM users WHERE id = ?').get(userId);
}

router.get('/', (req, res) => {
  const caller = getCaller(req.userId);

  let projects;
  if (caller.role === 'super_admin') {
    projects = db.prepare(`
      SELECT p.*, u.name as owner_name, o.name as org_name, o.id as org_id
      FROM projects p
      JOIN users u ON p.user_id = u.id
      LEFT JOIN organizations o ON u.org_id = o.id
      ORDER BY o.name ASC, p.created_at DESC
    `).all();
  } else if (caller.role === 'org_admin') {
    projects = db.prepare(`
      SELECT p.*, u.name as owner_name, o.name as org_name, o.id as org_id
      FROM projects p
      JOIN users u ON p.user_id = u.id
      LEFT JOIN organizations o ON u.org_id = o.id
      WHERE u.org_id = ?
      ORDER BY p.created_at DESC
    `).all(caller.org_id);
  } else if (caller.role === 'user') {
    // Regular users see only projects explicitly assigned to them
    projects = db.prepare(`
      SELECT p.*, u.name as owner_name, o.name as org_name, o.id as org_id
      FROM projects p
      JOIN project_assignments pa ON pa.project_id = p.id AND pa.user_id = ?
      JOIN users u ON p.user_id = u.id
      LEFT JOIN organizations o ON u.org_id = o.id
      ORDER BY p.created_at DESC
    `).all(req.userId);
  } else {
    projects = db.prepare('SELECT * FROM projects WHERE user_id = ? ORDER BY created_at DESC').all(req.userId);
  }

  res.json({ projects });
});

router.post('/', (req, res) => {
  const caller = getCaller(req.userId);
  if (caller.role === 'user') return res.status(403).json({ error: 'Regular users cannot create projects. Contact your org admin.' });
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const count = db.prepare('SELECT COUNT(*) as n FROM projects WHERE user_id = ?').get(req.userId).n;
  const idx   = count % COLORS.length;
  // Generate unique 6-digit numeric ID; retry if already taken
  let uuid;
  do {
    uuid = String(Math.floor(100000 + Math.random() * 900000));
  } while (db.prepare('SELECT id FROM projects WHERE uuid = ?').get(uuid));

  const result = db.prepare(
    'INSERT INTO projects (user_id, name, description, color, bg, uuid) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(req.userId, name, description || '', COLORS[idx], BKGS[idx], uuid);

  const folderPath = ensureProjectFolders(name, result.lastInsertRowid, uuid);
  db.prepare('UPDATE projects SET folder_path = ? WHERE id = ?').run(folderPath, result.lastInsertRowid);

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(result.lastInsertRowid);
  // config.json written per collection/env when collections are added
  res.json({ project });
});

router.put('/:id', (req, res) => {
  const caller = getCaller(req.userId);
  if (caller.role === 'user') return res.status(403).json({ error: 'Regular users cannot edit projects.' });
  const project = caller.role === 'super_admin'
    ? db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id)
    : db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!project) return res.status(404).json({ error: 'Not found' });
  const { name, description } = req.body;
  db.prepare('UPDATE projects SET name = ?, description = ? WHERE id = ?')
    .run(name || project.name, description ?? project.description, req.params.id);
  const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  // no-op: collection config.json contains effective project data
  res.json({ project: updated });
});

router.delete('/:id', async (req, res) => {
  try {
    const caller = getCaller(req.userId);
    if (caller.role === 'user') return res.status(403).json({ error: 'Regular users cannot delete projects.' });
    let project;
    if (caller.role === 'super_admin') {
      project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    } else if (caller.role === 'org_admin') {
      project = db.prepare(`
        SELECT p.* FROM projects p
        JOIN users u ON p.user_id = u.id
        WHERE p.id = ? AND u.org_id = ?
      `).get(req.params.id, caller.org_id);
    } else {
      project = db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
    }
    if (!project) return res.status(404).json({ error: 'Not found' });

    // Delete from DB immediately and respond — git cleanup + folder backup run in background
    db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
    resetSequence('projects');
    res.json({ ok: true });

    // Background: push project removal to GitHub (if git initialized), then backup + delete
    setImmediate(async () => {
      try {
        // ── Git cleanup: remove project folder from GitHub repo ──────────────
        const gitCfg = db.prepare('SELECT * FROM git_configs WHERE project_id = ?').get(project.id);
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
            await git.checkout('main');
            await git.pull('origin', 'main', { '--rebase': 'false' }).catch(() => {});

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
              await git.push('origin', 'main');
              console.log(`[Git] Project "${project.name}" removed from GitHub.`);
            }

            // Delete the entire workspace folder
            fs.rmSync(gitCfg.git_root, { recursive: true, force: true });
            console.log(`[Git] Workspace deleted: ${gitCfg.git_root}`);
          } catch (gitErr) {
            console.error('[Git] Failed to remove project from repo:', gitErr.message);
          }
        }

        // Backup and delete the project data folder
        await backupAndDeleteProjectFolder(project.folder_path, project.name, project.id);
      } catch (e) {
        console.error('[Projects] Backup/delete folder failed:', e.message);
      }
    });
  } catch (e) {
    console.error('[Projects] Delete failed:', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

router.post('/:id/ensure-folders', (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!project) return res.status(404).json({ error: 'Not found' });
  const folderPath = ensureProjectFolders(project.name, project.id, project.uuid || project.environment);
  db.prepare('UPDATE projects SET folder_path = ? WHERE id = ?').run(folderPath, req.params.id);
  res.json({ ok: true, folder_path: folderPath });
});

module.exports = router;
