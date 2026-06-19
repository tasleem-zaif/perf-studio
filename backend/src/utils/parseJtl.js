'use strict';
const fs = require('fs');

// Normalize JMeter's inconsistent column capitalisation
const HEADER_NORM = { Latency: 'latency', Connect: 'connect', Bytes: 'bytes', SentBytes: 'sentBytes' };

function pct(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

/**
 * Parse a JTL CSV file and return the full report-data object:
 * { meta, summary, by_api, timeline, errors }
 * Returns null if the file doesn't exist or has no data rows.
 */
function parseJtl(jtlPath, runMeta = {}) {
  if (!fs.existsSync(jtlPath)) return null;
  const content = fs.readFileSync(jtlPath, 'utf8');
  const lines   = content.trim().split('\n').filter(Boolean);
  if (lines.length < 2) return null;

  const headers = lines[0].split(',').map(h => {
    const clean = h.trim().replace(/^"|"$/g, '');
    return HEADER_NORM[clean] || clean;
  });

  function parseRow(line) {
    const parts = line.split(',');
    const row = {};
    headers.forEach((h, i) => { row[h] = (parts[i] || '').replace(/^"|"$/g, '').trim(); });
    return row;
  }

  const byLabel = {};
  let minTs = Infinity, maxTs = -Infinity;

  for (let i = 1; i < lines.length; i++) {
    const row     = parseRow(lines[i]);
    const ts      = parseInt(row.timeStamp) || 0;
    const elapsed = parseInt(row.elapsed)   || 0;
    const success = row.success === 'true';
    const label   = row.label || 'Unknown';

    if (ts < minTs) minTs = ts;
    if (ts + elapsed > maxTs) maxTs = ts + elapsed;

    if (!byLabel[label]) byLabel[label] = {
      elapsed: [], timestamps: [], latency: [], connect: [],
      bytes: [], sentBytes: [], success: 0, failed: 0,
      responseCodes: {}, failMessages: {},
    };
    const d = byLabel[label];
    d.elapsed.push(elapsed);
    d.timestamps.push(ts);
    d.latency.push(parseInt(row.latency) || 0);
    d.connect.push(parseInt(row.connect) || 0);
    d.bytes.push(parseInt(row.bytes) || 0);
    d.sentBytes.push(parseInt(row.sentBytes) || 0);
    if (success) {
      d.success++;
    } else {
      d.failed++;
      const code = row.responseCode || 'unknown';
      const msg  = row.failureMessage || row.responseMessage || '';
      d.responseCodes[code] = (d.responseCodes[code] || 0) + 1;
      if (msg) d.failMessages[msg] = (d.failMessages[msg] || 0) + 1;
    }
  }

  const totalDuration = minTs < maxTs ? (maxTs - minTs) / 1000 : 1;

  const by_api = Object.entries(byLabel).map(([label, d]) => {
    const total    = d.elapsed.length;
    const sum      = d.elapsed.reduce((a, b) => a + b, 0);
    const latSum   = d.latency.reduce((a, b) => a + b, 0);
    const connSum  = d.connect.reduce((a, b) => a + b, 0);
    const bytesSum = d.bytes.reduce((a, b) => a + b, 0);
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
      avg_latency: parseFloat((latSum  / total).toFixed(1)),
      avg_connect: parseFloat((connSum / total).toFixed(1)),
      avg_bytes:   parseFloat((bytesSum / total).toFixed(0)),
      response_codes: d.responseCodes,
      fail_messages:  d.failMessages,
    };
  });

  // Re-parse all rows for summary + timeline
  const allRows = [];
  for (let i = 1; i < lines.length; i++) allRows.push(parseRow(lines[i]));

  const totalReqs  = allRows.length;
  const totalSucc  = allRows.filter(r => r.success === 'true').length;
  const totalFail  = totalReqs - totalSucc;
  const allElapsed = allRows.map(r => parseInt(r.elapsed)   || 0);
  const allLatency = allRows.map(r => parseInt(r.latency)   || 0);
  const allConnect = allRows.map(r => parseInt(r.connect)   || 0);
  const allBytes   = allRows.map(r => parseInt(r.bytes)     || 0);
  const allSentB   = allRows.map(r => parseInt(r.sentBytes) || 0);
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
    avg_latency:         parseFloat((allLatency.reduce((a, b) => a + b, 0) / (totalReqs || 1)).toFixed(1)),
    avg_connect:         parseFloat((allConnect.reduce((a, b) => a + b, 0) / (totalReqs || 1)).toFixed(1)),
    total_bytes_received: allBytes.reduce((a, b) => a + b, 0),
    total_bytes_sent:     allSentB.reduce((a, b) => a + b, 0),
  };

  const timelineMap = {};
  for (const row of allRows) {
    const ts  = parseInt(row.timeStamp) || 0;
    const sec = Math.floor((ts - minTs) / 1000);
    if (!timelineMap[sec]) timelineMap[sec] = { count: 0, elapsed: [], latency: [], connect: [], bytes: 0, sentBytes: 0, threads: [], errors: 0 };
    const t = timelineMap[sec];
    t.count++;
    t.elapsed.push(parseInt(row.elapsed)  || 0);
    t.latency.push(parseInt(row.latency)  || 0);
    t.connect.push(parseInt(row.connect)  || 0);
    t.bytes     += parseInt(row.bytes)     || 0;
    t.sentBytes += parseInt(row.sentBytes) || 0;
    t.threads.push(parseInt(row.allThreads) || 0);
    if (row.success !== 'true') t.errors++;
  }
  const timeline = Object.entries(timelineMap)
    .sort(([a], [b]) => parseInt(a) - parseInt(b))
    .map(([sec, d]) => ({
      second:       parseInt(sec),
      tps:          d.count,
      avg_rt:       parseFloat((d.elapsed.reduce((a, b) => a + b, 0) / d.elapsed.length).toFixed(1)),
      avg_latency:  parseFloat((d.latency.reduce((a, b) => a + b, 0) / d.latency.length).toFixed(1)),
      avg_connect:  parseFloat((d.connect.reduce((a, b) => a + b, 0) / d.connect.length).toFixed(1)),
      bytes_received: d.bytes,
      bytes_sent:     d.sentBytes,
      threads:        Math.max(...d.threads),
      errors:         d.errors,
      error_rate:     parseFloat(((d.errors / d.count) * 100).toFixed(1)),
    }));

  const errorMap = {};
  for (const row of allRows) {
    if (row.success === 'true') continue;
    const key = `${row.label}||${row.responseCode || 'N/A'}||${row.responseMessage || ''}`;
    if (!errorMap[key]) errorMap[key] = {
      label:            row.label || 'Unknown',
      response_code:    row.responseCode    || 'N/A',
      response_message: (row.responseMessage  || '').slice(0, 120),
      failure_message:  (row.failureMessage   || '').slice(0, 200),
      count: 0,
    };
    errorMap[key].count++;
  }
  const errors = Object.values(errorMap).sort((a, b) => b.count - a.count);

  return {
    meta:     runMeta,
    summary,
    by_api,
    timeline,
    errors,
  };
}

module.exports = { parseJtl };
