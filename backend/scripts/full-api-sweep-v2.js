// v2 disposable full-API coverage sweep — fresh org, fixes every gap found in v1:
// correct CI config field names, license limits raised before use, regular-user
// script generation + real PR flow, proper params for diff/discard/correlations/
// generators, undefined-id guards, and two real CI runs for multi-run trend endpoints.
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
  if (typeof path === 'string' && path.includes('/undefined')) {
    record(group, method, path, 'SKIPPED', 0, 'guard: an id in this path was undefined, not calling');
    return { status: 'SKIPPED', json: null, ms: 0 };
  }
  const start = Date.now();
  try {
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    let fetchBody;
    if (isForm) fetchBody = body;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; fetchBody = JSON.stringify(body); }
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
  console.log('=== Fresh org + users ===');
  const superToken = await login('admin@perfstudio.com', 'Admin@123');

  const org = await call('org-create', 'POST', '/api/orgs', superToken, {
    name: 'Benchmark Org 2 (disposable)', plan: 'trial',
    admin_email: 'benchmark2-admin@peako.local',
  });
  const ORG_ID = org.json?.org?.id;
  if (!ORG_ID) throw new Error('Org creation failed, aborting: ' + JSON.stringify(org.json));
  console.log('Created org', ORG_ID);

  // Raise license limits FIRST — v1's bug was doing this too late, causing project_limit_reached.
  await call('licenses', 'PUT', `/api/licenses/${ORG_ID}`, superToken, { plan: 'trial', max_users: 10, max_projects: 10 });
  await call('licenses', 'PUT', `/api/licenses/${ORG_ID}/status`, superToken, { status: 'active' });

  const adminInviteUrl = org.json?.invite?.invite_url;
  const adminToken_accept = adminInviteUrl ? await call('invites', 'POST', `/api/invites/accept/${adminInviteUrl.split('/').pop()}`, null, { name: 'Benchmark2 Admin', password: 'Benchmark2@123' }) : null;
  const adminToken = await login('benchmark2-admin@peako.local', 'Benchmark2@123');

  const userInvite = await call('invites', 'POST', '/api/invites', adminToken, { email: 'benchmark2-user@peako.local', name: 'Benchmark2 User', role: 'user' });
  const userInviteToken = userInvite.json?.invite_url?.split('/').pop();
  if (userInviteToken) await call('invites', 'POST', `/api/invites/accept/${userInviteToken}`, null, { name: 'Benchmark2 User', password: 'Benchmark2@123' });
  const userToken = await login('benchmark2-user@peako.local', 'Benchmark2@123');

  const proj = await call('projects', 'POST', '/api/projects', adminToken, { name: 'Sweep2 Project', description: 'v2 full-API sweep' });
  const PROJECT_ID = proj.json?.project?.id;
  console.log('Created project', PROJECT_ID);

  await call('invites', 'PUT', `/api/invites/assign/${userInvite.json ? (await call('admin', 'GET', '/api/admin/users', adminToken)).json?.users?.find(u => u.email === 'benchmark2-user@peako.local')?.id : ''}`, adminToken, { project_ids: [PROJECT_ID] });

  const colForm = new FormData();
  colForm.append('name', 'Sweep2 Collection');
  colForm.append('description', 'real file upload');
  colForm.append('source_type', 'postman');
  colForm.append('tool_target', 'jmeter');
  colForm.append('environments', 'Default');
  colForm.append('file', new Blob([JSON.stringify({
    info: { name: 'Sweep2', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [
      { name: 'Get Users', request: { method: 'GET', header: [], url: { raw: 'https://jsonplaceholder.typicode.com/users', host: ['jsonplaceholder', 'typicode', 'com'], path: ['users'] } } },
      { name: 'Get Posts', request: { method: 'GET', header: [], url: { raw: 'https://jsonplaceholder.typicode.com/posts', host: ['jsonplaceholder', 'typicode', 'com'], path: ['posts'] } } },
    ],
  })], { type: 'application/json' }), 'sweep2.json');
  const col = await call('collections', 'POST', `/api/projects/${PROJECT_ID}/collections`, adminToken, colForm, true);
  const COLLECTION_ID = col.json?.collection?.id;

  const rule1 = await call('rules', 'POST', `/api/projects/${PROJECT_ID}/rules`, adminToken, { metric: 'avg_response_time', operator: '<', value: '2000', unit: 'ms', severity: 'warn' });
  await call('rules', 'POST', `/api/projects/${PROJECT_ID}/rules`, adminToken, { metric: 'error_rate', operator: '<', value: '5', unit: '%', severity: 'warn' });

  const suite = await call('test-suites', 'POST', `/api/projects/${PROJECT_ID}/test-suites`, adminToken, {
    name: 'Sweep2 Suite', test_type: 'load', collection_id: COLLECTION_ID, env: 'Default', engine: 'jmeter', vusers: 2, rampup: 2, duration: 15,
  });
  const SUITE_ID = suite.json?.suite?.id;
  console.log(`Collection ${COLLECTION_ID}, Suite ${SUITE_ID}`);

  // ── AI settings + smoke test ─────────────────────────────────────────────────
  console.log('\n=== AI settings + smoke test ===');
  await call('ai-settings', 'GET', '/api/settings/ai', adminToken);
  await call('ai-settings', 'PUT', '/api/settings/ai', adminToken, { provider: 'openai', model: 'gpt-4o-mini', heal_model: 'gpt-4o-mini', api_key: OPENAI_KEY });

  const badColForm = new FormData();
  badColForm.append('name', 'AI Smoke Test Collection');
  badColForm.append('source_type', 'json');
  badColForm.append('tool_target', 'jmeter');
  badColForm.append('environments', 'Default');
  badColForm.append('json_content', JSON.stringify([{ name: 'Bad Endpoint', method: 'GET', url: 'https://jsonplaceholder.typicode.com/this-does-not-exist-404', headers: {}, body: '', queryParams: {} }]));
  const badCol = await call('ai-smoke', 'POST', `/api/projects/${PROJECT_ID}/collections`, adminToken, badColForm, true);
  const badColId = badCol.json?.collection?.id;
  if (badColId) {
    await call('ai-smoke', 'POST', '/api/ai/pre-run', adminToken, { project_id: PROJECT_ID, collection_id: badColId, env: 'Default' });
    const heal = await call('ai-smoke', 'POST', '/api/ai/pre-run/heal', adminToken, {
      project_id: PROJECT_ID, collection_id: badColId, index: 0,
      instruction: 'This endpoint 404s — point it at https://jsonplaceholder.typicode.com/users instead.',
    });
    console.log('AI heal result:', JSON.stringify(heal.json).slice(0, 300));
  }

  // Correlations/generators with FULL required fields this time, capturing real ids.
  const corrManual = await call('ai-correlations', 'POST', '/api/ai/correlations/manual', adminToken, {
    project_id: PROJECT_ID, collection_id: COLLECTION_ID,
    sourceEndpointIndex: 0, sourceJsonPath: '$[0].id',
    targetEndpointIndex: [1], targetLocation: 'body', targetKey: 'userId',
  });
  await call('ai-correlations', 'GET', `/api/ai/correlations?project_id=${PROJECT_ID}&collection_id=${COLLECTION_ID}`, adminToken);
  const corrId = corrManual.json?.rule?.id ?? corrManual.json?.id ?? 0;
  await call('ai-correlations', 'POST', '/api/ai/correlations/status', adminToken, { project_id: PROJECT_ID, collection_id: COLLECTION_ID, id: corrId, status: 'confirmed' });
  await call('ai-correlations', 'POST', '/api/ai/correlations/delete', adminToken, { project_id: PROJECT_ID, collection_id: COLLECTION_ID, id: corrId });

  const genManual = await call('ai-generators', 'POST', '/api/ai/generators/manual', adminToken, {
    project_id: PROJECT_ID, collection_id: COLLECTION_ID, targetEndpointIndex: 0, targetLocation: 'body', targetKey: 'email', value: '', generator: 'uuid',
  });
  await call('ai-generators', 'GET', `/api/ai/generators?project_id=${PROJECT_ID}&collection_id=${COLLECTION_ID}`, adminToken);
  const genId = genManual.json?.rule?.id ?? genManual.json?.id ?? 0;
  await call('ai-generators', 'POST', '/api/ai/generators/delete', adminToken, { project_id: PROJECT_ID, collection_id: COLLECTION_ID, id: genId });

  // ── Git: admin does init + push to main ──────────────────────────────────────
  console.log('\n=== Git — admin init/push to main ===');
  await call('git', 'GET', `/api/projects/${PROJECT_ID}/git/config`, adminToken);
  await call('git', 'PUT', `/api/projects/${PROJECT_ID}/git/config`, adminToken, {
    provider: 'github', remote_url: REPO_URL, username: 'benchmark2-admin', email: 'benchmark2-admin@peako.local',
    auth_token: GITHUB_PAT, auth_method: 'pat', base_branch: 'main',
  });
  await call('git', 'PUT', `/api/projects/${PROJECT_ID}/git/identity`, adminToken, { author_name: 'Benchmark2 Admin', author_email: 'benchmark2-admin@peako.local', auth_method: 'pat', auth_token: GITHUB_PAT });
  await call('git', 'POST', `/api/projects/${PROJECT_ID}/git/test`, adminToken, {});
  await call('git', 'POST', `/api/projects/${PROJECT_ID}/git/init`, adminToken, {});
  await sleep(2000);
  await call('git', 'GET', `/api/projects/${PROJECT_ID}/git/status`, adminToken);
  await call('git', 'POST', `/api/projects/${PROJECT_ID}/git/commit`, adminToken, { message: 'v2 sweep: initial commit' });
  await call('git', 'POST', `/api/projects/${PROJECT_ID}/git/push`, adminToken, {});
  await call('git', 'GET', `/api/projects/${PROJECT_ID}/git/branches`, adminToken);
  await call('git', 'GET', `/api/projects/${PROJECT_ID}/git/log`, adminToken);
  await call('git', 'POST', `/api/projects/${PROJECT_ID}/git/fetch`, adminToken, {});
  await call('git', 'POST', `/api/projects/${PROJECT_ID}/git/sync`, adminToken, {});
  await call('git', 'POST', `/api/projects/${PROJECT_ID}/git/exec`, adminToken, { command: 'status' });

  // ── Regular user: identity, script generation, branch/commit/push, PR ───────
  console.log('\n=== Git — regular user script-gen + PR flow ===');
  await call('git', 'PUT', `/api/projects/${PROJECT_ID}/git/identity`, userToken, { author_name: 'Benchmark2 User', author_email: 'benchmark2-user@peako.local', auth_method: 'pat', auth_token: GITHUB_PAT });
  const gen = await call('test-suites', 'POST', `/api/projects/${PROJECT_ID}/test-suites/${SUITE_ID}/generate`, userToken, {});
  console.log('Script generation as regular user:', JSON.stringify(gen.json).slice(0, 200));
  await call('test-suites', 'GET', `/api/projects/${PROJECT_ID}/test-suites/${SUITE_ID}/download/jmeter`, userToken);

  await call('git', 'POST', `/api/projects/${PROJECT_ID}/git/branch`, userToken, { branch_name: 'users/benchmark2-user', create: true });
  await sleep(1000);
  await call('git', 'GET', `/api/projects/${PROJECT_ID}/git/status`, userToken);
  const diffStatus = await call('git', 'GET', `/api/projects/${PROJECT_ID}/git/status`, userToken);
  const changedFile = diffStatus.json?.status?.modified?.[0] || diffStatus.json?.status?.not_added?.[0] || diffStatus.json?.modified?.[0];
  if (changedFile) await call('git', 'GET', `/api/projects/${PROJECT_ID}/git/diff?path=${encodeURIComponent(changedFile)}`, userToken);
  await call('git', 'POST', `/api/projects/${PROJECT_ID}/git/commit`, userToken, { message: 'v2 sweep: generated script' });
  await call('git', 'POST', `/api/projects/${PROJECT_ID}/git/push`, userToken, {});
  await call('git', 'POST', `/api/projects/${PROJECT_ID}/git/discard`, userToken, { paths: [] });
  await call('git', 'POST', `/api/projects/${PROJECT_ID}/git/pull`, userToken, {});

  const pr = await call('git', 'POST', `/api/projects/${PROJECT_ID}/git/prs`, userToken, { title: 'v2 sweep PR', head: 'users/benchmark2-user', base: 'main', body: 'Disposable PR from v2 API coverage sweep.' });
  const prId = pr.json?.pr?.id ?? pr.json?.id;
  await call('git', 'GET', `/api/projects/${PROJECT_ID}/git/prs`, adminToken);
  if (prId) {
    await call('git', 'PUT', `/api/projects/${PROJECT_ID}/git/prs/${prId}/merge`, adminToken, {});
    await call('git', 'PUT', `/api/projects/${PROJECT_ID}/git/prs/${prId}/mark-merged`, adminToken, {});
  } else {
    record('git', 'SKIP', 'prs/:id/merge,mark-merged', 'SKIPPED', 0, 'no PR id returned');
  }
  await call('git', 'POST', `/api/projects/${PROJECT_ID}/git/prs/sync`, adminToken, {});

  // Also exercise close/push-close on a second throwaway branch+PR (never merged).
  await call('git', 'POST', `/api/projects/${PROJECT_ID}/git/branch`, userToken, { branch_name: 'users/benchmark2-user-throwaway', create: true });
  await call('git', 'POST', `/api/projects/${PROJECT_ID}/git/push`, userToken, {});
  const pr2 = await call('git', 'POST', `/api/projects/${PROJECT_ID}/git/prs`, userToken, { title: 'v2 sweep throwaway PR', head: 'users/benchmark2-user-throwaway', base: 'main', body: 'to be closed, not merged' });
  const pr2Id = pr2.json?.pr?.id ?? pr2.json?.id;
  if (pr2Id) {
    await call('git', 'PUT', `/api/projects/${PROJECT_ID}/git/prs/${pr2Id}/close`, adminToken, {});
    await call('git', 'PUT', `/api/projects/${PROJECT_ID}/git/prs/${pr2Id}/push-close`, adminToken, {});
  } else {
    record('git', 'SKIP', 'prs/:id/close,push-close', 'SKIPPED', 0, 'no PR id returned for throwaway PR');
  }

  // ── CI: correct field names this time, two real runs for multi-run trend endpoints ──
  console.log('\n=== CI pipeline (real trigger, correct fields) ===');
  await call('ci', 'GET', `/api/projects/${PROJECT_ID}/ci/config`, userToken);
  await call('ci', 'PUT', `/api/projects/${PROJECT_ID}/ci/config`, userToken, {
    github_enabled: true, github_repo: 'tasleemzaif85/Test', github_token: GITHUB_PAT,
    github_workflow_file: 'peako-run.yml', github_ref: 'main', github_auth_method: 'pat',
  });
  await call('ci', 'POST', `/api/projects/${PROJECT_ID}/ci/config/test`, userToken, { provider: 'github' });
  await call('ci', 'POST', `/api/projects/${PROJECT_ID}/ci/generate-yaml`, userToken, { test_suite_id: SUITE_ID, provider: 'github' });

  const runIds = [];
  for (let n = 0; n < 2; n++) {
    const trigger = await call('ci', 'POST', `/api/projects/${PROJECT_ID}/ci/trigger`, userToken, {
      provider: 'github', jmeter_users: 2, jmeter_rampup: 2, jmeter_loops: 1, jmeter_duration: 15,
    });
    const runId = trigger.json?.run?.id || trigger.json?.run_id || trigger.json?.id;
    if (runId) { runIds.push(runId); console.log(`Triggered run #${n + 1}: ${runId}`); }
    else { record('ci', 'SKIP', `trigger#${n}`, 'SKIPPED', 0, 'no run id returned: ' + JSON.stringify(trigger.json)); }
    await sleep(3000);
  }
  await call('ci', 'GET', `/api/projects/${PROJECT_ID}/ci/runs`, userToken);

  for (const runId of runIds) {
    let done = false;
    for (let i = 0; i < 20 && !done; i++) {
      await sleep(10000);
      const status = await call('ci', 'GET', `/api/projects/${PROJECT_ID}/ci/runs/${runId}/status`, userToken);
      const st = String(status.json?.status || status.json?.run?.status || '').toLowerCase();
      console.log(`  run ${runId} poll ${i + 1}: status=${st}`);
      if (['passed', 'failed', 'completed', 'error', 'success'].includes(st)) done = true;
    }
    await call('ci', 'GET', `/api/projects/${PROJECT_ID}/ci/runs/${runId}/steps`, userToken);
    await call('ci', 'POST', `/api/projects/${PROJECT_ID}/ci/runs/${runId}/sync-results`, userToken, {});
  }
  if (runIds[0]) {
    await call('ci', 'POST', `/api/projects/${PROJECT_ID}/ci/runs/${runIds[0]}/heal`, userToken, {});
    await call('ci', 'GET', `/api/projects/${PROJECT_ID}/ci/runs/${runIds[0]}/heal-status`, userToken);
  }

  // ── Trend analysis with real run_ids ─────────────────────────────────────────
  console.log('\n=== Trend analysis (real run_ids) ===');
  await call('trend', 'GET', `/api/projects/${PROJECT_ID}/trend-analysis/runs`, adminToken);
  await call('trend', 'GET', `/api/projects/${PROJECT_ID}/trend-analysis/runs/filter-options`, adminToken);
  await call('trend', 'GET', `/api/projects/${PROJECT_ID}/trend-analysis/insights`, adminToken);
  const runIdsParam = runIds.join(',');
  if (runIds.length) {
    await call('trend', 'GET', `/api/projects/${PROJECT_ID}/trend-analysis/apis?run_ids=${runIdsParam}`, adminToken);
    await call('trend', 'GET', `/api/projects/${PROJECT_ID}/trend-analysis/capacity-planning?run_id=${runIds[0]}`, adminToken);
  }
  if (runIds.length >= 2) {
    await call('trend', 'GET', `/api/projects/${PROJECT_ID}/trend-analysis/trend?run_ids=${runIdsParam}`, adminToken);
    await call('trend', 'GET', `/api/projects/${PROJECT_ID}/trend-analysis/scores?run_ids=${runIdsParam}`, adminToken);
    await call('trend', 'GET', `/api/projects/${PROJECT_ID}/trend-analysis/rca?run_ids=${runIdsParam}`, adminToken);
    await call('trend', 'GET', `/api/projects/${PROJECT_ID}/trend-analysis/recommendations?run_ids=${runIdsParam}`, adminToken);
    await call('trend', 'GET', `/api/projects/${PROJECT_ID}/trend-analysis/ai-summary?run_ids=${runIdsParam}`, adminToken);
    await call('trend', 'GET', `/api/projects/${PROJECT_ID}/trend-analysis/forecast?run_ids=${runIdsParam}`, adminToken);
    await call('trend', 'GET', `/api/projects/${PROJECT_ID}/trend-analysis/export-pdf?run_ids=${runIdsParam}`, adminToken);
  } else {
    record('trend', 'SKIP', 'multi-run endpoints', 'SKIPPED', 0, `only ${runIds.length} real run(s) available, need 2`);
  }

  // ── Execution / pipelines / runner ───────────────────────────────────────────
  console.log('\n=== Execution / pipelines / runner ===');
  await call('execution', 'POST', `/api/execution/run`, adminToken, { test_suite_id: SUITE_ID });
  await call('pipelines', 'GET', `/api/projects/${PROJECT_ID}/pipelines`, adminToken);
  await call('runner', 'POST', `/api/runner/execute`, adminToken, { engine: 'k6', test_suite_id: SUITE_ID });

  // ── Broad safe sweep — throwaway fixtures, limits already raised ────────────
  console.log('\n=== Broad safe sweep ===');
  const extraProj = await call('projects', 'POST', '/api/projects', adminToken, { name: 'Sweep2 Throwaway Project' });
  const extraProjId = extraProj.json?.project?.id;
  if (extraProjId) {
    await call('projects', 'PUT', `/api/projects/${extraProjId}`, adminToken, { name: 'Sweep2 Throwaway Project (renamed)' });
    await call('projects', 'POST', `/api/projects/${extraProjId}/ensure-folders`, adminToken, {});
    await call('projects', 'GET', `/api/projects/${extraProjId}/registry-token`, adminToken);
  }
  await call('projects', 'GET', '/api/projects/backups', adminToken);

  const extraRule = await call('rules', 'PUT', `/api/projects/${PROJECT_ID}/rules/${rule1.json?.rule?.id}`, adminToken, { metric: 'avg_response_time', operator: '<', value: '2500', unit: 'ms', severity: 'warn' });
  await call('rules', 'DELETE', `/api/projects/${PROJECT_ID}/rules/${rule1.json?.rule?.id}`, adminToken);

  const script = await call('scripts', 'POST', `/api/projects/${PROJECT_ID}/scripts`, adminToken, { name: 'Sweep2 Script', type: 'K6', target: 'https://jsonplaceholder.typicode.com' });
  const scriptId = script.json?.script?.id;
  await call('scripts', 'GET', `/api/projects/${PROJECT_ID}/scripts`, adminToken);
  if (scriptId) {
    await call('scripts', 'PUT', `/api/projects/${PROJECT_ID}/scripts/${scriptId}`, adminToken, { name: 'Sweep2 Script (renamed)' });
    await call('scripts', 'DELETE', `/api/projects/${PROJECT_ID}/scripts/${scriptId}`, adminToken);
  }

  const csvForm = new FormData();
  csvForm.append('name', 'Sweep2 Test Data');
  csvForm.append('csv', new Blob(['id,name\n1,foo\n2,bar\n'], { type: 'text/csv' }), 'sweep2.csv');
  const td = await call('test-data', 'POST', `/api/projects/${PROJECT_ID}/test-data`, adminToken, csvForm, true);
  const tdId = td.json?.testData?.id || td.json?.data?.id;
  await call('test-data', 'GET', `/api/projects/${PROJECT_ID}/test-data`, adminToken);
  if (tdId) {
    await call('test-data', 'GET', `/api/projects/${PROJECT_ID}/test-data/${tdId}/content`, adminToken);
    await call('test-data', 'PUT', `/api/projects/${PROJECT_ID}/test-data/${tdId}/content`, adminToken, { content: 'id,name\n1,foo\n2,baz\n' });
    await call('test-data', 'POST', `/api/projects/${PROJECT_ID}/test-data/${tdId}/open-external`, adminToken, {});
    await call('test-data', 'DELETE', `/api/projects/${PROJECT_ID}/test-data/${tdId}`, adminToken);
  }

  await call('config', 'GET', '/api/config', adminToken);
  await call('config', 'PUT', '/api/config', adminToken, { threads: 10 });
  await call('project-config', 'GET', `/api/projects/${PROJECT_ID}/config`, adminToken);
  await call('project-config', 'PUT', `/api/projects/${PROJECT_ID}/config`, adminToken, { urls: {} });
  await call('env-config', 'GET', `/api/projects/${PROJECT_ID}/collections/${COLLECTION_ID}/env-config/Default`, adminToken);
  await call('env-config', 'PUT', `/api/projects/${PROJECT_ID}/collections/${COLLECTION_ID}/env-config/Default`, adminToken, { variables: {} });

  await call('summary', 'GET', '/api/collections', adminToken);
  await call('summary', 'GET', '/api/rules', adminToken);
  await call('summary', 'GET', '/api/test-plans', adminToken);
  await call('summary', 'GET', '/api/test-data', adminToken);

  await call('licenses', 'GET', '/api/licenses/plans', adminToken);
  await call('licenses', 'GET', '/api/licenses/mine', adminToken);
  await call('licenses', 'GET', '/api/licenses', superToken);
  await call('licenses', 'GET', `/api/licenses/${ORG_ID}`, superToken);

  await call('alerts', 'GET', '/api/alerts/config', adminToken);
  await call('alerts', 'PUT', '/api/alerts/config', adminToken, { smtp_host: '', from_email: '' });
  await call('alerts', 'POST', '/api/alerts/test-smtp', adminToken, {});
  await call('alerts', 'POST', '/api/alerts/send-test', adminToken, {});
  await call('alerts', 'GET', '/api/alerts/recipients', adminToken);
  const recip = await call('alerts', 'POST', '/api/alerts/recipients', adminToken, { email: 'sweep2-recipient@peako.local' });
  const recipId = recip.json?.recipient?.id;
  if (recipId) await call('alerts', 'DELETE', `/api/alerts/recipients/${recipId}`, adminToken);
  await call('alerts', 'GET', `/api/alerts/projects/${PROJECT_ID}/recipients`, adminToken);
  const projRecip = await call('alerts', 'POST', `/api/alerts/projects/${PROJECT_ID}/recipients`, adminToken, { email: 'sweep2-proj-recipient@peako.local' });
  const projRecipId = projRecip.json?.recipient?.id;
  if (projRecipId) await call('alerts', 'DELETE', `/api/alerts/projects/${PROJECT_ID}/recipients/${projRecipId}`, adminToken);

  await call('invites', 'GET', '/api/invites', adminToken);
  await call('invites', 'GET', '/api/invites/org-users', adminToken);
  if (userInviteToken) await call('invites', 'GET', `/api/invites/validate/${userInviteToken}`, null);

  await call('orgs', 'GET', '/api/orgs', adminToken);
  await call('orgs', 'GET', '/api/orgs/managed', superToken);
  await call('orgs', 'GET', `/api/orgs/${ORG_ID}/admins`, superToken);
  await call('orgs', 'GET', `/api/orgs/${ORG_ID}/npm-token`, superToken);
  await call('orgs', 'POST', `/api/orgs/${ORG_ID}/npm-token`, superToken, {});
  await call('orgs', 'PUT', `/api/orgs/${ORG_ID}`, superToken, { name: 'Benchmark Org 2 (disposable)', description: 'updated by v2 sweep' });

  const usersList = await call('admin', 'GET', '/api/admin/users', superToken);
  const userId2 = usersList.json?.users?.find(u => u.email === 'benchmark2-user@peako.local')?.id;
  if (userId2) await call('admin', 'PUT', `/api/admin/users/${userId2}/status`, superToken, { status: 'active' });

  await call('password-reset', 'POST', '/api/auth/forgot-password', null, { email: 'benchmark2-admin@peako.local' });
  if (userId2) await call('password-reset', 'POST', `/api/admin/users/${userId2}/reset-password`, superToken, { new_password: 'ResetByV2Sweep123' });

  if (extraProjId) await call('projects', 'DELETE', `/api/projects/${extraProjId}`, adminToken);

  // ── 3-user concurrent read pass ──────────────────────────────────────────────
  console.log('\n=== 3-user concurrent read pass ===');
  const readPaths = [
    '/api/auth/me', '/api/dashboard/stats', '/api/projects',
    `/api/projects/${PROJECT_ID}/collections`, `/api/projects/${PROJECT_ID}/rules`,
    `/api/projects/${PROJECT_ID}/test-suites`, `/api/projects/${PROJECT_ID}/config`,
    `/api/projects/${PROJECT_ID}/trend-analysis/runs`, '/api/health',
  ];
  const toks = [adminToken, userToken, adminToken];
  await Promise.all(toks.map(async (tok) => { for (const p of readPaths) await call('concurrent-read', 'GET', p, tok); }));

  console.log('\n=== SUMMARY ===');
  const byGroup = {};
  for (const r of results) {
    byGroup[r.group] = byGroup[r.group] || { total: 0, ok: 0, fail: 0, skip: 0 };
    byGroup[r.group].total++;
    if (r.status === 'SKIPPED') byGroup[r.group].skip++;
    else if (typeof r.status === 'number' && r.status < 400) byGroup[r.group].ok++;
    else byGroup[r.group].fail++;
  }
  for (const [g, s] of Object.entries(byGroup)) console.log(`${g}: ${s.total} calls, ${s.ok} ok, ${s.fail} non-2xx/err, ${s.skip} skipped`);
  console.log('\nTotal calls:', results.length);
  console.log('RUN_IDS_CAPTURED:', JSON.stringify(runIds));
  console.log('\n=== FULL RESULTS JSON ===');
  console.log(JSON.stringify(results, null, 2));
})().catch(e => { console.error('FATAL', e); console.log('\n=== PARTIAL RESULTS JSON ==='); console.log(JSON.stringify(results, null, 2)); process.exit(1); });
