'use strict';
// Trend Analysis PDF export — mirrors generateAnalyticsPdf.js's approach exactly
// (screenshot each .page div with Puppeteer, stitch with pdfkit) so both PDF
// exports in the app look and behave consistently, and neither needs a print-CSS
// layout engine (which distorts charts/tables unpredictably across renderers).
const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer');
const PDFDocument = require('pdfkit');

const CHARTJS_PATHS = [
  path.join(__dirname, '../../../node_modules/chart.js/dist/chart.umd.min.js'),
  path.join(__dirname, '../../../../frontend/node_modules/chart.js/dist/chart.umd.min.js'),
];
const chartJsPath = CHARTJS_PATHS.find(p => fs.existsSync(p));
if (!chartJsPath) throw new Error('chart.js not found. Run: npm install chart.js in backend/');
const CHARTJS_SRC = fs.readFileSync(chartJsPath, 'utf8');

function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function fmt(ms) { const n = Number(ms); if (ms == null || isNaN(n) || !isFinite(n)) return '—'; return n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${Math.round(n)}ms`; }
function pct(n) { return n === null || n === undefined || isNaN(n) ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(1)}%`; }
function scoreOrNA(v) { return v === null || v === undefined ? 'N/A' : v; }

const SEVERITY_COLOR = { critical: '#ef4444', warn: '#f59e0b', info: '#58a6ff' };
const PRIORITY_COLOR = { critical: '#ef4444', high: '#f59e0b', medium: '#58a6ff', low: '#6b7280' };
const SCORE_ROWS = [
  ['overall', 'Performance Score'], ['apiHealth', 'API Health'], ['appHealth', 'Application Health'],
  ['regression', 'Regression'], ['reliability', 'Reliability'], ['scalability', 'Scalability'],
];

function hdr(title, sub) {
  return `
  <div style="background:linear-gradient(135deg,#1a2340 0%,#111830 100%);padding:11px 20px;border-bottom:1px solid #2a3558;flex-shrink:0">
    <div style="font-size:14px;font-weight:700;color:#f0f4ff">${esc(title)}</div>
    <div style="font-size:8.5px;color:#8898c0;margin-top:2px">${esc(sub)}</div>
  </div>`;
}

function buildHtml(data) {
  const { runRange, kpis, aiSummary, scores, comparison, insights, recommendations, capacity, trend } = data;

  const kpiHtml = kpis.map(k => `
    <div class="kpi" style="border-left-color:${k.color}">
      <div class="kpi-lbl">${esc(k.label)}</div>
      <div class="kpi-val" style="color:${k.color}">${esc(k.value)}</div>
    </div>`).join('');

  const scoreRows = SCORE_ROWS.map(([key, label]) => {
    const b = scores.baseline[key]?.value, l = scores.latest[key]?.value;
    const delta = (b !== null && b !== undefined && l !== null && l !== undefined) ? l - b : null;
    const deltaColor = delta === null ? '#6b7280' : delta >= 0 ? '#22c55e' : '#ef4444';
    return `<tr>
      <td class="left">${esc(label)}</td>
      <td>${scoreOrNA(b)}</td>
      <td>${scoreOrNA(l)}</td>
      <td style="color:${deltaColor};font-weight:700">${delta === null ? '—' : `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}`}</td>
    </tr>`;
  }).join('');

  function apiTable(rows, cols) {
    if (!rows.length) return `<div style="font-size:10px;color:#6b7280;padding:8px 0">None.</div>`;
    return `<table><thead><tr>${cols.map(c => `<th class="${c.left ? 'left' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r, i) => `<tr style="background:${i % 2 ? '#10131f' : 'transparent'}">${cols.map(c => `<td class="${c.left ? 'left' : ''}" style="${c.color ? `color:${c.color(r)}` : ''}">${esc(c.value(r))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }

  const regressedTable = apiTable(comparison.regressed || [], [
    { label: 'API', left: true, value: r => r.label },
    { label: 'Δ Avg RT', value: r => pct(r.deltas.avgPct), color: r => r.deltas.avgPct > 0 ? '#ef4444' : '#22c55e' },
    { label: 'Δ P95', value: r => pct(r.deltas.p95Pct) },
    { label: 'Δ Error Rate', value: r => `${r.deltas.errorRatePts > 0 ? '+' : ''}${r.deltas.errorRatePts.toFixed(1)} pts` },
    { label: 'Δ TPS', value: r => pct(r.deltas.tpsPct) },
  ]);
  const improvedTable = apiTable(comparison.improved || [], [
    { label: 'API', left: true, value: r => r.label },
    { label: 'Δ Avg RT', value: r => pct(r.deltas.avgPct), color: () => '#22c55e' },
  ]);
  const newTable = apiTable(comparison.new || [], [{ label: 'API', left: true, value: r => r.label }]);
  const removedTable = apiTable(comparison.removed || [], [{ label: 'API', left: true, value: r => r.label }]);

  const insightsHtml = insights.length
    ? insights.map(ins => `
      <div style="display:flex;gap:8px;padding:6px 10px;margin-bottom:5px;border-radius:5px;background:${SEVERITY_COLOR[ins.severity]}15;border-left:3px solid ${SEVERITY_COLOR[ins.severity] || '#6b7280'}">
        <span style="font-size:9.5px;color:#d1d5db">${esc(ins.message)}</span>
      </div>`).join('')
    : `<div style="font-size:10px;color:#6b7280">No notable changes detected.</div>`;

  const recsHtml = recommendations.recommendations.length
    ? recommendations.recommendations.map(rec => `
      <div style="padding:8px 10px;margin-bottom:6px;border-radius:6px;background:#131626;border:1px solid #1e2535">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">
          <span style="font-size:7px;font-weight:700;color:${PRIORITY_COLOR[rec.priority]};text-transform:uppercase">${esc(rec.priority)}</span>
          <span style="font-size:9.5px;font-weight:700;color:#f0f4ff">${esc(rec.title)}</span>
          <span style="margin-left:auto;font-size:8px;color:#6b7280">${rec.confidence_pct}% confidence</span>
        </div>
        <div style="font-size:8.5px;color:#9ca3af">${esc(rec.description)}</div>
      </div>`).join('')
    : `<div style="font-size:10px;color:#6b7280">No recommendations — nothing regressed.</div>`;

  const capacityPage = capacity && !capacity.insufficientData ? `
  <div class="page">
    ${hdr('Capacity Planning', runRange)}
    <div class="content">
      <div class="four-col">
        <div class="kpi" style="border-left-color:#22c55e"><div class="kpi-lbl">Max Stable Users</div><div class="kpi-val" style="color:#22c55e">${scoreOrNA(capacity.maxStableUsers)}</div></div>
        <div class="kpi" style="border-left-color:#58a6ff"><div class="kpi-lbl">Recommended Users</div><div class="kpi-val" style="color:#58a6ff">${scoreOrNA(capacity.recommendedUsers)}</div></div>
        <div class="kpi" style="border-left-color:#ef4444"><div class="kpi-lbl">Breaking Point</div><div class="kpi-val" style="color:#ef4444">${scoreOrNA(capacity.breakingPointUsers)}</div></div>
        <div class="kpi" style="border-left-color:#8b5cf6"><div class="kpi-lbl">Confidence</div><div class="kpi-val" style="color:#8b5cf6">${capacity.confidencePct}%</div></div>
      </div>
      ${capacity.projectedAtBreakingPoint ? `<div style="font-size:10px;color:#9ca3af;margin-top:10px">At the projected breaking point (~${capacity.breakingPointUsers} users): avg RT ${fmt(capacity.projectedAtBreakingPoint.avg)}, TPS ${capacity.projectedAtBreakingPoint.tps}, error rate ${capacity.projectedAtBreakingPoint.error_rate}%.</div>` : ''}
      <div style="font-size:9px;color:#6b7280;margin-top:14px">${esc(capacity.formula.description)}</div>
    </div>
    <div class="footer">Capacity Planning · ${esc(runRange)} · PerfStudio</div>
  </div>` : '';

  const DATA_JSON = JSON.stringify({ trend, scores });

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
* { box-sizing:border-box; margin:0; padding:0; }
body { background:#0d0f1a; color:#e4e6eb; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif; font-size:11px; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
.page { width:297mm; min-height:210mm; background:#0d0f1a; page-break-after:always; position:relative; display:flex; flex-direction:column; }
.content { padding:14px 20px 28px; flex:1; }
.footer { position:absolute; bottom:0; left:0; right:0; padding:4px 20px; background:#0a0c14; border-top:1px solid #1a2030; font-size:7px; color:#4b5563; text-align:center; }
.kpi-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; margin-bottom:16px; }
.four-col { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; }
.kpi { background:#131626; border:1px solid #1e2535; border-left:3px solid #2e3a5c; border-radius:6px; padding:9px 10px 9px 12px; }
.kpi-lbl { font-size:7.5px; color:#6b7280; text-transform:uppercase; letter-spacing:.4px; }
.kpi-val { font-size:16px; font-weight:700; margin-top:4px; }
.card { background:#131626; border:1px solid #1e2535; border-radius:8px; padding:12px; }
.card-title { font-size:8.5px; font-weight:600; color:#9ca3af; text-transform:uppercase; letter-spacing:.5px; margin-bottom:8px; }
.two-col { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
table { width:100%; border-collapse:collapse; font-size:8.5px; }
thead tr { background:#181b2e; }
thead th { padding:6px 6px; color:#9ca3af; font-weight:600; font-size:7.5px; text-transform:uppercase; text-align:right; border-bottom:1px solid #2a3050; }
thead th.left, td.left { text-align:left !important; }
tbody td { padding:5px 6px; color:#c9cdd6; text-align:right; border-bottom:1px solid #181b2e; }
</style></head><body>

<div class="page">
  ${hdr('Trend Analysis — Executive Summary', runRange)}
  <div class="content">
    <div class="card" style="margin-bottom:16px;background:linear-gradient(135deg,rgba(73,204,61,0.07),rgba(88,166,255,0.05))">
      <div class="card-title"><span style="color:#49CC3D">●</span> Executive Summary ${aiSummary.source === 'ai' ? '(AI-generated)' : '(Rule-based)'}</div>
      <ul style="margin:0;padding-left:16px;font-size:11px;line-height:1.7;color:#e4e6eb">
        ${(aiSummary.bullets || []).map(b => `<li>${esc(b)}</li>`).join('')}
      </ul>
    </div>
    <div class="kpi-grid">${kpiHtml}</div>
  </div>
  <div class="footer">Executive Summary · ${esc(runRange)} · PerfStudio Trend Analysis</div>
</div>

<div class="page">
  ${hdr('Performance Scores', 'Baseline vs. latest run, weighted formulas — see appendix')}
  <div class="content">
    <div class="card" style="margin-bottom:14px"><div class="card-title">Score Comparison</div><div style="height:180px"><canvas id="c_scores"></canvas></div></div>
    <table><thead><tr><th class="left">Score</th><th>Baseline</th><th>Latest</th><th>Δ</th></tr></thead><tbody>${scoreRows}</tbody></table>
  </div>
  <div class="footer">Performance Scores · ${esc(runRange)} · PerfStudio Trend Analysis</div>
</div>

<div class="page">
  ${hdr('Comparison', `${(comparison.regressed || []).length} regressed · ${(comparison.improved || []).length} improved · ${(comparison.new || []).length} new · ${(comparison.removed || []).length} removed`)}
  <div class="content">
    <div class="card-title" style="color:#ef4444;margin-bottom:6px">Regressed APIs</div>${regressedTable}
    <div class="card-title" style="color:#22c55e;margin:14px 0 6px">Improved APIs</div>${improvedTable}
    <div class="two-col" style="margin-top:14px">
      <div><div class="card-title" style="color:#58a6ff">New APIs</div>${newTable}</div>
      <div><div class="card-title" style="color:#9ca3af">Removed APIs</div>${removedTable}</div>
    </div>
  </div>
  <div class="footer">Comparison · ${esc(runRange)} · PerfStudio Trend Analysis</div>
</div>

<div class="page">
  ${hdr('Insights & Recommendations', 'Deterministic trend insights + ranked, root-cause-based recommendations')}
  <div class="content">
    <div class="card-title" style="margin-bottom:6px">Trend Insights</div>
    ${insightsHtml}
    <div class="card-title" style="margin:16px 0 6px">Recommendations</div>
    ${recsHtml}
  </div>
  <div class="footer">Insights & Recommendations · ${esc(runRange)} · PerfStudio Trend Analysis</div>
</div>

<div class="page">
  ${hdr('Trend Charts', 'Response time, throughput and error rate across the selected executions')}
  <div class="content">
    <div class="card" style="margin-bottom:14px"><div class="card-title">Response Time Trend (Avg / P95)</div><div style="height:170px"><canvas id="c_rt"></canvas></div></div>
    <div class="card"><div class="card-title">Throughput &amp; Error Rate Trend</div><div style="height:170px"><canvas id="c_tps"></canvas></div></div>
  </div>
  <div class="footer">Trend Charts · ${esc(runRange)} · PerfStudio Trend Analysis</div>
</div>

${capacityPage}

</body>
<script>
${CHARTJS_SRC}
(function() {
  const D = ${DATA_JSON};
  const GRID = 'rgba(255,255,255,0.06)';
  const TICK = '#9ca3af';
  const FONT = { family: 'system-ui,sans-serif', size: 9 };
  const TIPBG = { backgroundColor:'#1e2130', titleColor:'#f0f1f3', bodyColor:'#c4c8d0', borderColor:'#2e3142', borderWidth:1, cornerRadius:4, padding:8 };
  let total = 0, ready = 0;
  function chartDone() { if (++ready >= total) window.__chartsReady = true; }
  function mkChart(id, type, data, opts) {
    const el = document.getElementById(id);
    if (!el) { chartDone(); return; }
    total++;
    try { new Chart(el, { type, data, options: { ...opts, animation: { duration: 0, onComplete: chartDone } } }); }
    catch (e) { chartDone(); }
  }
  const axes = (y2) => ({
    x: { ticks: { color: TICK, font: FONT, maxRotation: 30 }, grid: { color: GRID }, border: { color: 'rgba(255,255,255,0.1)' } },
    y: { ticks: { color: TICK, font: FONT }, grid: { color: GRID }, border: { color: 'rgba(255,255,255,0.1)' } },
    ...(y2 ? { y2: { position: 'right', ticks: { color: TICK, font: FONT }, grid: { drawOnChartArea: false }, border: { color: 'rgba(255,255,255,0.1)' } } } : {}),
  });
  const baseOpts = (y2) => ({
    responsive: true, maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { display: true, labels: { color: '#9ca3af', font: FONT, boxWidth: 10, padding: 10 } }, tooltip: TIPBG },
    scales: axes(y2),
  });

  if (D.scores) {
    mkChart('c_scores', 'bar', {
      labels: ['Overall', 'API Health', 'App Health', 'Regression', 'Reliability', 'Scalability'],
      datasets: [
        { label: 'Baseline', data: [D.scores.baseline.overall, D.scores.baseline.apiHealth, D.scores.baseline.appHealth, D.scores.baseline.regression, D.scores.baseline.reliability, D.scores.baseline.scalability].map(s => s?.value ?? null), backgroundColor: '#58a6ffcc', borderRadius: 3 },
        { label: 'Latest', data: [D.scores.latest.overall, D.scores.latest.apiHealth, D.scores.latest.appHealth, D.scores.latest.regression, D.scores.latest.reliability, D.scores.latest.scalability].map(s => s?.value ?? null), backgroundColor: '#49CC3Dcc', borderRadius: 3 },
      ],
    }, baseOpts());
  }

  if (D.trend) {
    const labels = D.trend.runs.map(r => new Date(r.started_at).toLocaleDateString());
    mkChart('c_rt', 'line', {
      labels,
      datasets: [
        { label: 'Avg RT', data: D.trend.series.avg, borderColor: '#49CC3D', backgroundColor: '#49CC3D20', borderWidth: 2, pointRadius: 3, tension: .3, fill: true },
        { label: 'P95', data: D.trend.series.p95, borderColor: '#58a6ff', backgroundColor: 'transparent', borderWidth: 2, pointRadius: 3, tension: .3 },
      ],
    }, baseOpts());
    mkChart('c_tps', 'line', {
      labels,
      datasets: [
        { label: 'TPS', data: D.trend.series.tps, borderColor: '#06b6d4', backgroundColor: '#06b6d420', borderWidth: 2, pointRadius: 3, tension: .3, fill: true, yAxisID: 'y' },
        { label: 'Error Rate (%)', data: D.trend.series.error_rate, borderColor: '#ef4444', backgroundColor: 'transparent', borderWidth: 2, pointRadius: 3, tension: .3, yAxisID: 'y2' },
      ],
    }, baseOpts(true));
  }

  if (total === 0) window.__chartsReady = true;
  setTimeout(() => { window.__chartsReady = true; }, 3000);
})();
</script>
</html>`;
}

async function renderPdf(data) {
  let browser;
  const tmpFiles = [];
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1122, height: 794, deviceScaleFactor: 1.5 });
    await page.setContent(buildHtml(data), { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.__chartsReady === true, { timeout: 8000 });

    const pageEls = await page.$$('.page');
    for (let i = 0; i < pageEls.length; i++) {
      const el = pageEls[i];
      await page.evaluate(e => { e.style.minHeight = '794px'; e.style.height = '794px'; e.style.overflow = 'hidden'; }, el);
      const tmpPath = path.join(os.tmpdir(), `PerfStudio_trend_page_${process.pid}_${i}.jpg`);
      await el.screenshot({ type: 'jpeg', quality: 95, path: tmpPath });
      tmpFiles.push(tmpPath);
    }

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
    for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch (_) {} }
  }
}

async function generateTrendAnalysisPdf(data, res) {
  try {
    const pdf = await renderPdf(data);
    res.end(pdf);
  } catch (e) {
    console.error('[exportEngine] error:', e);
    if (!res.headersSent) res.status(500).json({ error: 'PDF generation failed: ' + e.message });
    else res.end();
  }
}

module.exports = { generateTrendAnalysisPdf };
