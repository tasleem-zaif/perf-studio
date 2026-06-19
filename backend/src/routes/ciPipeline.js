/**
 * ciPipeline.js — GitLab & GitHub Actions CI/CD pipeline integration
 *
 * Routes (all under /api/projects/:projectId/ci):
 *   GET    /config                — get CI config for project
 *   PUT    /config                — save CI config
 *   POST   /config/test           — test connection to GitLab/GitHub
 *   POST   /config/trigger-token  — create a GitLab trigger token via API
 *   POST   /generate-yaml         — generate + commit YAML files to git repo
 *   POST   /trigger               — trigger pipeline on GitLab or GitHub
 *   GET    /runs                  — list CI run history
 *   GET    /runs/:runId/status    — poll live status from external provider
 */

const router  = require('express').Router({ mergeParams: true });
const db      = require('../db');
const auth    = require('../middleware/auth');
const ownsProject = require('../utils/ownsProject');
const { encrypt, decrypt } = require('../utils/encryption');
const https   = require('https');
const http    = require('http');
const path    = require('path');
const fs      = require('fs');

router.use(auth);

// ── helpers ───────────────────────────────────────────────────────────────────

// Per-user CI config: first try (project_id, user_id), fall back to legacy (project_id, NULL)
function getConfig(projectId, userId) {
  if (userId) {
    const own = db.prepare('SELECT * FROM ci_pipeline_configs WHERE project_id = ? AND user_id = ?').get(projectId, userId);
    if (own) return own;
  }
  // Legacy shared config (user_id IS NULL) — used as read-only template if the user hasn't saved their own yet
  return db.prepare('SELECT * FROM ci_pipeline_configs WHERE project_id = ? AND user_id IS NULL').get(projectId) || null;
}

function decryptConfig(cfg) {
  if (!cfg) return null;
  return {
    ...cfg,
    gitlab_token:         cfg.gitlab_token         ? decrypt(cfg.gitlab_token)         : '',
    gitlab_trigger_token: cfg.gitlab_trigger_token ? decrypt(cfg.gitlab_trigger_token) : '',
    github_token:         cfg.github_token         ? decrypt(cfg.github_token)         : '',
  };
}

/** Minimal JSON HTTP request using Node built-ins (no axios/node-fetch needed) */
function apiRequest(urlStr, method, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url    = new URL(urlStr);
    const isHttps = url.protocol === 'https:';
    const options = {
      hostname: url.hostname,
      port:     url.port || (isHttps ? 443 : 80),
      path:     url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      rejectUnauthorized: false,
    };
    const payload = body ? JSON.stringify(body) : null;
    if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload);

    const req = (isHttps ? https : http).request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data), headers: res.headers }); }
        catch { resolve({ status: res.statusCode, body: data, headers: res.headers }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Helper: parse "owner/repo" from any GitHub remote URL ────────────────────
function parseOwnerRepo(url) {
  if (!url) return '';
  // HTTPS: https://github.com/owner/repo.git  (may have token@ prefix)
  const m = url.match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?(?:\s|$)/);
  return m ? m[1] : '';
}

// ── Helper: get github_repo from git config remote URL (fallback) ─────────────
function getRepoFromGit(projectId) {
  const gitCfg = db.prepare('SELECT remote_url FROM git_configs WHERE project_id = ?').get(projectId);
  return gitCfg?.remote_url ? parseOwnerRepo(gitCfg.remote_url) : '';
}

// ── Helper: extract PAT from the git remote URL (ghp_... embedded in URL) ─────
function getTokenFromGitRemote(projectId) {
  try {
    const { GIT_WORKSPACES_ROOT, cleanName } = require('../utils/projectFolders');
    const proj = db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId);
    if (!proj) return null;
    // Check both admin and any user-N workspace for a remote URL with an embedded token
    const wsBase = path.join(GIT_WORKSPACES_ROOT, cleanName(proj.name));
    const dirs = [path.join(wsBase, 'admin')];
    const fs2 = require('fs');
    if (fs2.existsSync(wsBase)) {
      for (const d of fs2.readdirSync(wsBase)) {
        const full = path.join(wsBase, d);
        if (d !== 'admin' && fs2.statSync(full).isDirectory()) dirs.push(full);
      }
    }
    for (const dir of dirs) {
      const configPath = path.join(dir, '.git', 'config');
      if (!fs2.existsSync(configPath)) continue;
      const content = fs2.readFileSync(configPath, 'utf8');
      const m = content.match(/https?:\/\/(ghp_[^@\s]+|github_pat_[^@\s]+)@github\.com/);
      if (m) return m[1];
    }
  } catch {}
  return null;
}

// ── Helper: sanitise and validate a github_repo value ─────────────────────────
// Accepts:  "owner/repo"  or  "https://github.com/owner/repo.git"
// Rejects:  email addresses, bare names without a slash, etc.
function sanitizeGithubRepo(raw) {
  if (!raw) return '';
  let v = raw.trim();
  // Strip full URL down to owner/repo
  v = v.replace(/^https?:\/\/[^@]*@?github\.com\//, '').replace(/\.git$/, '').trim();
  // Must look like  word/word  — no @ signs allowed
  return /^[\w.-]+\/[\w.-]+$/.test(v) ? v : '';
}

// ── GET /config — returns the CALLING USER's own CI config ───────────────────
router.get('/config', (req, res) => {
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const cfg = getConfig(req.params.projectId, req.userId);
  if (!cfg) return res.json({ config: null });

  // Auto-derive github_repo from the project's git remote URL if the stored
  // value is missing or invalid (e.g. user accidentally entered their email).
  let github_repo = sanitizeGithubRepo(cfg.github_repo);
  if (!github_repo) github_repo = getRepoFromGit(req.params.projectId);

  res.json({
    config: {
      ...cfg,
      github_repo,
      gitlab_token:             cfg.gitlab_token         ? '••••••••' : '',
      gitlab_trigger_token:     cfg.gitlab_trigger_token ? '••••••••' : '',
      github_token:             cfg.github_token         ? '••••••••' : '',
      gitlab_token_set:         !!cfg.gitlab_token,
      gitlab_trigger_token_set: !!cfg.gitlab_trigger_token,
      github_token_set:         !!cfg.github_token,
    },
  });
});

// ── Helper: project owner check ───────────────────────────────────────────────
function isProjectOwner(userId, projectId) {
  const proj = db.prepare('SELECT user_id FROM projects WHERE id = ?').get(projectId);
  return proj && String(proj.user_id) === String(userId);
}

// ── PUT /config ───────────────────────────────────────────────────────────────
router.put('/config', (req, res) => {
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  // Each user saves their OWN CI config — no owner restriction needed
  const {
    gitlab_enabled, gitlab_url, gitlab_project_id, gitlab_token, gitlab_trigger_token, gitlab_ref,
    github_enabled, github_token, github_workflow_file, github_ref,
  } = req.body;

  // Sanitize github_repo: strip full URLs, reject email addresses
  const github_repo = sanitizeGithubRepo(req.body.github_repo)
    || getRepoFromGit(req.params.projectId);

  // Look up THIS user's own config row (project_id + user_id)
  const existing = db.prepare('SELECT * FROM ci_pipeline_configs WHERE project_id = ? AND user_id = ?').get(req.params.projectId, req.userId);
  const gitCfgDefault = db.prepare('SELECT base_branch FROM git_configs WHERE project_id = ?').get(req.params.projectId);
  const defaultBranch = gitCfgDefault?.base_branch || 'main';

  const encGitlabToken        = gitlab_token && gitlab_token !== '••••••••'         ? encrypt(gitlab_token)         : existing?.gitlab_token         || '';
  const encGitlabTriggerToken = gitlab_trigger_token && gitlab_trigger_token !== '••••••••' ? encrypt(gitlab_trigger_token) : existing?.gitlab_trigger_token || '';
  const encGithubToken        = github_token && github_token !== '••••••••'         ? encrypt(github_token)         : existing?.github_token         || '';

  if (existing) {
    db.prepare(`UPDATE ci_pipeline_configs SET
      gitlab_enabled=?, gitlab_url=?, gitlab_project_id=?, gitlab_token=?,
      gitlab_trigger_token=?, gitlab_ref=?,
      github_enabled=?, github_repo=?, github_token=?, github_workflow_file=?, github_ref=?,
      updated_at=datetime('now')
      WHERE project_id=? AND user_id=?`
    ).run(
      gitlab_enabled ? 1 : 0, gitlab_url || 'https://gitlab.com', gitlab_project_id || '',
      encGitlabToken, encGitlabTriggerToken, gitlab_ref || defaultBranch,
      github_enabled ? 1 : 0, github_repo || '', encGithubToken,
      github_workflow_file || 'perf-test.yml', github_ref || defaultBranch,
      req.params.projectId, req.userId
    );
  } else {
    db.prepare(`INSERT INTO ci_pipeline_configs
      (project_id, user_id, gitlab_enabled, gitlab_url, gitlab_project_id, gitlab_token, gitlab_trigger_token, gitlab_ref,
       github_enabled, github_repo, github_token, github_workflow_file, github_ref)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      req.params.projectId, req.userId,
      gitlab_enabled ? 1 : 0, gitlab_url || 'https://gitlab.com', gitlab_project_id || '',
      encGitlabToken, encGitlabTriggerToken, gitlab_ref || defaultBranch,
      github_enabled ? 1 : 0, github_repo || '', encGithubToken,
      github_workflow_file || 'perf-test.yml', github_ref || defaultBranch
    );
  }

  res.json({ ok: true });
});

// ── POST /config/test — test connection ───────────────────────────────────────
router.post('/config/test', async (req, res) => {
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const { provider } = req.body;
  const cfg = decryptConfig(getConfig(req.params.projectId, req.userId));
  if (!cfg) return res.status(400).json({ error: 'Save CI configuration first.' });

  try {
    if (provider === 'gitlab') {
      if (!cfg.gitlab_token) return res.status(400).json({ error: 'GitLab access token not set.' });
      const gitlabUrl = (cfg.gitlab_url || 'https://gitlab.com').replace(/\/$/, '');
      const r = await apiRequest(`${gitlabUrl}/api/v4/user`, 'GET', null, { 'PRIVATE-TOKEN': cfg.gitlab_token });
      if (r.status === 200) return res.json({ ok: true, message: `Connected as: ${r.body.username} (${r.body.name})` });
      return res.status(400).json({ error: `GitLab returned ${r.status}: ${r.body?.message || 'Authentication failed'}` });
    }

    if (provider === 'github') {
      if (!cfg.github_token) return res.status(400).json({ error: 'GitHub token not set.' });
      const r = await apiRequest('https://api.github.com/user', 'GET', null, {
        Authorization: `token ${cfg.github_token}`,
        'User-Agent': 'PerfStudio',
        Accept: 'application/vnd.github+json',
      });
      if (r.status === 200) return res.json({ ok: true, message: `Connected as: ${r.body.login} (${r.body.name || ''})` });
      return res.status(400).json({ error: `GitHub returned ${r.status}: ${r.body?.message || 'Authentication failed'}` });
    }

    res.status(400).json({ error: 'Unknown provider. Use gitlab or github.' });
  } catch (e) {
    res.status(500).json({ error: `Connection failed: ${e.message}` });
  }
});

// ── POST /config/trigger-token — create GitLab trigger token ─────────────────
router.post('/config/trigger-token', async (req, res) => {
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const cfg = decryptConfig(getConfig(req.params.projectId, req.userId));
  if (!cfg?.gitlab_token)         return res.status(400).json({ error: 'Save GitLab access token first.' });
  if (!cfg?.gitlab_project_id)    return res.status(400).json({ error: 'GitLab project ID/path not set.' });

  const gitlabUrl = (cfg.gitlab_url || 'https://gitlab.com').replace(/\/$/, '');
  const encodedId = encodeURIComponent(cfg.gitlab_project_id);

  try {
    const r = await apiRequest(
      `${gitlabUrl}/api/v4/projects/${encodedId}/triggers`,
      'POST',
      { description: 'PerfStudio trigger token' },
      { 'PRIVATE-TOKEN': cfg.gitlab_token }
    );

    if (r.status === 201) {
      const token = r.body.token;
      // Save encrypted trigger token
      db.prepare('UPDATE ci_pipeline_configs SET gitlab_trigger_token=? WHERE project_id=?')
        .run(encrypt(token), req.params.projectId);
      return res.json({ ok: true, message: 'Trigger token created and saved.', token_preview: token.slice(0, 6) + '••••••' });
    }
    res.status(400).json({ error: `GitLab returned ${r.status}: ${JSON.stringify(r.body)}` });
  } catch (e) {
    res.status(500).json({ error: `Failed to create trigger token: ${e.message}` });
  }
});

// ── POST /generate-yaml — generate + commit YAML files ───────────────────────
router.post('/generate-yaml', async (req, res) => {
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const cfg     = decryptConfig(getConfig(req.params.projectId, req.userId));
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { providers = ['gitlab', 'github'] } = req.body;

  // Use per-project workspace (new structure: git-workspaces/<ProjectName>/admin/)
  const callerRow = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  const isAdmin   = ['org_admin', 'super_admin'].includes(callerRow?.role);
  const { GIT_WORKSPACES_ROOT, cleanName, resolveUserFolder } = require('../utils/projectFolders');
  const userFolder   = resolveUserFolder(req.userId);
  const cleanProject = (project.name || '').replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  const gitRoot      = path.join(GIT_WORKSPACES_ROOT, cleanProject, userFolder);
  fs.mkdirSync(gitRoot, { recursive: true });

  // Get all generated test plans for this project to include as YAML comments
  const suites = db.prepare("SELECT * FROM test_suites WHERE project_id = ? AND (jmx_path IS NOT NULL OR js_path IS NOT NULL)").all(req.params.projectId);

  const gitCfgBase = db.prepare('SELECT base_branch FROM git_configs WHERE project_id = ?').get(req.params.projectId);
  const baseBranch = gitCfgBase?.base_branch || 'main';

  const created = [];
  const errors  = [];

  // ── Generate .gitlab-ci.yml ──────────────────────────────────────────────
  if (providers.includes('gitlab')) {
    const defaultScript = suites.length > 0
      ? path.basename(suites[0].jmx_path || suites[0].js_path || 'test.jmx')
      : 'test.jmx';
    const ref = cfg?.gitlab_ref || baseBranch;

    const scriptList = suites.map(s => {
      const file = path.basename(s.jmx_path || s.js_path || '');
      const relPath = s.jmx_path
        ? path.relative(gitRoot, s.jmx_path).replace(/\\/g, '/')
        : path.relative(gitRoot, s.js_path || '').replace(/\\/g, '/');
      return `  # ${s.name} → ${relPath}`;
    }).join('\n');

    const gitlabYaml = `# ============================================================
# PerfStudio — GitLab CI/CD Performance Test Pipeline
# Generated by PerfStudio on ${new Date().toISOString().slice(0, 19).replace('T', ' ')}
#
# Available test scripts:
${scriptList || '  # (no generated scripts yet — generate from Test Plans first)'}
# ============================================================

workflow:
  rules:
    - when: always

image: docker:latest

services:
  - docker:dind

variables:
  DOCKER_DRIVER: overlay2
  SCRIPT_NAME: "${defaultScript}"
  JMETER_USERS: "10"
  JMETER_RAMPUP: "30"
  JMETER_LOOPS: "1"
  JMETER_DURATION: "300"

stages:
  - test

run_jmeter:
  stage: test
  before_script:
    - echo "PerfStudio Pipeline Execution"
    - echo "Script   : \${SCRIPT_NAME}"
    - echo "VUsers   : \${JMETER_USERS}"
    - echo "Ramp-up  : \${JMETER_RAMPUP}s"
    - echo "Duration : \${JMETER_DURATION}s"
  script:
    - mkdir -p reports
    - |
      docker run --rm \\
        -v "\$CI_PROJECT_DIR":/workspace \\
        -v "\$CI_PROJECT_DIR/reports":/output \\
        justb4/jmeter \\
        -Dlog4j2.formatMsgNoLookups=true \\
        -n -t "/workspace/\${SCRIPT_PATH:-\${SCRIPT_NAME}}" \\
        -Jusers="\${JMETER_USERS}" \\
        -Jrampup="\${JMETER_RAMPUP}" \\
        -Jloops="\${JMETER_LOOPS}" \\
        -Jduration="\${JMETER_DURATION}" \\
        -l /output/results.jtl \\
        -e -o /output/html
  artifacts:
    paths:
      - reports/
    expire_in: 7 days
  rules:
    - when: manual
`;
    try {
      const dest = path.join(gitRoot, '.gitlab-ci.yml');
      fs.writeFileSync(dest, gitlabYaml, 'utf8');
      created.push('.gitlab-ci.yml');
    } catch (e) { errors.push(`.gitlab-ci.yml: ${e.message}`); }
  }

  // ── Generate .github/workflows/perf-test.yml ─────────────────────────────
  if (providers.includes('github')) {
    const workflowFile = cfg?.github_workflow_file || 'perf-test.yml';
    const defaultScript = suites.length > 0
      ? path.basename(suites[0].jmx_path || suites[0].js_path || 'test.jmx')
      : 'test.jmx';

    // The branch where user scripts live — passed as a workflow input so the
    // checkout step fetches the right branch even when the workflow file lives on main.
    const userBranch = cfg?.github_ref || (isAdmin ? baseBranch : `feature/${(callerRow?.name || 'user').toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`);

    const scriptList = suites.map(s => {
      const relPath = s.jmx_path
        ? path.relative(gitRoot, s.jmx_path).replace(/\\/g, '/')
        : path.relative(gitRoot, s.js_path || '').replace(/\\/g, '/');
      return `      # ${s.name}: ${relPath}`;
    }).join('\n');

    const githubYaml = `# ============================================================
# PerfStudio — GitHub Actions Performance Test Pipeline
# Generated by PerfStudio on ${new Date().toISOString().slice(0, 19).replace('T', ' ')}
# ============================================================

name: PerfStudio Performance Test

on:
  workflow_dispatch:
    inputs:
      script_name:
        description: 'JMX script filename (relative to repo root)'
        required: true
        default: '${defaultScript}'
      script_path:
        description: 'Full relative path to script (overrides script_name if set)'
        required: false
        default: ''
      jmeter_users:
        description: 'Number of virtual users'
        required: true
        default: '10'
      jmeter_rampup:
        description: 'Ramp-up period in seconds'
        required: true
        default: '30'
      jmeter_loops:
        description: 'Number of iterations (used when not duration mode)'
        required: true
        default: '1'
      jmeter_duration:
        description: 'Test duration in seconds'
        required: true
        default: '300'
      branch:
        description: 'Branch containing the test scripts (user workspace branch)'
        required: false
        default: '${userBranch}'

# Available test scripts:
${scriptList || '      # (no generated scripts yet)'}

jobs:
  jmeter:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          ref: \${{ inputs.branch || github.ref_name }}

      - name: Patch JMX parameters
        run: |
          SCRIPT="\${{ inputs.script_path }}"
          [ -z "\$SCRIPT" ] && SCRIPT="\${{ inputs.script_name }}"
          echo "Patching \$SCRIPT  users=\${{ inputs.jmeter_users }} rampup=\${{ inputs.jmeter_rampup }} duration=\${{ inputs.jmeter_duration }}"
          python3 .perfstudio/patch_jmx.py "\$SCRIPT" "\${{ inputs.jmeter_users }}" "\${{ inputs.jmeter_rampup }}" "\${{ inputs.jmeter_loops }}" "\${{ inputs.jmeter_duration }}"
          echo "=== ThreadGroup after patch ==="
          grep -A 30 "ThreadGroup" "\$SCRIPT" | head -50
          echo "=== HTTP Samplers ==="
          grep -c "HTTPSamplerProxy\|HTTPSampler" "\$SCRIPT" || echo "0 samplers found"
          echo "=== Enabled elements ==="
          grep "enabled=" "\$SCRIPT" | head -10

      - name: Cache PerfStudio Docker image
        uses: actions/cache@v4
        with:
          path: /tmp/docker-cache
          key: docker-perfstudio-\${{ runner.os }}
          restore-keys: docker-perfstudio-

      - name: Load cached image or pull
        run: |
          if [ -f /tmp/docker-cache/perfstudio.tar ]; then
            echo "Loading PerfStudio image from cache..."
            docker load -i /tmp/docker-cache/perfstudio.tar
          else
            echo "Pulling PerfStudio image (first run on this runner)..."
            docker pull tasleemzaif/perfstudio:latest
            mkdir -p /tmp/docker-cache
            docker save tasleemzaif/perfstudio:latest -o /tmp/docker-cache/perfstudio.tar
          fi

      - name: Verify patch and CSV files
        run: |
          SCRIPT="\${{ inputs.script_path }}"
          [ -z "\$SCRIPT" ] && SCRIPT="\${{ inputs.script_name }}"
          echo "=== ThreadGroup after patch ==="
          grep -E "num_threads|ramp_time|scheduler|duration|continue_forever|LoopController.loops" "\$SCRIPT" || echo "WARN: no matches found"
          echo "=== CSV paths in JMX ==="
          grep -i "CSV_PATH\\|Argument.value.*testData\\|filename.*CSV\\|CSVDataSet" "\$SCRIPT" | head -10
          echo "=== CSV files in workspace ==="
          TESTDATA="\$(grep -o 'Argument.value>[^<]*testData' \$SCRIPT | head -1 | sed 's/Argument.value>//')"
          [ -n "\$TESTDATA" ] && ls -la "\$TESTDATA/" 2>/dev/null || echo "testData dir: \$TESTDATA (checking /workspace prefix)"
          ls -la "/workspace/projects/Demo1/Demo1_API_Collection/QA/testData/" 2>/dev/null || echo "Path not found"

      - name: Run JMeter
        run: |
          SCRIPT="\${{ inputs.script_path }}"
          [ -z "\$SCRIPT" ] && SCRIPT="\${{ inputs.script_name }}"
          mkdir -p reports
          docker run --rm \\
            -v "\${{ github.workspace }}":/workspace \\
            -v "\${{ github.workspace }}/reports":/output \\
            tasleemzaif/perfstudio:latest \\
            jmeter \\
            -n -t "/workspace/\$SCRIPT" \\
            -j /output/jmeter.log \\
            -l /output/results.jtl \\
            -e -o /output/html || true
          echo "=== JMeter Log (last 50 lines) ==="
          tail -50 reports/jmeter.log 2>/dev/null || echo "No jmeter.log found"

      - name: Validate results
        run: |
          JTL="reports/results.jtl"
          [ ! -f "\$JTL" ] && echo "ERROR: results.jtl not found" && exit 1
          TOTAL=\$(( \$(wc -l < "\$JTL") - 1 ))
          echo "Total requests: \$TOTAL"
          [ "\$TOTAL" -le 0 ] && echo "ERROR: 0 requests executed - check thread group config" && exit 1
          echo "Validation passed: \$TOTAL requests"

      - name: Upload report
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: jmeter-report-\${{ github.run_number }}
          path: reports/
          retention-days: 7
`;

    // Write Python patcher as a separate committed file — avoids heredoc/YAML nesting issues
    const patcherPy = `# PerfStudio JMX parameter patcher
# Usage: python3 patch_jmx.py <script> <users> <rampup> <loops> <duration>
import re, sys

script, users, rampup, loops, duration = sys.argv[1:6]
use_duration = duration != "-1" and int(duration) > 0

with open(script, "r", encoding="utf-8") as f:
    content = f.read()

def sp(xml, name, val):
    pat = r'(<(?:string|int|long|bool)Prop\\s+name="' + re.escape(name) + r'">)[^<]*'
    new, n = re.subn(pat, r'\\g<1>' + str(val), xml)
    print(("  SET " if n else "  WARN ") + name + "=" + str(val))
    return new

# Fix absolute local paths -> CI workspace paths
# Strips Windows paths up to and including git-workspaces/<project>/<user>/
# so JMeter finds files relative to /workspace (the Docker-mounted repo root).
path_pattern = r'[A-Za-z]:[/\\\\][^\\'\\'"<>]*?git-workspaces[/\\\\][^/\\\\]+[/\\\\][^/\\\\]+[/\\\\]'
fixed_content, path_fixes = re.subn(path_pattern, '/workspace/', content)
if path_fixes:
    fixed_content = fixed_content.replace('\\\\', '/')
    content = fixed_content
    print("  FIXED " + str(path_fixes) + " absolute path(s) -> /workspace/")
else:
    # Fallback: old single-level structure git-workspaces/<user>/
    path_pattern_old = r'[A-Za-z]:[/\\\\][^\\'\\'"<>]*?git-workspaces[/\\\\][^/\\\\]+[/\\\\]'
    fixed_content, path_fixes = re.subn(path_pattern_old, '/workspace/', content)
    if path_fixes:
        fixed_content = fixed_content.replace('\\\\', '/')
        content = fixed_content
        print("  FIXED " + str(path_fixes) + " absolute path(s) (old structure) -> /workspace/")
    else:
        print("  No absolute paths to fix")

content = sp(content, "ThreadGroup.num_threads", users)
content = sp(content, "ThreadGroup.ramp_time", rampup)

if use_duration:
    print("  Mode: Duration " + duration + "s")
    content = sp(content, "ThreadGroup.scheduler", "true")
    content = sp(content, "ThreadGroup.duration", duration)
    content = sp(content, "LoopController.loops", "-1")
    if 'name="ThreadGroup.duration"' not in content:
        content = content.replace("</ThreadGroup>",
            '<stringProp name="ThreadGroup.duration">' + duration + '</stringProp>\\n'
            '<boolProp name="ThreadGroup.scheduler">true</boolProp>\\n</ThreadGroup>')
        print("  INJECTED duration+scheduler")
else:
    print("  Mode: Loops " + loops)
    content = sp(content, "ThreadGroup.scheduler", "false")
    content = sp(content, "LoopController.loops", loops)

with open(script, "w") as f:
    f.write(content)
print("Patch complete")
`;

    try {
      const workflowDir = path.join(gitRoot, '.github', 'workflows');
      fs.mkdirSync(workflowDir, { recursive: true });
      fs.writeFileSync(path.join(workflowDir, workflowFile), githubYaml, 'utf8');
      created.push(`.github/workflows/${workflowFile}`);

      // Commit the Python patcher alongside the YAML
      const patcherDir = path.join(gitRoot, '.perfstudio');
      fs.mkdirSync(patcherDir, { recursive: true });
      fs.writeFileSync(path.join(patcherDir, 'patch_jmx.py'), patcherPy, 'utf8');
      created.push(`.perfstudio/patch_jmx.py`);
    } catch (e) { errors.push(`${e.message}`); }
  }

  if (created.length === 0) return res.status(500).json({ error: errors.join('; ') || 'Nothing generated' });

  // Auto-commit and push to remote so the workflow is immediately available on GitHub.
  // The perf-test.yml MUST be on the remote default branch (main) for workflow_dispatch to work.
  let pushMessage = '';
  try {
    const gitCfg = db.prepare('SELECT * FROM git_configs WHERE project_id = ?').get(req.params.projectId);
    if (gitCfg?.is_initialized && fs.existsSync(path.join(gitRoot, '.git'))) {
      const simpleGit = require('simple-git');
      const NO_PROMPT = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', GIT_SSH_ASKPASS: 'echo', GCM_INTERACTIVE: 'never', GCM_NO_INTERACTIVE: '1', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '' };

      // Build authenticated remote URL
      const { decrypt: dec } = require('../utils/encryption');
      const rawToken  = gitCfg.auth_token ? dec(gitCfg.auth_token) : '';
      const remoteUrl = rawToken
        ? gitCfg.remote_url.replace(/^(https?:\/\/)[^@]*@?/, `$1${encodeURIComponent(rawToken)}@`)
        : gitCfg.remote_url;

      const git = simpleGit({ baseDir: gitRoot, env: { ...process.env, ...NO_PROMPT } });

      // Configure identity
      await git.addConfig('user.name',  callerRow.name  || 'PerfStudio');
      await git.addConfig('user.email', callerRow.email || 'noreply@perfstudio.com');

      // Checkout base branch (workflow must be on default branch for workflow_dispatch to work)
      const autoCommitBranch = gitCfg?.base_branch || baseBranch;
      try { await git.checkout(autoCommitBranch); } catch {}
      await git.remote(['set-url', 'origin', remoteUrl]);

      // Stage and commit only the generated CI files
      await git.add(created.map(f => path.join(gitRoot, f)));
      const status = await git.status();
      if (status.staged.length > 0) {
        await git.commit('ci: add PerfStudio performance test workflow [auto]');
        try { await git.addConfig('credential.helper', '', false, 'local'); await git.addConfig('credential.https://github.com.helper', '', false, 'local'); } catch {}
        await git.push(['--set-upstream', 'origin', autoCommitBranch]);
        pushMessage = ` Committed and pushed to ${autoCommitBranch} automatically.`;
      } else {
        pushMessage = ` Files unchanged — already up to date on ${autoCommitBranch}.`;
      }
    }
  } catch (pushErr) {
    errors.push(`Auto-push failed: ${pushErr.message} — go to Configuration → Git and push manually.`);
  }

  res.json({ ok: true, created, errors, message: `Generated: ${created.join(', ')}.${pushMessage}` });
});

// ── POST /trigger — trigger pipeline on GitLab or GitHub ─────────────────────
router.post('/trigger', async (req, res) => {
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const cfg = decryptConfig(getConfig(req.params.projectId, req.userId));
  if (!cfg) return res.status(400).json({ error: 'CI configuration not saved yet.' });

  const { provider, script_name, script_path, jmeter_users, jmeter_rampup, jmeter_loops, jmeter_duration } = req.body;
  if (!provider) return res.status(400).json({ error: 'provider required (gitlab or github)' });

  // Build human-readable run_name: {SuiteName}_{N}Users_{D}sDuration (no Run# yet — added on sync)
  const { buildRunDirName } = require('../utils/buildRunName');
  const scriptFile2 = (script_name || '').replace(/\\/g, '/').split('/').pop();
  const matchedSuite2 = db.prepare("SELECT name FROM test_suites WHERE project_id = ? AND (jmx_path LIKE ? OR js_path LIKE ?) LIMIT 1")
    .get(req.params.projectId, `%${scriptFile2}`, `%${scriptFile2}`);
  const ciRunDisplayName = buildRunDirName(
    matchedSuite2?.name || scriptFile2.replace(/\.jmx$|\.js$/, ''),
    jmeter_users, 'duration', jmeter_loops, jmeter_duration, ''
  ).replace(/_Run$/, ''); // strip trailing _Run (no seq# at trigger time)

  // Token priority for CI triggers:
  // 1. CI config token (saved specifically for CI/CD under Configuration → Pipeline)
  // 2. User's Git Identity PAT as fallback
  // The CI config token should have both `repo` + `workflow` scopes.
  const userIdentity = db.prepare('SELECT auth_token FROM user_git_configs WHERE user_id = ? AND project_id = ?')
    .get(req.userId, req.params.projectId);
  const userToken = userIdentity?.auth_token ? decrypt(userIdentity.auth_token) : null;

  const effectiveGithubToken = cfg.github_token || userToken || getTokenFromGitRemote(req.params.projectId);
  const effectiveGitlabToken = cfg.gitlab_token || cfg.gitlab_trigger_token || userToken;

  const variables = { script_name, script_path: script_path || '', jmeter_users: String(jmeter_users || 10), jmeter_rampup: String(jmeter_rampup || 30), jmeter_loops: String(jmeter_loops || 1), jmeter_duration: String(jmeter_duration || 300) };

  // ── Compute targetRef here so it is in scope for both auto-push and dispatch ─
  const callerRow2  = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  const isAdmin2    = ['org_admin', 'super_admin'].includes(callerRow2?.role);
  const gitCfgTrigger = db.prepare('SELECT base_branch FROM git_configs WHERE project_id = ?').get(req.params.projectId);
  const baseBranch2 = gitCfgTrigger?.base_branch || 'main';
  const targetRef   = cfg.github_ref || (isAdmin2 ? baseBranch2 : `users/${(callerRow2?.name || '').toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`);

  // ── Auto-push script file to the target branch before dispatching ──────────
  // The CI runner checks out the branch from GitHub — the JMX file must exist
  // there or the Patch JMX step will fail with FileNotFoundError.
  try {
    const { GIT_WORKSPACES_ROOT, cleanName, resolveUserFolder: resolveUF } = require('../utils/projectFolders');
    const projectRow = db.prepare('SELECT name FROM projects WHERE id = ?').get(req.params.projectId);
    const userFolder  = resolveUF(req.userId);
    const wsRoot      = path.join(GIT_WORKSPACES_ROOT, cleanName(projectRow?.name || ''), userFolder);

    const gitCfg = db.prepare('SELECT * FROM git_configs WHERE project_id = ?').get(req.params.projectId);
    if (gitCfg?.is_initialized && fs.existsSync(path.join(wsRoot, '.git'))) {
      const simpleGit2 = require('simple-git');
      const NO_PROMPT2 = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', GIT_SSH_ASKPASS: 'echo', GCM_INTERACTIVE: 'never', GCM_NO_INTERACTIVE: '1', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '' };

      // Use user's PAT to push to their branch
      const rawTok  = userToken || (gitCfg.auth_token ? decrypt(gitCfg.auth_token) : '');
      const authUrl = rawTok
        ? gitCfg.remote_url.replace(/^(https?:\/\/)[^@]*@?/, `$1${encodeURIComponent(rawTok)}@`)
        : gitCfg.remote_url;

      const git2 = simpleGit2({ baseDir: wsRoot, env: { ...process.env, ...NO_PROMPT2 } });
      await git2.addConfig('user.name',  callerRow2?.name  || 'PerfStudio');
      await git2.addConfig('user.email', callerRow2?.email || 'noreply@perfstudio.com');
      await git2.remote(['set-url', 'origin', authUrl]);
      await git2.fetch(['origin']).catch(() => {});
      try {
        await git2.checkout(targetRef);
      } catch {
        // Branch may exist on remote but not locally — try to track it
        try { await git2.raw(['checkout', '-b', targetRef, `origin/${targetRef}`]); }
        catch { await git2.checkoutLocalBranch(targetRef); }
      }
      // Sync with remote BEFORE committing new files so the push is fast-forward.
      // Without this, if origin/main has new commits (workflow file updates, CI artifacts, etc.)
      // the push would be rejected as non-fast-forward and the JMX would never reach GitHub.
      try { await git2.raw(['merge', '--ff-only', `origin/${targetRef}`]); } catch {}
      try { await git2.raw(['reset', '--hard', `origin/${targetRef}`]); } catch {}

      // Copy the JMX/JS file into the workspace if it only exists in admin workspace.
      // Look up the absolute path from test_suites (jmx_path / js_path) — don't rely on
      // project.folder_path + script_path which points to the wrong location for new plans.
      if (script_name) {
        const scriptFile = (script_name || '').replace(/\\/g, '/').split('/').pop();
        const suiteRow   = db.prepare(
          "SELECT jmx_path, js_path FROM test_suites WHERE project_id = ? AND (jmx_path LIKE ? OR js_path LIKE ?) LIMIT 1"
        ).get(req.params.projectId, `%${scriptFile}`, `%${scriptFile}`);

        // Determine the absolute source path from the suite record
        let srcAbs = suiteRow?.jmx_path || suiteRow?.js_path || '';
        // Fallback: search all workspace roots for the file
        if (!srcAbs || !fs.existsSync(srcAbs)) {
          const { GIT_WORKSPACES_ROOT: _wsRoot2, cleanName: _cn2 } = require('../utils/projectFolders');
          const pName   = db.prepare('SELECT name FROM projects WHERE id = ?').get(req.params.projectId)?.name || '';
          const pFolder = path.join(_wsRoot2, _cn2(pName));
          try {
            const allDirs = fs.readdirSync(pFolder, { withFileTypes: true })
              .filter(d => d.isDirectory()).map(d => path.join(pFolder, d.name));
            for (const d of allDirs) {
              const candidate = path.join(d, script_path ? script_path.replace(/\//g, path.sep) : scriptFile);
              if (fs.existsSync(candidate)) { srcAbs = candidate; break; }
            }
          } catch {}
        }

        const destAbs = path.join(wsRoot, script_path ? script_path.replace(/\//g, path.sep) : scriptFile);
        if (srcAbs && fs.existsSync(srcAbs) && !fs.existsSync(destAbs)) {
          fs.mkdirSync(path.dirname(destAbs), { recursive: true });
          fs.copyFileSync(srcAbs, destAbs);
        }
      }

      // Stage everything new and push
      await git2.add('.');
      const st2 = await git2.status();
      if (st2.staged.length > 0 || st2.not_added.length > 0) {
        await git2.add('.');
        await git2.commit(`ci: sync scripts for pipeline run [auto]`);
      }
      // Disable GCM account picker in local .git/config before every push
      try {
        await git2.addConfig('credential.helper', '', false, 'local');
        await git2.addConfig('credential.https://github.com.helper', '', false, 'local');
      } catch {}
      // Push branch (set upstream if first time)
      await git2.push(['--set-upstream', 'origin', targetRef]);
    }
  } catch (syncErr) {
    console.warn('[CI trigger] Auto-push script failed:', syncErr.message);
    // Non-fatal — proceed with dispatch anyway; user may have pushed manually
  }

  try {
    // ── GitLab trigger ─────────────────────────────────────────────────────
    if (provider === 'gitlab') {
      if (!cfg.gitlab_trigger_token) return res.status(400).json({ error: 'GitLab trigger token not set. Create one in CI settings.' });
      if (!cfg.gitlab_project_id)    return res.status(400).json({ error: 'GitLab project ID not set.' });

      const gitlabUrl = (cfg.gitlab_url || 'https://gitlab.com').replace(/\/$/, '');
      const encodedId = encodeURIComponent(cfg.gitlab_project_id);
      const ref       = cfg.gitlab_ref || baseBranch2;

      // Build form-encoded body (GitLab trigger API uses form data)
      const params = new URLSearchParams();
      params.append('token', cfg.gitlab_trigger_token);
      params.append('ref',   ref);
      params.append('variables[SCRIPT_NAME]',     script_name || 'test.jmx');
      params.append('variables[SCRIPT_PATH]',     script_path || '');
      params.append('variables[JMETER_USERS]',    String(jmeter_users || 10));
      params.append('variables[JMETER_RAMPUP]',   String(jmeter_rampup || 30));
      params.append('variables[JMETER_LOOPS]',    String(jmeter_loops || 1));
      params.append('variables[JMETER_DURATION]', String(jmeter_duration || 300));

      const formBody = params.toString();
      const url = new URL(`${gitlabUrl}/api/v4/projects/${encodedId}/trigger/pipeline`);
      const isHttps = url.protocol === 'https:';
      const r = await new Promise((resolve, reject) => {
        const options = {
          hostname: url.hostname,
          port:     url.port || (isHttps ? 443 : 80),
          path:     url.pathname,
          method:   'POST',
          headers:  { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(formBody) },
          rejectUnauthorized: false,
        };
        const req2 = (isHttps ? https : http).request(options, res2 => {
          let data = '';
          res2.on('data', c => data += c);
          res2.on('end', () => resolve({ status: res2.statusCode, body: JSON.parse(data || '{}') }));
        });
        req2.on('error', reject);
        req2.write(formBody);
        req2.end();
      });

      if (r.status === 201) {
        const run = db.prepare('INSERT INTO ci_pipeline_runs (project_id, provider, external_id, web_url, status, script_name, run_name, variables, triggered_by) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(req.params.projectId, 'gitlab', String(r.body.id), r.body.web_url || '', r.body.status || 'pending', script_name, ciRunDisplayName, JSON.stringify(variables), req.userId);
        return res.json({ ok: true, run_id: run.lastInsertRowid, run_name: ciRunDisplayName, external_id: r.body.id, web_url: r.body.web_url, status: r.body.status, message: 'Pipeline triggered on GitLab' });
      }
      return res.status(400).json({ error: `GitLab returned ${r.status}: ${JSON.stringify(r.body)}` });
    }

    // ── GitHub Actions trigger ─────────────────────────────────────────────
    if (provider === 'github') {
      if (!effectiveGithubToken) return res.status(400).json({ error: 'No GitHub token available. Save your Personal Access Token in Git Identity (Configuration → Git).' });

      // Sanitize at trigger time — catches any stale invalid values in the DB
      const githubRepo = sanitizeGithubRepo(cfg.github_repo) || getRepoFromGit(req.params.projectId);
      if (!githubRepo) return res.status(400).json({ error: 'GitHub repo not set. Open CI Configuration and set it to "owner/repo" (e.g. tasleemzaif85/Project-Demo).' });
      cfg.github_repo = githubRepo;

      const workflowFile = cfg.github_workflow_file || 'perf-test.yml';
      // Dispatch to the base branch — perf-test.yml with workflow_dispatch trigger lives on the default branch.
      // cfg.github_ref is the user's scripts branch, but the workflow file must be on the base branch.
      const ref = baseBranch2;
      const ghHeaders    = {
        Authorization:          `token ${effectiveGithubToken}`,
        'User-Agent':           'PerfStudio',
        Accept:                 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      };
      const dispatchBody = {
        ref,  // base branch — GitHub requires workflow_dispatch ref to be the branch where perf-test.yml lives
        inputs: {
          script_name:     script_name || 'test.jmx',
          script_path:     script_path || '',
          jmeter_users:    String(jmeter_users || 10),
          jmeter_rampup:   String(jmeter_rampup || 30),
          jmeter_loops:    String(jmeter_loops || 1),
          jmeter_duration: String(jmeter_duration || 300),
          // Tell the workflow which branch to checkout for scripts/data.
          // For regular users this is their personal branch (users/<name>);
          // for admins it is the base branch. This is separate from the dispatch ref above.
          branch: targetRef,
        },
      };

      // Try filename first, then full path as fallback (both are valid per GitHub docs)
      let r = await apiRequest(
        `https://api.github.com/repos/${cfg.github_repo}/actions/workflows/${workflowFile}/dispatches`,
        'POST', dispatchBody, ghHeaders
      );

      if (r.status === 404) {
        // Fallback: try with full path
        r = await apiRequest(
          `https://api.github.com/repos/${cfg.github_repo}/actions/workflows/.github%2Fworkflows%2F${workflowFile}/dispatches`,
          'POST', dispatchBody, ghHeaders
        );
      }

      if (r.status === 404) {
        // Last resort: look up the numeric workflow ID and use that
        const wfList = await apiRequest(
          `https://api.github.com/repos/${cfg.github_repo}/actions/workflows`,
          'GET', null, ghHeaders
        );
        const wf = (wfList.body?.workflows || []).find(w =>
          w.path === `.github/workflows/${workflowFile}` || w.name === 'PerfStudio Performance Test'
        );
        if (wf?.id) {
          r = await apiRequest(
            `https://api.github.com/repos/${cfg.github_repo}/actions/workflows/${wf.id}/dispatches`,
            'POST', dispatchBody, ghHeaders
          );
        }
      }

      if (r.status === 404) {
        return res.status(404).json({
          error: `Workflow not found. Verify: 1) perf-test.yml is merged to "${ref}" branch. 2) The repo in CI settings is exactly "${cfg.github_repo}". 3) Your PAT has "repo" scope.`,
        });
      }

      // 422 — workflow found but either disabled or ref mismatch
      // Try to get workflow details to diagnose
      if (r.status === 422) {
        const wfList = await apiRequest(
          `https://api.github.com/repos/${cfg.github_repo}/actions/workflows`,
          'GET', null, ghHeaders
        );
        const wf = (wfList.body?.workflows || []).find(w =>
          w.path === `.github/workflows/${workflowFile}` || w.name === 'PerfStudio Performance Test'
        );

        console.log('[CI Trigger] 422 debug — workflow state:', wf?.state, '| ref:', ref, '| wf found:', !!wf);

        if (wf && wf.state === 'disabled_manually') {
          // Re-enable the workflow
          await apiRequest(
            `https://api.github.com/repos/${cfg.github_repo}/actions/workflows/${wf.id}/enable`,
            'PUT', null, ghHeaders
          );
          // Retry dispatch
          r = await apiRequest(
            `https://api.github.com/repos/${cfg.github_repo}/actions/workflows/${wf.id}/dispatches`,
            'POST', dispatchBody, ghHeaders
          );
        } else if (wf) {
          // Try dispatching by numeric ID with the default branch
          const repoInfo = await apiRequest(`https://api.github.com/repos/${cfg.github_repo}`, 'GET', null, ghHeaders);
          const defaultBranch = repoInfo.body?.default_branch || 'main';
          r = await apiRequest(
            `https://api.github.com/repos/${cfg.github_repo}/actions/workflows/${wf.id}/dispatches`,
            'POST', { ...dispatchBody, ref: defaultBranch }, ghHeaders
          );
          console.log('[CI Trigger] Retried with default branch:', defaultBranch, '| status:', r.status);
        }

        if (r.status !== 204) {
          return res.status(422).json({
            error: `GitHub 422: ${r.body?.message || 'Workflow dispatch failed'}. ` +
              `Workflow state: ${wf?.state || 'unknown'}. ` +
              `Try opening GitHub → your repo → Actions → ${workflowFile} → click "Enable workflow" if it appears disabled.`,
          });
        }
      }

      if (r.status === 204) {
        // Wait for GitHub to create the run record, then look for it.
        // We must verify the run was created AFTER we dispatched (within 30 s)
        // to avoid picking up a stale completed run from the history.
        const dispatchedAt = new Date();
        let latestRun = null;
        for (let attempt = 0; attempt < 5; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          const runsResp = await apiRequest(
            `https://api.github.com/repos/${cfg.github_repo}/actions/runs?event=workflow_dispatch&per_page=5`,
            'GET', null,
            { Authorization: `token ${effectiveGithubToken}`, 'User-Agent': 'PerfStudio', Accept: 'application/vnd.github+json' }
          );
          const recentRun = (runsResp.body?.workflow_runs || []).find(wr => {
            const createdAt = new Date(wr.created_at);
            return createdAt >= new Date(dispatchedAt.getTime() - 5000); // allow 5 s clock skew
          });
          if (recentRun) { latestRun = recentRun; break; }
        }

        const run = db.prepare('INSERT INTO ci_pipeline_runs (project_id, provider, external_id, web_url, status, script_name, run_name, variables, triggered_by) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(
            req.params.projectId, 'github',
            latestRun ? String(latestRun.id) : null,
            latestRun?.html_url || `https://github.com/${cfg.github_repo}/actions`,
            latestRun?.status || 'queued',
            script_name, ciRunDisplayName, JSON.stringify(variables), req.userId
          );
        return res.json({ ok: true, run_id: run.lastInsertRowid, run_name: ciRunDisplayName, external_id: latestRun?.id, web_url: latestRun?.html_url || `https://github.com/${cfg.github_repo}/actions`, status: latestRun?.status || 'queued', message: 'Workflow dispatched on GitHub Actions' });
      }
      return res.status(400).json({ error: `GitHub returned ${r.status}: ${JSON.stringify(r.body)}` });
    }

    res.status(400).json({ error: `Unknown provider: ${provider}` });
  } catch (e) {
    res.status(500).json({ error: `Trigger failed: ${e.message}` });
  }
});

// ── GET /runs — run history ───────────────────────────────────────────────────
router.get('/runs', (req, res) => {
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const runs = db.prepare('SELECT * FROM ci_pipeline_runs WHERE project_id = ? ORDER BY started_at DESC LIMIT 30').all(req.params.projectId);
  res.json({ runs });
});

// ── Auto-sync helper — called when status poll detects completion ─────────────
// Creates an execution_runs record from CI artifacts so Analytics shows the run.
async function autoSyncCiRun(run, cfg, projectId, userId) {
  const os      = require('os');
  const AdmZip  = require('adm-zip');
  const { parseJtl } = require('../utils/parseJtl');
  const { getUserProjectPath, getCollectionPath } = require('../utils/projectFolders');

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) return;

  // Guard: never create duplicate execution_runs for the same CI run
  const alreadySynced = db.prepare('SELECT id FROM execution_runs WHERE ci_run_id = ?').get(run.id);
  if (alreadySynced) { console.log(`[Auto-sync] CI run #${run.id} already synced → skipping`); return; }

  const callerRole = db.prepare('SELECT role FROM users WHERE id = ?').get(userId)?.role;
  const userProjPath = getUserProjectPath(userId, callerRole, project.name);
  const { buildRunDirName, extractRunNumber } = require('../utils/buildRunName');

  // Parse CI parameters for the run name
  const ciVars    = (() => { try { return JSON.parse(run.variables || '{}'); } catch { return {}; } })();
  const ciUsers   = ciVars.jmeter_users   || ciVars.script_users   || null;
  const ciLoops   = ciVars.jmeter_loops   || null;
  const ciDur     = ciVars.jmeter_duration|| null;

  // Determine result directory
  let resultDir = null;
  let suiteName = null;
  if (run.script_name) {
    const scriptFile = run.script_name.replace(/\\/g, '/').split('/').pop();
    const suite = db.prepare(`
      SELECT ts.*, c.name as col_name FROM test_suites ts
      LEFT JOIN collections c ON c.id = ts.collection_id
      WHERE ts.project_id = ? AND (ts.jmx_path LIKE ? OR ts.js_path LIKE ?) LIMIT 1
    `).get(projectId, `%${scriptFile}`, `%${scriptFile}`);
    suiteName = suite?.name || null;
    if (suite?.col_name && suite?.env) {
      const envPath = getCollectionPath(userProjPath, suite.col_name, suite.env);
      try { require('fs').mkdirSync(path.join(envPath, 'results'), { recursive: true }); } catch {}
      let nums = [];
      try { nums = require('fs').readdirSync(path.join(envPath, 'results'), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => extractRunNumber(d.name)).filter(n => n > 0); } catch {}
      const nextRun = nums.length ? Math.max(...nums) + 1 : 1;
      const runDirName = buildRunDirName(suiteName || scriptFile.replace(/\.jmx$/, ''), ciUsers, 'duration', ciLoops, ciDur, nextRun);
      resultDir = path.join(envPath, 'results', runDirName);
    }
  }
  if (!resultDir) {
    try {
      const nums = fs.readdirSync(path.join(userProjPath, 'results'), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => extractRunNumber(d.name)).filter(n => n > 0);
      const next = nums.length ? Math.max(...nums) + 1 : 1;
      const scriptBase = run.script_name ? run.script_name.replace(/\\/g, '/').split('/').pop().replace(/\.jmx$/, '') : 'CIRun';
      resultDir = path.join(userProjPath, 'results', buildRunDirName(suiteName || scriptBase, ciUsers, 'duration', ciLoops, ciDur, next));
    } catch {
      resultDir = path.join(userProjPath, 'results', `CI_Run_${run.id}`);
    }
  }
  fs.mkdirSync(resultDir, { recursive: true });

  const tmpZip = path.join(os.tmpdir(), `ci_auto_${run.id}_${Date.now()}.zip`);

  try {
    if (run.provider === 'github') {
      if (!cfg.github_token) throw new Error('No GitHub token');
      const ghHeaders = { Authorization: `token ${cfg.github_token}`, 'User-Agent': 'PerfStudio', Accept: 'application/vnd.github+json' };
      const artifactsResp = await apiRequest(`https://api.github.com/repos/${cfg.github_repo}/actions/runs/${run.external_id}/artifacts`, 'GET', null, ghHeaders);
      if (artifactsResp.status !== 200 || !artifactsResp.body?.artifacts?.length) throw new Error('No artifacts yet');
      const artifact = artifactsResp.body.artifacts[0];
      const dlResp = await apiRequest(`https://api.github.com/repos/${cfg.github_repo}/actions/artifacts/${artifact.id}/zip`, 'GET', null, ghHeaders);
      const downloadUrl = dlResp.headers?.location || dlResp.headers?.Location;
      if (!downloadUrl) throw new Error('No download URL');
      await new Promise((resolve, reject) => {
        const fileStream = fs.createWriteStream(tmpZip);
        https.get(downloadUrl, { rejectUnauthorized: false }, response => {
          if (response.statusCode === 302 || response.statusCode === 301) {
            https.get(response.headers.location, { rejectUnauthorized: false }, r2 => { r2.pipe(fileStream); fileStream.on('finish', () => { fileStream.close(); resolve(); }); }).on('error', reject);
          } else { response.pipe(fileStream); fileStream.on('finish', () => { fileStream.close(); resolve(); }); }
        }).on('error', reject);
      });
    } else if (run.provider === 'gitlab') {
      if (!cfg.gitlab_token) throw new Error('No GitLab token');
      const gitlabUrl = (cfg.gitlab_url || 'https://gitlab.com').replace(/\/$/, '');
      const encodedId = encodeURIComponent(cfg.gitlab_project_id);
      const jobsResp = await apiRequest(`${gitlabUrl}/api/v4/projects/${encodedId}/pipelines/${run.external_id}/jobs`, 'GET', null, { 'PRIVATE-TOKEN': cfg.gitlab_token });
      if (jobsResp.status !== 200 || !jobsResp.body?.length) throw new Error('No jobs found');
      const job = jobsResp.body.find(j => j.artifacts_file) || jobsResp.body[0];
      if (!job?.id) throw new Error('No artifact job');
      await new Promise((resolve, reject) => {
        const artifactUrl = `${gitlabUrl}/api/v4/projects/${encodedId}/jobs/${job.id}/artifacts`;
        const urlObj = new URL(artifactUrl);
        const fileStream = fs.createWriteStream(tmpZip);
        https.request({ hostname: urlObj.hostname, port: urlObj.port || 443, path: urlObj.pathname, method: 'GET', headers: { 'PRIVATE-TOKEN': cfg.gitlab_token }, rejectUnauthorized: false }, response => {
          response.pipe(fileStream); fileStream.on('finish', () => { fileStream.close(); resolve(); });
        }).on('error', reject).end();
      });
    }

    if (!fs.existsSync(tmpZip) || fs.statSync(tmpZip).size === 0) throw new Error('Empty zip');

    const zip = new AdmZip(tmpZip);
    zip.extractAllTo(resultDir, true);
    fs.unlinkSync(tmpZip);

    // Normalise html → report folder
    const ciHtmlDir = path.join(resultDir, 'html');
    const localHtmlDir = path.join(resultDir, 'report');
    if (fs.existsSync(ciHtmlDir) && !fs.existsSync(localHtmlDir)) fs.renameSync(ciHtmlDir, localHtmlDir);

    const jtlPath    = path.join(resultDir, 'results.jtl');
    const reportPath = path.join(localHtmlDir, 'index.html');

    // Resolve suite_id
    let suiteId = null;
    if (run.script_name) {
      const sf = run.script_name.split('/').pop();
      const s = db.prepare("SELECT id FROM test_suites WHERE project_id = ? AND (jmx_path LIKE ? OR js_path LIKE ?) LIMIT 1").get(projectId, `%${sf}`, `%${sf}`);
      suiteId = s?.id || null;
    }

    const reportData = fs.existsSync(jtlPath) ? parseJtl(jtlPath, {
      suite_name: suiteId ? db.prepare('SELECT name FROM test_suites WHERE id=?').get(suiteId)?.name : (run.script_name || 'CI Run'),
      engine: 'jmeter', started_at: run.started_at,
    }) : null;

    const execInsert = db.prepare(`
      INSERT INTO execution_runs (project_id, suite_id, engine, status, result_dir, report_path, logs, started_at, finished_at, report_data, ci_run_id)
      VALUES (?, ?, 'jmeter', 'completed', ?, ?, ?, ?, datetime('now'), ?, ?)
    `).run(
      projectId, suiteId, resultDir,
      fs.existsSync(reportPath) ? reportPath : null,
      JSON.stringify([{ type: 'info', message: `Results synced from CI pipeline run #${run.external_id} (${run.provider})` }]),
      run.started_at || new Date().toISOString(),
      reportData ? JSON.stringify(reportData) : null,
      run.id
    );
    const newRunId = execInsert.lastInsertRowid;

    console.log(`[Auto-sync] CI run #${run.id} synced → ${path.basename(resultDir)}`);

    // Send emails non-blocking — rule violation alert first, then full report
    setImmediate(async () => {
      try {
        const { sendAlertEmail, sendRuleViolationEmail } = require('../utils/emailUtils');
        const { evaluateRules } = require('../utils/ruleEvaluator');

        let violations = [];
        if (fs.existsSync(jtlPath)) {
          try {
            const rr = evaluateRules(projectId, jtlPath);
            violations = rr?.violations || [];
          } catch (_) {}
        }

        const suiteLookup = suiteId ? db.prepare('SELECT name FROM test_suites WHERE id = ?').get(suiteId) : null;
        const emailData = {
          ...(reportData || {
            meta: { suite_name: suiteLookup?.name || run.script_name || 'CI Run', engine: 'jmeter', started_at: run.started_at, status: 'completed' },
            summary: { total_requests: 0, total_success: 0, total_failed: 0, avg_response_time: 0, overall_tps: 0 },
            by_api: [], timeline: [], errors: [],
          }),
          rule_violations: violations,
        };
        if (suiteLookup?.name) emailData.meta.suite_name = suiteLookup.name;

        if (violations.length > 0) {
          await sendRuleViolationEmail(newRunId, userId, projectId, violations, emailData.meta.suite_name, project.name);
        }
        await sendAlertEmail(newRunId, userId, projectId, emailData, null, null);
        console.log(`[Auto-sync] Emails sent for CI run #${run.id} → exec run #${newRunId}`);
      } catch (e) {
        console.error('[Auto-sync] Email failed:', e.message);
      }
    });
  } catch (e) {
    try { if (fs.existsSync(tmpZip)) fs.unlinkSync(tmpZip); } catch {}
    console.warn(`[Auto-sync] CI run #${run.id} failed: ${e.message}`);
  }
}

// ── GET /runs/:runId/status — poll live status from provider ─────────────────
router.get('/runs/:runId/status', async (req, res) => {
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const run = db.prepare('SELECT * FROM ci_pipeline_runs WHERE id = ? AND project_id = ?').get(req.params.runId, req.params.projectId);
  if (!run) return res.status(404).json({ error: 'Run not found' });

  const cfg = decryptConfig(getConfig(req.params.projectId, req.userId));
  if (!run.external_id || !cfg) return res.json({ run });

  try {
    let status = run.status;
    let webUrl = run.web_url;

    if (run.provider === 'gitlab') {
      const gitlabUrl = (cfg.gitlab_url || 'https://gitlab.com').replace(/\/$/, '');
      const encodedId = encodeURIComponent(cfg.gitlab_project_id);
      const r = await apiRequest(
        `${gitlabUrl}/api/v4/projects/${encodedId}/pipelines/${run.external_id}`,
        'GET', null, { 'PRIVATE-TOKEN': cfg.gitlab_token }
      );
      if (r.status === 200) { status = r.body.status; webUrl = r.body.web_url || webUrl; }
    }

    if (run.provider === 'github') {
      const r = await apiRequest(
        `https://api.github.com/repos/${cfg.github_repo}/actions/runs/${run.external_id}`,
        'GET', null,
        { Authorization: `token ${cfg.github_token}`, 'User-Agent': 'PerfStudio', Accept: 'application/vnd.github+json' }
      );
      if (r.status === 200) {
        // GitHub: status=queued/in_progress/completed, conclusion=success/failure/cancelled
        status = r.body.status === 'completed' ? (r.body.conclusion || 'completed') : r.body.status;
        webUrl = r.body.html_url || webUrl;
      }
    }

    // Map external statuses to our internal ones
    const statusMap = {
      // GitLab
      created: 'pending', pending: 'pending', running: 'running',
      success: 'completed', failed: 'failed', canceled: 'cancelled', skipped: 'skipped',
      // GitHub
      queued: 'pending', in_progress: 'running',
      'success': 'completed', 'failure': 'failed', 'cancelled': 'cancelled',
    };
    const mappedStatus = statusMap[status] || status;

    // Update DB
    const isFinished = ['completed','failed','cancelled','skipped'].includes(mappedStatus);
    db.prepare('UPDATE ci_pipeline_runs SET status=?, web_url=?' + (isFinished ? ", finished_at=datetime('now')" : '') + ' WHERE id=?')
      .run(mappedStatus, webUrl, run.id);

    // Auto-sync: first time this run reaches "completed", download artifacts and
    // create an execution_runs record so it appears in Analytics automatically.
    if (mappedStatus === 'completed' && run.status !== 'completed') {
      const alreadySynced = db.prepare('SELECT id FROM execution_runs WHERE ci_run_id = ?').get(run.id);
      if (!alreadySynced) {
        const runSnapshot = db.prepare('SELECT * FROM ci_pipeline_runs WHERE id = ?').get(run.id);
        setImmediate(() => autoSyncCiRun(runSnapshot, cfg, req.params.projectId, req.userId).catch(() => {}));
      }
    }

    // Send email alert for failed / cancelled runs (completed runs get email via autoSyncCiRun)
    const wasFinished = ['completed','failed','cancelled','skipped'].includes(run.status);
    if (!wasFinished && ['failed','cancelled'].includes(mappedStatus)) {
      setImmediate(async () => {
        try {
          const { sendAlertEmail } = require('../utils/emailUtils');
          const ciVarsF = (() => { try { return JSON.parse(run.variables || '{}'); } catch { return {}; } })();
          const emailData = {
            meta: {
              suite_name: `${run.run_name || run.script_name || 'CI Run'} [${mappedStatus.toUpperCase()}]`,
              engine: 'jmeter',
              started_at: run.started_at,
              duration_s: run.finished_at
                ? Math.round((new Date(run.finished_at) - new Date(run.started_at)) / 1000)
                : 0,
              status: mappedStatus,
              ci_provider: run.provider,
              ci_web_url: webUrl,
            },
            summary: {
              total_requests: 0, total_success: 0, total_failed: 0,
              error_rate: 0, avg_response_time: 0, overall_tps: 0, p90: 0, p95: 0,
            },
            by_api: [], timeline: [], errors: [{ type: 'CI Pipeline', message: `Pipeline ${mappedStatus} on ${run.provider}` }],
            rule_violations: [],
          };
          await sendAlertEmail(null, req.userId, req.params.projectId, emailData, null, null);
          console.log(`[CI Status] Alert email sent for ${mappedStatus} run #${run.id}`);
        } catch (e) {
          console.error('[CI Status] Failed email for', mappedStatus, 'run:', e.message);
        }
      });
    }

    res.json({ run: { ...run, status: mappedStatus, web_url: webUrl } });
  } catch (e) {
    res.json({ run, poll_error: e.message });
  }
});

// ── POST /runs/:runId/sync-results — download artifacts and save to env results folder ──
router.post('/runs/:runId/sync-results', async (req, res) => {
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });

  const run = db.prepare('SELECT * FROM ci_pipeline_runs WHERE id = ? AND project_id = ?').get(req.params.runId, req.params.projectId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (!run.external_id) return res.status(400).json({ error: 'No external pipeline ID — pipeline may not have started yet.' });

  // Guard: don't create a second execution_runs record for the same CI run
  const alreadySynced = db.prepare('SELECT id FROM execution_runs WHERE ci_run_id = ?').get(run.id);
  if (alreadySynced) return res.json({ ok: true, already_synced: true, execution_run_id: alreadySynced.id, message: 'Already synced — results are already in Analytics.' });

  const cfg = decryptConfig(getConfig(req.params.projectId, req.userId));
  if (!cfg) return res.status(400).json({ error: 'CI configuration not found.' });

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const AdmZip = require('adm-zip');
  const os = require('os');
  const { getUserProjectPath, getCollectionPath } = require('../utils/projectFolders');
  const { buildRunDirName, extractRunNumber } = require('../utils/buildRunName');

  // ── Determine results directory ────────────────────────────────────────────
  const callerRole  = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId)?.role;
  const userProjPath = getUserProjectPath(req.userId, callerRole, project.name);

  // Parse CI parameters for the run name
  const ciVars2  = (() => { try { return JSON.parse(run.variables || '{}'); } catch { return {}; } })();
  const ciUsers2 = ciVars2.jmeter_users    || null;
  const ciLoops2 = ciVars2.jmeter_loops    || null;
  const ciDur2   = ciVars2.jmeter_duration || null;

  let resultDir = null;
  let syncSuiteName = null;
  if (run.script_name) {
    const scriptFile = run.script_name.replace(/\\/g, '/').split('/').pop();
    const suite = db.prepare(`
      SELECT ts.*, c.name as col_name FROM test_suites ts
      LEFT JOIN collections c ON c.id = ts.collection_id
      WHERE ts.project_id = ?
        AND (ts.jmx_path LIKE ? OR ts.js_path LIKE ?)
      LIMIT 1
    `).get(req.params.projectId, `%${scriptFile}`, `%${scriptFile}`);

    syncSuiteName = suite?.name || null;
    if (suite?.col_name && suite?.env) {
      const envPath = getCollectionPath(userProjPath, suite.col_name, suite.env);
      try { fs.mkdirSync(path.join(envPath, 'results'), { recursive: true }); } catch {}
      let nums = [];
      try { nums = fs.readdirSync(path.join(envPath, 'results'), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => extractRunNumber(d.name)).filter(n => n > 0); } catch {}
      const nextRun = nums.length ? Math.max(...nums) + 1 : 1;
      const syncScriptBase = scriptFile.replace(/\.jmx$/, '');
      resultDir = path.join(envPath, 'results', buildRunDirName(syncSuiteName || syncScriptBase, ciUsers2, 'duration', ciLoops2, ciDur2, nextRun));
    }
  }

  // Fallback to project-level results
  if (!resultDir) {
    try {
      const nums = fs.readdirSync(path.join(userProjPath, 'results'), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => extractRunNumber(d.name)).filter(n => n > 0);
      const next = nums.length ? Math.max(...nums) + 1 : 1;
      const fb = run.script_name ? run.script_name.replace(/\\/g, '/').split('/').pop().replace(/\.jmx$/, '') : 'CIRun';
      resultDir = path.join(userProjPath, 'results', buildRunDirName(syncSuiteName || fb, ciUsers2, 'duration', ciLoops2, ciDur2, next));
    } catch {
      resultDir = path.join(userProjPath, 'results', `CI_Run_${run.id}`);
    }
  }

  fs.mkdirSync(resultDir, { recursive: true });

  // ── Download artifact zip ─────────────────────────────────────────────────
  const tmpZip = path.join(os.tmpdir(), `ci_artifact_${run.id}_${Date.now()}.zip`);

  try {
    if (run.provider === 'github') {
      if (!cfg.github_token) return res.status(400).json({ error: 'GitHub token not set.' });

      // Get artifact list for this run
      const artifactsResp = await apiRequest(
        `https://api.github.com/repos/${cfg.github_repo}/actions/runs/${run.external_id}/artifacts`,
        'GET', null,
        { Authorization: `token ${cfg.github_token}`, 'User-Agent': 'PerfStudio', Accept: 'application/vnd.github+json' }
      );

      if (artifactsResp.status !== 200 || !artifactsResp.body?.artifacts?.length) {
        return res.status(404).json({ error: 'No artifacts found for this run. The pipeline may still be running or artifacts may have expired.' });
      }

      // Pick the first artifact (jmeter-report-*)
      const artifact = artifactsResp.body.artifacts[0];

      // Get download URL (GitHub returns 302 redirect)
      const dlResp = await apiRequest(
        `https://api.github.com/repos/${cfg.github_repo}/actions/artifacts/${artifact.id}/zip`,
        'GET', null,
        { Authorization: `token ${cfg.github_token}`, 'User-Agent': 'PerfStudio', Accept: 'application/vnd.github+json' }
      );

      // Follow the redirect to get the actual download URL
      const downloadUrl = dlResp.headers?.location || dlResp.headers?.Location;
      if (!downloadUrl) return res.status(500).json({ error: 'Could not get artifact download URL from GitHub.' });

      // Download the zip
      await new Promise((resolve, reject) => {
        const urlObj = new URL(downloadUrl);
        const isHttps = urlObj.protocol === 'https:';
        const fileStream = fs.createWriteStream(tmpZip);
        (isHttps ? https : http).get(downloadUrl, { rejectUnauthorized: false }, response => {
          // Handle another redirect if needed
          if (response.statusCode === 302 || response.statusCode === 301) {
            const redirectUrl = response.headers.location;
            (isHttps ? https : http).get(redirectUrl, { rejectUnauthorized: false }, r2 => {
              r2.pipe(fileStream);
              fileStream.on('finish', () => { fileStream.close(); resolve(); });
            }).on('error', reject);
          } else {
            response.pipe(fileStream);
            fileStream.on('finish', () => { fileStream.close(); resolve(); });
          }
        }).on('error', reject);
      });
    }

    if (run.provider === 'gitlab') {
      if (!cfg.gitlab_token) return res.status(400).json({ error: 'GitLab token not set.' });
      const gitlabUrl = (cfg.gitlab_url || 'https://gitlab.com').replace(/\/$/, '');
      const encodedId = encodeURIComponent(cfg.gitlab_project_id);

      // Get jobs for this pipeline
      const jobsResp = await apiRequest(
        `${gitlabUrl}/api/v4/projects/${encodedId}/pipelines/${run.external_id}/jobs`,
        'GET', null, { 'PRIVATE-TOKEN': cfg.gitlab_token }
      );
      if (jobsResp.status !== 200 || !jobsResp.body?.length) {
        return res.status(404).json({ error: 'No jobs found for this GitLab pipeline.' });
      }

      const job = jobsResp.body.find(j => j.artifacts_file) || jobsResp.body[0];
      if (!job?.id) return res.status(404).json({ error: 'No artifact-producing job found.' });

      // Download artifacts zip
      await new Promise((resolve, reject) => {
        const artifactUrl = `${gitlabUrl}/api/v4/projects/${encodedId}/jobs/${job.id}/artifacts`;
        const urlObj = new URL(artifactUrl);
        const isHttps = urlObj.protocol === 'https:';
        const fileStream = fs.createWriteStream(tmpZip);
        const options = { hostname: urlObj.hostname, port: urlObj.port || (isHttps ? 443 : 80), path: urlObj.pathname, method: 'GET', headers: { 'PRIVATE-TOKEN': cfg.gitlab_token }, rejectUnauthorized: false };
        (isHttps ? https : http).request(options, response => {
          response.pipe(fileStream);
          fileStream.on('finish', () => { fileStream.close(); resolve(); });
        }).on('error', reject).end();
      });
    }

    // ── Extract zip to resultDir ─────────────────────────────────────────────
    if (!fs.existsSync(tmpZip) || fs.statSync(tmpZip).size === 0) {
      return res.status(500).json({ error: 'Downloaded artifact is empty or missing.' });
    }

    const zip = new AdmZip(tmpZip);
    zip.extractAllTo(resultDir, true);
    fs.unlinkSync(tmpZip);

    // ── Normalise folder names to match local run structure ───────────────────
    // CI YAML writes HTML to reports/html/ — local runs use resultDir/report/
    const ciHtmlDir    = path.join(resultDir, 'html');
    const localHtmlDir = path.join(resultDir, 'report');
    if (fs.existsSync(ciHtmlDir) && !fs.existsSync(localHtmlDir)) {
      fs.renameSync(ciHtmlDir, localHtmlDir);
    }
    const reportPath = path.join(localHtmlDir, 'index.html');
    const jtlPath    = path.join(resultDir, 'results.jtl');

    // ── Generate analytics PDF from JTL ──────────────────────────────────────
    let pdfPath = null;
    let reportData = null;
    if (fs.existsSync(jtlPath)) {
      try {
        const { generateAnalyticsPdfToFile } = require('../utils/generateAnalyticsPdf');
        const runNum  = (resultDir.match(/Run_(\d+)/) || [])[1] || run.id;
        const tmpPdf  = path.join(resultDir, `Analytics_CI_Run_${runNum}.pdf`);

        // Build reportData structure expected by generateAnalyticsPdfToFile
        const content   = fs.readFileSync(jtlPath, 'utf8');
        const lines     = content.trim().split('\n').filter(Boolean);
        if (lines.length >= 2) {
          const HNORM = { Latency:'latency', Connect:'connect', Bytes:'bytes', SentBytes:'sentBytes' };
          const hdrs  = lines[0].split(',').map(h => { const c = h.trim().replace(/^"|"$/g,''); return HNORM[c]||c; });
          const splitCsvLine = line => {
            const cells = []; let cur = '', inQ = false;
            for (const ch of line) {
              if (ch === '"') inQ = !inQ;
              else if (ch === ',' && !inQ) { cells.push(cur.trim()); cur = ''; }
              else cur += ch;
            } cells.push(cur.trim()); return cells;
          };
          const parseRow = ln => { const p=splitCsvLine(ln),r={}; hdrs.forEach((h,i)=>{r[h]=(p[i]||'').replace(/^"|"$/g,'').trim();}); return r; };
          const pct = (arr,p) => { if(!arr.length)return null; const s=[...arr].sort((a,b)=>a-b); return s[Math.max(0,Math.ceil(p/100*s.length)-1)]; };

          const allRows   = lines.slice(1).map(parseRow);
          const elapsed   = allRows.map(r=>parseInt(r.elapsed)||0);
          const totalReqs = allRows.length;
          const totalFail = allRows.filter(r=>r.success==='false').length;
          const tsList    = allRows.map(r=>parseInt(r.timeStamp)||0).filter(Boolean);
          const durS      = tsList.length ? (Math.max(...tsList) - Math.min(...tsList))/1000 : 1;

          const suite = db.prepare('SELECT name FROM test_suites WHERE id = (SELECT suite_id FROM execution_runs WHERE result_dir LIKE ? LIMIT 1)').get(`%${path.basename(resultDir)}%`);

          const byLabel = {};
          allRows.forEach(r => {
            const lbl = r.label || 'Unknown';
            if (!byLabel[lbl]) byLabel[lbl] = { elapsed:[], success:0, failed:0 };
            byLabel[lbl].elapsed.push(parseInt(r.elapsed)||0);
            if (r.success === 'true') byLabel[lbl].success++; else byLabel[lbl].failed++;
          });
          const by_api = Object.entries(byLabel).map(([label, d]) => ({
            label, total: d.elapsed.length, success: d.success, failed: d.failed,
            error_rate: parseFloat(((d.failed / d.elapsed.length) * 100).toFixed(2)),
            avg: parseFloat((d.elapsed.reduce((a,b)=>a+b,0) / d.elapsed.length).toFixed(1)),
            p90: pct(d.elapsed, 90), p95: pct(d.elapsed, 95),
            tps: parseFloat((d.elapsed.length / durS).toFixed(3)),
          }));

          reportData = {
            meta: {
              suite_name: suite?.name || run.script_name || 'CI Run',
              engine: 'jmeter',
              started_at: run.started_at,
              duration_s: Math.round(durS),
              status:     'completed',
            },
            summary: {
              total_requests:    totalReqs,
              total_failed:      totalFail,
              total_success:     totalReqs - totalFail,
              error_rate: parseFloat(((totalFail / (totalReqs || 1)) * 100).toFixed(2)),
              avg_response_time: elapsed.length ? elapsed.reduce((a,b)=>a+b,0)/elapsed.length : 0,
              min_response_time: elapsed.length ? Math.min(...elapsed.filter(v=>v>0)) : 0,
              max_response_time: elapsed.length ? Math.max(...elapsed) : 0,
              p90:               pct(elapsed, 90) || 0,
              p95:               pct(elapsed, 95) || 0,
              overall_tps:       durS > 0 ? totalReqs / durS : 0,
            },
            by_api, timeline: [], errors: [], rule_violations: [],
          };

          await generateAnalyticsPdfToFile(reportData, runNum, tmpPdf);
          pdfPath = tmpPdf;
          console.log('[CI Sync] Analytics PDF generated:', pdfPath);
        }
      } catch (e) {
        console.error('[CI Sync] PDF generation failed:', e.message, e.stack?.split('\n')[1] || '');
      }
    }

    // ── Create execution_run record ───────────────────────────────────────────
    let suiteId = null;
    if (run.script_name) {
      const scriptFile = run.script_name.split('/').pop();
      const suite = db.prepare("SELECT id FROM test_suites WHERE project_id = ? AND (jmx_path LIKE ? OR js_path LIKE ?) LIMIT 1")
        .get(req.params.projectId, `%${scriptFile}`, `%${scriptFile}`);
      suiteId = suite?.id || null;
    }

    const execRunRow = db.prepare(`
      INSERT INTO execution_runs
        (project_id, suite_id, engine, status, result_dir, report_path, logs, started_at, finished_at, report_data, ci_run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)
    `).run(
      req.params.projectId,
      suiteId,
      'jmeter',
      'completed',
      resultDir,
      fs.existsSync(reportPath) ? reportPath : null,
      JSON.stringify([{ type: 'info', message: `Results synced from CI pipeline run #${run.external_id} (${run.provider})` }]),
      run.started_at || new Date().toISOString(),
      reportData ? JSON.stringify(reportData) : null,
      run.id
    );

    // Update ci_pipeline_run with result_dir reference
    db.prepare("UPDATE ci_pipeline_runs SET variables = ? WHERE id = ?")
      .run(JSON.stringify({ ...JSON.parse(run.variables || '{}'), result_dir: resultDir }), run.id);

    // ── Send email alert for CI run ───────────────────────────────────────────
    const newRunId = execRunRow.lastInsertRowid;
    const suppressEmail = req.query.suppress_email === 'true';
    if (!suppressEmail) setImmediate(async () => {
      try {
        const { sendAlertEmail, sendRuleViolationEmail } = require('../utils/emailUtils');
        const emailData = reportData || {
          meta: { suite_name: run.script_name || 'CI Run', engine: 'jmeter', started_at: run.started_at, duration_s: 0, status: 'completed' },
          summary: { total_requests: 0, total_success: 0, total_failed: 0, error_rate: 0, avg_response_time: 0, overall_tps: 0, p90: 0, p95: 0 },
          by_api: [], timeline: [], errors: [], rule_violations: [],
        };
        // Use the actual suite name from the test_suites table (suiteId resolved above)
        let resolvedSuiteName = emailData.meta.suite_name;
        if (suiteId) {
          const sRow = db.prepare('SELECT name FROM test_suites WHERE id = ?').get(suiteId);
          if (sRow?.name) { emailData.meta.suite_name = sRow.name; resolvedSuiteName = sRow.name; }
        }
        emailData.meta.run_id = newRunId;
        // Evaluate rules against JTL for violation summary in email
        let violations = [];
        if (fs.existsSync(jtlPath)) {
          try {
            const { evaluateRules } = require('../utils/ruleEvaluator');
            const rr = evaluateRules(req.params.projectId, jtlPath);
            violations = rr?.violations || [];
            emailData.rule_violations = violations;
          } catch (_) {}
        }
        // Send rule violation email first (as soon as violations are known, before full report)
        if (violations.length > 0) {
          const proj = db.prepare('SELECT name FROM projects WHERE id = ?').get(req.params.projectId);
          await sendRuleViolationEmail(newRunId, req.userId, req.params.projectId, violations, resolvedSuiteName, proj?.name || '');
        }
        // Send full report email
        await sendAlertEmail(newRunId, req.userId, req.params.projectId, emailData, pdfPath, null);
        console.log(`[CI Sync] Alert email sent for run #${newRunId}`);
      } catch (e) {
        console.error('[CI Sync] Alert email failed:', e.message);
      }
    });

    const savedFiles = fs.readdirSync(resultDir);
    res.json({
      ok: true,
      result_dir: resultDir,
      files: savedFiles,
      has_html_report: fs.existsSync(reportPath),
      has_pdf: !!pdfPath,
      message: `Results saved → ${path.basename(path.dirname(resultDir))}/${path.basename(resultDir)} (JTL + ${fs.existsSync(reportPath)?'HTML report + ':''}${pdfPath?'PDF':'no PDF'})`,
    });

  } catch (e) {
    try { if (fs.existsSync(tmpZip)) fs.unlinkSync(tmpZip); } catch {}
    res.status(500).json({ error: `Failed to sync results: ${e.message}` });
  }
});

// ── GET /runs/:runId/steps — live step details from GitHub/GitLab ─────────────
router.get('/runs/:runId/steps', async (req, res) => {
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const run = db.prepare('SELECT * FROM ci_pipeline_runs WHERE id = ? AND project_id = ?').get(req.params.runId, req.params.projectId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (!run.external_id) return res.json({ steps: [], status: run.status });

  const cfg = decryptConfig(getConfig(req.params.projectId, req.userId));
  if (!cfg) return res.json({ steps: [], status: run.status });

  try {
    if (run.provider === 'github') {
      if (!cfg.github_token) return res.json({ steps: [], status: run.status });
      const ghHeaders = {
        Authorization: `token ${cfg.github_token}`,
        'User-Agent': 'PerfStudio',
        Accept: 'application/vnd.github+json',
      };

      // Get jobs for this run
      const jobsResp = await apiRequest(
        `https://api.github.com/repos/${cfg.github_repo}/actions/runs/${run.external_id}/jobs`,
        'GET', null, ghHeaders
      );

      if (jobsResp.status !== 200) return res.json({ steps: [], status: run.status });

      const job = jobsResp.body?.jobs?.[0];
      if (!job) return res.json({ steps: [], status: run.status });

      const steps = (job.steps || []).map(s => ({
        number:       s.number,
        name:         s.name,
        status:       s.status,       // queued | in_progress | completed
        conclusion:   s.conclusion,   // success | failure | skipped | cancelled | null
        started_at:   s.started_at,
        completed_at: s.completed_at,
        duration_s:   s.started_at && s.completed_at
          ? Math.round((new Date(s.completed_at) - new Date(s.started_at)) / 1000)
          : null,
      }));

      // Job-level details
      const jobInfo = {
        id:           job.id,
        name:         job.name,
        status:       job.status,
        conclusion:   job.conclusion,
        started_at:   job.started_at,
        completed_at: job.completed_at,
        html_url:     job.html_url,
        runner_name:  job.runner_name,
      };

      return res.json({ steps, job: jobInfo, status: run.status, provider: 'github' });
    }

    if (run.provider === 'gitlab') {
      if (!cfg.gitlab_token) return res.json({ steps: [], status: run.status });
      const gitlabUrl = (cfg.gitlab_url || 'https://gitlab.com').replace(/\/$/, '');
      const encodedId = encodeURIComponent(cfg.gitlab_project_id);

      const jobsResp = await apiRequest(
        `${gitlabUrl}/api/v4/projects/${encodedId}/pipelines/${run.external_id}/jobs`,
        'GET', null, { 'PRIVATE-TOKEN': cfg.gitlab_token }
      );

      if (jobsResp.status !== 200) return res.json({ steps: [], status: run.status });

      const steps = (jobsResp.body || []).map(j => ({
        number:       j.id,
        name:         j.name,
        status:       j.status,
        conclusion:   j.status === 'success' ? 'success' : j.status === 'failed' ? 'failure' : null,
        started_at:   j.started_at,
        completed_at: j.finished_at,
        duration_s:   j.duration ? Math.round(j.duration) : null,
      }));

      return res.json({ steps, status: run.status, provider: 'gitlab' });
    }

    res.json({ steps: [], status: run.status });
  } catch (e) {
    res.json({ steps: [], status: run.status, error: e.message });
  }
});

module.exports = router;
