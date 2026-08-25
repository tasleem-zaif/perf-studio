// Disposable full-API coverage sweep against the deployed Peako server.
// Exercises every route module at least once (git/CI/AI real integrations included),
// then a light-concurrency (3 users) pass over safe read/write endpoints.
// Usage: node full-api-sweep.js
'use strict';

const BASE = 'https://peako.qtsolvdev.com';
const CREDS_PATH = process.argv[2];
const { githubPat: GITHUB_PAT, openaiKey: OPENAI_KEY } = JSON.parse(require('fs').readFileSync(CREDS_PATH, 'utf8'));
const REPO_URL = 'https://github.com/tasleemzaif85/Test.git';

const results = [];
function record(group, method, path, status, ms, note) {
  results.push({ group, method, path, status, ms, note: note || '' });
  console.log(`[${group}] ${method} ${path} -> ${status} (${ms}ms) ${note || ''}`);
}

async function call(group, method, path, token, body, isForm) {
  const start = Date.now();
  try {
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    let fetchBody;
    if (isForm) {
      fetchBody = body; // FormData
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      fetchBody = JSON.stringify(body);
    }
    const res = await fetch(BASE + path, { method, headers, body: fetchBody });
    const ms = Date.now() - start;
    let json = null;
    try { json = await res.json(); } catch (_) {}
    record(group, method, path, res.status, ms, json?.error || '');
    return { status: res.status, json, ms };
  } catch (e) {
    const ms = Date.now() - start;
    record(group, method, path, 'ERR', ms, e.message);
    return { status: 'ERR', json: null, ms, error: e.message };
  }
}

async function login(email, password) {
  const r = await call('auth', 'POST', '/api/auth/login', null, { email, password, force: true });
  return r.json?.token;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  console.log('=== Logging in ===');
  const adminToken = await login('benchmark-admin@peako.local', 'Benchmark@123');
  const userToken = await login('benchmark-user@peako.local', 'Benchmark@123');
  const superToken = await login('admin@perfstudio.com', 'Admin@123');
  const PROJECT_ID = 4;

  // Resolve the benchmark org's id dynamically and verify it by name before any
  // super-admin-level write touches it — never trust a hardcoded id here.
  const orgsList = await call('orgs-lookup', 'GET', '/api/orgs', superToken);
  const benchOrg = (orgsList.json?.orgs || []).find(o => o.name === 'Benchmark Org (disposable)');
  if (!benchOrg) throw new Error('Could not find "Benchmark Org (disposable)" via /api/orgs — aborting before any super-admin writes.');
  const BENCH_ORG_ID = benchOrg.id;
  console.log(`Verified benchmark org id = ${BENCH_ORG_ID} (name matched)`);

  // ── GROUP: AI settings + one real smoke-test call ───────────────────────────
  console.log('\n=== AI settings + smoke test ===');
  await call('ai-settings', 'GET', '/api/settings/ai', adminToken);
  await call('ai-settings', 'PUT', '/api/settings/ai', adminToken, {
    provider: 'openai', model: 'gpt-4o-mini', heal_model: 'gpt-4o-mini', api_key: OPENAI_KEY,
  });

  // Create a throwaway collection with one guaranteed-failing endpoint so pre-run/heal has something to fix.
  const badColForm = new FormData();
  badColForm.append('name', 'AI Smoke Test Collection');
  badColForm.append('source_type', 'json');
  badColForm.append('tool_target', 'jmeter');
  badColForm.append('environments', 'Default');
  badColForm.append('json_content', JSON.stringify([
    { name: 'Bad Endpoint', method: 'GET', url: 'https://jsonplaceholder.typicode.com/this-does-not-exist-404', headers: {}, body: '', queryParams: {} },
  ]));
  const badCol = await call('ai-smoke', 'POST', `/api/projects/${PROJECT_ID}/collections`, adminToken, badColForm, true);
  const badColId = badCol.json?.collection?.id;

  if (badColId) {
    const preRun = await call('ai-smoke', 'POST', '/api/ai/pre-run', adminToken, {
      project_id: PROJECT_ID, collection_id: badColId, env: 'Default',
    });
    const healResult = await call('ai-smoke', 'POST', '/api/ai/pre-run/heal', adminToken, {
      project_id: PROJECT_ID, collection_id: badColId, index: 0,
      instruction: 'This endpoint 404s — point it at https://jsonplaceholder.typicode.com/users instead.',
    });
    console.log('AI heal result:', JSON.stringify(healResult.json).slice(0, 300));
  } else {
    record('ai-smoke', 'SKIP', 'pre-run/heal', 'SKIPPED', 0, 'collection creation failed, cannot test heal');
  }

  await call('ai-correlations', 'GET', `/api/ai/correlations?project_id=${PROJECT_ID}&collection_id=6`, adminToken);
  await call('ai-correlations', 'POST', '/api/ai/correlations/manual', adminToken, {
    project_id: PROJECT_ID, collection_id: 6, source_index: 0, target_index: 1,
    source_field: 'id', target_field: 'userId', target_location: 'body',
  });
  await call('ai-correlations', 'POST', '/api/ai/correlations/status', adminToken, {
    project_id: PROJECT_ID, collection_id: 6, index: 0, status: 'confirmed',
  });
  await call('ai-correlations', 'POST', '/api/ai/correlations/delete', adminToken, {
    project_id: PROJECT_ID, collection_id: 6, index: 0,
  });
  await call('ai-generators', 'GET', `/api/ai/generators?project_id=${PROJECT_ID}&collection_id=6`, adminToken);
  await call('ai-generators', 'POST', '/api/ai/generators/manual', adminToken, {
    project_id: PROJECT_ID, collection_id: 6, index: 0, field: 'email', generator: 'uuid',
  });
  await call('ai-generators', 'POST', '/api/ai/generators/delete', adminToken, {
    project_id: PROJECT_ID, collection_id: 6, index: 0, field: 'email',
  });

  // ── GROUP: Git lifecycle (real GitHub PAT) ──────────────────────────────────
  console.log('\n=== Git lifecycle ===');
  await call('git', 'GET', `/api/projects/${PROJECT_ID}/git/config`, adminToken);
  await call('git', 'PUT', `/api/projects/${PROJECT_ID}/git/config`, adminToken, {
    provider: 'github', remote_url: REPO_URL, username: 'benchmark-admin', email: 'benchmark-admin@peako.local',
    auth_token: GITHUB_PAT, auth_method: 'pat', base_branch: 'main',
  });
  await call('git', 'GET', `/api/projects/${PROJECT_ID}/git/identity`, adminToken);
  await call('git', 'PUT', `/api/projects/${PROJECT_ID}/git/identity`, adminToken, {
    author_name: 'Benchmark Admin', author_email: 'benchmark-admin@peako.local', auth_method: 'pat',
  });
  await call('git', 'POST', `/api/projects/${PROJECT_ID}/git/test`, adminToken, {});
  await call('git', 'POST', `/api/projects/${PROJECT_ID}/git/init`, adminToken, {});
  await sleep(2000);
  await call('git', 'GET', `/api/projects/${PROJECT_ID}/git/status`, adminToken);
  await call('git', 'GET', `/api/projects/${PROJECT_ID}/git/diff`, adminToken);
  await call('git', 'POST', `/api/projects/${PROJECT_ID}/git/commit`, adminToken, { message: 'Benchmark sweep: initial commit' });
  await call('git', 'POST', `/api/projects/${PROJECT_ID}/git/push`, adminToken, {});
  await call('git', 'GET', `/api/projects/${PROJECT_ID}/git/branches`, adminToken);
  await call('git', 'GET', `/api/projects/${PROJECT_ID}/git/log`, adminToken);
  await call('git', 'POST', `/api/projects/${PROJECT_ID}/git/branch`, adminToken, { branch_name: 'benchmark-sweep-branch', create: true });
  await call('git', 'POST', `/api/projects/${PROJECT_ID}/git/fetch`, adminToken, {});
  await call('git', 'POST', `/api/projects/${PROJECT_ID}/git/pull`, adminToken, {});
  await call('git', 'POST', `/api/projects/${PROJECT_ID}/git/sync`, adminToken, {});
  await call('git', 'POST', `/api/projects/${PROJECT_ID}/git/discard`, adminToken, {});
  await call('git', 'GET', `/api/projects/${PROJECT_ID}/git/prs`, adminToken);
  const pr = await call('git', 'POST', `/api/projects/${PROJECT_ID}/git/prs`, adminToken, {
    title: 'Benchmark sweep PR', head: 'benchmark-sweep-branch', base: 'main', body: 'Disposable PR from API coverage sweep.',
  });
  const prId = pr.json?.pr?.id || pr.json?.id;
  if (prId) {
    await call('git', 'PUT', `/api/projects/${PROJECT_ID}/git/prs/${prId}/merge`, adminToken, {});
    await call('git', 'PUT', `/api/projects/${PROJECT_ID}/git/prs/${prId}/mark-merged`, adminToken, {});
  } else {
    record('git', 'SKIP', 'prs/:id/merge,close,push-close,mark-merged', 'SKIPPED', 0, 'no PR id returned');
  }
  await call('git', 'POST', `/api/projects/${PROJECT_ID}/git/prs/sync`, adminToken, {});
  await call('git', 'POST', `/api/projects/${PROJECT_ID}/git/exec`, adminToken, { command: 'status' });

  // ── GROUP: CI pipeline (real trigger) ───────────────────────────────────────
  console.log('\n=== CI pipeline ===');
  await call('ci', 'GET', `/api/projects/${PROJECT_ID}/ci/config`, adminToken);
  await call('ci', 'PUT', `/api/projects/${PROJECT_ID}/ci/config`, adminToken, {
    provider: 'github', repo_url: REPO_URL, auth_token: GITHUB_PAT, workflow_file: 'peako-run.yml', branch: 'main',
  });
  await call('ci', 'POST', `/api/projects/${PROJECT_ID}/ci/config/test`, adminToken, {});
  await call('ci', 'POST', `/api/projects/${PROJECT_ID}/ci/config/trigger-token`, adminToken, {});
  await call('ci', 'POST', `/api/projects/${PROJECT_ID}/ci/generate-yaml`, adminToken, { test_suite_id: 6 });

  // Generate the actual JMX for our test suite so a real trigger has something to run.
  await call('testsuite-generate', 'POST', `/api/projects/${PROJECT_ID}/test-suites/6/generate`, adminToken, {});

  const trigger = await call('ci', 'POST', `/api/projects/${PROJECT_ID}/ci/trigger`, adminToken, { test_suite_id: 6 });
  const runId = trigger.json?.run?.id || trigger.json?.run_id;
  await call('ci', 'GET', `/api/projects/${PROJECT_ID}/ci/runs`, adminToken);

  if (runId) {
    console.log(`CI run triggered: ${runId}. Polling up to ~3 minutes...`);
    let done = false;
    for (let i = 0; i < 18 && !done; i++) {
      await sleep(10000);
      const status = await call('ci', 'GET', `/api/projects/${PROJECT_ID}/ci/runs/${runId}/status`, adminToken);
      const st = status.json?.status || status.json?.run?.status;
      console.log(`  poll ${i + 1}: status=${st}`);
      if (st && ['passed', 'failed', 'completed', 'error', 'success'].includes(String(st).toLowerCase())) done = true;
    }
    await call('ci', 'GET', `/api/projects/${PROJECT_ID}/ci/runs/${runId}/steps`, adminToken);
    await call('ci', 'POST', `/api/projects/${PROJECT_ID}/ci/runs/${runId}/sync-results`, adminToken, {});
    await call('ci', 'POST', `/api/projects/${PROJECT_ID}/ci/runs/${runId}/heal`, adminToken, {});
    await call('ci', 'GET', `/api/projects/${PROJECT_ID}/ci/runs/${runId}/heal-status`, adminToken);
  } else {
    record('ci', 'SKIP', 'runs/:id/*', 'SKIPPED', 0, 'no run id returned from trigger');
  }

  // ── GROUP: Trend analysis (real data if CI run produced it) ─────────────────
  console.log('\n=== Trend analysis ===');
  for (const ep of ['runs', 'runs/filter-options', 'apis', 'trend', 'scores', 'insights', 'rca',
                     'recommendations', 'ai-summary', 'capacity-planning', 'forecast']) {
    await call('trend', 'GET', `/api/projects/${PROJECT_ID}/trend-analysis/${ep}`, adminToken);
  }
  await call('trend', 'GET', `/api/projects/${PROJECT_ID}/trend-analysis/export-pdf`, adminToken);

  // ── GROUP: Execution / pipelines / runner (mostly retired, confirm 410) ─────
  console.log('\n=== Execution / pipelines / runner (expect mostly 410) ===');
  await call('execution', 'POST', `/api/execution/run`, adminToken, { test_suite_id: 6 });
  await call('pipelines', 'GET', `/api/projects/${PROJECT_ID}/pipelines`, adminToken);
  await call('runner', 'POST', `/api/runner/execute`, adminToken, { test_suite_id: 6 });

  // ── GROUP: Broad safe sweep — throwaway extra fixtures for write/delete coverage ──
  console.log('\n=== Broad safe sweep (throwaway fixtures + 3-user concurrency) ===');

  // extra disposable project for delete-testing
  const extraProj = await call('projects', 'POST', '/api/projects', adminToken, { name: 'Sweep Throwaway Project', description: 'delete-test only' });
  const extraProjId = extraProj.json?.project?.id;
  await call('projects', 'PUT', `/api/projects/${extraProjId}`, adminToken, { name: 'Sweep Throwaway Project (renamed)' });
  await call('projects', 'POST', `/api/projects/${extraProjId}/ensure-folders`, adminToken, {});
  await call('projects', 'GET', '/api/projects/backups', adminToken);
  await call('projects', 'GET', `/api/projects/${extraProjId}/registry-token`, adminToken);

  // rules extra + update + delete
  const extraRule = await call('rules', 'POST', `/api/projects/${PROJECT_ID}/rules`, adminToken, { metric: 'p95', operator: '<', value: '500', unit: 'ms', severity: 'warn' });
  const extraRuleId = extraRule.json?.rule?.id;
  await call('rules', 'PUT', `/api/projects/${PROJECT_ID}/rules/${extraRuleId}`, adminToken, { metric: 'p95', operator: '<', value: '600', unit: 'ms', severity: 'warn' });
  await call('rules', 'DELETE', `/api/projects/${PROJECT_ID}/rules/${extraRuleId}`, adminToken);

  // scripts CRUD
  const script = await call('scripts', 'POST', `/api/projects/${PROJECT_ID}/scripts`, adminToken, { name: 'Sweep Script', type: 'K6', target: 'https://jsonplaceholder.typicode.com' });
  const scriptId = script.json?.script?.id;
  await call('scripts', 'GET', `/api/projects/${PROJECT_ID}/scripts`, adminToken);
  await call('scripts', 'PUT', `/api/projects/${PROJECT_ID}/scripts/${scriptId}`, adminToken, { name: 'Sweep Script (renamed)' });
  await call('scripts', 'DELETE', `/api/projects/${PROJECT_ID}/scripts/${scriptId}`, adminToken);

  // test-suites extra + generate + download + delete
  const extraSuite = await call('test-suites', 'POST', `/api/projects/${PROJECT_ID}/test-suites`, adminToken, { name: 'Sweep Suite', test_type: 'load', collection_id: 6, env: 'Default', engine: 'k6', vusers: 5, rampup: 5, duration: 30 });
  const extraSuiteId = extraSuite.json?.suite?.id;
  await call('test-suites', 'GET', `/api/projects/${PROJECT_ID}/test-suites`, adminToken);
  await call('test-suites', 'PUT', `/api/projects/${PROJECT_ID}/test-suites/${extraSuiteId}`, adminToken, { name: 'Sweep Suite (renamed)' });
  await call('test-suites', 'POST', `/api/projects/${PROJECT_ID}/test-suites/${extraSuiteId}/generate`, adminToken, {});
  await call('test-suites', 'GET', `/api/projects/${PROJECT_ID}/test-suites/${extraSuiteId}/download/k6`, adminToken);
  await call('test-suites', 'DELETE', `/api/projects/${PROJECT_ID}/test-suites/${extraSuiteId}`, adminToken);

  // testData CRUD
  const csvForm = new FormData();
  csvForm.append('name', 'Sweep Test Data');
  csvForm.append('csv', new Blob(['id,name\n1,foo\n2,bar\n'], { type: 'text/csv' }), 'sweep.csv');
  const td = await call('test-data', 'POST', `/api/projects/${PROJECT_ID}/test-data`, adminToken, csvForm, true);
  const tdId = td.json?.testData?.id || td.json?.data?.id;
  await call('test-data', 'GET', `/api/projects/${PROJECT_ID}/test-data`, adminToken);
  if (tdId) {
    await call('test-data', 'GET', `/api/projects/${PROJECT_ID}/test-data/${tdId}/content`, adminToken);
    await call('test-data', 'PUT', `/api/projects/${PROJECT_ID}/test-data/${tdId}/content`, adminToken, { content: 'id,name\n1,foo\n2,baz\n' });
    await call('test-data', 'POST', `/api/projects/${PROJECT_ID}/test-data/${tdId}/open-external`, adminToken, {});
    await call('test-data', 'DELETE', `/api/projects/${PROJECT_ID}/test-data/${tdId}`, adminToken);
  }

  // config / envConfig / projectConfig
  await call('config', 'GET', '/api/config', adminToken);
  await call('config', 'PUT', '/api/config', adminToken, { threads: 10 });
  await call('project-config', 'GET', `/api/projects/${PROJECT_ID}/config`, adminToken);
  await call('project-config', 'PUT', `/api/projects/${PROJECT_ID}/config`, adminToken, { urls: {} });
  await call('env-config', 'GET', `/api/projects/${PROJECT_ID}/collections/6/env-config/Default`, adminToken);
  await call('env-config', 'PUT', `/api/projects/${PROJECT_ID}/collections/6/env-config/Default`, adminToken, { variables: {} });

  // summary.js alt views
  await call('summary', 'GET', '/api/collections', adminToken);
  await call('summary', 'GET', '/api/rules', adminToken);
  await call('summary', 'GET', '/api/test-plans', adminToken);
  await call('summary', 'GET', '/api/test-data', adminToken);

  // licenses
  await call('licenses', 'GET', '/api/licenses/plans', adminToken);
  await call('licenses', 'GET', '/api/licenses/mine', adminToken);
  await call('licenses', 'GET', '/api/licenses', superToken);
  await call('licenses', 'GET', `/api/licenses/${BENCH_ORG_ID}`, superToken);
  await call('licenses', 'PUT', `/api/licenses/${BENCH_ORG_ID}`, superToken, { plan: 'trial', max_users: 10, max_projects: 10 });
  await call('licenses', 'PUT', `/api/licenses/${BENCH_ORG_ID}/status`, superToken, { status: 'active' });

  // alerts
  await call('alerts', 'GET', '/api/alerts/config', adminToken);
  await call('alerts', 'PUT', '/api/alerts/config', adminToken, { smtp_host: '', from_email: '' });
  await call('alerts', 'POST', '/api/alerts/test-smtp', adminToken, {});
  await call('alerts', 'POST', '/api/alerts/send-test', adminToken, {});
  await call('alerts', 'GET', '/api/alerts/recipients', adminToken);
  const recip = await call('alerts', 'POST', '/api/alerts/recipients', adminToken, { email: 'sweep-recipient@peako.local' });
  const recipId = recip.json?.recipient?.id;
  if (recipId) await call('alerts', 'DELETE', `/api/alerts/recipients/${recipId}`, adminToken);
  await call('alerts', 'GET', `/api/alerts/projects/${PROJECT_ID}/recipients`, adminToken);
  const projRecip = await call('alerts', 'POST', `/api/alerts/projects/${PROJECT_ID}/recipients`, adminToken, { email: 'sweep-proj-recipient@peako.local' });
  const projRecipId = projRecip.json?.recipient?.id;
  if (projRecipId) await call('alerts', 'DELETE', `/api/alerts/projects/${PROJECT_ID}/recipients/${projRecipId}`, adminToken);

  // invites remaining
  await call('invites', 'GET', '/api/invites', adminToken);
  const extraInvite = await call('invites', 'POST', '/api/invites', adminToken, { email: 'sweep-throwaway@peako.local', name: 'Sweep Throwaway', role: 'user' });
  const inviteToken = extraInvite.json?.invite_url?.split('/').pop();
  if (inviteToken) await call('invites', 'GET', `/api/invites/validate/${inviteToken}`, null);
  const inviteId = extraInvite.json?.id;
  await call('invites', 'GET', '/api/invites/org-users', adminToken);
  if (inviteId) await call('invites', 'DELETE', `/api/invites/${inviteId}`, adminToken);

  // orgs
  await call('orgs', 'GET', '/api/orgs', adminToken);
  await call('orgs', 'GET', '/api/orgs/managed', superToken);
  await call('orgs', 'GET', `/api/orgs/${BENCH_ORG_ID}/admins`, superToken);
  await call('orgs', 'GET', `/api/orgs/${BENCH_ORG_ID}/npm-token`, superToken);
  await call('orgs', 'POST', `/api/orgs/${BENCH_ORG_ID}/npm-token`, superToken, {});
  await call('orgs', 'PUT', `/api/orgs/${BENCH_ORG_ID}`, superToken, { description: 'updated by sweep' });
  const extraOrg = await call('orgs', 'POST', '/api/orgs', superToken, { name: 'Sweep Delete-Test Org', plan: 'trial' });
  const extraOrgId = extraOrg.json?.org?.id;
  if (extraOrgId) {
    await call('orgs', 'DELETE', `/api/orgs/${extraOrgId}/npm-token`, superToken);
    await call('orgs', 'DELETE', `/api/orgs/${extraOrgId}`, superToken);
  }

  // admin.js
  await call('admin', 'GET', '/api/admin/users', superToken);
  await call('admin', 'PUT', '/api/admin/users/7/status', superToken, { status: 'active' });

  // password reset
  await call('password-reset', 'POST', '/api/auth/forgot-password', null, { email: 'benchmark-admin@peako.local' });
  await call('password-reset', 'POST', `/api/admin/users/7/reset-password`, superToken, {});

  // Now delete the extra throwaway project (last, since delete is destructive)
  if (extraProjId) await call('projects', 'DELETE', `/api/projects/${extraProjId}`, adminToken);

  // ── 3-concurrent-user light pass over the core read endpoints ───────────────
  console.log('\n=== 3-user concurrent read pass ===');
  const readPaths = [
    '/api/auth/me', '/api/dashboard/stats', '/api/projects',
    `/api/projects/${PROJECT_ID}/collections`, `/api/projects/${PROJECT_ID}/rules`,
    `/api/projects/${PROJECT_ID}/test-suites`, `/api/projects/${PROJECT_ID}/config`,
    `/api/projects/${PROJECT_ID}/trend-analysis/runs`, '/api/health',
  ];
  const tokens = [adminToken, userToken, adminToken];
  await Promise.all(tokens.map(async (tok, i) => {
    for (const p of readPaths) {
      await call('concurrent-read', 'GET', p, tok, undefined);
    }
  }));

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log('\n=== SUMMARY ===');
  const byGroup = {};
  for (const r of results) {
    byGroup[r.group] = byGroup[r.group] || { total: 0, ok: 0, fail: 0, skip: 0 };
    byGroup[r.group].total++;
    if (r.status === 'SKIPPED') byGroup[r.group].skip++;
    else if (typeof r.status === 'number' && r.status < 400) byGroup[r.group].ok++;
    else byGroup[r.group].fail++;
  }
  for (const [g, s] of Object.entries(byGroup)) {
    console.log(`${g}: ${s.total} calls, ${s.ok} ok, ${s.fail} non-2xx/err, ${s.skip} skipped`);
  }
  console.log('\nTotal calls:', results.length);
  console.log('\n=== FULL RESULTS JSON ===');
  console.log(JSON.stringify(results, null, 2));
})().catch(e => { console.error('FATAL', e); process.exit(1); });
