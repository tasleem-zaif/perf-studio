'use strict';
// resultsWorkspaceSync.js — mirrors a completed run's result files (results.jtl, jmeter.log,
// JMeter HTML report, analytics PDF) into the EXECUTING USER's own git-tracked workspace —
// the same "lives in git, shows up to commit/push" treatment config.json/testData already get
// (see configWriter.js's writeJsonToSession / testData.js's PAT upload branch, which this
// mirrors). Purely additive: resultsStore.js's own S3 mirror (used by Analytics/Trend
// Analysis/CI/alerts) is untouched — this reads FROM that durable copy, it doesn't replace it.
//
// result_dir's root differs by caller: execution.js's live /run handler always computes it
// against the PROJECT'S OWN (admin) content root, regardless of who ran the test — one
// canonical results tree per project. ciPipeline.js's CI-sync/auto-heal paths, by contrast,
// already root it under getUserProjectPath(effectiveUserId, ...) — the SAME user this function
// is asked to sync into. This function accepts either shape: it tries the admin root first,
// then falls back to the target user's own root (a no-op re-root in that second case, since
// it's already there) — so one call site works for both without the caller having to know
// which shape its result_dir has.

const path = require('path');
const posix = path.posix;
const fs = require('fs');
const db = require('../db');
const gitEngine = require('./gitEngine');
const resultsStore = require('./resultsStore');
const {
  getUserProjectPath, getProjectPath, resolveOrgSlugForProject, cleanName,
} = require('./projectFolders');

/** Same auth-method check every other PAT/SSH writer (configWriter.js, testData.js,
 * collections.js) already has its own copy of. */
async function isSshMode(userId, projectId) {
  if (!userId || !projectId) return true;
  const identity = await db.prepare('SELECT auth_method FROM user_git_configs WHERE user_id = ? AND project_id = ?').get(userId, projectId);
  return (identity?.auth_method || 'pat') === 'ssh';
}

// Same bounded-concurrency helper resultsStore.js/gitEngine.js/s3Sync.js each keep their own
// copy of, for the same reason (each module owns its own S3 fan-out policy).
const RESULTS_S3_CONCURRENCY = Number(process.env.RESULTS_S3_CONCURRENCY) || 16;
async function mapLimit(items, limit, fn) {
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Strips a leftover "results/" gitignore line (from before this feature existed) so files
 * written under results/ aren't silently ignored by a stale .gitignore. No-op if absent. */
function stripResultsIgnore(content) {
  return content.split('\n').filter(line => line.trim() !== 'results/').join('\n');
}

/**
 * Copies every file resultsStore already has for this run into userId's own workspace, at
 * the same relative path result_dir has below the project's (admin) content root — just
 * re-rooted under this user's own actor workspace. No-ops quietly (logs only) on any failure;
 * this is a best-effort mirror for git visibility, never the durable copy of the data.
 */
async function syncRunResultsToUserWorkspace(run, userId) {
  try {
    if (!run?.result_dir || !userId) return;
    const project = await db.prepare('SELECT * FROM projects WHERE id = ?').get(run.project_id);
    if (!project) return;
    const caller = await db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
    const role = caller?.role;

    const orgSlug = await resolveOrgSlugForProject(run.project_id);

    const userProjectPath = await getUserProjectPath(userId, role, project.name, project.id);
    const gitDir = path.dirname(userProjectPath);

    // Try both possible roots result_dir may have been computed against — see file-level
    // comment. A valid relative suffix never starts with ".." or is itself absolute.
    const isValidRel = (rel) => !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    const adminContentRoot = project.folder_path || getProjectPath(project.name, project.id);
    let relSuffix = path.relative(adminContentRoot, run.result_dir);
    if (!isValidRel(relSuffix)) relSuffix = path.relative(userProjectPath, run.result_dir);
    if (!isValidRel(relSuffix)) {
      console.warn(`[ResultsWorkspaceSync] result_dir "${run.result_dir}" is not under the admin root ` +
        `("${adminContentRoot}") or user root ("${userProjectPath}") — skipping sync for run #${run.id}`);
      return;
    }
    const relSuffixPosix = relSuffix.split(path.sep).join('/');

    const files = await resultsStore.listFiles(run.result_dir, orgSlug);
    if (!files.length) return;

    if (!(await isSshMode(userId, run.project_id))) {
      // ── PAT mode: write straight into the gitEngine in-memory session ──────────────────
      const session = await gitEngine.openSession(gitDir, orgSlug);
      const targetDir = posix.join(session.dir, cleanName(project.name), relSuffixPosix);

      const gitignorePath = posix.join(session.dir, '.gitignore');
      if (session.fs.existsSync(gitignorePath)) {
        const current = session.fs.readFileSync(gitignorePath, 'utf8');
        const stripped = stripResultsIgnore(current);
        if (stripped !== current) session.fs.writeFileSync(gitignorePath, stripped);
      }

      await mapLimit(files, RESULTS_S3_CONCURRENCY, async (relPath) => {
        const buf = await resultsStore.readFile(run.result_dir, orgSlug, relPath);
        if (!buf) return;
        const full = posix.join(targetDir, relPath.replace(/\\/g, '/'));
        session.fs.mkdirSync(posix.dirname(full), { recursive: true });
        session.fs.writeFileSync(full, buf);
      });

      const persisted = await gitEngine.persistSession(session, gitDir, orgSlug);
      if (!persisted.ok) {
        console.error('[ResultsWorkspaceSync] S3 persist failed for', persisted.failed.length, 'file(s) under', targetDir);
      }
    } else {
      // ── SSH mode: real disk — hydrate first (may have been reclaimed by the S3 sweep
      // since this user last touched their workspace) ───────────────────────────────────
      try {
        const { ensureGitWorkspaceHydrated } = require('../routes/git');
        await ensureGitWorkspaceHydrated(gitDir, run.project_id, userId);
      } catch (_) {}

      const targetDir = path.join(userProjectPath, relSuffix);
      const gitignorePath = path.join(gitDir, '.gitignore');
      if (fs.existsSync(gitignorePath)) {
        const current = fs.readFileSync(gitignorePath, 'utf8');
        const stripped = stripResultsIgnore(current);
        if (stripped !== current) fs.writeFileSync(gitignorePath, stripped);
      }

      await mapLimit(files, RESULTS_S3_CONCURRENCY, async (relPath) => {
        const buf = await resultsStore.readFile(run.result_dir, orgSlug, relPath);
        if (!buf) return;
        const full = path.join(targetDir, relPath.split('/').join(path.sep));
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, buf);
      });
    }
  } catch (e) {
    console.error('[ResultsWorkspaceSync] Failed to sync run results into workspace:', e.message);
  }
}

module.exports = { syncRunResultsToUserWorkspace };
