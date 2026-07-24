require('dotenv').config();

// ── Boot-time S3 enforcement (GDPR: zero local disk) ──────────────────────────
// This app's zero-local-disk guarantee (PAT-mode git storage, run results/artifacts,
// and SSH-mode's tmpfs workspaces surviving a restart) depends entirely on S3 being
// configured — see PROJECT_MAP.md's "S3 migration" section. Refuse to start rather than
// silently writing customer data onto this server's disk.
const S3_SYNC_ENABLED_AT_BOOT = String(process.env.S3_SYNC_ENABLED || '').toLowerCase() === 'true';
if (!S3_SYNC_ENABLED_AT_BOOT || !process.env.S3_BUCKET) {
  console.error(
    '[Boot] Refusing to start: S3_SYNC_ENABLED=true and S3_BUCKET are both required. ' +
    'This deployment stores all customer data (git workspaces, run results, artifacts) via S3 only.'
  );
  process.exit(1);
}

const express = require('express');
const cors = require('cors');
const path = require('path');

// Express 4 doesn't catch rejections thrown by async route handlers — without
// this, any unhandled DB/network error in a route (e.g. a stale schema
// assumption) crashes the whole process instead of just failing that request.
process.on('unhandledRejection', (err) => {
  console.error('[UnhandledRejection]', err?.message || err);
});
process.on('uncaughtException', (err) => {
  console.error('[UncaughtException]', err?.message || err);
});

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
app.use('/api/licenses',                               require('./routes/licenses'));
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
app.use('/api/projects/:projectId/trend-analysis',     require('./routes/trendAnalysis'));
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

async function start() {
  const { assertBucketReachable, warnIfInsecureCredentials } = require('./utils/s3Sync');
  warnIfInsecureCredentials();
  try {
    await assertBucketReachable();
  } catch (error) {
    console.error('[Boot] Refusing to start:', error.message);
    process.exit(1);
  }

app.listen(PORT, () => {
  console.log(`PerfStudio API running on http://localhost:${PORT}`);

  // ── On startup: mark orphaned running runs as failed ─────────────────────
  (async () => {
    try {
      const db = require('./db');
      const orphanedExec = await db.prepare(
        "UPDATE execution_runs SET status='failed', finished_at=NOW() WHERE status='running'"
      ).run();
      const orphanedPipeline = await db.prepare(
        "UPDATE pipeline_runs SET status='failed', finished_at=NOW() WHERE status='running'"
      ).run();
      if (orphanedExec.changes > 0)    console.log(`[Startup] Marked ${orphanedExec.changes} orphaned execution run(s) as failed`);
      if (orphanedPipeline.changes > 0) console.log(`[Startup] Marked ${orphanedPipeline.changes} orphaned pipeline run(s) as failed`);
    } catch (e) { console.error('[Startup] Orphan cleanup error:', e.message); }
  })();

  // ── Regenerate all config.json files on startup ─────────────────────────
  setImmediate(async () => {
    try {
      const db = require('./db');
      const { getUserProjectPath, isAdminRole } = require('./utils/projectFolders');
      const { updateCollectionConfigs } = require('./utils/configWriter');

      const { resolveOrgSlugForProject } = require('./utils/projectFolders');
      const gitEngine = require('./utils/gitEngine');
      async function isSshModeStartup(userId, projectId) {
        const identity = await db.prepare('SELECT auth_method FROM user_git_configs WHERE user_id = ? AND project_id = ?').get(userId, projectId);
        return (identity?.auth_method || 'pat') === 'ssh';
      }

      const projects = await db.prepare('SELECT p.*, u.role as user_role FROM projects p JOIN users u ON u.id = p.user_id').all();

      for (const proj of projects) {
        try {
          const projectFolderPath = await getUserProjectPath(proj.user_id, proj.user_role, proj.name, proj.id);
          if (isAdminRole(proj.user_role)) continue;
          const isSSH = await isSshModeStartup(proj.user_id, proj.id);
          if (!isSSH) {
            const orgSlug = await resolveOrgSlugForProject(proj.id);
            const session = await gitEngine.openSession(require('path').dirname(projectFolderPath), orgSlug);
            if (!session.hadState) continue;
          }
          const collections = await db.prepare('SELECT id FROM collections WHERE project_id = ?').all(proj.id);
          for (const col of collections) {
            updateCollectionConfigs(col.id, projectFolderPath, proj.user_id);
          }
        } catch (_) {}
      }

      const allUsers = await db.prepare('SELECT id, role FROM users').all();
      const allProjects = await db.prepare('SELECT * FROM projects').all();
      for (const user of allUsers) {
        for (const proj of allProjects) {
          if (proj.user_id === user.id) continue;
          try {
            const projectFolderPath = await getUserProjectPath(user.id, user.role, proj.name, proj.id);
            if (isAdminRole(user.role)) continue;
            const isSSH = await isSshModeStartup(user.id, proj.id);
            if (isSSH) {
              const fs = require('fs');
              if (!fs.existsSync(projectFolderPath)) continue;
            } else {
              const orgSlug = await resolveOrgSlugForProject(proj.id);
              const session = await gitEngine.openSession(require('path').dirname(projectFolderPath), orgSlug);
              if (!session.hadState) continue;
            }
            const collections = await db.prepare('SELECT id FROM collections WHERE project_id = ?').all(proj.id);
            for (const col of collections) {
              updateCollectionConfigs(col.id, projectFolderPath, user.id);
            }
          } catch (_) {}
        }
      }

      console.log('[Startup] config.json files regenerated for all workspaces.');
    } catch (e) {
      console.error('[Startup] Config regeneration error:', e.message);
    }
  });

  // ── S3 workspace reclaim sweep ────────────────────────────────────────────
  // Reclaims local disk for workspaces that were confirmed synced to S3 (see
  // workspaceLifecycle.js's markWorkspaceSyncedAfterPush) and have sat untouched past the
  // cooldown window. Deliberately a periodic sweep, not something tied to the push itself —
  // that's what keeps a push immediately followed by another action on the same project from
  // ever paying a rehydration cost. No-op entirely while S3_SYNC_ENABLED is unset.
  if (String(process.env.S3_SYNC_ENABLED || '').toLowerCase() === 'true') {
    const { sweepStaleWorkspaces } = require('./utils/workspaceLifecycle');
    const SWEEP_INTERVAL_MS = Number(process.env.S3_SWEEP_INTERVAL_MS) || 30 * 60 * 1000;
    setInterval(() => {
      sweepStaleWorkspaces().then(({ swept, skipped }) => {
        if (swept.length) console.log(`[S3Sweep] Reclaimed ${swept.length} workspace(s):`, swept);
        if (skipped.length) console.log(`[S3Sweep] Skipped ${skipped.length}:`, skipped.map(s => s.reason).join(', '));
      }).catch(e => console.error('[S3Sweep] Error:', e.message));
    }, SWEEP_INTERVAL_MS);
  }
});
}

start();

