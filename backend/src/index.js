require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';
// In production (Docker), frontend is served by this same server — allow any same-origin request
app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (same-origin, mobile apps, curl)
    if (!origin) return cb(null, true);
    // Allow configured origin or any localhost port
    if (origin === CORS_ORIGIN || /^http:\/\/localhost:\d+$/.test(origin)) return cb(null, true);
    cb(null, true); // allow all in current setup — restrict in production via CORS_ORIGIN env var
  },
  credentials: true,
}));
app.use(express.json());

app.use('/api/auth',                                   require('./routes/auth'));
app.use('/api/auth',                                   require('./routes/passwordReset'));
app.use('/api/admin',                                  require('./routes/passwordReset'));
app.use('/api/orgs',                                   require('./routes/orgs'));
app.use('/api/admin',                                  require('./routes/admin'));
app.use('/api/dashboard',                              require('./routes/dashboard'));
app.use('/api',                                        require('./routes/summary'));
app.use('/api/projects',                               require('./routes/projects'));
app.use('/api/projects/:projectId/collections',        require('./routes/collections'));
app.use('/api/projects/:projectId/rules',              require('./routes/rules'));
app.use('/api/projects/:projectId/scripts',            require('./routes/scripts'));
app.use('/api/projects/:projectId/test-suites',        require('./routes/testSuites'));
app.use('/api/projects/:projectId/test-data',          require('./routes/testData'));
app.use('/api/projects/:projectId/config',             require('./routes/projectConfig'));
app.use('/api/projects/:projectId/collections/:collectionId/env-config', require('./routes/envConfig'));
app.use('/api/config',                                 require('./routes/config'));
app.use('/api/ai',                                     require('./routes/ai'));
app.use('/api/settings',                               require('./routes/settings'));
app.use('/api/runner',                                 require('./routes/runner'));
app.use('/api/execution',                              require('./routes/execution'));
app.use('/api/alerts',                                 require('./routes/alerts'));
app.use('/api/invites',                                require('./routes/invites'));
app.use('/api/projects/:projectId/git',              require('./routes/git'));
app.use('/api/projects/:projectId/pipelines',        require('./routes/pipelines'));
app.use('/api/projects/:projectId/ci',               require('./routes/ciPipeline'));

// Serve generated project files (scripts, test data, HTML reports) for download
// Mount the entire git-workspaces root so user workspace reports are accessible
const { PROJECTS_ROOT, GIT_WORKSPACES_ROOT } = require('./utils/projectFolders');
app.use('/projects-files', express.static(PROJECTS_ROOT));
app.use('/workspace-files', express.static(GIT_WORKSPACES_ROOT));

app.get('/api/health', (_, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ── Production: serve the built React frontend ────────────────────────────────
// When running inside the Docker all-in-one image, the frontend is built and
// copied to backend/public. Serve it as static files and fall back to index.html
// for all non-API routes (SPA routing support).
if (process.env.NODE_ENV === 'production') {
  const fs = require('fs');
  const frontendBuild = path.join(__dirname, '..', 'public');
  if (fs.existsSync(frontendBuild)) {
    app.use(express.static(frontendBuild));
    // Catch-all: return index.html for any non-API route (React SPA routing)
    app.get('*', (req, res) => {
      if (!req.path.startsWith('/api/') && !req.path.startsWith('/projects-files/')) {
        res.sendFile(path.join(frontendBuild, 'index.html'));
      }
    });
    console.log(`Serving frontend from ${frontendBuild}`);
  }
}

app.listen(PORT, () => {
  console.log(`PerfStudio API running on http://localhost:${PORT}`);

  // ── On startup: mark orphaned running runs as failed ─────────────────────
  // If the server was restarted mid-execution, runs stuck in 'running' state
  // will never complete. Mark them failed so the UI doesn't show stale spinners.
  try {
    const db = require('./db');
    const orphanedExec = db.prepare(
      "UPDATE execution_runs SET status='failed', finished_at=datetime('now') WHERE status='running'"
    ).run();
    const orphanedPipeline = db.prepare(
      "UPDATE pipeline_runs SET status='failed', finished_at=datetime('now') WHERE status='running'"
    ).run();
    if (orphanedExec.changes > 0)    console.log(`[Startup] Marked ${orphanedExec.changes} orphaned execution run(s) as failed`);
    if (orphanedPipeline.changes > 0) console.log(`[Startup] Marked ${orphanedPipeline.changes} orphaned pipeline run(s) as failed`);
  } catch (e) { console.error('[Startup] Orphan cleanup error:', e.message); }

  // ── Regenerate all config.json files on startup ─────────────────────────
  // Ensures every workspace's config.json is always up-to-date with the
  // latest rules, test plans and settings — regardless of which user last
  // triggered a save. Runs after the server is ready so it doesn't block startup.
  setImmediate(() => {
    try {
      const db = require('./db');
      const { getUserProjectPath, isAdminWorkspace } = require('./utils/projectFolders');
      const { updateCollectionConfigs } = require('./utils/configWriter');

      // For every project, regenerate config for every NON-ADMIN user who has a workspace
      const projects = db.prepare('SELECT p.*, u.role as user_role FROM projects p JOIN users u ON u.id = p.user_id').all();

      for (const proj of projects) {
        try {
          const projectFolderPath = getUserProjectPath(proj.user_id, proj.user_role, proj.name);
          if (isAdminWorkspace(projectFolderPath)) continue; // skip admin workspace
          const collections = db.prepare('SELECT id FROM collections WHERE project_id = ?').all(proj.id);
          for (const col of collections) {
            updateCollectionConfigs(col.id, projectFolderPath);
          }
        } catch (_) {}
      }

      // Also regenerate for any other users (non-owners) who have workspaces for a project
      const allUsers = db.prepare('SELECT id, role FROM users').all();
      const allProjects = db.prepare('SELECT * FROM projects').all();
      for (const user of allUsers) {
        for (const proj of allProjects) {
          if (proj.user_id === user.id) continue; // already done above
          try {
            const projectFolderPath = getUserProjectPath(user.id, user.role, proj.name);
            if (isAdminWorkspace(projectFolderPath)) continue; // skip admin workspace
            const fs = require('fs');
            const path = require('path');
            if (!fs.existsSync(projectFolderPath)) continue; // no workspace for this user
            const collections = db.prepare('SELECT id FROM collections WHERE project_id = ?').all(proj.id);
            for (const col of collections) {
              updateCollectionConfigs(col.id, projectFolderPath);
            }
          } catch (_) {}
        }
      }

      console.log('[Startup] config.json files regenerated for all workspaces.');
    } catch (e) {
      console.error('[Startup] Config regeneration error:', e.message);
    }
  });
});
