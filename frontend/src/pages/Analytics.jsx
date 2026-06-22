import { useState, useEffect, useRef } from 'react';
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, BarElement, LineElement,
  PointElement, ArcElement, Title, Tooltip, Legend, Filler,
} from 'chart.js';
import { Bar, Line, Doughnut } from 'react-chartjs-2';
import api from '../api';
import CustomSelect from '../components/CustomSelect';
import EnvBar from '../components/EnvBar';

ChartJS.register(CategoryScale, LinearScale, BarElement, LineElement, PointElement, ArcElement, Title, Tooltip, Legend, Filler);

const PALETTE  = ['#49CC3D','#22c55e','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#f97316','#ec4899','#14b8a6','#a855f7'];
const ERR_PAL  = ['#ef4444','#f97316','#f59e0b','#8b5cf6','#06b6d4','#ec4899','#14b8a6','#3b82f6'];
const chartFont = { family: "'Inter','Segoe UI',sans-serif", size: 11 };

const TABS = [
  { id: 'summary',     label: 'Summary Report',       icon: 'ti-clipboard-list' },
  { id: 'dashboard',   label: 'Performance Dashboard', icon: 'ti-layout-dashboard' },
  { id: 'transaction', label: 'Transaction Breakdown', icon: 'ti-table' },
  { id: 'trend',       label: 'Trend Analysis',        icon: 'ti-trending-up' },
  { id: 'resource',    label: 'Resource Utilization',  icon: 'ti-cpu' },
  { id: 'errors',      label: 'Error Analysis',        icon: 'ti-alert-triangle' },
];

// ── Chart theme — always dark to match the Analytics dark page ───────────────
function makeChartTheme() {
  const gridColor = 'rgba(48,54,61,0.8)';
  const TOOLTIP_BASE = {
    backgroundColor: '#1c2330',
    titleColor:  '#e6edf3',
    bodyColor:   '#8b949e',
    borderColor: '#30363d',
    borderWidth: 1, cornerRadius: 6, padding: 10,
  };
  const SCALE_X = { ticks: { color: '#6e7681', font: chartFont }, grid: { color: gridColor }, border: { color: gridColor } };
  const SCALE_Y = { ticks: { color: '#6e7681', font: chartFont }, grid: { color: gridColor }, border: { color: gridColor } };
  return { TOOLTIP_BASE, SCALE_X, SCALE_Y, textPrimary: '#e6edf3', textSecondary: '#8b949e', textTertiary: '#6e7681' };
}

const BASE_SHARED = { responsive: true, maintainAspectRatio: false };

// Bar charts: intersect:false — tooltip fires when cursor is anywhere in the
// same vertical column as a bar (standard web-chart crosshair behaviour)
function mkBarOpts({ yFmt, xTrunc, showLegend, extraScales } = {}) {
  const { TOOLTIP_BASE, SCALE_X, SCALE_Y, textTertiary } = makeChartTheme();
  return {
    ...BASE_SHARED,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: showLegend
        ? { display: true, labels: { color: textTertiary, font: chartFont, boxWidth: 12, padding: 14 } }
        : { display: false },
      tooltip: {
        ...TOOLTIP_BASE,
        callbacks: yFmt ? { label: ctx => ` ${yFmt(ctx.parsed.y)}` } : undefined,
      },
    },
    scales: {
      x: {
        ...SCALE_X,
        ticks: {
          ...SCALE_X.ticks,
          maxRotation: 30,
          callback: xTrunc ? function(v) { const l = this.getLabelForValue(v); return l.length > 14 ? l.slice(0,13)+'…' : l; } : undefined,
        },
      },
      y: {
        ...SCALE_Y,
        ticks: { ...SCALE_Y.ticks, callback: yFmt ? v => yFmt(v) : undefined },
        ...(extraScales?.y || {}),
      },
      ...(extraScales || {}),
    },
  };
}

// Line charts: mode:'index' + intersect:false = standard crosshair behaviour
function mkLineOpts({ dualAxis, yFmt, y2Fmt, y2Label, yLabel, showLegend } = {}) {
  const { TOOLTIP_BASE, SCALE_X, SCALE_Y, textTertiary } = makeChartTheme();
  return {
    ...BASE_SHARED,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: showLegend !== false, labels: { color: textTertiary, font: chartFont, boxWidth: 12, padding: 14 } },
      tooltip: {
        ...TOOLTIP_BASE,
        callbacks: yFmt ? { label: ctx => ` ${yFmt(ctx.parsed.y)}` } : undefined,
      },
    },
    scales: {
      x: SCALE_X,
      y: {
        ...SCALE_Y,
        title: yLabel ? { display: true, text: yLabel, color: textTertiary, font: chartFont } : undefined,
        ticks: { ...SCALE_Y.ticks, callback: yFmt ? v => yFmt(v) : undefined },
      },
      ...(dualAxis ? {
        y2: {
          ...SCALE_Y,
          position: 'right',
          title: { display: true, text: y2Label || '', color: textTertiary, font: chartFont },
          ticks: { ...SCALE_Y.ticks, callback: y2Fmt ? v => y2Fmt(v) : undefined },
          grid: { drawOnChartArea: false },
        },
      } : {}),
    },
  };
}

function fmt(ms)   {
  const n = Number(ms);
  if (ms == null || isNaN(n) || !isFinite(n)) return '—';
  if (n >= 1000) return `${(n/1000).toFixed(2)}s`;
  return `${Math.round(n)}ms`;
}
function fmtB(b)   {
  const n = Number(b);
  if (b == null || isNaN(n) || !isFinite(n)) return '—';
  if (n === 0) return '0 B';
  if (n >= 1048576) return `${(n/1048576).toFixed(2)} MB`;
  if (n >= 1024) return `${(n/1024).toFixed(1)} KB`;
  return `${n} B`;
}
function safeN(v, fallback = 0) { const n = Number(v); return isNaN(n) || !isFinite(n) ? fallback : n; }
function parseDbDate(d) { if (!d) return null; const s = String(d).replace(' ', 'T'); return new Date(s.endsWith('Z') ? s : s + 'Z'); }
function fmtDate(d){ if (!d) return '—'; const dt = parseDbDate(d); return isNaN(dt) ? String(d) : dt.toLocaleString(); }
function trunc(s, n=20){ return s && s.length > n ? s.slice(0,n-1)+'…' : (s||''); }

// ── Analytics dark theme palette (always dark regardless of app theme) ───────
const D = {
  pageBg:     '#1a2035',   // 25% lighter than before
  cardBg:     '#222b42',   // card surface
  cardBg2:    '#1e2840',   // alternate / deeper surface
  border:     '#2e3a55',   // subtle borders
  borderGlow: '#49CC3D',
  textPri:    '#f0f3fa',   // bright white-ish
  textSec:    '#b8c4d8',   // clearly readable secondary
  textTer:    '#7a8eaa',   // muted tertiary
  accent:     '#49CC3D',
  accentBlue: '#58a6ff',
};

// ── UI atoms ─────────────────────────────────────────────────────────────────
function Card({ bg, border, children, style }) {
  return (
    <div style={{ background: bg||D.cardBg, border: `1px solid ${border||D.border}`, borderRadius: 10, padding: '16px 18px', ...style }}>
      {children}
    </div>
  );
}

function KPI({ icon, label, value, sub, color }) {
  return (
    <Card style={{ display:'flex', flexDirection:'column', gap:5, minWidth:0 }}>
      <div style={{ display:'flex', alignItems:'center', gap:6 }}>
        <i className={`ti ${icon}`} style={{ fontSize:14, color: color||D.accent }} />
        <span style={{ fontSize:10, fontWeight:700, color:D.textTer, textTransform:'uppercase', letterSpacing:'.6px' }}>{label}</span>
      </div>
      <div style={{ fontSize:24, fontWeight:700, color: color||D.textPri, lineHeight:1.1, fontFamily:'var(--font-mono)' }}>{value}</div>
      {sub && <div style={{ fontSize:11, color:D.textSec }}>{sub}</div>}
    </Card>
  );
}

function ChartCard({ title, height=260, children }) {
  return (
    <Card>
      {title && <div style={{ fontSize:12, fontWeight:600, color:D.textSec, marginBottom:12, display:'flex', alignItems:'center', gap:6 }}>{title}</div>}
      <div style={{ height }}>{children}</div>
    </Card>
  );
}

function SectionLabel({ icon, color, children }) {
  return (
    <div style={{ fontSize:12, fontWeight:600, color:D.textSec, display:'flex', alignItems:'center', gap:6 }}>
      <i className={`ti ${icon}`} style={{ color: color||D.accent }} />{children}
    </div>
  );
}

// ── tab panels ───────────────────────────────────────────────────────────────

const PATCH_PROPS = [
  'jmeter.save.saveservice.latency=true',
  'jmeter.save.saveservice.connect_time=true',
  'jmeter.save.saveservice.bytes=true',
  'jmeter.save.saveservice.sent_bytes=true',
];

function LatencyPatchPrompt() {
  const [step, setStep] = useState('checking'); // checking | info | already-set | confirm | patching | done | error
  const [result, setResult] = useState(null);

  useEffect(() => {
    api.get('/execution/jmeter/latency-status')
      .then(({ data }) => setStep(data.configured ? 'already-set' : 'info'))
      .catch(() => setStep('info'));
  }, []);

  async function applyPatch() {
    setStep('patching');
    try {
      const { data } = await api.post('/execution/jmeter/enable-latency');
      setResult(data);
      setStep('done');
    } catch (e) {
      setResult({ error: e.response?.data?.error || 'Failed to patch jmeter.properties' });
      setStep('error');
    }
  }

  if (step === 'checking') return (
    <div style={{ marginTop:14, padding:'10px 14px', fontSize:12, color:D.textTer, display:'flex', alignItems:'center', gap:8 }}>
      <span className="spinner" style={{ width:14, height:14 }} /> Checking jmeter.properties…
    </div>
  );

  if (step === 'already-set') return (
    <div style={{ marginTop:14, padding:'12px 16px', background:'rgba(34,197,94,0.07)', border:'1px solid rgba(34,197,94,0.2)', borderRadius:8 }}>
      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:6 }}>
        <i className="ti ti-circle-check" style={{ color:'#22c55e', fontSize:15 }} />
        <span style={{ fontSize:13, fontWeight:600, color:'#22c55e' }}>Latency properties already enabled</span>
      </div>
      <div style={{ fontSize:12, color:D.textTer, lineHeight:1.6 }}>
        Your <code style={{ color:D.textSec }}>jmeter.properties</code> is correctly configured.
        This run was captured before the settings took effect.
      </div>
      <div style={{ marginTop:10, fontSize:12, color:'#f59e0b', display:'flex', alignItems:'center', gap:6 }}>
        <i className="ti ti-player-play" />
        Run a new test — latency &amp; connect data will appear in the next analytics report.
      </div>
    </div>
  );

  if (step === 'done') return (
    <div style={{ marginTop:14, padding:'12px 16px', background:'rgba(34,197,94,0.08)', border:'1px solid rgba(34,197,94,0.25)', borderRadius:8 }}>
      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8 }}>
        <i className="ti ti-circle-check" style={{ color:'#22c55e', fontSize:16 }} />
        <span style={{ fontSize:13, fontWeight:600, color:'#22c55e' }}>jmeter.properties updated successfully</span>
      </div>
      <div style={{ fontSize:12, color:D.textTer, marginBottom:6 }}>
        File: <code style={{ color:D.textSec }}>{result?.path}</code>
      </div>
      {result?.changed?.length > 0 ? (
        <ul style={{ margin:'6px 0 0 0', paddingLeft:18, fontSize:11, color:D.textTer }}>
          {result.changed.map(k => <li key={k} style={{ color:'#86efac' }}>{k}=true</li>)}
        </ul>
      ) : (
        <div style={{ fontSize:12, color:D.textTer }}>All properties were already set correctly.</div>
      )}
      <div style={{ marginTop:10, fontSize:12, color:'#f59e0b' }}>
        <i className="ti ti-refresh" style={{ marginRight:5 }} />
        Re-run your test to see latency data in future analytics reports.
      </div>
    </div>
  );

  if (step === 'error') return (
    <div style={{ marginTop:14, padding:'12px 16px', background:'rgba(239,68,68,0.08)', border:'1px solid rgba(239,68,68,0.25)', borderRadius:8 }}>
      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:6 }}>
        <i className="ti ti-circle-x" style={{ color:'#ef4444', fontSize:16 }} />
        <span style={{ fontSize:13, fontWeight:600, color:'#ef4444' }}>Failed to update jmeter.properties</span>
      </div>
      <div style={{ fontSize:12, color:D.textTer, marginBottom:10 }}>{result?.error}</div>
      <button className="btn-secondary btn-sm" onClick={() => setStep('info')}>Try again</button>
    </div>
  );

  if (step === 'confirm') return (
    <div style={{ marginTop:14, padding:'14px 16px', background:'rgba(245,158,11,0.07)', border:'1px solid rgba(245,158,11,0.3)', borderRadius:8 }}>
      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:10 }}>
        <i className="ti ti-alert-triangle" style={{ color:'#f59e0b', fontSize:15 }} />
        <span style={{ fontSize:13, fontWeight:600, color:'#f0c060' }}>Confirm changes to jmeter.properties</span>
      </div>
      <div style={{ fontSize:12, color:D.textTer, marginBottom:10 }}>
        The following lines will be set (or uncommented) in your JMeter <code style={{ color:D.textSec }}>bin/jmeter.properties</code> file:
      </div>
      <div style={{ background:'rgba(0,0,0,0.3)', borderRadius:6, padding:'8px 12px', fontFamily:'var(--font-mono)', fontSize:11, color:'#86efac', marginBottom:14, lineHeight:1.8 }}>
        {PATCH_PROPS.map(p => <div key={p}>{p}</div>)}
      </div>
      <div style={{ display:'flex', gap:8 }}>
        <button className="btn-primary btn-sm" onClick={applyPatch} disabled={step==='patching'}>
          {step==='patching' ? <><span className="spinner" style={{ margin:0, marginRight:6 }} />Applying…</> : <><i className="ti ti-check" style={{ marginRight:5 }} />Apply Changes</>}
        </button>
        <button className="btn-secondary btn-sm" onClick={() => setStep('info')}>Cancel</button>
      </div>
    </div>
  );

  // default: info state
  return (
    <div style={{ marginTop:14, padding:'12px 16px', background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.08)', borderRadius:8 }}>
      <div style={{ fontSize:12, color:D.textTer, marginBottom:12, lineHeight:1.6 }}>
        <i className="ti ti-info-circle" style={{ marginRight:6, color:D.textTer }} />
        Latency &amp; connect time data was not recorded in this JTL. To capture it in future runs, the following properties must be enabled in JMeter's <code style={{ color:D.textSec }}>jmeter.properties</code>:
      </div>
      <div style={{ background:'rgba(0,0,0,0.25)', borderRadius:6, padding:'7px 12px', fontFamily:'var(--font-mono)', fontSize:11, color:D.textTer, marginBottom:12, lineHeight:1.8 }}>
        {PATCH_PROPS.map(p => <div key={p}>{p}</div>)}
      </div>
      <button className="btn-primary btn-sm" onClick={() => setStep('confirm')}>
        <i className="ti ti-settings-automation" style={{ marginRight:6 }} />
        Enable Automatically in jmeter.properties
      </button>
    </div>
  );
}

function SummaryTab({ data, runNum, selectedRun }) {
  const s = data.summary;
  const errRate  = safeN(s.error_rate);
  const errColor = errRate === 0 ? '#22c55e' : errRate < 5 ? '#f59e0b' : '#ef4444';

  // Prefer DB row values — JTL meta may have duration_s=0 or missing finished_at
  const finishedAt = data.meta.finished_at || selectedRun?.finished_at || null;
  const durationS  = data.meta.duration_s > 0
    ? data.meta.duration_s
    : (selectedRun?.finished_at && selectedRun?.started_at
        ? Math.round((parseDbDate(selectedRun.finished_at) - parseDbDate(selectedRun.started_at)) / 1000)
        : null);

  // detect whether latency/bytes columns were present in the JTL
  const hasLatency = safeN(s.avg_latency) > 0 || safeN(s.avg_connect) > 0;
  const hasBytes   = safeN(s.total_bytes_received) > 0 || safeN(s.total_bytes_sent) > 0;

  const rtDist = {
    labels: ['< 500ms','500ms–1s','1s–2s','2s–5s','> 5s'],
    datasets: [{
      data: (() => {
        const buckets = [0,0,0,0,0];
        for (const a of data.by_api) {
          const v = safeN(a.avg);
          if (v < 500) buckets[0]++;
          else if (v < 1000) buckets[1]++;
          else if (v < 2000) buckets[2]++;
          else if (v < 5000) buckets[3]++;
          else buckets[4]++;
        }
        return buckets;
      })(),
      backgroundColor: ['#22c55e','#84cc16','#f59e0b','#f97316','#ef4444'],
      borderWidth: 0,
    }],
  };
  const { TOOLTIP_BASE: TB1, textTertiary: tt1 } = makeChartTheme();
  const doughOpts = {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { display: true, position: 'right', labels: { color: tt1, font: chartFont, boxWidth: 12, padding: 10 } },
      tooltip: TB1,
    },
    cutout: '62%',
  };

  const avgRt    = safeN(s.avg_response_time);
  const avgLat   = safeN(s.avg_latency);
  const avgConn  = safeN(s.avg_connect);
  const processing = Math.max(0, avgRt - avgLat);

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
      {/* Run header */}
      <div style={{ background:D.cardBg, border:`1px solid ${D.border}`, borderRadius:12, padding:'16px 20px' }}>
        <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:6 }}>
          <i className="ti ti-chart-dots-3" style={{ fontSize:18, color:'#49CC3D' }} />
          <span style={{ fontSize:17, fontWeight:700, color:D.textPri }}>{data.meta.suite_name}</span>
          <span className={`badge ${data.meta.status==='completed'?'tag-green':'tag-red'}`}>{data.meta.status}</span>
        </div>
        <div style={{ display:'flex', gap:18, flexWrap:'wrap' }}>
          {[['ti-clock-play','#22c55e','Start',fmtDate(data.meta.started_at)],['ti-clock-stop','#ef4444','End',finishedAt ? fmtDate(finishedAt) : '—'],['ti-hourglass','#f59e0b','Duration',durationS != null ? `${durationS}s` : '—']].map(([ic,cl,lbl,val])=>(
            <div key={lbl} style={{ fontSize:12, color:D.textSec, display:'flex', alignItems:'center', gap:5 }}>
              <i className={`ti ${ic}`} style={{ fontSize:13, color:cl }} />
              <span style={{ color:D.textSec }}>{lbl}:</span> {val}
            </div>
          ))}
        </div>
      </div>

      {/* KPI grid */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10 }}>
        <KPI icon="ti-list-numbers" label="Total Requests"  value={(s.total_requests||0).toLocaleString()} sub="All samplers" color="#49CC3D" />
        <KPI icon="ti-circle-check" label="Passed"          value={(s.total_success||0).toLocaleString()} sub={`${(100-errRate).toFixed(1)}% pass rate`} color="#22c55e" />
        <KPI icon="ti-circle-x"     label="Failed"          value={(s.total_failed||0).toLocaleString()}  sub="HTTP errors / assertions" color="#ef4444" />
        <KPI icon="ti-alert-triangle" label="Error Rate"    value={`${errRate}%`} sub={errRate===0?'All passing':errRate<5?'Acceptable':'High — investigate'} color={errColor} />
        <KPI icon="ti-clock"          label="Avg Response"  value={fmt(s.avg_response_time)} sub="Mean across all requests" color="#8b5cf6" />
        <KPI icon="ti-arrow-down"     label="Min Response"  value={fmt(s.min_response_time)} sub="Fastest single request" color="#22c55e" />
        <KPI icon="ti-arrow-up"       label="Max Response"  value={fmt(s.max_response_time)} sub="Slowest single request" color="#ef4444" />
        <KPI icon="ti-bolt"           label="Throughput"    value={`${safeN(s.overall_tps)} TPS`} sub="Requests per second" color="#06b6d4" />
        <KPI icon="ti-chart-line"     label="P90"           value={fmt(s.p90)} sub="90th percentile" color="#a78bfa" />
        <KPI icon="ti-chart-line"     label="P95"           value={fmt(s.p95)} sub="95th percentile" color="#06b6d4" />
        <KPI icon="ti-arrow-bar-to-down" label="Bytes Received" value={hasBytes ? fmtB(s.total_bytes_received) : 'N/A'} sub={hasBytes ? 'Total download' : 'Not in JTL'} color="#f59e0b" />
        <KPI icon="ti-arrow-bar-to-up"   label="Bytes Sent"     value={hasBytes ? fmtB(s.total_bytes_sent) : 'N/A'} sub={hasBytes ? 'Total upload' : 'Not in JTL'} color="#f97316" />
      </div>

      {/* RT distribution donut + latency breakdown */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14 }}>
        <ChartCard title={<SectionLabel icon="ti-chart-donut-3" color="#8b5cf6">Response Time Distribution (by API avg)</SectionLabel>} height={200}>
          <Doughnut data={rtDist} options={doughOpts} />
        </ChartCard>
        <Card>
          <SectionLabel icon="ti-stopwatch" color="#f59e0b">Latency Breakdown</SectionLabel>
          {!hasLatency ? (
            <LatencyPatchPrompt />
          ) : (
            <div style={{ marginTop:14, display:'flex', flexDirection:'column', gap:10 }}>
              {[
                ['Connect Time',             avgConn,     avgRt, '#ef4444'],
                ['Time to First Byte (TTFB)', avgLat,     avgRt, '#f59e0b'],
                ['Processing / Download',     processing, avgRt, '#49CC3D'],
              ].map(([lbl, val, total, color]) => {
                const pct = total > 0 ? Math.min(100, (val / total) * 100) : 0;
                return (
                  <div key={lbl}>
                    <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4 }}>
                      <span style={{ fontSize:11, color:D.textTer }}>{lbl}</span>
                      <span style={{ fontSize:11, fontFamily:'var(--font-mono)', color:D.textPri }}>{fmt(val)}</span>
                    </div>
                    <div style={{ height:7, borderRadius:4, background:'rgba(255,255,255,0.07)', overflow:'hidden' }}>
                      <div style={{ height:'100%', width:`${pct}%`, background:color, borderRadius:4, transition:'width .4s' }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function DashboardTab({ data }) {
  const labels = data.by_api.map(a => a.label);
  const tlLabels = data.timeline.map(t => `${t.second}s`);

  const avgRtChart = {
    labels,
    datasets: [{ label:'Avg RT', data: data.by_api.map(a=>a.avg), backgroundColor: labels.map((_,i)=>PALETTE[i%PALETTE.length]+'cc'), borderColor: labels.map((_,i)=>PALETTE[i%PALETTE.length]), borderWidth:1, borderRadius:4 }],
  };
  const tpsChart = {
    labels,
    datasets: [{ label:'TPS', data: data.by_api.map(a=>a.tps), backgroundColor: labels.map((_,i)=>PALETTE[(i+3)%PALETTE.length]+'cc'), borderColor: labels.map((_,i)=>PALETTE[(i+3)%PALETTE.length]), borderWidth:1, borderRadius:4 }],
  };
  const tlChart = {
    labels: tlLabels,
    datasets: [
      { label:'Avg RT (ms)', data: data.timeline.map(t=>t.avg_rt), borderColor:'#49CC3D', backgroundColor:'#49CC3D20', borderWidth:2, pointRadius:1, tension:.3, fill:true, yAxisID:'y' },
      { label:'Req/s', data: data.timeline.map(t=>t.tps), borderColor:'#06b6d4', backgroundColor:'#06b6d420', borderWidth:2, pointRadius:1, tension:.3, fill:false, yAxisID:'y2' },
    ],
  };

  const TOP5_SLOW = [...data.by_api].sort((a,b)=>b.avg-a.avg).slice(0,5);
  const slowChart = {
    labels: TOP5_SLOW.map(a=>a.label),
    datasets: [{ label:'Avg RT', data: TOP5_SLOW.map(a=>a.avg), backgroundColor:['#ef4444cc','#f97316cc','#f59e0bcc','#eab308cc','#84cc16cc'], borderColor:['#ef4444','#f97316','#f59e0b','#eab308','#84cc16'], borderWidth:1, borderRadius:4 }],
  };

  const chartH = Math.max(180, labels.length * 32 + 50);

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14 }}>
        <ChartCard title={<SectionLabel icon="ti-clock" color="#49CC3D">Avg Response Time per API</SectionLabel>} height={chartH}>
          <Bar data={avgRtChart} options={mkBarOpts({ yFmt:fmt, xTrunc:true })} />
        </ChartCard>
        <ChartCard title={<SectionLabel icon="ti-bolt" color="#22c55e">TPS per API</SectionLabel>} height={chartH}>
          <Bar data={tpsChart} options={mkBarOpts({ xTrunc:true })} />
        </ChartCard>
      </div>
      {data.timeline.length > 1 && (
        <ChartCard title={<SectionLabel icon="ti-timeline" color="#06b6d4">Response Time &amp; Throughput Over Time</SectionLabel>} height={220}>
          <Line data={tlChart} options={mkLineOpts({ dualAxis:true, yFmt:fmt, y2Label:'Req/s', yLabel:'Avg RT (ms)' })} />
        </ChartCard>
      )}
      <ChartCard title={<SectionLabel icon="ti-hourglass-high" color="#ef4444">Top 5 Slowest APIs (avg response time)</SectionLabel>} height={220}>
        <Bar data={slowChart} options={mkBarOpts({ yFmt:fmt, xTrunc:true })} />
      </ChartCard>
    </div>
  );
}

function TransactionTab({ data }) {
  const [sort, setSort] = useState({ col:'avg', dir:'desc' });
  const [filter, setFilter] = useState('');
  const cols = [
    { key:'label',      label:'API / Sampler', align:'left' },
    { key:'total',      label:'Total',         align:'right' },
    { key:'success',    label:'Success',       align:'right' },
    { key:'failed',     label:'Failed',        align:'right' },
    { key:'error_rate', label:'Err %',         align:'right' },
    { key:'avg',        label:'Avg RT',        align:'right' },
    { key:'min',        label:'Min',           align:'right' },
    { key:'max',        label:'Max',           align:'right' },
    { key:'median',     label:'Median',        align:'right' },
    { key:'p90',        label:'P90',           align:'right' },
    { key:'p95',        label:'P95',           align:'right' },
    { key:'avg_latency',label:'TTFB',          align:'right' },
    { key:'avg_connect',label:'Connect',       align:'right' },
    { key:'avg_bytes',  label:'Avg Bytes',     align:'right' },
    { key:'tps',        label:'TPS',           align:'right' },
  ];

  const sorted = [...data.by_api]
    .filter(a => !filter || a.label.toLowerCase().includes(filter.toLowerCase()))
    .sort((a,b) => {
      const va = a[sort.col], vb = b[sort.col];
      if (typeof va === 'string') return sort.dir==='asc' ? va.localeCompare(vb) : vb.localeCompare(va);
      return sort.dir==='asc' ? va-vb : vb-va;
    });

  function toggleSort(col) {
    setSort(s => s.col===col ? { col, dir: s.dir==='asc'?'desc':'asc' } : { col, dir:'desc' });
  }

  const p9095Chart = {
    labels: data.by_api.map(a=>a.label),
    datasets: [
      { label:'P90', data: data.by_api.map(a=>a.p90), backgroundColor:'#8b5cf6cc', borderColor:'#8b5cf6', borderWidth:1, borderRadius:3 },
      { label:'P95', data: data.by_api.map(a=>a.p95), backgroundColor:'#06b6d4cc', borderColor:'#06b6d4', borderWidth:1, borderRadius:3 },
    ],
  };

  const chartH = Math.max(160, data.by_api.length * 30 + 50);

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
      <ChartCard title={<SectionLabel icon="ti-percentage" color="#8b5cf6">P90 &amp; P95 per API</SectionLabel>} height={chartH}>
        <Bar data={p9095Chart} options={mkBarOpts({ yFmt:fmt, xTrunc:true, showLegend:true })} />
      </ChartCard>

      <Card>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12, gap:10 }}>
          <SectionLabel icon="ti-table" color="#f59e0b">Full Transaction Table</SectionLabel>
          <input value={filter} onChange={e=>setFilter(e.target.value)} placeholder="Filter by name…" style={{ fontSize:12, padding:'4px 10px', width:200 }} />
        </div>
        <div style={{ overflowX:'auto' }}>
          <table className="dark-table" style={{ width:'100%', borderCollapse:'collapse', fontSize:11 }}>
            <thead>
              <tr style={{ background:'rgba(255,255,255,0.03)' }}>
                {cols.map(c=>(
                  <th key={c.key} onClick={()=>toggleSort(c.key)} style={{ padding:'8px 10px', textAlign:c.align, color: sort.col===c.key?D.accent:D.textTer, fontWeight:600, fontSize:10, textTransform:'uppercase', letterSpacing:'.5px', borderBottom:`1px solid ${D.border}`, whiteSpace:'nowrap', cursor:'pointer', userSelect:'none' }}>
                    {c.label} {sort.col===c.key ? (sort.dir==='asc'?'↑':'↓') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((a,idx)=>(
                <tr key={a.label} style={{ borderBottom:'1px solid rgba(255,255,255,0.04)', background: idx%2===0?'transparent':'rgba(255,255,255,0.015)' }}>
                  <td style={{ padding:'7px 10px', color:D.textPri, fontWeight:500, maxWidth:180, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                    <span style={{ display:'inline-block', width:7, height:7, borderRadius:'50%', background:PALETTE[idx%PALETTE.length], marginRight:7 }} />
                    {a.label}
                  </td>
                  <td style={{ padding:'7px 10px', textAlign:'right', fontFamily:'var(--font-mono)', color:D.textPri }}>{a.total}</td>
                  <td style={{ padding:'7px 10px', textAlign:'right', fontFamily:'var(--font-mono)', color:'#4ade80' }}>{a.success}</td>
                  <td style={{ padding:'7px 10px', textAlign:'right', fontFamily:'var(--font-mono)', color: a.failed>0?'#f87171':'#9da3ae' }}>{a.failed}</td>
                  <td style={{ padding:'7px 10px', textAlign:'right', fontFamily:'var(--font-mono)' }}>
                    <span style={{ color: a.error_rate===0?'#22c55e':a.error_rate<5?'#f59e0b':'#ef4444', fontWeight:600 }}>{a.error_rate}%</span>
                  </td>
                  {['avg','min','max','median','p90','p95'].map(k=>(
                    <td key={k} style={{ padding:'7px 10px', textAlign:'right', fontFamily:'var(--font-mono)', color:D.textSec }}>{fmt(a[k])}</td>
                  ))}
                  <td style={{ padding:'7px 10px', textAlign:'right', fontFamily:'var(--font-mono)', color:D.textSec }}>{safeN(a.avg_latency) > 0 ? fmt(a.avg_latency) : '—'}</td>
                  <td style={{ padding:'7px 10px', textAlign:'right', fontFamily:'var(--font-mono)', color:D.textSec }}>{safeN(a.avg_connect) > 0 ? fmt(a.avg_connect) : '—'}</td>
                  <td style={{ padding:'7px 10px', textAlign:'right', fontFamily:'var(--font-mono)', color:D.textSec }}>{safeN(a.avg_bytes) > 0 ? fmtB(a.avg_bytes) : '—'}</td>
                  <td style={{ padding:'7px 10px', textAlign:'right', fontFamily:'var(--font-mono)', color:'#f59e0b', fontWeight:600 }}>{a.tps}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function TrendTab({ data }) {
  if (!data.timeline.length) return <div className="empty"><div className="empty-title">No timeline data available</div></div>;
  const tl = data.timeline;
  const tlL = tl.map(t=>`${t.second}s`);

  const hasLatency = tl.some(t => safeN(t.avg_latency) > 0);
  const hasThreads = tl.some(t => safeN(t.threads) > 0);
  const hasErrors  = tl.some(t => safeN(t.errors) > 0);

  const rtDatasets = [
    { label:'Avg RT', data: tl.map(t=>safeN(t.avg_rt)), borderColor:'#49CC3D', backgroundColor:'#49CC3D25', borderWidth:2, pointRadius:1, tension:.3, fill:true },
  ];
  if (hasLatency) rtDatasets.push({ label:'TTFB', data: tl.map(t=>safeN(t.avg_latency)), borderColor:'#f59e0b', backgroundColor:'transparent', borderWidth:1.5, pointRadius:0, tension:.3, fill:false, borderDash:[4,3] });

  const tpsChart = { labels: tlL, datasets: [{ label:'Requests/s', data: tl.map(t=>safeN(t.tps)), borderColor:'#22c55e', backgroundColor:'#22c55e20', borderWidth:2, pointRadius:1, tension:.3, fill:true }] };
  const errChart = { labels: tlL, datasets: [{ label:'Error Rate %', data: tl.map(t=>safeN(t.error_rate)), borderColor:'#ef4444', backgroundColor:'#ef444420', borderWidth:2, pointRadius:1, tension:.3, fill:true }] };
  const threadChart = { labels: tlL, datasets: [{ label:'Active Threads', data: tl.map(t=>safeN(t.threads)), borderColor:'#8b5cf6', backgroundColor:'#8b5cf625', borderWidth:2, pointRadius:1, tension:.3, fill:true }] };

  const noData = <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100%', fontSize:12, color:D.textTer }}><i className="ti ti-info-circle" style={{ marginRight:6 }} />Not recorded in this JTL</div>;

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14 }}>
        <ChartCard title={<SectionLabel icon="ti-clock" color="#49CC3D">Response Time Trend{hasLatency ? ' (RT & TTFB)' : ''}</SectionLabel>} height={220}>
          <Line data={{ labels:tlL, datasets:rtDatasets }} options={mkLineOpts({ yFmt:fmt, yLabel:'ms' })} />
        </ChartCard>
        <ChartCard title={<SectionLabel icon="ti-bolt" color="#22c55e">Throughput Trend (Requests/s)</SectionLabel>} height={220}>
          <Line data={tpsChart} options={mkLineOpts({ yLabel:'Req/s' })} />
        </ChartCard>
        <ChartCard title={<SectionLabel icon="ti-alert-triangle" color="#ef4444">Error Rate Over Time (%)</SectionLabel>} height={220}>
          {hasErrors ? <Line data={errChart} options={mkLineOpts({ yLabel:'Error %' })} /> : noData}
        </ChartCard>
        <ChartCard title={<SectionLabel icon="ti-users" color="#8b5cf6">Concurrent Users (Active Threads)</SectionLabel>} height={220}>
          {hasThreads ? <Line data={threadChart} options={mkLineOpts({ yLabel:'Threads' })} /> : noData}
        </ChartCard>
      </div>
    </div>
  );
}

function ResourceTab({ data }) {
  const tl = data.timeline;
  if (!tl.length) return <div className="empty"><div className="empty-title">No resource data available</div></div>;
  const tlL = tl.map(t=>`${t.second}s`);

  const bytesChart = {
    labels: tlL,
    datasets: [
      { label:'Received (B/s)', data: tl.map(t=>t.bytes_received||0), borderColor:'#06b6d4', backgroundColor:'#06b6d420', borderWidth:2, pointRadius:1, tension:.3, fill:true, yAxisID:'y' },
      { label:'Sent (B/s)', data: tl.map(t=>t.bytes_sent||0), borderColor:'#f97316', backgroundColor:'transparent', borderWidth:1.5, pointRadius:0, tension:.3, fill:false, yAxisID:'y' },
    ],
  };
  const threadChart = {
    labels: tlL,
    datasets: [{ label:'Active Threads', data: tl.map(t=>t.threads||0), borderColor:'#8b5cf6', backgroundColor:'#8b5cf625', borderWidth:2, pointRadius:1, tension:.3, fill:true }],
  };
  const connChart = {
    labels: tlL,
    datasets: [
      { label:'Avg Connect', data: tl.map(t=>t.avg_connect||0), borderColor:'#ef4444', backgroundColor:'transparent', borderWidth:1.5, pointRadius:0, tension:.3, fill:false },
      { label:'Avg TTFB', data: tl.map(t=>t.avg_latency||0), borderColor:'#f59e0b', backgroundColor:'transparent', borderWidth:1.5, pointRadius:0, tension:.3, fill:false },
      { label:'Avg Total RT', data: tl.map(t=>t.avg_rt), borderColor:'#49CC3D', backgroundColor:'#49CC3D15', borderWidth:2, pointRadius:1, tension:.3, fill:true },
    ],
  };

  const s = data.summary;
  const hasBytes   = safeN(s.total_bytes_received) > 0 || safeN(s.total_bytes_sent) > 0;
  const hasLatency = safeN(s.avg_latency) > 0 || safeN(s.avg_connect) > 0;
  const hasThreads = tl.some(t => safeN(t.threads) > 0);
  const bwTotal    = safeN(s.total_bytes_received) + safeN(s.total_bytes_sent);
  const bwRecvPct  = bwTotal > 0 ? ((safeN(s.total_bytes_received)/bwTotal)*100).toFixed(1) : '—';

  const notInJTL = (
    <div style={{ padding:'10px 14px', background:D.cardBg2, border:`1px solid ${D.border}`, borderRadius:7, fontSize:12, color:D.textTer }}>
      <i className="ti ti-info-circle" style={{ marginRight:6 }} />
      Not recorded in this JTL. Enable in JMeter properties if needed.
    </div>
  );

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
      {/* Bandwidth summary cards */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10 }}>
        <KPI icon="ti-arrow-bar-to-down" label="Total Received" value={hasBytes ? fmtB(s.total_bytes_received) : 'N/A'} sub={hasBytes ? `${bwRecvPct}% of traffic` : 'Not in JTL'} color="#06b6d4" />
        <KPI icon="ti-arrow-bar-to-up"   label="Total Sent"     value={hasBytes ? fmtB(s.total_bytes_sent) : 'N/A'}     sub={hasBytes ? 'Request payload' : 'Not in JTL'} color="#f97316" />
        <KPI icon="ti-network"           label="Avg TTFB"       value={hasLatency ? fmt(s.avg_latency) : 'N/A'}          sub={hasLatency ? 'Time to first byte' : 'Not in JTL'} color="#f59e0b" />
        <KPI icon="ti-plug-connected"    label="Avg Connect"    value={hasLatency ? fmt(s.avg_connect) : 'N/A'}          sub={hasLatency ? 'TCP handshake time' : 'Not in JTL'} color="#ef4444" />
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14 }}>
        <ChartCard title={<SectionLabel icon="ti-network" color="#06b6d4">Network Throughput Over Time</SectionLabel>} height={220}>
          {hasBytes ? <Line data={bytesChart} options={mkLineOpts({ dualAxis:false, yFmt:v=>fmtB(v), showLegend:true, yLabel:'Bytes/s' })} /> : notInJTL}
        </ChartCard>
        <ChartCard title={<SectionLabel icon="ti-users" color="#8b5cf6">Thread Utilization Over Time</SectionLabel>} height={220}>
          {hasThreads ? <Line data={threadChart} options={mkLineOpts({ yLabel:'Threads' })} /> : notInJTL}
        </ChartCard>
      </div>

      <ChartCard title={<SectionLabel icon="ti-layers-linked" color="#f59e0b">Response Time Breakdown (Connect → TTFB → Total)</SectionLabel>} height={220}>
        {hasLatency ? (
          <Line data={connChart} options={mkLineOpts({ yFmt:fmt, showLegend:true, yLabel:'ms' })} />
        ) : (
          <Line data={{ labels: tl.map(t=>`${t.second}s`), datasets: [{ label:'Avg Total RT', data: tl.map(t=>t.avg_rt), borderColor:'#49CC3D', backgroundColor:'#49CC3D15', borderWidth:2, pointRadius:1, tension:.3, fill:true }] }} options={mkLineOpts({ yFmt:fmt, yLabel:'ms' })} />
        )}
      </ChartCard>

      {/* Per-API latency breakdown table */}
      <Card>
        <SectionLabel icon="ti-table-column" color="#49CC3D">Per-API Timing Breakdown</SectionLabel>
        <div style={{ overflowX:'auto', marginTop:12 }}>
          <table className="dark-table" style={{ width:'100%', borderCollapse:'collapse', fontSize:11 }}>
            <thead>
              <tr style={{ background:'rgba(255,255,255,0.03)' }}>
                {['API / Sampler','Avg RT','Avg TTFB','Avg Connect','Processing','Avg Bytes'].map(h=>(
                  <th key={h} style={{ padding:'7px 10px', textAlign: h==='API / Sampler'?'left':'right', color:D.textTer, fontWeight:600, fontSize:10, textTransform:'uppercase', letterSpacing:'.5px', borderBottom:`1px solid ${D.border}`, whiteSpace:'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.by_api.map((a,i)=>(
                <tr key={a.label} style={{ borderBottom:'1px solid rgba(255,255,255,0.04)', background: i%2===0?'transparent':'rgba(255,255,255,0.015)' }}>
                  <td style={{ padding:'7px 10px', color:D.textPri, fontWeight:500, maxWidth:180, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                    <span style={{ display:'inline-block', width:7, height:7, borderRadius:'50%', background:PALETTE[i%PALETTE.length], marginRight:7 }} />
                    {a.label}
                  </td>
                  <td style={{ padding:'7px 10px', textAlign:'right', fontFamily:'var(--font-mono)', color:D.textSec }}>{fmt(a.avg)}</td>
                  <td style={{ padding:'7px 10px', textAlign:'right', fontFamily:'var(--font-mono)', color:'#f59e0b' }}>{safeN(a.avg_latency)>0 ? fmt(a.avg_latency) : '—'}</td>
                  <td style={{ padding:'7px 10px', textAlign:'right', fontFamily:'var(--font-mono)', color:'#ef4444' }}>{safeN(a.avg_connect)>0 ? fmt(a.avg_connect) : '—'}</td>
                  <td style={{ padding:'7px 10px', textAlign:'right', fontFamily:'var(--font-mono)', color:'#49CC3D' }}>{safeN(a.avg_latency)>0 ? fmt(Math.max(0,a.avg - a.avg_latency)) : '—'}</td>
                  <td style={{ padding:'7px 10px', textAlign:'right', fontFamily:'var(--font-mono)', color:D.textSec }}>{safeN(a.avg_bytes)>0 ? fmtB(a.avg_bytes) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function ErrorsTab({ data }) {
  // Fallback: reconstruct error info from by_api when backend didn't send errors array
  const errors = (() => {
    if (data.errors && data.errors.length > 0) return data.errors;
    // derive from by_api response_codes if available
    const derived = [];
    for (const a of data.by_api) {
      if (!a.failed) continue;
      if (a.response_codes && Object.keys(a.response_codes).length > 0) {
        for (const [code, count] of Object.entries(a.response_codes)) {
          derived.push({ label: a.label, response_code: code, response_message: '', failure_message: '', count });
        }
      } else {
        derived.push({ label: a.label, response_code: 'N/A', response_message: '', failure_message: '', count: a.failed });
      }
    }
    return derived.sort((a,b) => b.count - a.count);
  })();

  if (!errors.length && safeN(data.summary.total_failed) === 0) {
    return (
      <div className="empty">
        <i className="ti ti-circle-check" style={{ fontSize:40, color:'#22c55e', marginBottom:10 }} />
        <div className="empty-title" style={{ color:'#22c55e' }}>No errors detected</div>
        <div className="empty-desc">All {(data.summary.total_requests||0).toLocaleString()} requests passed successfully.</div>
      </div>
    );
  }

  // Error distribution donut
  const topErrors = errors.slice(0,6);
  const errDonut = {
    labels: topErrors.map(e=>`${e.label} [${e.response_code}]`),
    datasets: [{ data: topErrors.map(e=>e.count), backgroundColor: ERR_PAL.map(c=>c+'cc'), borderWidth:0 }],
  };
  const { TOOLTIP_BASE: TB2, textTertiary: tt2 } = makeChartTheme();
  const doughOpts = {
    responsive:true, maintainAspectRatio:false,
    plugins: {
      legend: { display:true, position:'right', labels:{ color: tt2, font:chartFont, boxWidth:12, padding:8, generateLabels: chart => chart.data.labels.map((l,i)=>({ text: trunc(l,28), fillStyle: ERR_PAL[i%ERR_PAL.length]+'cc', strokeStyle:'transparent', fontColor: tt2, index:i })) } },
      tooltip: TB2,
    },
    cutout:'55%',
  };

  // Error timeline
  const errTimeline = {
    labels: data.timeline.map(t=>`${t.second}s`),
    datasets: [
      { label:'Errors/s', data: data.timeline.map(t=>t.errors||0), borderColor:'#ef4444', backgroundColor:'#ef444425', borderWidth:2, pointRadius:1, tension:.3, fill:true, yAxisID:'y' },
      { label:'Error Rate %', data: data.timeline.map(t=>t.error_rate||0), borderColor:'#a78bfa', backgroundColor:'transparent', borderWidth:1.5, pointRadius:0, tension:.3, borderDash:[4,3], yAxisID:'y2' },
    ],
  };

  // Per-API error rate bar
  const errApis = [...data.by_api].filter(a=>a.failed>0).sort((a,b)=>b.error_rate-a.error_rate);
  const errApiChart = {
    labels: errApis.map(a=>a.label),
    datasets: [{ label:'Error Rate %', data: errApis.map(a=>a.error_rate), backgroundColor: errApis.map((_,i)=>ERR_PAL[i%ERR_PAL.length]+'cc'), borderColor: errApis.map((_,i)=>ERR_PAL[i%ERR_PAL.length]), borderWidth:1, borderRadius:4 }],
  };

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10 }}>
        <KPI icon="ti-circle-x"       label="Total Errors"    value={(data.summary.total_failed||0).toLocaleString()} color="#ef4444" />
        <KPI icon="ti-alert-triangle" label="Error Rate"      value={`${safeN(data.summary.error_rate)}%`} color={safeN(data.summary.error_rate)<5?'#f59e0b':'#ef4444'} />
        <KPI icon="ti-list-details"   label="Unique Error Types" value={errors.length} color="#f97316" />
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14 }}>
        {topErrors.length > 0 && (
          <ChartCard title={<SectionLabel icon="ti-chart-donut-3" color="#ef4444">Error Distribution (top 6)</SectionLabel>} height={200}>
            <Doughnut data={errDonut} options={doughOpts} />
          </ChartCard>
        )}
        {errApis.length > 0 && (
          <ChartCard title={<SectionLabel icon="ti-chart-bar" color="#f97316">Error Rate per API</SectionLabel>} height={200}>
            <Bar data={errApiChart} options={mkBarOpts({ xTrunc:true, yFmt:v=>`${v}%` })} />
          </ChartCard>
        )}
      </div>

      {data.timeline.length > 1 && (
        <ChartCard title={<SectionLabel icon="ti-timeline" color="#ef4444">Error Timeline</SectionLabel>} height={200}>
          <Line data={errTimeline} options={mkLineOpts({ dualAxis:true, y2Label:'Error Rate %', yLabel:'Errors/s' })} />
        </ChartCard>
      )}

      <Card>
        <SectionLabel icon="ti-table" color="#f59e0b">Error Details</SectionLabel>
        <div style={{ overflowX:'auto', marginTop:12 }}>
          <table className="dark-table" style={{ width:'100%', borderCollapse:'collapse', fontSize:11 }}>
            <thead>
              <tr style={{ background:'rgba(255,255,255,0.03)' }}>
                {['API / Sampler','Response Code','Count','Response Message','Failure Message'].map(h=>(
                  <th key={h} style={{ padding:'7px 10px', textAlign: h==='Count'?'right':'left', color:D.textTer, fontWeight:600, fontSize:10, textTransform:'uppercase', letterSpacing:'.5px', borderBottom:`1px solid ${D.border}`, whiteSpace:'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {errors.map((e,i)=>(
                <tr key={i} style={{ borderBottom:'1px solid rgba(255,255,255,0.04)', background: i%2===0?'transparent':'rgba(255,255,255,0.015)' }}>
                  <td style={{ padding:'7px 10px', color:D.textPri, fontWeight:500, minWidth:120 }}>{e.label}</td>
                  <td style={{ padding:'7px 10px', minWidth:80 }}>
                    <span style={{ padding:'2px 7px', borderRadius:4, background: String(e.response_code).startsWith('5')?'rgba(239,68,68,0.15)':'rgba(249,115,22,0.15)', color: String(e.response_code).startsWith('5')?'#f87171':'#fb923c', fontFamily:'var(--font-mono)', fontSize:11, fontWeight:600, whiteSpace:'pre-wrap', wordBreak:'break-word', display:'inline-block' }}>
                      {e.response_code}
                    </span>
                  </td>
                  <td style={{ padding:'7px 10px', textAlign:'right', fontFamily:'var(--font-mono)', color:'#f87171', fontWeight:700, minWidth:60 }}>{e.count}</td>
                  <td style={{ padding:'7px 10px', color:D.textTer, minWidth:180, whiteSpace:'pre-wrap', wordBreak:'break-word' }}>{e.response_message||'—'}</td>
                  <td style={{ padding:'7px 10px', color:D.textTer, minWidth:180, whiteSpace:'pre-wrap', wordBreak:'break-word' }}>{e.failure_message||'—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function LogsTab({ data, ciWebUrl, ciProvider, ciExternalId }) {
  const logs = data.logs || [];

  const typeStyle = {
    ok:   { color:'#4ade80', icon:'ti-check' },
    err:  { color:'#f87171', icon:'ti-x' },
    warn: { color:'#fbbf24', icon:'ti-alert-triangle' },
    info: { color:'#93c5fd', icon:'ti-info-circle' },
  };

  const providerIcon = ciProvider === 'gitlab' ? 'ti-brand-gitlab' : 'ti-brand-github';
  const providerLabel = ciProvider === 'gitlab' ? 'GitLab' : 'GitHub';

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
      {/* CI pipeline link */}
      {ciWebUrl && (
        <Card style={{ padding:'14px 18px' }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:12, flexWrap:'wrap' }}>
            <div style={{ display:'flex', alignItems:'center', gap:10 }}>
              <i className={`ti ${providerIcon}`} style={{ fontSize:18, color: ciProvider === 'gitlab' ? '#fc6d26' : '#9ca3af' }} />
              <div>
                <div style={{ fontSize:12, fontWeight:700, color:D.textPri }}>
                  {providerLabel} CI Pipeline Run
                  {ciExternalId && <span style={{ marginLeft:8, fontSize:11, color:D.textTer, fontWeight:400 }}>#{ciExternalId}</span>}
                </div>
                <div style={{ fontSize:11, color:D.textTer, marginTop:2 }}>View the complete build logs, test artifacts and workflow details</div>
              </div>
            </div>
            <a
              href={ciWebUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ display:'inline-flex', alignItems:'center', gap:6, padding:'7px 14px', borderRadius:6, border:`1px solid ${ciProvider === 'gitlab' ? 'rgba(252,109,38,0.4)' : 'rgba(139,148,158,0.4)'}`, background: ciProvider === 'gitlab' ? 'rgba(252,109,38,0.08)' : 'rgba(139,148,158,0.08)', color: ciProvider === 'gitlab' ? '#fc6d26' : '#9ca3af', fontSize:12, fontWeight:600, textDecoration:'none', whiteSpace:'nowrap' }}
            >
              <i className="ti ti-external-link" style={{ fontSize:13 }} />
              View on {providerLabel}
            </a>
          </div>
        </Card>
      )}

      {/* Execution logs */}
      {logs.length > 0 && (
        <Card style={{ padding:0 }}>
          <div style={{ padding:'12px 16px', borderBottom:`1px solid ${D.border}`, display:'flex', alignItems:'center', gap:8 }}>
            <i className="ti ti-terminal-2" style={{ color:D.accent }} />
            <span style={{ fontWeight:600, fontSize:12, color:D.textSec }}>Execution Logs</span>
            <span className="badge tag-gray">{logs.length} entries</span>
          </div>
          <div style={{ fontFamily:'var(--font-mono)', fontSize:11.5, lineHeight:1.7, maxHeight:600, overflowY:'auto', padding:'10px 0' }}>
            {logs.map((l,i)=>{
              const ts = typeStyle[l.type] || typeStyle.info;
              const isBanner = l.message && l.message.includes('━━━');
              return (
                <div key={i} style={{ padding:'1px 16px', display:'flex', gap:10, alignItems:'flex-start', background: isBanner?'rgba(255,255,255,0.04)':'transparent' }}>
                  {!isBanner && <i className={`ti ${ts.icon}`} style={{ color:ts.color, fontSize:11, marginTop:2, flexShrink:0 }} />}
                  <span style={{ color: isBanner?'#7d8390': ts.color, whiteSpace:'pre-wrap', wordBreak:'break-all', flex:1 }}>{l.message}</span>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {!ciWebUrl && !logs.length && (
        <div className="empty"><div className="empty-title">No execution logs stored for this run</div></div>
      )}
    </div>
  );
}

// ── main component ────────────────────────────────────────────────────────────
export default function Analytics({ project, collection, env, envs, onEnvChange }) {
  const [runs, setRuns] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingData, setLoadingData] = useState(false);
  const [error, setError] = useState('');
  const [errorMeta, setErrorMeta] = useState(null); // { ci_run_id } when not_cached
  const [activeTab, setActiveTab] = useState('summary');
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [restoring, setRestoring] = useState(null); // run id being restored
  const [syncingCi, setSyncingCi] = useState(false); // CI results being auto-synced
  const analyticsRef = useRef(null);
  const syncPollRef = useRef(null);

  function fetchRuns(includeArchived = false) {
    if (!project) return;
    setLoading(true);
    setSelectedId('');
    setData(null);
    api.get('/execution/runs', { params: { project_id: project.id, include_archived: includeArchived ? 'true' : 'false' } })
      .then(({ data: d }) => {
        let list = (d.runs || []).filter(r => r.engine === 'jmeter');
        if (collection?.id) list = list.filter(r => String(r.collection_id) === String(collection.id));
        if (env) list = list.filter(r => r.suite_env === env);
        // Sort by run number extracted from result_dir descending so the dropdown
        // order matches the directory sequence (Run 6 > Run 5 > Run 4 > …)
        list.sort((a, b) => {
          const na = parseInt((a.result_dir?.split(/[/\\]/).pop()?.match(/Run_?(\d+)$/)||[])[1] || 0);
          const nb = parseInt((b.result_dir?.split(/[/\\]/).pop()?.match(/Run_?(\d+)$/)||[])[1] || 0);
          return nb - na;
        });
        setRuns(list);

        // If backend is syncing CI results, poll every 5 s until they appear
        if (d.syncing_count > 0) {
          setSyncingCi(true);
          if (!syncPollRef.current) {
            syncPollRef.current = setInterval(() => {
              api.get('/execution/runs', { params: { project_id: project.id, include_archived: includeArchived ? 'true' : 'false' } })
                .then(({ data: pd }) => {
                  if (pd.syncing_count === 0) {
                    clearInterval(syncPollRef.current);
                    syncPollRef.current = null;
                    setSyncingCi(false);
                  }
                  let plist = (pd.runs || []).filter(r => r.engine === 'jmeter');
                  if (collection?.id) plist = plist.filter(r => String(r.collection_id) === String(collection.id));
                  if (env) plist = plist.filter(r => r.suite_env === env);
                  plist.sort((a, b) => {
                    const na = parseInt((a.result_dir?.split(/[/\\]/).pop()?.match(/Run_?(\d+)$/)||[])[1] || 0);
                    const nb = parseInt((b.result_dir?.split(/[/\\]/).pop()?.match(/Run_?(\d+)$/)||[])[1] || 0);
                    return nb - na;
                  });
                  setRuns(plist);
                })
                .catch(() => {});
            }, 5000);
          }
        } else {
          setSyncingCi(false);
          if (syncPollRef.current) { clearInterval(syncPollRef.current); syncPollRef.current = null; }
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    setShowArchived(false);
    fetchRuns(false);
    return () => { if (syncPollRef.current) { clearInterval(syncPollRef.current); syncPollRef.current = null; } };
  }, [project?.id, collection?.id, env]);

  function toggleArchived() {
    const next = !showArchived;
    setShowArchived(next);
    fetchRuns(next);
  }

  useEffect(() => {
    // Always clear previous run data immediately so the old charts don't linger
    setData(null); setError(''); setErrorMeta(null);
    if (!selectedId) return;
    setLoadingData(true);
    api.get(`/execution/runs/${selectedId}/report-data`)
      .then(({ data: d }) => setData(d))
      .catch(e => {
        const resp = e.response?.data || {};
        if (resp.error === 'not_cached') {
          setError(resp.message || 'Report data not available.');
          setErrorMeta({ ci_run_id: resp.ci_run_id });
        } else {
          setError(resp.error || resp.message || 'Failed to load analytics data');
          setErrorMeta(null);
        }
      })
      .finally(() => setLoadingData(false));
  }, [selectedId]);

  async function handleDeleteRun(deleteFiles) {
    if (!selectedId) return;
    setDeleting(true);
    try {
      const { data: r } = await api.delete(`/execution/runs/${selectedId}`, { params: { delete_files: deleteFiles ? 'true' : 'false' } });
      if (r.archived) {
        // Soft delete — mark archived in local list so it appears/disappears correctly
        setRuns(prev => prev.map(run => String(run.id) === String(selectedId) ? { ...run, archived: 1 } : run));
      } else {
        // Hard delete — remove from list entirely
        setRuns(prev => prev.filter(run => String(run.id) !== String(selectedId)));
      }
      setSelectedId('');
      setData(null);
      setError('');
      setErrorMeta(null);
    } catch (e) {
      alert(`Delete failed: ${e.response?.data?.error || e.message}`);
    } finally {
      setDeleting(false);
      setDeleteConfirm(false);
    }
  }

  async function handleRestore(runId) {
    setRestoring(runId);
    try {
      await api.patch(`/execution/runs/${runId}/restore`);
      setRuns(prev => prev.map(r => String(r.id) === String(runId) ? { ...r, archived: 0 } : r));
    } catch (e) {
      alert(`Restore failed: ${e.response?.data?.error || e.message}`);
    } finally {
      setRestoring(null);
    }
  }

  async function handleExportPDF() {
    if (!data || !selectedId) return;
    setExporting(true);
    setExportProgress('Generating PDF on server…');

    const suiteName = (data?.meta?.suite_name || 'Analytics').replace(/[^a-zA-Z0-9_-]/g, '_');

    try {
      const response = await api.get(`/execution/runs/${selectedId}/export-pdf`, {
        responseType: 'blob',
      });
      const url = URL.createObjectURL(new Blob([response.data], { type: 'application/pdf' }));
      const a   = document.createElement('a');
      a.href     = url;
      a.download = `${suiteName}_Run${runNum || selectedId}_Analytics.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('PDF export failed', e);
      alert(`PDF export failed: ${e.response?.data?.error || e.message}`);
    } finally {
      setExporting(false);
      setExportProgress('');
    }
  }

  if (!project) return (
    <div className="page" style={{ background: D.pageBg, color: D.textPri }}>
      <EnvBar envs={envs} activeEnv={env} onEnvChange={onEnvChange} hint="Select environment to view performance analytics" />
      <div className="empty" style={{ color: D.textSec }}>
        <i className="ti ti-folder-off" style={{ color: D.textTer }} />
        <div className="empty-title" style={{ color: D.textSec }}>Select a project first</div>
      </div>
    </div>
  );

  const selectedRun = runs.find(r=>String(r.id)===selectedId);
  // Extract the sequential number from result_dir basename (handles both Run_3 and SuiteName_Run3)
  const getRunNum = r => {
    const base = r?.result_dir?.split(/[/\\]/).pop() || '';
    return (base.match(/Run_?(\d+)$/)||[])[1] || r?.id;
  };
  // Full execution label — the result_dir basename IS the canonical run name
  const getRunLabel = r => r?.result_dir?.split(/[/\\]/).pop() || `Run_${r?.id}`;
  const runNum = getRunNum(selectedRun);

  return (
    <div className="page fade-in" style={{ background: D.pageBg, color: D.textPri }}>
      <EnvBar envs={envs} activeEnv={env} onEnvChange={onEnvChange} hint="Select environment to view performance analytics" />
      {syncingCi && (
        <div style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 16px', marginBottom:12, borderRadius:8, background:'rgba(99,102,241,0.12)', border:'1px solid rgba(99,102,241,0.3)', fontSize:13, color:'#a5b4fc' }}>
          <span className="spinner" style={{ borderTopColor:'#818cf8' }} />
          Syncing CI pipeline results to Analytics… this page will update automatically.
        </div>
      )}
      {/* Run selector bar */}
      <div style={{ display:'flex', alignItems:'flex-end', gap:12, marginBottom:16, flexWrap:'wrap' }}>
        <div style={{ flex:1, minWidth:240 }}>
          <label className="form-label" style={{ marginBottom:4, display:'block', color:D.textSec, fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:'.6px' }}>
            <i className="ti ti-history" style={{ marginRight:5, color:D.accent }} /> Select Run
          </label>
          {loading ? (
            <span style={{ fontSize:12, color:D.textSec }}><span className="spinner" /> Loading…</span>
          ) : (
            <>
              {runs.filter(r => !r.archived).length === 0 && !showArchived ? (
                <div style={{ fontSize:13, color:D.textSec }}>No JMeter runs found for this project.</div>
              ) : (
                <CustomSelect value={selectedId} onChange={e=>{ setSelectedId(e.target.value); setActiveTab('summary'); }} style={{ width:'100%', maxWidth:520 }}>
                  <option value="">— Select a run —</option>
                  {runs.filter(r => !r.archived).map(r => (
                    <option key={r.id} value={r.id}>{`${getRunLabel(r)} — ${new Date(r.started_at).toLocaleString()}`}</option>
                  ))}
                </CustomSelect>
              )}
              {/* Archived runs list */}
              {showArchived && runs.filter(r => r.archived).length > 0 && (
                <div style={{ marginTop:10, background:'rgba(107,114,128,0.08)', border:'1px solid rgba(107,114,128,0.2)', borderRadius:8, padding:'10px 14px' }}>
                  <div style={{ fontSize:11, fontWeight:700, color:D.textSec, textTransform:'uppercase', letterSpacing:'.5px', marginBottom:8 }}>Deleted Runs</div>
                  {runs.filter(r => r.archived).map(r => (
                    <div key={r.id} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'6px 0', borderBottom:'1px solid rgba(107,114,128,0.15)', gap:8 }}>
                      <span style={{ fontSize:12, color:D.textSec }}>
                        {getRunLabel(r)} — {new Date(r.started_at).toLocaleString()}
                      </span>
                      <button
                        onClick={() => handleRestore(r.id)}
                        disabled={restoring === r.id}
                        style={{ display:'inline-flex', alignItems:'center', gap:4, padding:'4px 10px', borderRadius:5, border:'1px solid rgba(34,197,94,0.4)', background:'rgba(34,197,94,0.1)', color:'#22c55e', fontSize:11, fontWeight:600, cursor:'pointer', whiteSpace:'nowrap', flexShrink:0 }}
                      >
                        {restoring === r.id ? <span className="spinner" style={{ margin:0, width:10, height:10 }} /> : <i className="ti ti-refresh" />}
                        Restore
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {showArchived && runs.filter(r => r.archived).length === 0 && (
                <div style={{ fontSize:12, color:D.textTer, marginTop:6 }}>No deleted runs to recover.</div>
              )}
            </>
          )}
        </div>
        {data && (
          <button className="btn-secondary btn-sm" onClick={handleExportPDF} disabled={exporting} style={{ display:'inline-flex', alignItems:'center', gap:5, whiteSpace:'nowrap', minWidth: exporting ? 180 : 'auto' }}>
            {exporting ? <span className="spinner" style={{ margin:0, flexShrink:0 }} /> : <i className="ti ti-file-type-pdf" />}
            {exporting ? (exportProgress || 'Exporting…') : 'Export PDF'}
          </button>
        )}
        {selectedId && (
          <button
            className="btn-sm"
            onClick={() => setDeleteConfirm(true)}
            style={{ display:'inline-flex', alignItems:'center', gap:5, whiteSpace:'nowrap', background:'rgba(239,68,68,0.12)', border:'1px solid rgba(239,68,68,0.35)', color:'#ef4444', borderRadius:6, padding:'5px 12px', fontSize:12, fontWeight:600, cursor:'pointer' }}
          >
            <i className="ti ti-trash" /> Delete Report
          </button>
        )}
        <button
          className="btn-sm"
          onClick={toggleArchived}
          style={{ display:'inline-flex', alignItems:'center', gap:5, whiteSpace:'nowrap', background: showArchived ? 'rgba(245,158,11,0.15)' : 'transparent', border:`1px solid ${showArchived ? 'rgba(245,158,11,0.4)' : 'rgba(107,114,128,0.3)'}`, color: showArchived ? '#f59e0b' : D.textSec, borderRadius:6, padding:'5px 12px', fontSize:12, fontWeight:600, cursor:'pointer' }}
        >
          <i className="ti ti-archive" /> {showArchived ? 'Hide Deleted' : 'Deleted Runs'}
        </button>
      </div>

      {loadingData && <div className="empty"><span className="spinner" style={{ width:28, height:28 }} /><div style={{ marginTop:12, color:D.textSec, fontSize:13 }}>Loading analytics…</div></div>}
      {error && !loadingData && (
        <div style={{ padding:'14px 16px', background:'rgba(239,68,68,0.08)', border:'1px solid rgba(239,68,68,0.25)', borderRadius:8, color:'#ef4444', fontSize:13, marginBottom:16, display:'flex', alignItems:'flex-start', gap:10 }}>
          <i className="ti ti-alert-circle" style={{ fontSize:16, flexShrink:0, marginTop:1 }} />
          <div>
            <div style={{ fontWeight:600, marginBottom: errorMeta?.ci_run_id ? 6 : 0 }}>{error}</div>
            {errorMeta?.ci_run_id && (
              <div style={{ fontSize:12, color:'#f87171', marginTop:4 }}>
                <i className="ti ti-refresh" style={{ marginRight:4 }} />
                Go to <strong>CI Pipeline</strong> and sync this run's results to regenerate the report.
              </div>
            )}
          </div>
        </div>
      )}

      {!selectedId && !loadingData && (
        <div className="empty">
          <i className="ti ti-chart-bar" style={{ fontSize:40, color:D.textTer, marginBottom:10 }} />
          <div className="empty-title" style={{ color:D.textSec }}>Select a JMeter run to view analytics</div>
          <div className="empty-desc" style={{ color:D.textTer }}>7 report sections: Summary · Dashboard · Transactions · Trends · Resources · Errors · Logs</div>
        </div>
      )}

      {data && !loadingData && (
        <div ref={analyticsRef}>
          {/* Tab bar */}
          <div style={{ display:'flex', gap:2, marginBottom:16, borderBottom:`1px solid ${D.border}`, flexWrap:'wrap' }}>
            {TABS.map(t=>(
              <button
                key={t.id}
                onClick={()=>setActiveTab(t.id)}
                style={{
                  display:'flex', alignItems:'center', gap:6,
                  padding:'8px 14px', fontSize:12, fontWeight:600,
                  border:'none', borderBottom: activeTab===t.id?`2px solid ${D.accent}`:'2px solid transparent',
                  background:'transparent', color: activeTab===t.id?D.accent:D.textSec,
                  cursor:'pointer', whiteSpace:'nowrap', marginBottom:'-1px',
                  transition:'color .15s',
                }}
              >
                <i className={`ti ${t.icon}`} style={{ fontSize:13 }} />
                {t.label}
                {t.id==='errors' && data.summary.total_failed>0 && (
                  <span style={{ background:'#ef4444', color:'#fff', borderRadius:10, padding:'0 6px', fontSize:10, fontWeight:700, marginLeft:2 }}>
                    {data.summary.total_failed}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div>
            {activeTab==='summary'     && <SummaryTab     data={data} runNum={runNum} selectedRun={selectedRun} />}
            {activeTab==='dashboard'   && <DashboardTab   data={data} />}
            {activeTab==='transaction' && <TransactionTab data={data} />}
            {activeTab==='trend'       && <TrendTab       data={data} />}
            {activeTab==='resource'    && <ResourceTab    data={data} />}
            {activeTab==='errors'      && <ErrorsTab      data={data} />}
          </div>

          <footer style={{ marginTop:24, padding:'10px 0', borderTop:`1px solid ${D.border}`, fontSize:11, color:D.textTer, textAlign:'center' }}>
            Peako — Analytics Report · {data.meta.suite_name} · Run {runNum}
          </footer>
        </div>
      )}

      {/* ── Delete confirmation dialog ─────────────────────────────────────── */}
      {deleteConfirm && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.6)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center' }}>
          <div style={{ background:'#1a2035', border:'1px solid #2a3558', borderRadius:12, padding:28, maxWidth:420, width:'90%', boxShadow:'0 20px 60px rgba(0,0,0,0.5)' }}>
            <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:16 }}>
              <i className="ti ti-trash" style={{ fontSize:20, color:'#ef4444' }} />
              <span style={{ fontSize:16, fontWeight:700, color:'#f0f4ff' }}>Delete Report</span>
            </div>
            <p style={{ fontSize:13, color:'#9ca3af', marginBottom:12, lineHeight:1.6 }}>
              Choose how to delete <strong style={{ color:'#f0f4ff' }}>Run {runNum}</strong>:
            </p>
            <div style={{ display:'flex', flexDirection:'column', gap:10, marginBottom:20 }}>
              <div style={{ background:'rgba(34,197,94,0.06)', border:'1px solid rgba(34,197,94,0.2)', borderRadius:8, padding:'10px 14px' }}>
                <div style={{ fontSize:13, fontWeight:600, color:'#22c55e', marginBottom:3 }}>
                  <i className="ti ti-archive" style={{ marginRight:5 }} />Archive (Recoverable)
                </div>
                <div style={{ fontSize:12, color:'#6b7280', lineHeight:1.5 }}>
                  Hides the report from the list. Disk files are kept. You can restore it anytime via the <strong style={{ color:'#9ca3af' }}>Deleted Runs</strong> button.
                </div>
              </div>
              <div style={{ background:'rgba(239,68,68,0.06)', border:'1px solid rgba(239,68,68,0.2)', borderRadius:8, padding:'10px 14px' }}>
                <div style={{ fontSize:13, fontWeight:600, color:'#ef4444', marginBottom:3 }}>
                  <i className="ti ti-trash" style={{ marginRight:5 }} />Delete Permanently
                </div>
                <div style={{ fontSize:12, color:'#6b7280', lineHeight:1.5 }}>
                  Removes the record AND deletes all local result files (JTL, HTML report). <strong style={{ color:'#f87171' }}>Cannot be undone.</strong>
                </div>
              </div>
            </div>
            <div style={{ display:'flex', gap:8, justifyContent:'flex-end', flexWrap:'wrap' }}>
              <button
                onClick={() => setDeleteConfirm(false)}
                disabled={deleting}
                style={{ padding:'7px 16px', borderRadius:6, border:'1px solid #2a3558', background:'transparent', color:'#9ca3af', fontSize:13, cursor:'pointer' }}
              >
                Cancel
              </button>
              <button
                onClick={() => handleDeleteRun(false)}
                disabled={deleting}
                style={{ padding:'7px 16px', borderRadius:6, border:'1px solid rgba(34,197,94,0.4)', background:'rgba(34,197,94,0.1)', color:'#22c55e', fontSize:13, fontWeight:600, cursor:'pointer' }}
              >
                {deleting ? <span className="spinner" style={{ margin:0 }} /> : <><i className="ti ti-archive" style={{ marginRight:4 }} />Archive</>}
              </button>
              <button
                onClick={() => handleDeleteRun(true)}
                disabled={deleting}
                style={{ padding:'7px 16px', borderRadius:6, border:'none', background:'#ef4444', color:'#fff', fontSize:13, fontWeight:600, cursor:'pointer' }}
              >
                {deleting ? <span className="spinner" style={{ margin:0 }} /> : <><i className="ti ti-trash" style={{ marginRight:4 }} />Delete Permanently</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
