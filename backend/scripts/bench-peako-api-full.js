// Ramp benchmark against the deployed Peako server, using a broad set of real,
// confirmed-working GET endpoints (not just the original 9 dashboard reads) —
// spans auth, dashboard, projects, collections, rules, test-suites, config,
// trend-analysis, summary, licenses, alerts, invites, orgs, scripts, test-data,
// git, and ci. Same 5->15->30->50 concurrency profile as the original benchmark.
const autocannon = require('autocannon');

const TOKEN = process.argv[2];
if (!TOKEN) { console.error('Usage: node bench-peako-api-full.js <JWT_TOKEN>'); process.exit(1); }

const BASE = 'https://peako.qtsolvdev.com';
const PROJECT_ID = 5;
const COLLECTION_ID = 9;

const paths = [
  '/api/auth/me',
  '/api/dashboard/stats',
  '/api/projects',
  `/api/projects/${PROJECT_ID}/collections`,
  `/api/projects/${PROJECT_ID}/rules`,
  `/api/projects/${PROJECT_ID}/test-suites`,
  `/api/projects/${PROJECT_ID}/config`,
  `/api/projects/${PROJECT_ID}/trend-analysis/runs`,
  `/api/projects/${PROJECT_ID}/trend-analysis/runs/filter-options`,
  `/api/projects/${PROJECT_ID}/trend-analysis/insights`,
  '/api/collections',
  '/api/rules',
  '/api/test-plans',
  '/api/test-data',
  '/api/licenses/plans',
  '/api/licenses/mine',
  '/api/alerts/config',
  '/api/alerts/recipients',
  `/api/alerts/projects/${PROJECT_ID}/recipients`,
  '/api/invites',
  '/api/invites/org-users',
  '/api/orgs',
  `/api/projects/${PROJECT_ID}/scripts`,
  `/api/projects/${PROJECT_ID}/test-data`,
  `/api/projects/${PROJECT_ID}/git/config`,
  `/api/projects/${PROJECT_ID}/git/status`,
  `/api/projects/${PROJECT_ID}/git/branches`,
  `/api/projects/${PROJECT_ID}/git/log`,
  `/api/projects/${PROJECT_ID}/git/prs`,
  `/api/projects/${PROJECT_ID}/ci/config`,
  `/api/projects/${PROJECT_ID}/ci/runs`,
  `/api/projects/${PROJECT_ID}/collections/${COLLECTION_ID}/env-config/Default`,
  '/api/health',
];

const requests = paths.map(p => ({
  method: 'GET',
  path: p,
  headers: { Authorization: `Bearer ${TOKEN}` },
}));

const STAGES = [
  { connections: 5, duration: 90 },
  { connections: 15, duration: 90 },
  { connections: 30, duration: 90 },
  { connections: 50, duration: 120 },
];

async function runStage(stage) {
  console.log(`\n=== Stage: ${stage.connections} concurrent users, ${stage.duration}s, ${paths.length} distinct endpoints ===`);
  const result = await autocannon({
    url: BASE,
    connections: stage.connections,
    duration: stage.duration,
    requests,
  });
  const perConnRps = result.requests.average / stage.connections;
  console.log(JSON.stringify({
    connections: stage.connections,
    totalRequests: result.requests.total,
    avgRps: result.requests.average,
    rpsPerUser: Number(perConnRps.toFixed(3)),
    latencyAvgMs: result.latency.average,
    latencyP50Ms: result.latency.p50,
    latencyP95Ms: result.latency.p97_5,
    latencyP99Ms: result.latency.p99,
    errors: result.errors,
    non2xx: result.non2xx,
  }, null, 2));
  return { stage, result };
}

(async () => {
  const all = [];
  for (const stage of STAGES) all.push(await runStage(stage));
  console.log('\n=== SUMMARY ===');
  for (const { stage, result } of all) {
    console.log(
      `${stage.connections} users: avg ${result.latency.average}ms, p95 ${result.latency.p97_5}ms, p99 ${result.latency.p99}ms, ` +
      `${result.requests.average} req/s total (${(result.requests.average / stage.connections).toFixed(2)} req/s/user), ` +
      `errors=${result.errors} non2xx=${result.non2xx}`
    );
  }
})();
