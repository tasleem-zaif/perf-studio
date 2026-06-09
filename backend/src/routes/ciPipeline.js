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

function getConfig(projectId) {
  return db.prepare('SELECT * FROM ci_pipeline_configs WHERE project_id = ?').get(projectId) || null;
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

// ── GET /config ───────────────────────────────────────────────────────────────
router.get('/config', (req, res) => {
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const cfg = getConfig(req.params.projectId);
  if (!cfg) return res.json({ config: null });

  // Mask tokens — never return raw tokens to frontend
  res.json({
    config: {
      ...cfg,
      gitlab_token:         cfg.gitlab_token         ? '••••••••' : '',
      gitlab_trigger_token: cfg.gitlab_trigger_token ? '••••••••' : '',
      github_token:         cfg.github_token         ? '••••••••' : '',
      gitlab_token_set:         !!cfg.gitlab_token,
      gitlab_trigger_token_set: !!cfg.gitlab_trigger_token,
      github_token_set:         !!cfg.github_token,
    },
  });
});

// ── PUT /config ───────────────────────────────────────────────────────────────
router.put('/config', (req, res) => {
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const {
    gitlab_enabled, gitlab_url, gitlab_project_id, gitlab_token, gitlab_trigger_token, gitlab_ref,
    github_enabled, github_repo, github_token, github_workflow_file, github_ref,
  } = req.body;

  const existing = getConfig(req.params.projectId);

  // Only encrypt + store token if a new value was provided (not the masked placeholder)
  const encGitlabToken        = gitlab_token && gitlab_token !== '••••••••'         ? encrypt(gitlab_token)         : existing?.gitlab_token         || '';
  const encGitlabTriggerToken = gitlab_trigger_token && gitlab_trigger_token !== '••••••••' ? encrypt(gitlab_trigger_token) : existing?.gitlab_trigger_token || '';
  const encGithubToken        = github_token && github_token !== '••••••••'         ? encrypt(github_token)         : existing?.github_token         || '';

  if (existing) {
    db.prepare(`UPDATE ci_pipeline_configs SET
      gitlab_enabled=?, gitlab_url=?, gitlab_project_id=?, gitlab_token=?,
      gitlab_trigger_token=?, gitlab_ref=?,
      github_enabled=?, github_repo=?, github_token=?, github_workflow_file=?, github_ref=?,
      updated_at=datetime('now')
      WHERE project_id=?`
    ).run(
      gitlab_enabled ? 1 : 0, gitlab_url || 'https://gitlab.com', gitlab_project_id || '',
      encGitlabToken, encGitlabTriggerToken, gitlab_ref || 'main',
      github_enabled ? 1 : 0, github_repo || '', encGithubToken,
      github_workflow_file || 'perf-test.yml', github_ref || 'main',
      req.params.projectId
    );
  } else {
    db.prepare(`INSERT INTO ci_pipeline_configs
      (project_id, gitlab_enabled, gitlab_url, gitlab_project_id, gitlab_token, gitlab_trigger_token, gitlab_ref,
       github_enabled, github_repo, github_token, github_workflow_file, github_ref)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      req.params.projectId,
      gitlab_enabled ? 1 : 0, gitlab_url || 'https://gitlab.com', gitlab_project_id || '',
      encGitlabToken, encGitlabTriggerToken, gitlab_ref || 'main',
      github_enabled ? 1 : 0, github_repo || '', encGithubToken,
      github_workflow_file || 'perf-test.yml', github_ref || 'main'
    );
  }

  res.json({ ok: true });
});

// ── POST /config/test — test connection ───────────────────────────────────────
router.post('/config/test', async (req, res) => {
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const { provider } = req.body;
  const cfg = decryptConfig(getConfig(req.params.projectId));
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
  const cfg = decryptConfig(getConfig(req.params.projectId));
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
  const cfg     = decryptConfig(getConfig(req.params.projectId));
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { providers = ['gitlab', 'github'] } = req.body;

  // YAML files (.github/workflows/*, .gitlab-ci.yml) must ALWAYS go into the
  // ADMIN workspace. GitHub requires the `workflow` PAT scope to push workflow
  // files — regular users don't have this scope. The org admin pushes these
  // files once, after which all users can trigger the pipeline.
  const { GIT_WORKSPACES_ROOT } = require('../utils/projectFolders');
  const gitRoot = path.join(GIT_WORKSPACES_ROOT, 'admin'); // git-workspaces/admin/

  // Get all generated test plans for this project to include as YAML comments
  const suites = db.prepare("SELECT * FROM test_suites WHERE project_id = ? AND (jmx_path IS NOT NULL OR js_path IS NOT NULL)").all(req.params.projectId);

  const created = [];
  const errors  = [];

  // ── Generate .gitlab-ci.yml ──────────────────────────────────────────────
  if (providers.includes('gitlab')) {
    const defaultScript = suites.length > 0
      ? path.basename(suites[0].jmx_path || suites[0].js_path || 'test.jmx')
      : 'test.jmx';
    const ref = cfg?.gitlab_ref || 'main';

    const scriptList = suites.map(s => {
      const file = path.basename(s.jmx_path || s.js_path || '');
      const relPath = s.jmx_path
        ? path.relative(gitRoot, s.jmx_path).replace(/\\/g, '/')
        : path.relative(gitRoot, s.js_path || '').replace(/\\/g, '/');
      return `  # ${s.name} → ${relPath}`;
    }).join('\n');

    const gitlabYaml = `# ============================================================
# PerfStudio — GitLab CI/CD Performance Test Pipeline
# Generated by PerfStudio on ${new Date().toISOString().slice(0, 10)}
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

    const scriptList = suites.map(s => {
      const relPath = s.jmx_path
        ? path.relative(gitRoot, s.jmx_path).replace(/\\/g, '/')
        : path.relative(gitRoot, s.js_path || '').replace(/\\/g, '/');
      return `      # ${s.name}: ${relPath}`;
    }).join('\n');

    const githubYaml = `# ============================================================
# PerfStudio — GitHub Actions Performance Test Pipeline
# Generated by PerfStudio on ${new Date().toISOString().slice(0, 10)}
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

# Available test scripts:
${scriptList || '      # (no generated scripts yet)'}

jobs:
  jmeter:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Run JMeter performance test
        run: |
          SCRIPT="\${{ inputs.script_path }}"
          if [ -z "\$SCRIPT" ]; then
            SCRIPT="\${{ inputs.script_name }}"
          fi
          echo "Running script: \$SCRIPT"
          mkdir -p reports

          docker run --rm \\
            -v "\${{ github.workspace }}":/workspace \\
            -v "\${{ github.workspace }}/reports":/output \\
            justb4/jmeter \\
            -Dlog4j2.formatMsgNoLookups=true \\
            -n -t "/workspace/\$SCRIPT" \\
            -Jusers="\${{ inputs.jmeter_users }}" \\
            -Jrampup="\${{ inputs.jmeter_rampup }}" \\
            -Jloops="\${{ inputs.jmeter_loops }}" \\
            -Jduration="\${{ inputs.jmeter_duration }}" \\
            -l /output/results.jtl \\
            -e -o /output/html

      - name: Upload JMeter report
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: jmeter-report-\${{ github.run_number }}
          path: reports/
          retention-days: 7
`;
    try {
      const workflowDir = path.join(gitRoot, '.github', 'workflows');
      fs.mkdirSync(workflowDir, { recursive: true });
      fs.writeFileSync(path.join(workflowDir, workflowFile), githubYaml, 'utf8');
      created.push(`.github/workflows/${workflowFile}`);
    } catch (e) { errors.push(`.github/workflows/${workflowFile}: ${e.message}`); }
  }

  if (created.length === 0) return res.status(500).json({ error: errors.join('; ') || 'Nothing generated' });
  res.json({ ok: true, created, errors, message: `Generated: ${created.join(', ')}. Commit and push these files to your branch.` });
});

// ── POST /trigger — trigger pipeline on GitLab or GitHub ─────────────────────
router.post('/trigger', async (req, res) => {
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const cfg = decryptConfig(getConfig(req.params.projectId));
  if (!cfg) return res.status(400).json({ error: 'CI configuration not saved yet.' });

  const { provider, script_name, script_path, jmeter_users, jmeter_rampup, jmeter_loops, jmeter_duration } = req.body;
  if (!provider) return res.status(400).json({ error: 'provider required (gitlab or github)' });

  // Prefer the calling user's personal PAT over the project CI config token.
  // This way each user's pipeline trigger is attributed to their own GitHub/GitLab account.
  // Regular users already have a PAT saved in Git Identity — no extra setup needed.
  const userIdentity = db.prepare('SELECT auth_token FROM user_git_configs WHERE user_id = ? AND project_id = ?')
    .get(req.userId, req.params.projectId);
  const userToken = userIdentity?.auth_token ? decrypt(userIdentity.auth_token) : null;

  // Effective tokens: user's personal PAT takes priority
  const effectiveGithubToken = userToken || cfg.github_token;
  const effectiveGitlabToken = userToken || cfg.gitlab_token;

  const variables = { script_name, script_path: script_path || '', jmeter_users: String(jmeter_users || 10), jmeter_rampup: String(jmeter_rampup || 30), jmeter_loops: String(jmeter_loops || 1), jmeter_duration: String(jmeter_duration || 300) };

  try {
    // ── GitLab trigger ─────────────────────────────────────────────────────
    if (provider === 'gitlab') {
      if (!cfg.gitlab_trigger_token) return res.status(400).json({ error: 'GitLab trigger token not set. Create one in CI settings.' });
      if (!cfg.gitlab_project_id)    return res.status(400).json({ error: 'GitLab project ID not set.' });

      const gitlabUrl = (cfg.gitlab_url || 'https://gitlab.com').replace(/\/$/, '');
      const encodedId = encodeURIComponent(cfg.gitlab_project_id);
      const ref       = cfg.gitlab_ref || 'main';

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
        const run = db.prepare('INSERT INTO ci_pipeline_runs (project_id, provider, external_id, web_url, status, script_name, variables, triggered_by) VALUES (?,?,?,?,?,?,?,?)')
          .run(req.params.projectId, 'gitlab', String(r.body.id), r.body.web_url || '', r.body.status || 'pending', script_name, JSON.stringify(variables), req.userId);
        return res.json({ ok: true, run_id: run.lastInsertRowid, external_id: r.body.id, web_url: r.body.web_url, status: r.body.status, message: 'Pipeline triggered on GitLab' });
      }
      return res.status(400).json({ error: `GitLab returned ${r.status}: ${JSON.stringify(r.body)}` });
    }

    // ── GitHub Actions trigger ─────────────────────────────────────────────
    if (provider === 'github') {
      if (!effectiveGithubToken) return res.status(400).json({ error: 'No GitHub token available. Save your Personal Access Token in Git Identity (Configuration → Git).' });
      if (!cfg.github_repo)      return res.status(400).json({ error: 'GitHub repo (owner/repo) not set in CI configuration.' });

      const workflowFile = cfg.github_workflow_file || 'perf-test.yml';
      const ref          = cfg.github_ref || 'main';

      const r = await apiRequest(
        `https://api.github.com/repos/${cfg.github_repo}/actions/workflows/${workflowFile}/dispatches`,
        'POST',
        {
          ref,
          inputs: {
            script_name:     script_name || 'test.jmx',
            script_path:     script_path || '',
            jmeter_users:    String(jmeter_users || 10),
            jmeter_rampup:   String(jmeter_rampup || 30),
            jmeter_loops:    String(jmeter_loops || 1),
            jmeter_duration: String(jmeter_duration || 300),
          },
        },
        {
          Authorization:  `token ${effectiveGithubToken}`,
          'User-Agent':   'PerfStudio',
          Accept:         'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        }
      );

      if (r.status === 204) {
        await new Promise(r => setTimeout(r, 2000));
        const runsResp = await apiRequest(
          `https://api.github.com/repos/${cfg.github_repo}/actions/runs?event=workflow_dispatch&per_page=1`,
          'GET', null,
          { Authorization: `token ${effectiveGithubToken}`, 'User-Agent': 'PerfStudio', Accept: 'application/vnd.github+json' }
        );
        const latestRun = runsResp.body?.workflow_runs?.[0];
        const run = db.prepare('INSERT INTO ci_pipeline_runs (project_id, provider, external_id, web_url, status, script_name, variables, triggered_by) VALUES (?,?,?,?,?,?,?,?)')
          .run(req.params.projectId, 'github', latestRun ? String(latestRun.id) : null, latestRun?.html_url || `https://github.com/${cfg.github_repo}/actions`, latestRun?.status || 'queued', script_name, JSON.stringify(variables), req.userId);
        return res.json({ ok: true, run_id: run.lastInsertRowid, external_id: latestRun?.id, web_url: latestRun?.html_url || `https://github.com/${cfg.github_repo}/actions`, status: latestRun?.status || 'queued', message: 'Workflow dispatched on GitHub Actions' });
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

// ── GET /runs/:runId/status — poll live status from provider ─────────────────
router.get('/runs/:runId/status', async (req, res) => {
  if (!ownsProject(req.userId, req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const run = db.prepare('SELECT * FROM ci_pipeline_runs WHERE id = ? AND project_id = ?').get(req.params.runId, req.params.projectId);
  if (!run) return res.status(404).json({ error: 'Run not found' });

  const cfg = decryptConfig(getConfig(req.params.projectId));
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

  const cfg = decryptConfig(getConfig(req.params.projectId));
  if (!cfg) return res.status(400).json({ error: 'CI configuration not found.' });

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const AdmZip = require('adm-zip');
  const os = require('os');
  const { getUserProjectPath, getCollectionPath } = require('../utils/projectFolders');

  // ── Determine results directory ────────────────────────────────────────────
  // Find test suite by script name to get collection + env
  const callerRole  = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId)?.role;
  const userProjPath = getUserProjectPath(req.userId, callerRole, project.name);

  let resultDir = null;
  if (run.script_name) {
    const scriptFile = run.script_name.replace(/\\/g, '/').split('/').pop();
    const suite = db.prepare(`
      SELECT ts.*, c.name as col_name FROM test_suites ts
      LEFT JOIN collections c ON c.id = ts.collection_id
      WHERE ts.project_id = ?
        AND (ts.jmx_path LIKE ? OR ts.js_path LIKE ?)
      LIMIT 1
    `).get(req.params.projectId, `%${scriptFile}`, `%${scriptFile}`);

    if (suite?.col_name && suite?.env) {
      const envPath = getCollectionPath(userProjPath, suite.col_name, suite.env);
      // Get next run number
      const existing = fs.readdirSync(path.join(envPath, 'results').replace(/\\/g, '/'), { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name.startsWith('Run_'))
        .map(d => parseInt(d.name.replace('Run_', '')) || 0);
      try { fs.mkdirSync(path.join(envPath, 'results'), { recursive: true }); } catch {}
      let dirs = [];
      try { dirs = fs.readdirSync(path.join(envPath, 'results'), { withFileTypes: true }).filter(d => d.isDirectory() && d.name.startsWith('Run_')).map(d => parseInt(d.name.replace('Run_', '')) || 0); } catch {}
      const nextRun = dirs.length ? Math.max(...dirs) + 1 : 1;
      resultDir = path.join(envPath, 'results', `Run_${nextRun}`);
    }
  }

  // Fallback to project-level results
  if (!resultDir) {
    try {
      const dirs = fs.readdirSync(path.join(userProjPath, 'results'), { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name.startsWith('Run_'))
        .map(d => parseInt(d.name.replace('Run_', '')) || 0);
      const next = dirs.length ? Math.max(...dirs) + 1 : 1;
      resultDir = path.join(userProjPath, 'results', `Run_${next}`);
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
    fs.unlinkSync(tmpZip); // clean up temp file

    // ── Create execution_run record so it shows in Run History ───────────────
    const jtlPath = path.join(resultDir, 'results.jtl');
    const htmlPath = path.join(resultDir, 'html', 'index.html');

    // Find matching suite for DB record
    let suiteId = null;
    if (run.script_name) {
      const scriptFile = run.script_name.split('/').pop();
      const suite = db.prepare("SELECT id FROM test_suites WHERE project_id = ? AND (jmx_path LIKE ? OR js_path LIKE ?) LIMIT 1")
        .get(req.params.projectId, `%${scriptFile}`, `%${scriptFile}`);
      suiteId = suite?.id || null;
    }

    db.prepare(`
      INSERT INTO execution_runs
        (project_id, suite_id, engine, status, result_dir, logs, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      req.params.projectId,
      suiteId,
      'jmeter',
      'completed',
      resultDir,
      JSON.stringify([{ type: 'info', message: `Results synced from CI pipeline run #${run.external_id} (${run.provider})` }]),
      run.started_at || new Date().toISOString()
    );

    // Update ci_pipeline_run with result_dir
    db.prepare("UPDATE ci_pipeline_runs SET variables = ? WHERE id = ?")
      .run(JSON.stringify({ ...JSON.parse(run.variables || '{}'), result_dir: resultDir }), run.id);

    res.json({
      ok: true,
      result_dir: resultDir,
      files: fs.readdirSync(resultDir),
      message: `Results saved to ${resultDir.replace(/\\/g, '/')}`,
    });

  } catch (e) {
    try { if (fs.existsSync(tmpZip)) fs.unlinkSync(tmpZip); } catch {}
    res.status(500).json({ error: `Failed to sync results: ${e.message}` });
  }
});

module.exports = router;
