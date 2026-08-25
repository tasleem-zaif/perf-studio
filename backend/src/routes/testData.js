const router = require('express').Router({ mergeParams: true });
const path = require('path');
const posix = path.posix;
const fs = require('fs');
const multer = require('multer');
const db = require('../db');
const auth = require('../middleware/auth');
const ownsProject = require('../utils/ownsProject');
const { readCsv, writeCsv, readCsvContent } = require('../utils/csvUtils');
const { getUserProjectPath, getCollectionPath, resolveOrgSlugForProject, cleanName } = require('../utils/projectFolders');
const resetSequence = require('../utils/resetSequence');
const s3Sync = require('../utils/s3Sync');
const gitEngine = require('../utils/gitEngine');

// multer buffers the upload in memory regardless of auth mode — the route handler below
// decides where the durable copy goes (a real local write for SSH-mode workspaces, straight
// into the gitEngine in-memory session for PAT-mode ones). Never touches local disk itself.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.originalname.match(/\.(csv|txt|xlsx|xls)$/i)) return cb(new Error('Only CSV, TXT, XLS or XLSX files allowed'));
    cb(null, true);
  },
});

/** Whether userId's chosen auth method for projectId is SSH (real local workspace) or PAT
 * (gitEngine, S3-backed, zero local disk) — mirrors git.js's getAuth()'s own precedence. */
async function isSshMode(userId, projectId) {
  const identity = await db.prepare('SELECT auth_method FROM user_git_configs WHERE user_id = ? AND project_id = ?').get(userId, projectId);
  return (identity?.auth_method || 'pat') === 'ssh';
}

/** Resolve the CALLING user's own workspace root (gitDir, one level above the project's
 * content folder) for a PAT-mode gitEngine session — every read/write must go through this,
 * never the project-wide project.folder_path (set once at /init time by whoever initialized
 * the repo, almost always the org admin). Falling back to folder_path meant every regular
 * user's test data landed inside the admin's main-branch workspace instead of their own
 * users/<name> branch, ahead of any PR merge. Returns null if git isn't initialized yet. */
async function resolveActorGitDir(userId, projectId, projectName) {
  const callerUser = await db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
  const userProjPath = await getUserProjectPath(userId, callerUser?.role, projectName, projectId);
  return userProjPath ? path.dirname(userProjPath) : null;
}

// Restores the calling user's own workspace if the S3 sweep reclaimed it since the last
// access — a stored test_data_files.path lives inside that workspace. SSH-mode only (PAT-mode
// workspaces have no local folder to restore — gitEngine hydrates from S3 per-session instead).
// No-ops (and never throws) for a non-git project, or once already warm.
async function hydrateOwnWorkspace(projectId, userId) {
  try {
    const { getUserProjectPath } = require('../utils/projectFolders');
    const proj = await db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId);
    const callerUser = await db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
    const userProjPath = await getUserProjectPath(userId, callerUser?.role, proj?.name || '', projectId);
    if (userProjPath) await require('../routes/git').ensureGitWorkspaceHydrated(path.dirname(userProjPath), projectId, userId);
  } catch (e) { console.error('[TestData] Workspace hydrate failed for project', projectId, ':', e.message); }
}

/**
 * Resolve where a test-data file belongs, independent of storage mode: which collection/env
 * (or project-level fallback), and the relative path from the project's content root
 * (e.g. "Collection1/QA/testData/users.csv"). Callers root this against either a real
 * userProjPath (SSH) or a gitEngine session's content root (PAT).
 */
async function resolveDestination(projectId, colId, envName, userId) {
  if (colId) {
    const col = await db.prepare('SELECT * FROM collections WHERE id = ? AND project_id = ? AND user_id = ?').get(colId, projectId, userId);
    if (col) {
      let targetEnv = envName;
      if (!targetEnv) {
        try {
          const envs = JSON.parse(col.environments || '[]');
          targetEnv = envs[0] || col.environment || 'Default';
        } catch { targetEnv = col.environment || 'Default'; }
      }
      return { col, relDir: posix.join(cleanName(col.name), cleanName(targetEnv), 'testData') };
    }
  }
  return { col: null, relDir: 'testData' };
}

router.use(auth);

router.get('/', async (req, res) => {
  if (!await ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const colId   = req.query.collection_id;
  const envName = req.query.env;
  let files;
  if (colId && envName) {
    // Strict env isolation: filter by collection_id + env DB columns
    files = await db.prepare(
      "SELECT * FROM test_data_files WHERE project_id = ? AND collection_id = ? AND env = ? AND user_id = ? ORDER BY created_at DESC"
    ).all(req.params.projectId, colId, envName, req.userId);
    // Fallback: include files without DB tags but with matching path (legacy files uploaded before tagging)
    if (!files.length) {
      const col = await db.prepare('SELECT * FROM collections WHERE id = ? AND project_id = ? AND user_id = ?').get(colId, req.params.projectId, req.userId);
      if (col) {
        const proj = await db.prepare('SELECT folder_path FROM projects WHERE id = ?').get(req.params.projectId);
        const basePath = proj?.folder_path || '';
        if (basePath) {
          const filterPath = getCollectionPath(basePath, col.name, envName).replace(/\\/g, '/');
          const legacyFiles = await db.prepare('SELECT * FROM test_data_files WHERE project_id = ? AND (collection_id IS NULL OR collection_id = 0) AND user_id = ? ORDER BY created_at DESC').all(req.params.projectId, req.userId);
          files = legacyFiles.filter(f => f.path && f.path.replace(/\\/g, '/').startsWith(filterPath));
        }
      }
    }
  } else if (colId) {
    files = await db.prepare(
      "SELECT * FROM test_data_files WHERE project_id = ? AND collection_id = ? AND user_id = ? ORDER BY created_at DESC"
    ).all(req.params.projectId, colId, req.userId);
  } else {
    files = await db.prepare('SELECT * FROM test_data_files WHERE project_id = ? AND user_id = ? ORDER BY created_at DESC').all(req.params.projectId, req.userId);
  }

  // Flag stale files (DB record exists but file no longer available)
  const isSSH = await isSshMode(req.userId, req.params.projectId);
  let result;
  if (isSSH) {
    result = files.map(f => ({ ...f, stale: !fs.existsSync(f.path) }));
  } else {
    const proj = await db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.projectId);
    const orgSlug = await resolveOrgSlugForProject(req.params.projectId);
    const gitDir = await resolveActorGitDir(req.userId, req.params.projectId, proj?.name || '');
    const session = gitDir ? await gitEngine.openSession(gitDir, orgSlug) : null;
    result = files.map(f => ({ ...f, stale: !(session && session.fs.existsSync(posix.join(session.dir, f.path))) }));
  }
  res.json({ files: result });
});

router.post('/', upload.single('csv'), async (req, res) => {
  const proj = await ownsProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  if (!req.file) return res.status(400).json({ error: 'CSV file required' });
  if (!proj.folder_path) return res.status(400).json({ error: 'git_not_initialized: Git repository not initialized. Go to Configuration → Git to initialize the repository first.' });

  const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
  const colId   = req.query.collection_id || req.body?.collection_id || null;
  const envName = req.query.env || req.body?.env || '';

  try {
    const isSSH = await isSshMode(req.userId, req.params.projectId);
    const orgSlug = await resolveOrgSlugForProject(req.params.projectId);

    let headers;
    if (req.body?.columns) {
      try { headers = JSON.parse(req.body.columns); } catch { headers = req.body.columns.split(',').map(c => c.trim()); }
    } else if (/\.(csv|txt)$/i.test(req.file.originalname)) {
      ({ headers } = readCsvContent(req.file.buffer, 1));
    } else {
      headers = []; // xlsx/xls without supplied columns — columns unknown until editor opens
    }

    if (!isSSH) {
      // ── PAT mode: write straight into the gitEngine in-memory session, no local file ever —
      // always the CALLING user's own workspace, never proj.folder_path (the admin's) ────────
      const gitDir = await resolveActorGitDir(req.userId, req.params.projectId, proj.name);
      if (!gitDir) return res.status(400).json({ error: 'git_not_initialized: Git repository not initialized. Go to Configuration → Git to initialize the repository first.' });
      const session = await gitEngine.openSession(gitDir, orgSlug);
      const contentRoot = posix.join(session.dir, cleanName(proj.name));

      if (colId && !envName) {
        // "All environments" — copy file to every env folder of the collection
        const col = await db.prepare('SELECT * FROM collections WHERE id = ? AND project_id = ? AND user_id = ?').get(colId, req.params.projectId, req.userId);
        if (col) {
          let allEnvs = [];
          try { allEnvs = JSON.parse(col.environments || '[]'); } catch {}
          if (!allEnvs.length && col.environment) allEnvs = [col.environment];
          if (!allEnvs.length) allEnvs = ['Default'];

          let lastFileId = null;
          for (const ev of allEnvs) {
            const relDir = posix.join(cleanName(col.name), cleanName(ev), 'testData');
            const relPath = posix.join(relDir, safeName);
            session.fs.mkdirSync(posix.join(contentRoot, relDir), { recursive: true });
            session.fs.writeFileSync(posix.join(contentRoot, relPath), req.file.buffer);
            const evFilePath = posix.join(cleanName(proj.name), relPath);

            const evExisting = await db.prepare(
              "SELECT id FROM test_data_files WHERE project_id = ? AND original_name = ? AND env = ? AND collection_id = ? AND user_id = ?"
            ).get(req.params.projectId, req.file.originalname, ev, colId, req.userId);
            if (evExisting) {
              await db.prepare('UPDATE test_data_files SET filename=?, path=?, columns=?, collection_id=?, env=? WHERE id=? AND user_id=?')
                .run(safeName, evFilePath, JSON.stringify(headers), colId, ev, evExisting.id, req.userId);
              lastFileId = evExisting.id;
            } else {
              const r = await db.prepare('INSERT INTO test_data_files (project_id, collection_id, env, filename, original_name, path, columns, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
                .run(req.params.projectId, colId, ev, safeName, req.file.originalname, evFilePath, JSON.stringify(headers), req.userId);
              lastFileId = r.lastInsertRowid;
            }
          }
          await gitEngine.persistSession(session, gitDir, orgSlug);
          return res.json({ file: await db.prepare('SELECT * FROM test_data_files WHERE id = ? AND user_id = ?').get(lastFileId, req.userId), copied_to_envs: allEnvs });
        }
      }

      // Single environment upload
      let targetEnv = envName;
      let relDir = 'testData';
      if (colId) {
        const col = await db.prepare('SELECT * FROM collections WHERE id = ? AND project_id = ? AND user_id = ?').get(colId, req.params.projectId, req.userId);
        if (col) {
          if (!targetEnv) {
            try { const envs = JSON.parse(col.environments || '[]'); targetEnv = envs[0] || col.environment || 'Default'; } catch { targetEnv = col.environment || 'Default'; }
          }
          relDir = posix.join(cleanName(col.name), cleanName(targetEnv), 'testData');
        }
      }
      const relPath = posix.join(relDir, safeName);
      session.fs.mkdirSync(posix.join(contentRoot, relDir), { recursive: true });
      session.fs.writeFileSync(posix.join(contentRoot, relPath), req.file.buffer);
      const filePath = posix.join(cleanName(proj.name), relPath);

      const destPrefix = posix.dirname(filePath);
      const existing = await db.prepare(
        "SELECT id FROM test_data_files WHERE project_id = ? AND original_name = ? AND REPLACE(path, '\\', '/') LIKE ? AND user_id = ?"
      ).get(req.params.projectId, req.file.originalname, `${destPrefix}/%`, req.userId);

      let fileId;
      if (existing) {
        await db.prepare('UPDATE test_data_files SET filename=?, path=?, columns=?, collection_id=?, env=? WHERE id=? AND user_id=?')
          .run(safeName, filePath, JSON.stringify(headers), colId, targetEnv || envName, existing.id, req.userId);
        fileId = existing.id;
      } else {
        const result = await db.prepare(
          'INSERT INTO test_data_files (project_id, collection_id, env, filename, original_name, path, columns, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(req.params.projectId, colId, targetEnv || envName, safeName, req.file.originalname, filePath, JSON.stringify(headers), req.userId);
        fileId = result.lastInsertRowid;
      }
      await gitEngine.persistSession(session, gitDir, orgSlug);
      return res.json({ file: await db.prepare('SELECT * FROM test_data_files WHERE id = ? AND user_id = ?').get(fileId, req.userId) });
    }

    // ── SSH mode: unchanged — write to the real local workspace directory ──────────────
    const callerUser = await db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId);
    const userProjPath = await getUserProjectPath(req.userId, callerUser?.role, proj.name, proj.id);
    if (!userProjPath) return res.status(400).json({ error: 'Git repository not initialized.' });
    await require('../routes/git').ensureGitWorkspaceHydrated(path.dirname(userProjPath), req.params.projectId, req.userId);

    const { col, relDir } = await resolveDestination(req.params.projectId, colId, envName, req.userId);
    const destFolder = path.join(userProjPath, ...relDir.split('/'));
    fs.mkdirSync(destFolder, { recursive: true });
    const filePath = path.join(destFolder, safeName);
    fs.writeFileSync(filePath, req.file.buffer);

    const initialUp = await s3Sync.uploadFile(filePath, orgSlug);
    if (!initialUp.ok && !initialUp.skipped) console.error('[TestData] S3 sync failed for', filePath, ':', initialUp.error?.message);

    if (colId && !envName && col) {
      let allEnvs = [];
      try { allEnvs = JSON.parse(col.environments || '[]'); } catch {}
      if (!allEnvs.length && col.environment) allEnvs = [col.environment];
      if (!allEnvs.length) allEnvs = ['Default'];

      let lastFileId = null;
      for (const ev of allEnvs) {
        const envPath = getCollectionPath(userProjPath, col.name, ev);
        const evDestFolder = path.join(envPath, 'testData');
        fs.mkdirSync(evDestFolder, { recursive: true });
        const evFilePath = path.join(evDestFolder, safeName);
        fs.copyFileSync(filePath, evFilePath);
        const evUp = await s3Sync.uploadFile(evFilePath, orgSlug);
        if (!evUp.ok && !evUp.skipped) console.error('[TestData] S3 sync failed for', evFilePath, ':', evUp.error?.message);

        const evExisting = await db.prepare(
          "SELECT id FROM test_data_files WHERE project_id = ? AND original_name = ? AND env = ? AND collection_id = ? AND user_id = ?"
        ).get(req.params.projectId, req.file.originalname, ev, colId, req.userId);
        if (evExisting) {
          await db.prepare('UPDATE test_data_files SET filename=?, path=?, columns=?, collection_id=?, env=? WHERE id=? AND user_id=?')
            .run(safeName, evFilePath, JSON.stringify(headers), colId, ev, evExisting.id, req.userId);
          lastFileId = evExisting.id;
        } else {
          const r = await db.prepare('INSERT INTO test_data_files (project_id, collection_id, env, filename, original_name, path, columns, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(req.params.projectId, colId, ev, safeName, req.file.originalname, evFilePath, JSON.stringify(headers), req.userId);
          lastFileId = r.lastInsertRowid;
        }
      }
      return res.json({ file: await db.prepare('SELECT * FROM test_data_files WHERE id = ? AND user_id = ?').get(lastFileId, req.userId), copied_to_envs: allEnvs });
    }

    const destDir = path.dirname(filePath).replace(/\\/g, '/');
    const existing = await db.prepare(
      "SELECT id FROM test_data_files WHERE project_id = ? AND original_name = ? AND REPLACE(path, '\\', '/') LIKE ? AND user_id = ?"
    ).get(req.params.projectId, req.file.originalname, `${destDir}/%`, req.userId);

    let fileId;
    if (existing) {
      await db.prepare(
        'UPDATE test_data_files SET filename=?, path=?, columns=?, collection_id=?, env=? WHERE id=? AND user_id=?'
      ).run(safeName, filePath, JSON.stringify(headers), colId, envName, existing.id, req.userId);
      fileId = existing.id;
    } else {
      const result = await db.prepare(
        'INSERT INTO test_data_files (project_id, collection_id, env, filename, original_name, path, columns, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(req.params.projectId, colId, envName, safeName, req.file.originalname, filePath, JSON.stringify(headers), req.userId);
      fileId = result.lastInsertRowid;
    }

    res.json({ file: await db.prepare('SELECT * FROM test_data_files WHERE id = ? AND user_id = ?').get(fileId, req.userId) });
  } catch (e) {
    res.status(400).json({ error: `Failed to read file: ${e.message}` });
  }
});

router.get('/:id/content', async (req, res) => {
  if (!await ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const file = await db.prepare('SELECT * FROM test_data_files WHERE id = ? AND project_id = ? AND user_id = ?').get(req.params.id, req.params.projectId, req.userId);
  if (!file) return res.status(404).json({ error: 'Test data file not found — it may have been deleted. Please re-upload the file.' });

  const limit = parseInt(req.query.limit) || 500;
  const offset = parseInt(req.query.offset) || 0;
  const isSSH = await isSshMode(req.userId, req.params.projectId);

  try {
    if (!isSSH) {
      const proj = await db.prepare('SELECT name FROM projects WHERE id = ?').get(req.params.projectId);
      const orgSlug = await resolveOrgSlugForProject(req.params.projectId);
      const gitDir = await resolveActorGitDir(req.userId, req.params.projectId, proj?.name || '');
      if (!gitDir) return res.status(404).json({ error: 'Git repository not initialized.' });
      const session = await gitEngine.openSession(gitDir, orgSlug);
      const full = posix.join(session.dir, file.path);
      if (!session.fs.existsSync(full)) {
        return res.status(404).json({ error: `File not found: "${file.original_name}". The file may have been deleted or the workspace was re-initialized. Please delete this record and re-upload the file.`, stale: true, file_id: file.id });
      }
      const { headers, rows, totalRows } = readCsvContent(session.fs.readFileSync(full), offset + limit);
      return res.json({ headers, rows: rows.slice(offset), totalRows });
    }

    // ── SSH mode: unchanged ────────────────────────────────────────────────────────────
    await hydrateOwnWorkspace(req.params.projectId, req.userId);
    if (!fs.existsSync(file.path)) {
      return res.status(404).json({
        error: `File not found on disk: "${file.original_name}". The file may have been deleted or the workspace was re-initialized. Please delete this record and re-upload the file.`,
        stale: true,
        file_id: file.id,
      });
    }
    const { headers, rows, totalRows } = readCsv(file.path, offset + limit);
    res.json({ headers, rows: rows.slice(offset), totalRows });
  } catch (e) {
    res.status(500).json({ error: `Failed to read file: ${e.message}` });
  }
});

router.put('/:id/content', async (req, res) => {
  if (!await ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const file = await db.prepare('SELECT * FROM test_data_files WHERE id = ? AND project_id = ? AND user_id = ?').get(req.params.id, req.params.projectId, req.userId);
  if (!file) return res.status(404).json({ error: 'Test data file not found — it may have been deleted. Please re-upload the file.' });

  const { headers, rows } = req.body;
  if (!Array.isArray(headers) || !Array.isArray(rows)) return res.status(400).json({ error: 'headers and rows arrays required' });

  try {
    const isSSH = await isSshMode(req.userId, req.params.projectId);
    const orgSlug = await resolveOrgSlugForProject(req.params.projectId);

    if (!isSSH) {
      const proj = await db.prepare('SELECT name FROM projects WHERE id = ?').get(req.params.projectId);
      const gitDir = await resolveActorGitDir(req.userId, req.params.projectId, proj?.name || '');
      if (!gitDir) return res.status(404).json({ error: 'Git repository not initialized.' });
      const session = await gitEngine.openSession(gitDir, orgSlug);
      const full = posix.join(session.dir, file.path);
      const { buildCsvContent } = require('../utils/csvUtils');
      session.fs.mkdirSync(posix.dirname(full), { recursive: true });
      session.fs.writeFileSync(full, buildCsvContent(headers, rows), 'utf8');
      await gitEngine.persistSession(session, gitDir, orgSlug);
      await db.prepare('UPDATE test_data_files SET columns = ? WHERE id = ? AND user_id = ?').run(JSON.stringify(headers), req.params.id, req.userId);
      return res.json({ ok: true });
    }

    // ── SSH mode: unchanged ────────────────────────────────────────────────────────────
    await hydrateOwnWorkspace(req.params.projectId, req.userId);
    writeCsv(file.path, headers, rows);
    const up = await s3Sync.uploadFile(file.path, orgSlug);
    if (!up.ok && !up.skipped) console.error('[TestData] S3 sync failed for', file.path, ':', up.error?.message);
    await db.prepare('UPDATE test_data_files SET columns = ? WHERE id = ? AND user_id = ?').run(JSON.stringify(headers), req.params.id, req.userId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: `Failed to write file: ${e.message}` });
  }
});

// ── POST /:id/open-external — open the file with the OS default application ──
// Desktop-only convenience feature (opens a LOCAL file with a LOCAL OS app) — only
// meaningful for SSH-mode workspaces, which still have a real local directory.
router.post('/:id/open-external', async (req, res) => {
  if (!await ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const file = await db.prepare('SELECT * FROM test_data_files WHERE id = ? AND project_id = ? AND user_id = ?').get(req.params.id, req.params.projectId, req.userId);
  if (!file) return res.status(404).json({ error: 'Test data file not found — it may have been deleted. Please re-upload the file.' });

  const isSSH = await isSshMode(req.userId, req.params.projectId);
  if (!isSSH) {
    return res.status(501).json({ error: 'Opening files in a desktop application is only available for SSH-mode workspaces (PAT-mode workspaces have no local file to open). Use the built-in editor instead.' });
  }

  await hydrateOwnWorkspace(req.params.projectId, req.userId);

  const { exec } = require('child_process');

  if (!fs.existsSync(file.path)) {
    return res.status(404).json({ error: 'File not found on disk. Please delete this record and re-upload the file.', stale: true });
  }

  // Open with the OS default app (Excel/Numbers for .csv on most systems)
  const absPath = path.resolve(file.path);
  let cmd;
  if (process.platform === 'win32') {
    // Use explorer to open with default app — handles paths with spaces correctly
    cmd = `explorer "${absPath}"`;
  } else if (process.platform === 'darwin') {
    cmd = `open "${absPath}"`;
  } else {
    cmd = `xdg-open "${absPath}"`;
  }

  exec(cmd, { timeout: 5000 }, (err) => {
    if (err && !err.killed) {
      // explorer.exe often returns exit code 1 even on success — ignore that
      if (process.platform !== 'win32') {
        return res.status(500).json({ error: 'Could not open file: ' + err.message });
      }
    }
    res.json({ ok: true, path: absPath, message: `Opened "${file.original_name}" in default application` });
  });
});

router.delete('/:id', async (req, res) => {
  const proj = await ownsProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  const file = await db.prepare('SELECT * FROM test_data_files WHERE id = ? AND project_id = ? AND user_id = ?').get(req.params.id, req.params.projectId, req.userId);
  if (!file) return res.status(404).json({ error: 'Test data file not found — it may have already been deleted.' });

  const isSSH = await isSshMode(req.userId, req.params.projectId);
  const orgSlug = await resolveOrgSlugForProject(req.params.projectId);

  if (!isSSH) {
    const gitDir = await resolveActorGitDir(req.userId, req.params.projectId, proj.name);
    if (gitDir) {
      const session = await gitEngine.openSession(gitDir, orgSlug);
      const full = posix.join(session.dir, file.path);
      try { session.fs.unlinkSync(full); } catch (_) {}
      await gitEngine.persistSession(session, gitDir, orgSlug);
    }
  } else {
    // Delete the actual file — path is now always the correct env-specific location
    try { fs.unlinkSync(file.path); } catch (_) { /* already gone */ }
    const del = await s3Sync.deleteObject(file.path, orgSlug);
    if (!del.ok && !del.skipped) console.error('[TestData] S3 delete failed for', file.path, ':', del.error?.message);
  }

  await db.prepare('DELETE FROM test_data_files WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
  resetSequence('test_data_files');
  res.json({ ok: true });
});

module.exports = router;
