'use strict';
const fs = require('fs');

// Mirrors parseJtl.js's shape exactly — { meta, summary, by_api, timeline, errors } — so every
// downstream consumer (Analytics, PDF, Trend Analysis) works unmodified regardless of engine.
//
// Built from k6's `--out json=<file>` NDJSON output: each line is either a Metric definition or
// a Point sample like { type:'Point', metric:'http_req_duration', data:{ time, value, tags:{...} } }.
// `http_req_duration` Points are the per-request record — tags.name/status/expected_response map
// onto JMeter's label/responseCode/success. k6 has no per-request analog of JMeter's separate
// Latency/Connect/bytes columns, so latency reuses elapsed, connect is 0, and bytes are only
// summed in aggregate (data_sent/data_received are not reliably tagged per-endpoint across k6
// versions, so no per-`by_api` byte breakdown is attempted).

function pct(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

function parseNdjson(content) {
  const out = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip malformed line */ }
  }
  return out;
}

/**
 * Parse a k6 `--out json=` results file and return the full report-data object:
 * { meta, summary, by_api, timeline, errors }
 * Returns null if the file doesn't exist or has no http_req_duration samples.
 */
function parseK6(resultsJsonPath, runMeta = {}) {
  if (!fs.existsSync(resultsJsonPath)) return null;
  const content = fs.readFileSync(resultsJsonPath, 'utf8');
  return parseK6Content(content, runMeta);
}

/**
 * Same as parseK6, but takes already-fetched NDJSON text directly (e.g. read from S3 via
 * resultsStore.readText()) instead of a local file path.
 */
function parseK6Content(content, runMeta = {}) {
  if (!content) return null;
  const points = parseNdjson(content);
  if (!points.length) return null;

  const byLabel = {};
  let minTs = Infinity, maxTs = -Infinity;
  let bytesSent = 0, bytesReceived = 0;
  const vusByBucket = {}; // populated once minTs is known, see second pass below

  const durationPoints = [];
  const vusPoints = [];

  for (const p of points) {
    if (p.type !== 'Point' || !p.data) continue;
    const ts = Date.parse(p.data.time) || 0;
    if (p.metric === 'http_req_duration') {
      durationPoints.push({ ts, value: p.data.value, tags: p.data.tags || {} });
      if (ts < minTs) minTs = ts;
      if (ts > maxTs) maxTs = ts;
    } else if (p.metric === 'data_sent') {
      bytesSent += p.data.value || 0;
    } else if (p.metric === 'data_received') {
      bytesReceived += p.data.value || 0;
    } else if (p.metric === 'vus') {
      vusPoints.push({ ts, value: p.data.value });
    }
  }

  if (!durationPoints.length) return null;

  for (const dp of durationPoints) {
    const label   = dp.tags.name || 'Unknown';
    const success = dp.tags.expected_response === 'true';
    const code    = dp.tags.status || 'unknown';

    if (!byLabel[label]) byLabel[label] = {
      elapsed: [], timestamps: [], success: 0, failed: 0,
      responseCodes: {}, failMessages: {},
    };
    const d = byLabel[label];
    d.elapsed.push(dp.value);
    d.timestamps.push(dp.ts);
    if (success) {
      d.success++;
    } else {
      d.failed++;
      d.responseCodes[code] = (d.responseCodes[code] || 0) + 1;
    }
  }

  const totalDuration = minTs < maxTs ? (maxTs - minTs) / 1000 : 1;

  if (!runMeta.started_at  && minTs < Infinity) runMeta.started_at  = new Date(minTs).toISOString();
  if (!runMeta.finished_at && maxTs > -Infinity) runMeta.finished_at = new Date(maxTs).toISOString();
  if (!runMeta.duration_s)  runMeta.duration_s = Math.round(totalDuration);

  const by_api = Object.entries(byLabel).map(([label, d]) => {
    const total  = d.elapsed.length;
    const sum    = d.elapsed.reduce((a, b) => a + b, 0);
    return {
      label, total, success: d.success, failed: d.failed,
      error_rate: parseFloat(((d.failed / total) * 100).toFixed(2)),
      avg:    parseFloat((sum / total).toFixed(1)),
      min:    d.elapsed.reduce((a, b) => Math.min(a, b), Infinity) || 0,
      max:    d.elapsed.reduce((a, b) => Math.max(a, b), 0),
      median: pct(d.elapsed, 50),
      p90:    pct(d.elapsed, 90),
      p95:    pct(d.elapsed, 95),
      tps:    parseFloat((total / totalDuration).toFixed(3)),
      avg_latency: parseFloat((sum / total).toFixed(1)), // no separate latency metric in k6 — approximate as elapsed
      avg_connect: 0,                                    // no connect-time analog in k6
      avg_bytes:   0,                                    // per-endpoint byte breakdown not reliable across k6 versions
      response_codes: d.responseCodes,
      fail_messages:  d.failMessages,
    };
  });

  const totalReqs  = durationPoints.length;
  const totalSucc  = durationPoints.filter(dp => dp.tags.expected_response === 'true').length;
  const totalFail  = totalReqs - totalSucc;
  const allElapsed = durationPoints.map(dp => dp.value);
  const elapsedSum = allElapsed.reduce((a, b) => a + b, 0);

  const summary = {
    total_requests:      totalReqs,
    total_success:       totalSucc,
    total_failed:        totalFail,
    error_rate:          parseFloat(((totalFail / totalReqs) * 100).toFixed(2)),
    avg_response_time:   parseFloat((elapsedSum / (totalReqs || 1)).toFixed(1)),
    overall_tps:         parseFloat((totalReqs / totalDuration).toFixed(3)),
    p90:                 pct(allElapsed, 90),
    p95:                 pct(allElapsed, 95),
    min_response_time:   allElapsed.reduce((a, b) => Math.min(a, b), Infinity) || 0,
    max_response_time:   allElapsed.reduce((a, b) => Math.max(a, b), 0),
    avg_latency:         parseFloat((elapsedSum / (totalReqs || 1)).toFixed(1)),
    avg_connect:         0,
    total_bytes_received: bytesReceived,
    total_bytes_sent:     bytesSent,
  };

  const timelineMap = {};
  for (const dp of durationPoints) {
    const sec = Math.floor((dp.ts - minTs) / 1000);
    if (!timelineMap[sec]) timelineMap[sec] = { count: 0, elapsed: [], errors: 0 };
    const t = timelineMap[sec];
    t.count++;
    t.elapsed.push(dp.value);
    if (dp.tags.expected_response !== 'true') t.errors++;
  }
  for (const vp of vusPoints) {
    const sec = Math.floor((vp.ts - minTs) / 1000);
    if (!timelineMap[sec]) continue; // only bucket VUs into seconds that actually had requests
    vusByBucket[sec] = Math.max(vusByBucket[sec] || 0, vp.value || 0);
  }
  const timeline = Object.entries(timelineMap)
    .sort(([a], [b]) => parseInt(a) - parseInt(b))
    .map(([sec, d]) => ({
      second:       parseInt(sec),
      tps:          d.count,
      avg_rt:       parseFloat((d.elapsed.reduce((a, b) => a + b, 0) / d.elapsed.length).toFixed(1)),
      avg_latency:  parseFloat((d.elapsed.reduce((a, b) => a + b, 0) / d.elapsed.length).toFixed(1)),
      avg_connect:  0,
      bytes_received: 0,
      bytes_sent:     0,
      threads:        vusByBucket[sec] || 0,
      errors:         d.errors,
      error_rate:     parseFloat(((d.errors / d.count) * 100).toFixed(1)),
    }));

  const errorMap = {};
  for (const dp of durationPoints) {
    if (dp.tags.expected_response === 'true') continue;
    const label = dp.tags.name || 'Unknown';
    const code  = dp.tags.status || 'N/A';
    const key   = `${label}||${code}||`;
    if (!errorMap[key]) errorMap[key] = {
      label, response_code: code, response_message: '', failure_message: '', count: 0,
    };
    errorMap[key].count++;
  }
  const errors = Object.values(errorMap).sort((a, b) => b.count - a.count);

  return { meta: runMeta, summary, by_api, timeline, errors };
}

/**
 * Lightweight metrics-only parse for rule evaluation — mirrors ruleEvaluator.js's
 * parseJtlMetrics/parseJtlMetricsFromContent shape without building the full report.
 * Returns { total, pass, fail, error_rate, avg_response_time, p90, p95, throughput }.
 */
function parseK6Metrics(resultsJsonPath) {
  if (!resultsJsonPath || !fs.existsSync(resultsJsonPath)) return null;
  return parseK6MetricsFromContent(fs.readFileSync(resultsJsonPath, 'utf8'));
}

function parseK6MetricsFromContent(content) {
  if (!content) return null;
  const points = parseNdjson(content);
  if (!points.length) return null;

  const elapsed = [];
  let pass = 0, fail = 0, minTs = Infinity, maxTs = -Infinity;

  for (const p of points) {
    if (p.type !== 'Point' || p.metric !== 'http_req_duration' || !p.data) continue;
    const ts = Date.parse(p.data.time) || 0;
    const ok = (p.data.tags || {}).expected_response === 'true';
    elapsed.push(p.data.value);
    ok ? pass++ : fail++;
    if (ts < minTs) minTs = ts;
    if (ts > maxTs) maxTs = ts;
  }

  if (!elapsed.length) return null;

  const total       = elapsed.length;
  const sorted      = [...elapsed].sort((a, b) => a - b);
  const pctOf       = p => sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
  const avgRt       = elapsed.reduce((a, b) => a + b, 0) / total;
  const durationSec = minTs < maxTs ? (maxTs - minTs) / 1000 : 1;

  return {
    total,
    pass,
    fail,
    error_rate:        (fail / total) * 100,
    avg_response_time: avgRt,
    p90:               pctOf(90),
    p95:               pctOf(95),
    throughput:        total / durationSec,
  };
}

module.exports = { parseK6, parseK6Content, parseK6Metrics, parseK6MetricsFromContent };
