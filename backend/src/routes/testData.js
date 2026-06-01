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
        const { ensureCollectionFolders, getCollectionPath } = require('../utils/projectFolders');
        const basePath = proj.folder_path || '';
        if (basePath) {
          const envFolderPath = getCollectionPath(basePath, col.name, col.id, targetEnv);
          require('fs').mkdirSync(path.join(envFolderPath, 'testData'), { recursive: true });
          return cb(null, path.join(envFolderPath, 'testData'));
        }
      }
    }

    // Fallback: project-level testData folder
    let folderPath = proj.folder_path;
    if (!folderPath) {
      folderPath = ensureProjectFolders(proj.name, proj.id, proj.uuid || proj.environment);
      db.prepare('UPDATE projects SET folder_path = ? WHERE id = ?').run(folderPath, proj.id);
    }
    const dest = path.join(folderPath, 'testData');
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
  const colId  = req.query.collection_id;
  const envName = req.query.env;
  let files;
  if (colId) {
    const col = db.prepare('SELECT * FROM collections WHERE id = ? AND project_id = ?').get(colId, req.params.projectId);
    if (col && col.folder_path || (col && require('../utils/projectFolders').PROJECTS_ROOT)) {
      const proj = db.prepare('SELECT folder_path FROM projects WHERE id = ?').get(req.params.projectId);
      const basePath = proj?.folder_path || '';
      let filterPath;
      if (envName && basePath) {
        // Filter to specific env folder
        const { getCollectionPath } = require('../utils/projectFolders');
        filterPath = getCollectionPath(basePath, col.name, col.id, envName).replace(/\\/g, '/');
      } else if (col.folder_path) {
        // Filter to all files under the collection folder (all envs)
        filterPath = col.folder_path.replace(/\\/g, '/');
      }
      if (filterPath) {
        files = db.prepare('SELECT * FROM test_data_files WHERE project_id = ? ORDER BY created_at DESC').all(req.params.projectId)
          .filter(f => f.path && f.path.replace(/\\/g, '/').startsWith(filterPath));
      } else {
        files = [];
      }
    } else {
      files = [];
    }
  } else {
    files = db.prepare('SELECT * FROM test_data_files WHERE project_id = ? ORDER BY created_at DESC').all(req.params.projectId);
  }
  res.json({ files });
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
    if (existing) {
      db.prepare(
        'UPDATE test_data_files SET filename=?, path=?, columns=? WHERE id=?'
      ).run(req.file.filename, req.file.path, JSON.stringify(headers), existing.id);
      fileId = existing.id;
    } else {
      const result = db.prepare(
        'INSERT INTO test_data_files (project_id, filename, original_name, path, columns) VALUES (?, ?, ?, ?, ?)'
      ).run(req.params.projectId, req.file.filename, req.file.originalname, req.file.path, JSON.stringify(headers));
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

router.delete('/:id', (req, res) => {
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const file = db.prepare('SELECT * FROM test_data_files WHERE id = ? AND project_id = ?').get(req.params.id, req.params.projectId);
  if (!file) return res.status(404).json({ error: 'Not found' });
  try { unlinkSync(file.path); } catch (_) { /* file may already be gone */ }
  db.prepare('DELETE FROM test_data_files WHERE id = ?').run(req.params.id);
  resetSequence('test_data_files');
  res.json({ ok: true });
});

module.exports = router;
