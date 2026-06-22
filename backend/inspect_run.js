'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const db = new DatabaseSync(path.join(__dirname, 'data', 'peako.db'));
const run = db.prepare('SELECT id, started_at, finished_at, report_data FROM execution_runs WHERE ci_run_id IS NOT NULL ORDER BY id DESC LIMIT 1').get();
console.log('ID:', run.id, '| started_at:', run.started_at, '| finished_at:', run.finished_at);
if (run.report_data) {
  const rd = JSON.parse(run.report_data);
  console.log('meta:', JSON.stringify(rd.meta));
  const tl = rd.timeline || [];
  const seconds = tl.map(t => t.second);
  console.log('timeline.length:', tl.length, '| min_second:', Math.min(...seconds), '| max_second:', Math.max(...seconds));
  console.log('errors.length:', (rd.errors || []).length);
  // Simulate what generateAnalyticsPdf.js does
  function safeN(v) { const n = Number(v); return isNaN(n) || !isFinite(n) ? 0 : n; }
  const tlLastSec = tl.length ? Math.max(...tl.map(t => safeN(t.second))) : 0;
  const effectiveDurS = safeN(rd.meta.duration_s) || (tlLastSec > 0 ? tlLastSec + 1 : 0);
  const effectiveFinAt = rd.meta.finished_at ||
    (rd.meta.started_at && effectiveDurS > 0 ? new Date(new Date(rd.meta.started_at).getTime() + effectiveDurS * 1000).toISOString() : null);
  console.log('effectiveDurS:', effectiveDurS, '| effectiveFinAt:', effectiveFinAt);
  console.log('durS display:', effectiveDurS.toFixed(1) + 's');
  console.log('finAt display:', effectiveFinAt ? new Date(effectiveFinAt).toLocaleString() : '—');
} else {
  console.log('NO report_data');
}
db.close();
