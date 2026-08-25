const test = require('node:test');
const assert = require('node:assert/strict');

const { parseK6Content, parseK6Metrics, parseK6MetricsFromContent } = require('./parseK6');
const { parseJtlContent } = require('./parseJtl');

// Hand-built k6 `--out json=` NDJSON fixture: 4 requests to /login (1 failed with 500) and
// 4 requests to /profile (all succeed), plus data_sent/data_received/vus samples interleaved
// the way a real k6 run would emit them (Metric-definition lines are ignored by the parser,
// so none are included here — only Point samples matter).
function k6Line(metric, time, value, tags) {
  return JSON.stringify({ type: 'Point', metric, data: { time, value, tags } });
}

function buildFixture() {
  const lines = [];
  const t = s => new Date(1700000000000 + s * 1000).toISOString();

  // /login — 2 requests: 1 success (200), 1 failure (500)
  lines.push(k6Line('http_req_duration', t(0), 120, { name: '/login', method: 'POST', status: '200', expected_response: 'true' }));
  lines.push(k6Line('http_req_duration', t(1), 340, { name: '/login', method: 'POST', status: '500', expected_response: 'false' }));

  // /profile — 2 requests, both success
  lines.push(k6Line('http_req_duration', t(0), 80,  { name: '/profile', method: 'GET', status: '200', expected_response: 'true' }));
  lines.push(k6Line('http_req_duration', t(1), 100, { name: '/profile', method: 'GET', status: '200', expected_response: 'true' }));

  lines.push(k6Line('data_sent',     t(0), 512,  {}));
  lines.push(k6Line('data_received', t(0), 2048, {}));
  lines.push(k6Line('vus',           t(0), 5,    {}));
  lines.push(k6Line('vus',           t(1), 5,    {}));

  return lines.join('\n');
}

// Equivalent JMeter JTL for the same logical data, to prove shape parity.
function buildJtlFixture() {
  const header = 'timeStamp,elapsed,label,responseCode,responseMessage,threadName,dataType,success,failureMessage,bytes,sentBytes,grpThreads,allThreads,URL,Latency,IdleTime,Connect';
  const rows = [
    '1700000000000,120,/login,200,OK,t1,text,true,,0,0,5,5,,120,0,0',
    '1700000001000,340,/login,500,Error,t1,text,false,boom,0,0,5,5,,340,0,0',
    '1700000000000,80,/profile,200,OK,t1,text,true,,0,0,5,5,,80,0,0',
    '1700000001000,100,/profile,200,OK,t1,text,true,,0,0,5,5,,100,0,0',
  ];
  return [header, ...rows].join('\n');
}

test('parseK6Content returns null for empty/missing content', () => {
  assert.equal(parseK6Content(''), null);
  assert.equal(parseK6Content(null), null);
});

test('parseK6Content returns null when there are no http_req_duration samples', () => {
  const onlyMeta = [k6Line('vus', new Date().toISOString(), 1, {})].join('\n');
  assert.equal(parseK6Content(onlyMeta), null);
});

test('parseK6Content produces the same shape as parseJtlContent for equivalent data', () => {
  const k6Result  = parseK6Content(buildFixture(), {});
  const jtlResult = parseJtlContent(buildJtlFixture(), {});

  for (const shape of [k6Result, jtlResult]) {
    assert.ok(shape.meta);
    assert.ok(shape.summary);
    assert.ok(Array.isArray(shape.by_api));
    assert.ok(Array.isArray(shape.timeline));
    assert.ok(Array.isArray(shape.errors));
  }

  assert.equal(k6Result.summary.total_requests, jtlResult.summary.total_requests);
  assert.equal(k6Result.summary.total_success,  jtlResult.summary.total_success);
  assert.equal(k6Result.summary.total_failed,   jtlResult.summary.total_failed);
  assert.equal(k6Result.summary.error_rate,     jtlResult.summary.error_rate);

  assert.equal(k6Result.by_api.length, jtlResult.by_api.length);
  const k6Login  = k6Result.by_api.find(a => a.label === '/login');
  const jtlLogin = jtlResult.by_api.find(a => a.label === '/login');
  assert.equal(k6Login.total,  jtlLogin.total);
  assert.equal(k6Login.failed, jtlLogin.failed);
  assert.equal(k6Login.error_rate, jtlLogin.error_rate);

  assert.equal(k6Result.errors.length, jtlResult.errors.length);
  assert.equal(k6Result.errors[0].response_code, '500');
});

test('parseK6Content sums data_sent/data_received into aggregate summary bytes only', () => {
  const result = parseK6Content(buildFixture(), {});
  assert.equal(result.summary.total_bytes_sent, 512);
  assert.equal(result.summary.total_bytes_received, 2048);
  // Per-endpoint byte breakdown is deliberately not attempted (unreliable tagging across k6 versions)
  assert.equal(result.by_api[0].avg_bytes, 0);
});

test('parseK6Content buckets vus samples into timeline threads', () => {
  const result = parseK6Content(buildFixture(), {});
  const bucket0 = result.timeline.find(t => t.second === 0);
  assert.equal(bucket0.threads, 5);
});

test('parseK6Metrics/parseK6MetricsFromContent produce the ruleEvaluator-compatible metrics shape', () => {
  const metrics = parseK6MetricsFromContent(buildFixture());
  assert.equal(metrics.total, 4);
  assert.equal(metrics.pass, 3);
  assert.equal(metrics.fail, 1);
  assert.equal(metrics.error_rate, 25);
  assert.ok(metrics.avg_response_time > 0);
  assert.ok('p90' in metrics && 'p95' in metrics && 'throughput' in metrics);
});

test('parseK6Metrics returns null for a nonexistent file', () => {
  assert.equal(parseK6Metrics('/no/such/results.json'), null);
});
