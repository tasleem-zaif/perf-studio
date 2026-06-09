const router = require('express').Router({ mergeParams: true });
const path = require('path');
const { unlinkSync } = require('fs');
const multer = require('multer');
const db = require('../db');
const auth = require('../middleware/auth');
const ownsProject = require('../utils/ownsProject');
const { readCsv, writeCsv } = require('../utils/csvUtils');
const { ensureProjectFolders } = require('../utils/projectFolders');
const resetSequence = require('../utils/resetSequence');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const proj = ownsProject(req.userId, req.params.projectId);
    if (!proj) return cb(new Error('Project not found'));
    if (!proj.folder_path) return cb(new Error('git_not_initialized: Git repository not initialized. Go to Configuration → Git to initialize the repository first.'));

    const { getUserProjectPath, getCollectionPath, isAdminWorkspace } = require('../utils/projectFolders');
    const callerUser = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId);
    const userProjPath = getUserProjectPath(req.userId, callerUser?.role, proj.name);
    if (!userProjPath) return cb(new Error('Git repository not initialized.'));

    // Admin workspace holds only empty folders — block file uploads for admin
    if (isAdminWorkspace(userProjPath)) {
      return cb(new Error('admin_workspace: Test data files cannot be uploaded to the admin workspace. Please use a regular user account to upload test data.'));
    }

    // If a collection_id is provided, store inside collection/env/testData/
    const colId = req.query.collection_id || req.body?.collection_id;
    const envName = req.query.env || req.body?.env;

    if (colId) {
      const col = db.prepare('SELECT * FROM collections WHERE id = ? AND project_id = ?').get(colId, req.params.projectId);
      if (col) {
        // Resolve the target environment
        let targetEnv = envName;
        if (!targetEnv) {
          // Fall back to first env from collection's environments array
          try {
            const envs = JSON.parse(col.environments || '[]');
            targetEnv = envs[0] || col.environment || 'Default';
          } catch {
            targetEnv = col.environment || 'Default';
          }
        }

        // Ensure the env folder exists
        const envFolderPath = getCollectionPath(userProjPath, col.name, targetEnv);
        require('fs').mkdirSync(path.join(envFolderPath, 'testData'), { recursive: true });
        return cb(null, path.join(envFolderPath, 'testData'));
      }
    }

    // Fallback: project-level testData folder
    const dest = path.join(userProjPath, 'testData');
    require('fs').mkdirSync(dest, { recursive: true });
    cb(null, dest);
  },
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, safeName);
  },
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 }, fileFilter: (req, file, cb) => {
  if (!file.originalname.match(/\.(csv|txt|xlsx|xls)$/i)) return cb(new Error('Only CSV, TXT, XLS or XLSX files allowed'));
  cb(null, true);
}});

router.use(auth);

router.get('/', (req, res) => {
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const colId   = req.query.collection_id;
  const envName = req.query.env;
  let files;
  if (colId && envName) {
    // Strict env isolation: filter by collection_id + env DB columns
    files = db.prepare(
      "SELECT * FROM test_data_files WHERE project_id = ? AND collection_id = ? AND env = ? ORDER BY created_at DESC"
    ).all(req.params.projectId, colId, envName);
    // Fallback: include files without DB tags but with matching path (legacy files uploaded before tagging)
    if (!files.length) {
      const col = db.prepare('SELECT * FROM collections WHERE id = ? AND project_id = ?').get(colId, req.params.projectId);
      if (col) {
        const proj = db.prepare('SELECT folder_path FROM projects WHERE id = ?').get(req.params.projectId);
        const basePath = proj?.folder_path || '';
        if (basePath) {
          const { getCollectionPath } = require('../utils/projectFolders');
          const filterPath = getCollectionPath(basePath, col.name, envName).replace(/\\/g, '/');
          files = db.prepare('SELECT * FROM test_data_files WHERE project_id = ? AND (collection_id IS NULL OR collection_id = 0) ORDER BY created_at DESC').all(req.params.projectId)
            .filter(f => f.path && f.path.replace(/\\/g, '/').startsWith(filterPath));
        }
      }
    }
  } else if (colId) {
    files = db.prepare(
      "SELECT * FROM test_data_files WHERE project_id = ? AND collection_id = ? ORDER BY created_at DESC"
    ).all(req.params.projectId, colId);
  } else {
    files = db.prepare('SELECT * FROM test_data_files WHERE project_id = ? ORDER BY created_at DESC').all(req.params.projectId);
  }
  // Flag stale files (DB record exists but file no longer on disk)
  const fs = require('fs');
  const result = files.map(f => ({ ...f, stale: !fs.existsSync(f.path) }));
  res.json({ files: result });
});

router.post('/', upload.single('csv'), (req, res) => {
  const proj = ownsProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  if (!req.file) return res.status(400).json({ error: 'CSV file required' });

  try {
    let headers;
    // If the caller already knows the columns (e.g., generated data), use them directly
    if (req.body?.columns) {
      try { headers = JSON.parse(req.body.columns); } catch { headers = req.body.columns.split(',').map(c => c.trim()); }
    } else if (/\.(csv|txt)$/i.test(req.file.originalname)) {
      ({ headers } = readCsv(req.file.path, 1));
    } else {
      headers = []; // xlsx/xls without supplied columns — columns unknown until editor opens
    }

    // Upsert by original_name + destination path prefix so the same filename in
    // different env folders (QA/testData/users.csv vs Staging/testData/users.csv)
    // are stored as SEPARATE records, while re-uploading the exact same file
    // (same name + same destination dir) updates the existing record.
    const destDir = require('path').dirname(req.file.path).replace(/\\/g, '/');
    const existing = db.prepare(
      "SELECT id FROM test_data_files WHERE project_id = ? AND original_name = ? AND REPLACE(path, '\\', '/') LIKE ?"
    ).get(req.params.projectId, req.file.originalname, `${destDir}/%`);

    let fileId;
    const colId   = req.query.collection_id || req.body?.collection_id || null;
    const envName = req.query.env || req.body?.env || '';

    // "All environments" — copy file to every env folder of the collection
    if (colId && !envName) {
      const col = db.prepare('SELECT * FROM collections WHERE id = ? AND project_id = ?').get(colId, req.params.projectId);
      if (col) {
        let allEnvs = [];
        try { allEnvs = JSON.parse(col.environments || '[]'); } catch {}
        if (!allEnvs.length && col.environment) allEnvs = [col.environment];
        if (!allEnvs.length) allEnvs = ['Default'];

        const { getUserProjectPath, getCollectionPath } = require('../utils/projectFolders');
        const callerUser = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId);
        const userProjPath = getUserProjectPath(req.userId, callerUser?.role, proj.name);

        let lastFileId = null;
        for (const ev of allEnvs) {
          // Determine the CORRECT path for THIS env's testData folder
          let evFilePath = req.file.path; // fallback
          if (userProjPath) {
            const envPath = getCollectionPath(userProjPath, col.name, ev);
            const destFolder = path.join(envPath, 'testData');
            require('fs').mkdirSync(destFolder, { recursive: true });
            const destFile = path.join(destFolder, req.file.filename);
            require('fs').copyFileSync(req.file.path, destFile);
            evFilePath = destFile; // store THE ACTUAL path for this env
          }
          // Save a DB record per env with CORRECT path
          const evExisting = db.prepare(
            "SELECT id FROM test_data_files WHERE project_id = ? AND original_name = ? AND env = ? AND collection_id = ?"
          ).get(req.params.projectId, req.file.originalname, ev, colId);
          if (evExisting) {
            db.prepare('UPDATE test_data_files SET filename=?, path=?, columns=?, collection_id=?, env=? WHERE id=?')
              .run(req.file.filename, evFilePath, JSON.stringify(headers), colId, ev, evExisting.id);
            lastFileId = evExisting.id;
          } else {
            const r = db.prepare('INSERT INTO test_data_files (project_id, collection_id, env, filename, original_name, path, columns) VALUES (?, ?, ?, ?, ?, ?, ?)')
              .run(req.params.projectId, colId, ev, req.file.filename, req.file.originalname, evFilePath, JSON.stringify(headers));
            lastFileId = r.lastInsertRowid;
          }
        }
        return res.json({ file: db.prepare('SELECT * FROM test_data_files WHERE id = ?').get(lastFileId), copied_to_envs: allEnvs });
      }
    }

    // Single environment upload
    if (existing) {
      db.prepare(
        'UPDATE test_data_files SET filename=?, path=?, columns=?, collection_id=?, env=? WHERE id=?'
      ).run(req.file.filename, req.file.path, JSON.stringify(headers), colId, envName, existing.id);
      fileId = existing.id;
    } else {
      const result = db.prepare(
        'INSERT INTO test_data_files (project_id, collection_id, env, filename, original_name, path, columns) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(req.params.projectId, colId, envName, req.file.filename, req.file.originalname, req.file.path, JSON.stringify(headers));
      fileId = result.lastInsertRowid;
    }

    res.json({ file: db.prepare('SELECT * FROM test_data_files WHERE id = ?').get(fileId) });
  } catch (e) {
    res.status(400).json({ error: `Failed to read file: ${e.message}` });
  }
});

router.get('/:id/content', (req, res) => {
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const file = db.prepare('SELECT * FROM test_data_files WHERE id = ? AND project_id = ?').get(req.params.id, req.params.projectId);
  if (!file) return res.status(404).json({ error: 'Not found' });

  // Check file exists on disk before attempting to read
  const fs = require('fs');
  if (!fs.existsSync(file.path)) {
    return res.status(404).json({
      error: `File not found on disk: "${file.original_name}". The file may have been deleted or the workspace was re-initialized. Please delete this record and re-upload the file.`,
      stale: true,
      file_id: file.id,
    });
  }

  const limit = parseInt(req.query.limit) || 500;
  const offset = parseInt(req.query.offset) || 0;

  try {
    const { headers, rows, totalRows } = readCsv(file.path, offset + limit);
    res.json({ headers, rows: rows.slice(offset), totalRows });
  } catch (e) {
    res.status(500).json({ error: `Failed to read file: ${e.message}` });
  }
});

router.put('/:id/content', (req, res) => {
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const file = db.prepare('SELECT * FROM test_data_files WHERE id = ? AND project_id = ?').get(req.params.id, req.params.projectId);
  if (!file) return res.status(404).json({ error: 'Not found' });

  const { headers, rows } = req.body;
  if (!Array.isArray(headers) || !Array.isArray(rows)) return res.status(400).json({ error: 'headers and rows arrays required' });

  try {
    writeCsv(file.path, headers, rows);
    db.prepare('UPDATE test_data_files SET columns = ? WHERE id = ?').run(JSON.stringify(headers), req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: `Failed to write file: ${e.message}` });
  }
});

// ── POST /:id/open-external — open the file with the OS default application ──
router.post('/:id/open-external', (req, res) => {
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const file = db.prepare('SELECT * FROM test_data_files WHERE id = ? AND project_id = ?').get(req.params.id, req.params.projectId);
  if (!file) return res.status(404).json({ error: 'Not found' });

  const fs   = require('fs');
  const { exec } = require('child_process');

  if (!fs.existsSync(file.path)) {
    return res.status(404).json({ error: 'File not found on disk. Please delete this record and re-upload the file.', stale: true });
  }

  // Open with the OS default app (Excel/Numbers for .csv on most systems)
  const absPath = require('path').resolve(file.path);
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

router.delete('/:id', (req, res) => {
  const proj = ownsProject(req.userId, req.params.projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  const file = db.prepare('SELECT * FROM test_data_files WHERE id = ? AND project_id = ?').get(req.params.id, req.params.projectId);
  if (!file) return res.status(404).json({ error: 'Not found' });

  // Delete the actual file — path is now always the correct env-specific location
  try { unlinkSync(file.path); } catch (_) { /* already gone */ }

  db.prepare('DELETE FROM test_data_files WHERE id = ?').run(req.params.id);
  resetSequence('test_data_files');
  res.json({ ok: true });
});

module.exports = router;
