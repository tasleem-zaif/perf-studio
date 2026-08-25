// Disposable benchmark script — hits real Peako API endpoints on a seeded
// benchmark org/project to answer "avg API response time" / "RPS per user".
// Not part of the app; run manually with:
//   node scripts/bench-peako-api.js <BASE_URL> <PROJECT_ID> <TOKEN>
const autocannon = require('autocannon');

const BASE_URL = process.argv[2];
const PROJECT_ID = process.argv[3];
const TOKEN = process.argv[4];
if (!BASE_URL || !PROJECT_ID || !TOKEN) {
  console.error('Usage: node bench-peako-api.js <BASE_URL> <PROJECT_ID> <JWT_TOKEN>');
  process.exit(1);
}

// Representative "browsing a project" session — the endpoints a real user's
// dashboard/session actually calls, weighted toward the ones hit most often.
const paths = [
  '/api/auth/me',
  '/api/dashboard/stats',
  '/api/projects',
  `/api/projects/${PROJECT_ID}/collections`,
  `/api/projects/${PROJECT_ID}/rules`,
  `/api/projects/${PROJECT_ID}/test-suites`,
  `/api/projects/${PROJECT_ID}/config`,
  `/api/projects/${PROJECT_ID}/trend-analysis/runs`,
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
  console.log(`\n=== Stage: ${stage.connections} concurrent users, ${stage.duration}s ===`);
  const result = await autocannon({
    url: BASE_URL,
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
  for (const stage of STAGES) {
    all.push(await runStage(stage));
  }
  console.log('\n=== SUMMARY ===');
  for (const { stage, result } of all) {
    console.log(
      `${stage.connections} users: avg ${result.latency.average}ms, p95 ${result.latency.p97_5}ms, ` +
      `${result.requests.average} req/s total (${(result.requests.average / stage.connections).toFixed(2)} req/s/user), ` +
      `errors=${result.errors} non2xx=${result.non2xx}`
    );
  }
})();
