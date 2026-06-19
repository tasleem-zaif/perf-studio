'use strict';
const fs        = require('fs');
const path      = require('path');
const puppeteer = require('puppeteer');

// inline Chart.js UMD so the HTML has zero external dependencies
// Try backend node_modules first (Docker), fall back to frontend node_modules (dev)
const CHARTJS_PATHS = [
  path.join(__dirname, '../../node_modules/chart.js/dist/chart.umd.min.js'),
  path.join(__dirname, '../../../frontend/node_modules/chart.js/dist/chart.umd.min.js'),
];
const chartJsPath = CHARTJS_PATHS.find(p => fs.existsSync(p));
if (!chartJsPath) throw new Error('chart.js not found. Run: npm install chart.js in backend/');
const CHARTJS_SRC = fs.readFileSync(chartJsPath, 'utf8');

// ── formatters ────────────────────────────────────────────────────────────────
function fmt(ms) {
  const n = Number(ms);
  if (ms == null || isNaN(n) || !isFinite(n)) return '—';
  if (n >= 1000) return `${(n / 1000).toFixed(2)}s`;
  return `${Math.round(n)}ms`;
}
function fmtB(b) {
  const n = Number(b);
  if (!n || isNaN(n)) return '—';
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024)    return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}
function fmtN(n)  { const v = Number(n); return isNaN(v) ? '—' : v.toLocaleString(); }
function safeN(v) { const n = Number(v); return isNaN(n) || !isFinite(n) ? 0 : n; }
function esc(s)   { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function trunc(s,n=18){ return s && s.length>n ? s.slice(0,n-1)+'…' : (s||''); }

// ── HTML builder ──────────────────────────────────────────────────────────────
function buildHtml({ summary, by_api, timeline, errors, meta, rule_violations }, runNum) {
  // Defensive defaults — prevent crashes when called with minimal reportData
  by_api    = by_api    || [];
  timeline  = timeline  || [];
  errors    = errors    || [];
  summary   = summary   || {};
  meta      = meta      || {};
  const suiteName = meta.suite_name || 'Unknown';
  const runLabel  = `Run ${runNum || meta.run_id}`;
  const startedAt = meta.started_at  ? new Date(meta.started_at).toLocaleString()  : '—';
  const finAt     = meta.finished_at ? new Date(meta.finished_at).toLocaleString() : '—';
  const durS      = `${safeN(meta.duration_s).toFixed(1)}s`;
  const engine    = (meta.engine || 'JMeter').toUpperCase();
  const isOk      = meta.status === 'completed';
  const statusBg  = isOk ? '#14532d' : '#7f1d1d';
  const statusFg  = isOk ? '#4ade80' : '#f87171';
  const statusTxt = (meta.status || 'unknown').toUpperCase();
  const errPct    = safeN(summary.error_rate).toFixed(2);
  const errColor  = summary.error_rate > 5 ? '#ef4444' : summary.error_rate > 0 ? '#f59e0b' : '#22c55e';
  const hasLat    = safeN(summary.avg_latency) > 0 || safeN(summary.avg_connect) > 0;
  const hasBytes  = safeN(summary.total_bytes_received) > 0 || safeN(summary.total_bytes_sent) > 0;
  const hasErrors = safeN(summary.total_failed) > 0 || errors.length > 0;

  // ── KPI cards ────────────────────────────────────────────────────────────────
  const kpis = [
    { label:'Total Requests', value:fmtN(summary.total_requests),                   color:'#3b82f6' },
    { label:'Passed',         value:fmtN(summary.total_success),                    color:'#22c55e' },
    { label:'Failed',         value:fmtN(summary.total_failed),                     color:summary.total_failed>0?'#ef4444':'#6b7280' },
    { label:'Error Rate',     value:`${errPct}%`,                                   color:errColor },
    { label:'Avg Response',   value:fmt(summary.avg_response_time),                 color:'#3b82f6' },
    { label:'Throughput',     value:`${safeN(summary.overall_tps).toFixed(1)} TPS`, color:'#06b6d4' },
    { label:'Min RT',         value:fmt(summary.min_response_time),                 color:'#22c55e' },
    { label:'Max RT',         value:fmt(summary.max_response_time),                 color:'#ef4444' },
    { label:'P90',            value:fmt(summary.p90),                               color:'#a78bfa' },
    { label:'P95',            value:fmt(summary.p95),                               color:'#c4b5fd' },
    { label:'Bytes Recv',     value:hasBytes?fmtB(summary.total_bytes_received):'N/A', color:'#f59e0b' },
    { label:'Bytes Sent',     value:hasBytes?fmtB(summary.total_bytes_sent):'N/A',     color:'#f97316' },
  ];
  const kpiHtml = kpis.map(k=>`
    <div class="kpi" style="border-left-color:${k.color}">
      <div class="kpi-lbl">${esc(k.label)}</div>
      <div class="kpi-val" style="color:${k.color}">${esc(k.value)}</div>
    </div>`).join('');

  // ── Latency breakdown bars ────────────────────────────────────────────────────
  const avgRt   = safeN(summary.avg_response_time) || 1;
  const avgLat  = safeN(summary.avg_latency);
  const avgConn = safeN(summary.avg_connect);
  const proc    = Math.max(0, avgRt - avgLat);
  const latHtml = hasLat ? [
    { label:'Connect Time',              val:avgConn, color:'#ef4444' },
    { label:'Time to First Byte (TTFB)', val:avgLat,  color:'#f59e0b' },
    { label:'Processing / Download',     val:proc,    color:'#3b82f6' },
  ].map(it => {
    const pct = Math.min(100, avgRt>0 ? (it.val/avgRt)*100 : 0).toFixed(1);
    return `
    <div style="margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;margin-bottom:3px">
        <span style="font-size:9px;color:#9ca3af">${it.label}</span>
        <span style="font-size:9px;font-weight:600;color:${it.color}">${fmt(it.val)}</span>
      </div>
      <div style="height:7px;background:#1e2535;border-radius:4px;overflow:hidden">
        <div style="height:100%;width:${pct}%;background:${it.color};border-radius:4px"></div>
      </div>
    </div>`;
  }).join('') : `<div style="font-size:10px;color:#6b7280;margin-top:10px">Latency columns not recorded in this JTL.<br>Enable jmeter.save.saveservice.latency=true and re-run.</div>`;

  // ── Transaction table rows ────────────────────────────────────────────────────
  const txRows = by_api.map((a,ri)=>{
    const ec = a.error_rate>5?'#ef4444':a.error_rate>0?'#f59e0b':'#22c55e';
    return `<tr style="background:${ri%2?'#10131f':'transparent'}">
      <td class="left">${esc(trunc(a.label,30))}</td>
      <td>${fmtN(a.total)}</td>
      <td style="color:#22c55e">${fmtN(a.success)}</td>
      <td style="color:${a.failed>0?'#ef4444':'#6b7280'}">${fmtN(a.failed)}</td>
      <td style="color:${ec}">${safeN(a.error_rate).toFixed(1)}%</td>
      <td>${fmt(a.avg)}</td>
      <td style="color:#22c55e">${fmt(a.min)}</td>
      <td style="color:#ef4444">${fmt(a.max)}</td>
      <td>${fmt(a.p90)}</td>
      <td>${fmt(a.p95)}</td>
      <td style="color:#f59e0b">${safeN(a.avg_latency)>0?fmt(a.avg_latency):'—'}</td>
      <td style="color:#ef4444">${safeN(a.avg_connect)>0?fmt(a.avg_connect):'—'}</td>
      <td style="color:#06b6d4">${safeN(a.tps).toFixed(2)}</td>
    </tr>`;
  }).join('');

  // ── Resource timing table ─────────────────────────────────────────────────────
  const resRows = by_api.map((a,i)=>`
    <tr style="background:${i%2?'#10131f':'transparent'}">
      <td class="left">${esc(trunc(a.label,30))}</td>
      <td>${fmt(a.avg)}</td>
      <td style="color:#f59e0b">${safeN(a.avg_latency)>0?fmt(a.avg_latency):'—'}</td>
      <td style="color:#ef4444">${safeN(a.avg_connect)>0?fmt(a.avg_connect):'—'}</td>
      <td style="color:#3b82f6">${safeN(a.avg_latency)>0?fmt(Math.max(0,a.avg-a.avg_latency)):'—'}</td>
      <td>${safeN(a.avg_bytes)>0?fmtB(a.avg_bytes):'—'}</td>
    </tr>`).join('');

  // ── Error table rows ──────────────────────────────────────────────────────────
  const errRows = errors.map((e,i)=>`
    <tr style="background:${i%2?'#10131f':'transparent'}">
      <td class="left">${esc(trunc(e.label,30))}</td>
      <td style="color:${String(e.response_code||'').startsWith('5')?'#ef4444':'#f97316'}">${esc(e.response_code||'—')}</td>
      <td style="color:#f87171;font-weight:700">${fmtN(e.count)}</td>
      <td class="left" style="color:#9ca3af">${esc(String(e.response_message||'—').slice(0,60))}</td>
      <td class="left" style="color:#9ca3af">${esc(String(e.failure_message||'—').slice(0,60))}</td>
    </tr>`).join('');

  // ── serialize data for the inline <script> ────────────────────────────────────
  const DATA_JSON = JSON.stringify({ summary, by_api, timeline, errors, meta });

  const PALETTE  = ['#3b82f6','#22c55e','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#f97316','#ec4899','#14b8a6','#a855f7'];
  const ERR_PAL  = ['#ef4444','#f97316','#f59e0b','#eab308','#dc2626','#b91c1c','#7f1d1d','#fca5a5'];
  const tlHasTL  = timeline.length > 1;
  const top12    = [...by_api].sort((a,b)=>b.avg-a.avg).slice(0,12);
  const errApis  = [...by_api].filter(a=>a.failed>0).sort((a,b)=>b.error_rate-a.error_rate);

  // header helper
  function hdr(title, sub, bgColor = 'linear-gradient(135deg,#1a2340 0%,#111830 100%)', borderColor = '#2a3558') {
    return `
    <div style="background:${bgColor};padding:11px 20px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid ${borderColor};flex-shrink:0">
      <div>
        <div style="font-size:14px;font-weight:700;color:#f0f4ff">${esc(title)}</div>
        <div style="font-size:8.5px;color:#8898c0;margin-top:2px">${esc(sub)}</div>
      </div>
      <div style="font-size:8px;font-weight:700;padding:4px 10px;border-radius:4px;border:1px solid ${statusFg};color:${statusFg};background:${statusBg}">${esc(statusTxt)}</div>
    </div>`;
  }

  // section heading
  function sh(icon, label, color) {
    return `<div style="font-size:9px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">${esc(label)}</div>`;
  }

  // table wrapper
  function tableWrap(headCells, bodyRows, colWidths) {
    const ths = headCells.map((h,i)=>`<th style="width:${colWidths?colWidths[i]||'auto':'auto'}">${h}</th>`).join('');
    return `<table><thead><tr>${ths}</tr></thead><tbody>${bodyRows}</tbody></table>`;
  }

  const errPage = hasErrors ? `
  <div class="page">
    ${hdr('Error Analysis', `${fmtN(summary.total_failed)} failed requests · ${errPct}% error rate`, 'linear-gradient(135deg,#3b0a0a 0%,#270707 100%)', '#7f1d1d')}
    <div class="content">
      <div class="kpi-grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:14px">
        <div class="kpi" style="border-left-color:#ef4444"><div class="kpi-lbl">Total Errors</div><div class="kpi-val" style="color:#ef4444">${fmtN(summary.total_failed)}</div></div>
        <div class="kpi" style="border-left-color:#ef4444"><div class="kpi-lbl">Error Rate</div><div class="kpi-val" style="color:#ef4444">${errPct}%</div></div>
        <div class="kpi" style="border-left-color:#f97316"><div class="kpi-lbl">Unique Types</div><div class="kpi-val" style="color:#f97316">${errors.length}</div></div>
      </div>
      <div class="two-col" style="margin-bottom:14px">
        <div class="card"><div class="card-title">Error Distribution (top 6)</div><div style="height:160px"><canvas id="c_err_dist"></canvas></div></div>
        <div class="card"><div class="card-title">Error Rate per API (%)</div><div style="height:160px"><canvas id="c_err_bar"></canvas></div></div>
      </div>
      ${tlHasTL ? `<div class="card" style="margin-bottom:14px"><div class="card-title">Error Timeline</div><div style="height:120px"><canvas id="c_err_tl"></canvas></div></div>` : ''}
      ${errors.length > 0 ? `
      ${sh('','Error Details')}
      ${tableWrap(['API / Sampler','Code','Count','Response Message','Failure Message'],errRows,['30%','8%','8%','27%','27%'])}` : ''}
    </div>
    <div class="footer">Error Analysis · ${esc(suiteName)} · ${esc(runLabel)} · Performance Studio</div>
  </div>` : '';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
* { box-sizing:border-box; margin:0; padding:0; }
body {
  background:#0d0f1a; color:#e4e6eb;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;
  font-size:11px;
  -webkit-print-color-adjust:exact; print-color-adjust:exact;
}
@page { size:A4 landscape; margin:0; }
.page { width:297mm; min-height:210mm; background:#0d0f1a; page-break-after:always; position:relative; display:flex; flex-direction:column; }
.content { padding:12px 20px 28px; flex:1; }
.footer { position:absolute; bottom:0; left:0; right:0; padding:4px 20px; background:#0a0c14; border-top:1px solid #1a2030; font-size:7px; color:#4b5563; text-align:center; }
/* meta strip */
.meta-row { display:flex; padding:7px 20px; border-bottom:1px solid #1a2030; }
.meta-item { flex:1; }
.meta-lbl  { font-size:7px; color:#6b7280; text-transform:uppercase; letter-spacing:.5px; }
.meta-val  { font-size:11px; font-weight:600; color:#d1d5db; margin-top:2px; }
/* KPI */
.kpi-grid { display:grid; grid-template-columns:repeat(6,1fr); gap:6px; margin-bottom:12px; }
.kpi { background:#131626; border:1px solid #1e2535; border-left:3px solid #2e3a5c; border-radius:6px; padding:7px 8px 7px 10px; }
.kpi-lbl { font-size:7px; color:#6b7280; text-transform:uppercase; letter-spacing:.4px; }
.kpi-val { font-size:14px; font-weight:700; margin-top:3px; line-height:1; }
/* layout */
.two-col { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
.four-col { display:grid; grid-template-columns:1fr 1fr 1fr 1fr; gap:10px; margin-bottom:12px; }
.card { background:#131626; border:1px solid #1e2535; border-radius:8px; padding:12px; }
.card-title { font-size:8px; font-weight:600; color:#9ca3af; text-transform:uppercase; letter-spacing:.5px; margin-bottom:8px; }
/* table */
table { width:100%; border-collapse:collapse; font-size:8px; }
thead tr { background:#181b2e; }
thead th { padding:5px 5px; color:#9ca3af; font-weight:600; font-size:7px; text-transform:uppercase; letter-spacing:.4px; text-align:right; border-bottom:1px solid #2a3050; white-space:nowrap; }
thead th.left, td.left { text-align:left !important; }
tbody td { padding:4px 5px; color:#c9cdd6; text-align:right; border-bottom:1px solid #181b2e; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:0; }
code { font-family:monospace; background:#1e2535; padding:1px 4px; border-radius:3px; font-size:8px; }
</style>
</head>
<body>

<!-- ═══ PAGE 1: SUMMARY ═══════════════════════════════════════════════════ -->
<div class="page">
  ${hdr('Performance Analytics Report', `${suiteName} · ${runLabel} · ${startedAt}`)}
  <div class="meta-row">
    <div class="meta-item"><div class="meta-lbl">Started</div><div class="meta-val">${esc(startedAt)}</div></div>
    <div class="meta-item"><div class="meta-lbl">Finished</div><div class="meta-val">${esc(finAt)}</div></div>
    <div class="meta-item"><div class="meta-lbl">Duration</div><div class="meta-val">${esc(durS)}</div></div>
    <div class="meta-item"><div class="meta-lbl">Engine</div><div class="meta-val">${esc(engine)}</div></div>
  </div>
  <div class="content">
    <div class="kpi-grid">${kpiHtml}</div>
    <div class="two-col">
      <div class="card">
        <div class="card-title">Response Time Distribution (by API avg)</div>
        <div style="height:160px"><canvas id="c_rt_dist"></canvas></div>
      </div>
      <div class="card">
        <div class="card-title">Latency Breakdown</div>
        ${latHtml}
      </div>
    </div>
  </div>
  <div class="footer">Summary Report · ${esc(suiteName)} · ${esc(runLabel)} · Performance Studio</div>
</div>

<!-- ═══ PAGE 2: DASHBOARD ═════════════════════════════════════════════════ -->
<div class="page">
  ${hdr('Performance Dashboard', 'Response time, throughput and trends')}
  <div class="content">
    <div class="two-col" style="margin-bottom:12px">
      <div class="card"><div class="card-title">Avg Response Time per API</div><div style="height:155px"><canvas id="c_avg_rt"></canvas></div></div>
      <div class="card"><div class="card-title">Throughput per API (TPS)</div><div style="height:155px"><canvas id="c_tps"></canvas></div></div>
    </div>
    ${tlHasTL ? `
    <div class="card" style="margin-bottom:12px">
      <div class="card-title">Response Time &amp; Throughput Over Time</div>
      <div style="height:145px"><canvas id="c_timeline"></canvas></div>
    </div>` : ''}
    <div class="card">
      <div class="card-title">Top ${Math.min(5,by_api.length)} Slowest APIs (avg response time)</div>
      <div style="height:130px"><canvas id="c_slow"></canvas></div>
    </div>
  </div>
  <div class="footer">Performance Dashboard · ${esc(suiteName)} · ${esc(runLabel)} · Performance Studio</div>
</div>

<!-- ═══ PAGE 3: TRANSACTIONS ══════════════════════════════════════════════ -->
<div class="page">
  ${hdr('Transaction Breakdown', `${by_api.length} API samplers`)}
  <div class="content">
    <div class="card" style="margin-bottom:12px">
      <div class="card-title">P90 &amp; P95 per API</div>
      <div style="height:130px"><canvas id="c_p9095"></canvas></div>
    </div>
    <div class="card-title" style="margin-bottom:6px">Full Transaction Table</div>
    ${tableWrap(['API / Sampler','Req','Pass','Fail','Err%','Avg RT','Min','Max','P90','P95','TTFB','Connect','TPS'],txRows,['22%','5%','5%','5%','5%','7%','6%','7%','6%','6%','6%','6%','5%'])}
  </div>
  <div class="footer">Transaction Breakdown · ${esc(suiteName)} · ${esc(runLabel)} · Performance Studio</div>
</div>

<!-- ═══ PAGE 4: TREND ANALYSIS ════════════════════════════════════════════ -->
<div class="page">
  ${hdr('Trend Analysis', 'Response time, throughput, errors and thread trends over time')}
  <div class="content">
    ${tlHasTL ? `
    <div class="two-col" style="margin-bottom:12px">
      <div class="card"><div class="card-title">Response Time Trend</div><div style="height:150px"><canvas id="c_rt_trend"></canvas></div></div>
      <div class="card"><div class="card-title">Throughput Trend (Req/s)</div><div style="height:150px"><canvas id="c_tps_trend"></canvas></div></div>
    </div>
    <div class="two-col">
      <div class="card"><div class="card-title">Error Rate Over Time (%)</div><div style="height:150px"><canvas id="c_err_trend"></canvas></div></div>
      <div class="card"><div class="card-title">Concurrent Users (Active Threads)</div><div style="height:150px"><canvas id="c_thread_trend"></canvas></div></div>
    </div>` : '<div style="padding:60px;text-align:center;color:#6b7280;font-size:12px">No timeline data available for this run.</div>'}
  </div>
  <div class="footer">Trend Analysis · ${esc(suiteName)} · ${esc(runLabel)} · Performance Studio</div>
</div>

<!-- ═══ PAGE 5: RESOURCE UTILIZATION ═════════════════════════════════════ -->
<div class="page">
  ${hdr('Resource Utilization', 'Network, threads and timing breakdown')}
  <div class="content">
    <div class="four-col">
      <div class="kpi" style="border-left-color:#06b6d4"><div class="kpi-lbl">Total Received</div><div class="kpi-val" style="color:#06b6d4;font-size:13px">${hasBytes?fmtB(summary.total_bytes_received):'N/A'}</div></div>
      <div class="kpi" style="border-left-color:#f97316"><div class="kpi-lbl">Total Sent</div><div class="kpi-val" style="color:#f97316;font-size:13px">${hasBytes?fmtB(summary.total_bytes_sent):'N/A'}</div></div>
      <div class="kpi" style="border-left-color:#f59e0b"><div class="kpi-lbl">Avg TTFB</div><div class="kpi-val" style="color:#f59e0b;font-size:13px">${hasLat?fmt(summary.avg_latency):'N/A'}</div></div>
      <div class="kpi" style="border-left-color:#ef4444"><div class="kpi-lbl">Avg Connect</div><div class="kpi-val" style="color:#ef4444;font-size:13px">${hasLat?fmt(summary.avg_connect):'N/A'}</div></div>
    </div>
    <div class="two-col" style="margin-bottom:12px">
      <div class="card"><div class="card-title">Response Time Breakdown (Connect → TTFB → Total)</div><div style="height:130px"><canvas id="c_res_rt"></canvas></div></div>
      <div class="card"><div class="card-title">Network Throughput &amp; Thread Utilization</div><div style="height:130px"><canvas id="c_res_net"></canvas></div></div>
    </div>
    <div class="card-title" style="margin-bottom:6px">Per-API Timing Breakdown</div>
    ${tableWrap(['API / Sampler','Avg RT','Avg TTFB','Avg Connect','Processing','Avg Bytes'],resRows,['34%','13%','13%','13%','13%','14%'])}
  </div>
  <div class="footer">Resource Utilization · ${esc(suiteName)} · ${esc(runLabel)} · Performance Studio</div>
</div>

${errPage}

</body>
<script>
${CHARTJS_SRC}

(function() {
  const D   = ${DATA_JSON};
  const s   = D.summary;
  const api = D.by_api;
  const tl  = D.timeline;
  const PAL = ${JSON.stringify(PALETTE)};
  const EP  = ${JSON.stringify(ERR_PAL)};

  const GRID  = 'rgba(255,255,255,0.06)';
  const TICK  = '#9ca3af';
  const FONT  = { family: 'system-ui,sans-serif', size: 9 };
  const TIPBG = { backgroundColor:'#1e2130', titleColor:'#f0f1f3', bodyColor:'#c4c8d0', borderColor:'#2e3142', borderWidth:1, cornerRadius:4, padding:8 };

  function safeN(v){ const n=Number(v); return isNaN(n)||!isFinite(n)?0:n; }
  function fmt(ms){ const n=Number(ms); if(ms==null||isNaN(n)||!isFinite(n))return'—'; if(n>=1000)return(n/1000).toFixed(2)+'s'; return Math.round(n)+'ms'; }
  function fmtB(b){ const n=Number(b); if(!n||isNaN(n))return'—'; if(n>=1048576)return(n/1048576).toFixed(1)+' MB'; if(n>=1024)return(n/1024).toFixed(1)+' KB'; return n+' B'; }

  const axes = (yFmt, y2) => ({
    x: { ticks:{ color:TICK, font:FONT, maxRotation:30 }, grid:{ color:GRID }, border:{ color:'rgba(255,255,255,0.1)' } },
    y: { ticks:{ color:TICK, font:FONT, callback: yFmt||undefined }, grid:{ color:GRID }, border:{ color:'rgba(255,255,255,0.1)' } },
    ...(y2 ? { y2:{ position:'right', ticks:{ color:TICK, font:FONT, callback:y2.fmt||undefined }, grid:{ drawOnChartArea:false }, border:{ color:'rgba(255,255,255,0.1)' }, title:{ display:true, text:y2.label||'', color:'#6b7280', font:FONT } } } : {}),
  });

  const baseOpts = (yFmt, y2, mode) => ({
    responsive:true, maintainAspectRatio:false,
    animation:{ duration:0, onComplete: chartDone },
    interaction:{ mode: mode||'index', intersect:false },
    plugins:{ legend:{ display:false }, tooltip:{ ...TIPBG, callbacks: yFmt?{ label: ctx=>' '+yFmt(ctx.parsed.y) }:undefined } },
    scales: axes(yFmt, y2),
  });

  // chart-ready counter — duration:0 ensures onComplete fires even with empty data
  let total = 0, ready = 0;
  function chartDone() { if(++ready >= total) window.__chartsReady = true; }

  function mkChart(id, type, data, opts) {
    const el = document.getElementById(id);
    if (!el) { chartDone(); return; }
    total++;
    try { new Chart(el, { type, data, options:{ ...opts, animation:{ duration:0, onComplete: chartDone } } }); }
    catch(e) { chartDone(); }
  }

  const apiLabels = api.map(a => a.label.length>14 ? a.label.slice(0,13)+'…' : a.label);
  const tlLabels  = tl.map(t => t.second+'s');

  // ── P1: RT Distribution doughnut ──────────────────────────────────────────
  const buckets = [0,0,0,0,0];
  for(const a of api){ const v=safeN(a.avg); if(v<500)buckets[0]++; else if(v<1000)buckets[1]++; else if(v<2000)buckets[2]++; else if(v<5000)buckets[3]++; else buckets[4]++; }
  mkChart('c_rt_dist','doughnut',{
    labels:['< 500ms','500ms–1s','1s–2s','2s–5s','> 5s'],
    datasets:[{ data:buckets, backgroundColor:['#22c55e','#84cc16','#f59e0b','#f97316','#ef4444'], borderWidth:0 }]
  },{
    responsive:true, maintainAspectRatio:false,
    cutout:'60%',
    plugins:{ legend:{ display:true, position:'right', labels:{ color:'#9ca3af', font:FONT, boxWidth:10, padding:8 } }, tooltip:TIPBG },
  });

  // ── P2: Avg RT bar ────────────────────────────────────────────────────────
  mkChart('c_avg_rt','bar',{
    labels:apiLabels,
    datasets:[{ data:api.map(a=>safeN(a.avg)), backgroundColor:api.map((_,i)=>PAL[i%PAL.length]+'cc'), borderColor:api.map((_,i)=>PAL[i%PAL.length]), borderWidth:1, borderRadius:3 }]
  }, baseOpts(fmt));

  // ── P2: TPS bar ───────────────────────────────────────────────────────────
  mkChart('c_tps','bar',{
    labels:apiLabels,
    datasets:[{ data:api.map(a=>safeN(a.tps)), backgroundColor:api.map((_,i)=>PAL[(i+3)%PAL.length]+'cc'), borderColor:api.map((_,i)=>PAL[(i+3)%PAL.length]), borderWidth:1, borderRadius:3 }]
  }, baseOpts(v=>v.toFixed(1)));

  // ── P2: Timeline dual-axis ────────────────────────────────────────────────
  mkChart('c_timeline','line',{
    labels:tlLabels,
    datasets:[
      { label:'Avg RT', data:tl.map(t=>safeN(t.avg_rt)), borderColor:'#3b82f6', backgroundColor:'#3b82f620', borderWidth:2, pointRadius:0, tension:.3, fill:true, yAxisID:'y' },
      { label:'Req/s',  data:tl.map(t=>safeN(t.tps)),    borderColor:'#22c55e', backgroundColor:'transparent', borderWidth:1.5, pointRadius:0, tension:.3, fill:false, yAxisID:'y2' },
    ]
  }, baseOpts(fmt, { label:'Req/s', fmt:v=>v.toFixed(0) }));

  // ── P2: Top-5 slowest ─────────────────────────────────────────────────────
  const top5 = [...api].sort((a,b)=>b.avg-a.avg).slice(0,5);
  mkChart('c_slow','bar',{
    labels:top5.map(a=>a.label.length>16?a.label.slice(0,15)+'…':a.label),
    datasets:[{ data:top5.map(a=>safeN(a.avg)), backgroundColor:['#ef4444cc','#f97316cc','#f59e0bcc','#eab308cc','#84cc16cc'], borderWidth:0, borderRadius:3 }]
  }, baseOpts(fmt));

  // ── P3: P90/P95 ───────────────────────────────────────────────────────────
  mkChart('c_p9095','bar',{
    labels:apiLabels,
    datasets:[
      { label:'P90', data:api.map(a=>safeN(a.p90)), backgroundColor:'#8b5cf6cc', borderColor:'#8b5cf6', borderWidth:1, borderRadius:3 },
      { label:'P95', data:api.map(a=>safeN(a.p95)), backgroundColor:'#06b6d4cc', borderColor:'#06b6d4', borderWidth:1, borderRadius:3 },
    ]
  }, { ...baseOpts(fmt), plugins:{ legend:{ display:true, labels:{ color:'#9ca3af', font:FONT, boxWidth:10 } }, tooltip:{ ...TIPBG, callbacks:{ label:ctx=>' '+fmt(ctx.parsed.y) } } } });

  // ── P4: RT trend ──────────────────────────────────────────────────────────
  const hasLat = tl.some(t=>safeN(t.avg_latency)>0);
  mkChart('c_rt_trend','line',{
    labels:tlLabels,
    datasets:[
      { label:'Avg RT', data:tl.map(t=>safeN(t.avg_rt)), borderColor:'#3b82f6', backgroundColor:'#3b82f625', borderWidth:2, pointRadius:0, tension:.3, fill:true },
      ...(hasLat?[{ label:'TTFB', data:tl.map(t=>safeN(t.avg_latency)), borderColor:'#f59e0b', backgroundColor:'transparent', borderWidth:1.5, pointRadius:0, tension:.3, borderDash:[4,3] }]:[]),
    ]
  }, { ...baseOpts(fmt), plugins:{ legend:{ display:true, labels:{ color:'#9ca3af', font:FONT, boxWidth:10 } }, tooltip:{ ...TIPBG } } });

  // ── P4: TPS trend ─────────────────────────────────────────────────────────
  mkChart('c_tps_trend','line',{
    labels:tlLabels,
    datasets:[{ label:'Req/s', data:tl.map(t=>safeN(t.tps)), borderColor:'#22c55e', backgroundColor:'#22c55e20', borderWidth:2, pointRadius:0, tension:.3, fill:true }]
  }, baseOpts(v=>v.toFixed(0)));

  // ── P4: Error rate trend ──────────────────────────────────────────────────
  mkChart('c_err_trend','line',{
    labels:tlLabels,
    datasets:[{ label:'Error Rate %', data:tl.map(t=>safeN(t.error_rate)), borderColor:'#ef4444', backgroundColor:'#ef444425', borderWidth:2, pointRadius:0, tension:.3, fill:true }]
  }, baseOpts(v=>v.toFixed(1)+'%'));

  // ── P4: Thread trend ──────────────────────────────────────────────────────
  mkChart('c_thread_trend','line',{
    labels:tlLabels,
    datasets:[{ label:'Threads', data:tl.map(t=>safeN(t.threads)), borderColor:'#8b5cf6', backgroundColor:'#8b5cf625', borderWidth:2, pointRadius:0, tension:.3, fill:true }]
  }, baseOpts(v=>Math.round(v)));

  // ── P5: RT breakdown (line) ───────────────────────────────────────────────
  mkChart('c_res_rt','line',{
    labels:tlLabels,
    datasets:[
      { label:'Avg RT',      data:tl.map(t=>safeN(t.avg_rt)),      borderColor:'#3b82f6', backgroundColor:'#3b82f615', borderWidth:2, pointRadius:0, tension:.3, fill:true },
      { label:'TTFB',        data:tl.map(t=>safeN(t.avg_latency)), borderColor:'#f59e0b', backgroundColor:'transparent', borderWidth:1.5, pointRadius:0, tension:.3 },
      { label:'Connect',     data:tl.map(t=>safeN(t.avg_connect)), borderColor:'#ef4444', backgroundColor:'transparent', borderWidth:1.5, pointRadius:0, tension:.3 },
    ]
  }, { ...baseOpts(fmt), plugins:{ legend:{ display:true, labels:{ color:'#9ca3af', font:FONT, boxWidth:10 } }, tooltip:{ ...TIPBG } } });

  // ── P5: Network (bytes + threads) ─────────────────────────────────────────
  mkChart('c_res_net','line',{
    labels:tlLabels,
    datasets:[
      { label:'Received/s', data:tl.map(t=>safeN(t.bytes_received)), borderColor:'#06b6d4', backgroundColor:'#06b6d420', borderWidth:2, pointRadius:0, tension:.3, fill:true, yAxisID:'y' },
      { label:'Threads',    data:tl.map(t=>safeN(t.threads)),        borderColor:'#8b5cf6', backgroundColor:'transparent', borderWidth:1.5, pointRadius:0, tension:.3, yAxisID:'y2' },
    ]
  }, { ...baseOpts(fmtB, { label:'Threads', fmt:v=>Math.round(v) }), plugins:{ legend:{ display:true, labels:{ color:'#9ca3af', font:FONT, boxWidth:10 } }, tooltip:TIPBG } });

  // ── P6: Error distribution doughnut ──────────────────────────────────────
  if(D.errors && D.errors.length){
    const top6 = D.errors.slice(0,6);
    mkChart('c_err_dist','doughnut',{
      labels:top6.map(e=>(e.label||'').slice(0,20)+' ['+e.response_code+']'),
      datasets:[{ data:top6.map(e=>e.count), backgroundColor:EP.map(c=>c+'cc'), borderWidth:0 }]
    },{
      responsive:true, maintainAspectRatio:false, cutout:'55%',
      plugins:{ legend:{ display:true, position:'right', labels:{ color:'#9ca3af', font:FONT, boxWidth:10, padding:6 } }, tooltip:TIPBG },
    });

    const errApis = D.by_api.filter(a=>a.failed>0).sort((a,b)=>b.error_rate-a.error_rate);
    mkChart('c_err_bar','bar',{
      labels:errApis.map(a=>a.label.length>14?a.label.slice(0,13)+'…':a.label),
      datasets:[{ data:errApis.map(a=>safeN(a.error_rate)), backgroundColor:EP.map(c=>c+'cc'), borderWidth:0, borderRadius:3 }]
    }, baseOpts(v=>v.toFixed(1)+'%'));

    mkChart('c_err_tl','line',{
      labels:tlLabels,
      datasets:[
        { label:'Errors/s',   data:tl.map(t=>safeN(t.errors)),     borderColor:'#ef4444', backgroundColor:'#ef444425', borderWidth:2, pointRadius:0, tension:.3, fill:true,  yAxisID:'y' },
        { label:'Err Rate %', data:tl.map(t=>safeN(t.error_rate)), borderColor:'#f97316', backgroundColor:'transparent', borderWidth:1.5, pointRadius:0, tension:.3, borderDash:[4,3], yAxisID:'y2' },
      ]
    }, { ...baseOpts(v=>v.toFixed(0), { label:'Err Rate %', fmt:v=>v.toFixed(1)+'%' }), plugins:{ legend:{ display:true, labels:{ color:'#9ca3af', font:FONT, boxWidth:10 } }, tooltip:TIPBG } });
  }

  // If no charts registered at all, mark ready immediately
  if (total === 0) window.__chartsReady = true;
  // Fallback: force ready after 3s in case any chart fails to fire onComplete
  setTimeout(() => { window.__chartsReady = true; }, 3000);
})();
</script>
</html>`;
}

// ── shared Puppeteer PDF renderer ────────────────────────────────────────────
// Strategy: screenshot each .page div individually then stitch with pdfkit.
// This avoids CSS print-layout distortion and produces pixel-perfect pages.
async function renderPdf(data, runNum) {
  const PDFDocument = require('pdfkit');
  const os = require('os');
  let browser;
  const tmpFiles = [];
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    // A4 landscape at 96 DPI: 297mm × 210mm = 1122 × 794 px
    // deviceScaleFactor:1.5 gives 1.5× resolution screenshots for crisp text/charts
    await page.setViewport({ width: 1122, height: 794, deviceScaleFactor: 1.5 });
    await page.setContent(buildHtml(data, runNum), { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.__chartsReady === true, { timeout: 8000 });

    // Screenshot each .page div — write to temp files (pdfkit requires file path or stream, not raw Buffer)
    const pageEls = await page.$$('.page');
    for (let i = 0; i < pageEls.length; i++) {
      const el = pageEls[i];
      // Force page height to exactly 794px (A4 landscape) so screenshots are uniform
      await page.evaluate(e => { e.style.minHeight = '794px'; e.style.height = '794px'; e.style.overflow = 'hidden'; }, el);
      const tmpPath = path.join(os.tmpdir(), `perfstudio_page_${process.pid}_${i}.jpg`);
      await el.screenshot({ type: 'jpeg', quality: 95, path: tmpPath });
      tmpFiles.push(tmpPath);
    }

    // Build PDF: A4 landscape = 841.89 × 595.28 pt
    const chunks = [];
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0, autoFirstPage: false });
    doc.on('data', c => chunks.push(c));
    const done = new Promise((res, rej) => { doc.on('end', res); doc.on('error', rej); });
    for (const tmpPath of tmpFiles) {
      doc.addPage({ size: 'A4', layout: 'landscape', margin: 0 });
      doc.image(tmpPath, 0, 0, { width: doc.page.width, height: doc.page.height });
    }
    doc.end();
    await done;
    return Buffer.concat(chunks);
  } finally {
    if (browser) await browser.close().catch(() => {});
    // Clean up temp screenshot files
    for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch (_) {} }
  }
}

// ── route handler — streams PDF to HTTP response ──────────────────────────────
async function generateAnalyticsPdf(data, runNum, res) {
  try {
    const pdf = await renderPdf(data, runNum);
    res.end(pdf);
  } catch (e) {
    console.error('[generateAnalyticsPdf] error:', e);
    if (!res.headersSent) res.status(500).json({ error: 'PDF generation failed: ' + e.message });
    else res.end();
  }
}

// ── email helper — saves PDF to a temp file and returns the path ──────────────
async function generateAnalyticsPdfToFile(data, runNum, destPath) {
  const pdf = await renderPdf(data, runNum);
  require('fs').writeFileSync(destPath, pdf);
  return destPath;
}

module.exports = { generateAnalyticsPdf, generateAnalyticsPdfToFile };
