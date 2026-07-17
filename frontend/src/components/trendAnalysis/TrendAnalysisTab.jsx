import { useState, useEffect, useCallback, useRef } from 'react';
import api from '../../api';
import RunSelectorBar from './RunSelectorBar';
import RunMetadataModal from './RunMetadataModal';
import TrendChartsPanel from './TrendChartsPanel';
import ComparisonTable from './ComparisonTable';
import ScoreCards from './ScoreCards';
import InsightsFeed from './InsightsFeed';
import AiSummaryCard from './AiSummaryCard';
import RcaPanel from './RcaPanel';
import RecommendationsPanel from './RecommendationsPanel';
import CapacityPlanningPanel from './CapacityPlanningPanel';
import { D } from '../../theme/analyticsDark';

const EMPTY_FILTERS = { environment: '', browser: '', build_number: '', release_tag: '', load_profile: '', suite_id: '' };
const EMPTY_FILTER_OPTIONS = { environment: [], browser: [], build_number: [], release_tag: [], load_profile: [], test_plans: [] };

const getRunLabel = r => r?.result_dir?.split(/[/\\]/).pop() || `Run_${r?.id}`;

const STATUS_COLORS = {
  completed: { bg: 'rgba(34,197,94,0.12)', fg: '#22c55e' },
  failed:    { bg: 'rgba(239,68,68,0.12)', fg: '#ef4444' },
  running:   { bg: 'rgba(88,166,255,0.12)', fg: '#58a6ff' },
};

function StatusPill({ status }) {
  const c = STATUS_COLORS[status] || { bg: 'rgba(122,142,170,0.12)', fg: D.textTer };
  return (
    <span style={{ display:'inline-block', padding:'2px 9px', borderRadius:20, fontSize:11, fontWeight:700, background:c.bg, color:c.fg, textTransform:'capitalize' }}>
      {status || 'unknown'}
    </span>
  );
}

/**
 * Trend Analysis — run discovery/filtering/selection/tagging, scores, AI executive
 * summary, insights, RCA, recommendations, capacity planning, trend charts (with
 * forecast/anomaly overlay), run comparison, PDF export, and pagination for large
 * run lists. Clicking an API in the comparison table drills down into that API's
 * own trend chart below.
 */
export default function TrendAnalysisTab({ project, env }) {
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [filterOptions, setFilterOptions] = useState(EMPTY_FILTER_OPTIONS);
  const [mode, setMode] = useState('list');
  const [lastN, setLastN] = useState(10);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const [runs, setRuns] = useState([]);
  const [baselineLatest, setBaselineLatest] = useState(null); // { baseline, latest } when mode==='baseline'
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [editingRun, setEditingRun] = useState(null);
  const [comparison, setComparison] = useState(null);
  const [comparing, setComparing] = useState(false);
  const [compareError, setCompareError] = useState('');
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({ total: 0, limit: 50 });
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const [drillDownApi, setDrillDownApi] = useState(null);
  const [drillDownToken, setDrillDownToken] = useState(0);
  const trendChartsRef = useRef(null);
  // Guards against out-of-order responses: if the user changes a filter/mode/lastN
  // rapidly (e.g. clicking the number input's spinner arrows repeatedly), multiple
  // requests can be in flight at once — without this, a slower earlier response
  // could resolve after a later one and silently overwrite the correct, up-to-date result.
  const requestSeqRef = useRef(0);

  useEffect(() => {
    if (!project) return;
    api.get(`/projects/${project.id}/trend-analysis/runs/filter-options`)
      .then(({ data }) => setFilterOptions(data))
      .catch(() => setFilterOptions(EMPTY_FILTER_OPTIONS));
  }, [project?.id]);

  const fetchRuns = useCallback(() => {
    if (!project) return;
    const seq = ++requestSeqRef.current;
    setLoading(true);
    setError('');
    setBaselineLatest(null);

    const params = {};
    for (const [k, v] of Object.entries(filters)) {
      if (!v) continue;
      // "Environment" in the UI/filters state maps to test_suites.env server-side
      // (same concept EnvBar/Analytics.jsx use) — the query param is named suite_env
      // to avoid colliding with the separate, taggable `environment` DB column that
      // used to (wrongly) double as this filter and never matched real runs.
      params[k === 'environment' ? 'suite_env' : k] = v;
    }
    if (env) params.suite_env = params.suite_env || env;

    if (mode === 'baseline') params.baseline = 'true';
    else if (mode === 'last_n') params.last_n = lastN;
    else if (mode === 'custom_range') {
      if (dateFrom) params.date_from = dateFrom;
      if (dateTo) params.date_to = dateTo;
      params.page = page;
      params.limit = 50;
    } else {
      params.page = page;
      params.limit = 50;
    }

    api.get(`/projects/${project.id}/trend-analysis/runs`, { params })
      .then(({ data }) => {
        if (seq !== requestSeqRef.current) return; // a newer request has since superseded this one
        setRuns(data.runs || []);
        setSelectedIds(new Set());
        setComparison(null);
        setPagination({ total: data.total || 0, limit: data.limit || 50 });
        if (data.mode === 'baseline_vs_latest') setBaselineLatest({ baseline: data.baseline, latest: data.latest });
      })
      .catch(e => {
        if (seq !== requestSeqRef.current) return;
        setError(e.response?.data?.error || 'Failed to load runs');
      })
      .finally(() => {
        if (seq === requestSeqRef.current) setLoading(false);
      });
  }, [project?.id, JSON.stringify(filters), mode, lastN, dateFrom, dateTo, env, page]);

  useEffect(() => { fetchRuns(); }, [fetchRuns]);

  // A filter/mode change invalidates the current page — always land back on page 1.
  useEffect(() => { setPage(1); }, [JSON.stringify(filters), mode, lastN, dateFrom, dateTo, env]);

  function updateFilter(key, value) {
    setFilters(f => ({ ...f, [key]: value }));
  }

  function handleDrillDown(apiLabel) {
    setDrillDownApi(apiLabel);
    setDrillDownToken(t => t + 1);
    trendChartsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function handleExportPdf() {
    setExporting(true);
    setExportError('');
    try {
      const runIds = chronologicalRuns.map(r => r.id).join(',');
      const response = await api.get(`/projects/${project.id}/trend-analysis/export-pdf`, {
        params: { run_ids: runIds }, responseType: 'blob',
      });
      const url = URL.createObjectURL(new Blob([response.data], { type: 'application/pdf' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `TrendAnalysis_${project.name || project.id}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      setExportError(e.response?.data?.error || 'Failed to export PDF');
    } finally {
      setExporting(false);
    }
  }

  function toggleSelected(id) {
    setComparison(null);
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function handleCompare() {
    setComparing(true);
    setCompareError('');
    setComparison(null);
    try {
      const { data } = await api.post(`/projects/${project.id}/trend-analysis/compare`, { runIds: [...selectedIds] });
      setComparison(data);
    } catch (e) {
      setCompareError(e.response?.data?.error || 'Failed to compare selected runs');
    } finally {
      setComparing(false);
    }
  }

  async function saveMetadata(runId, values) {
    const { data } = await api.patch(`/projects/${project.id}/trend-analysis/runs/${runId}/metadata`, values);
    setRuns(rs => rs.map(r => (r.id === runId ? data.run : r)));
    // Metadata values (environment/build/release/etc) just changed — refresh the
    // filter dropdown options so a newly-typed value shows up next time.
    api.get(`/projects/${project.id}/trend-analysis/runs/filter-options`).then(({ data: d }) => setFilterOptions(d)).catch(() => {});
  }

  if (!project) {
    return (
      <div className="empty">
        <i className="ti ti-folder-off" style={{ color: D.textTer }} />
        <div className="empty-title" style={{ color: D.textSec }}>Select a project first</div>
      </div>
    );
  }

  const displayRuns = mode === 'baseline' && baselineLatest
    ? [baselineLatest.baseline, baselineLatest.latest].filter(Boolean)
    : runs;
  // Trend charts read left-to-right as time — always chronological regardless of
  // how the table above happens to be sorted for a given mode.
  const chronologicalRuns = [...displayRuns].sort((a, b) => new Date(a.started_at) - new Date(b.started_at));

  return (
    <div>
      {chronologicalRuns.length >= 2 && (
        <div style={{ display:'flex', justifyContent:'flex-end', gap:10, marginBottom:12 }}>
          {exportError && <span style={{ fontSize:12, color:'#ef4444', alignSelf:'center' }}>{exportError}</span>}
          <button
            onClick={handleExportPdf}
            disabled={exporting}
            style={{ display:'inline-flex', alignItems:'center', gap:6, padding:'7px 14px', borderRadius:7, border:`1px solid ${D.border}`, background:D.cardBg, color:D.textPri, fontSize:12, fontWeight:600, cursor: exporting ? 'default' : 'pointer' }}
          >
            {exporting ? <span className="spinner" style={{ margin:0, width:12, height:12 }} /> : <i className="ti ti-file-type-pdf" style={{ color:D.accent }} />}
            {exporting ? 'Exporting…' : 'Export PDF'}
          </button>
        </div>
      )}

      <RunSelectorBar
        filters={filters} onFilterChange={updateFilter} filterOptions={filterOptions}
        mode={mode} onModeChange={setMode}
        lastN={lastN} onLastNChange={setLastN}
        dateFrom={dateFrom} dateTo={dateTo} onDateFromChange={setDateFrom} onDateToChange={setDateTo}
      />

      {mode === 'baseline' && baselineLatest && (baselineLatest.baseline || baselineLatest.latest) && (
        <div style={{ display:'flex', gap:12, marginBottom:14, fontSize:12, color:D.textSec }}>
          <span><i className="ti ti-flag" style={{ marginRight:5, color:D.accentBlue }} />Baseline: <strong style={{ color:D.textPri }}>{baselineLatest.baseline ? getRunLabel(baselineLatest.baseline) : '—'}</strong></span>
          <span><i className="ti ti-flag-3" style={{ marginRight:5, color:D.accent }} />Latest: <strong style={{ color:D.textPri }}>{baselineLatest.latest ? getRunLabel(baselineLatest.latest) : '—'}</strong></span>
        </div>
      )}

      {!loading && !error && chronologicalRuns.length > 0 && (
        <ScoreCards project={project} runId={chronologicalRuns[chronologicalRuns.length - 1].id} />
      )}

      {!loading && !error && chronologicalRuns.length >= 2 && (
        <AiSummaryCard project={project} runIds={chronologicalRuns.map(r => r.id)} />
      )}

      {!loading && !error && chronologicalRuns.length >= 2 && (
        <InsightsFeed project={project} runIds={chronologicalRuns.map(r => r.id)} />
      )}

      {!loading && !error && chronologicalRuns.length >= 2 && (
        <RcaPanel project={project} runIds={chronologicalRuns.map(r => r.id)} />
      )}

      {!loading && !error && chronologicalRuns.length >= 2 && (
        <RecommendationsPanel project={project} runIds={chronologicalRuns.map(r => r.id)} />
      )}

      {!loading && !error && chronologicalRuns.length > 0 && (
        <CapacityPlanningPanel project={project} runId={chronologicalRuns[chronologicalRuns.length - 1].id} />
      )}

      {!loading && !error && chronologicalRuns.length >= 2 && (
        <div ref={trendChartsRef}>
          <TrendChartsPanel project={project} runs={chronologicalRuns} focusScope={drillDownApi} focusToken={drillDownToken} />
        </div>
      )}

      {selectedIds.size > 0 && (
        <div style={{ display:'flex', alignItems:'center', gap:10, padding:'9px 14px', marginBottom:14, borderRadius:8, background:'rgba(73,204,61,0.08)', border:`1px solid rgba(73,204,61,0.3)` }}>
          <span style={{ fontSize:12, color:D.textPri, fontWeight:600 }}>{selectedIds.size} run{selectedIds.size===1?'':'s'} selected</span>
          <button
            onClick={handleCompare}
            disabled={selectedIds.size < 2 || comparing}
            title={selectedIds.size < 2 ? 'Select at least 2 runs to compare' : 'Compare selected runs'}
            style={{
              padding:'5px 12px', borderRadius:6, border:`1px solid ${selectedIds.size < 2 ? D.border : D.accent}`,
              background: selectedIds.size < 2 ? 'transparent' : 'rgba(73,204,61,0.12)',
              color: selectedIds.size < 2 ? D.textTer : D.accent,
              fontSize:12, fontWeight:600, cursor: selectedIds.size < 2 ? 'not-allowed' : 'pointer', marginLeft:'auto',
            }}
          >
            {comparing ? <span className="spinner" style={{ margin:0, width:11, height:11 }} /> : <i className="ti ti-git-compare" style={{ marginRight:5 }} />}
            Compare Selected
          </button>
        </div>
      )}
      {compareError && (
        <div style={{ padding:'10px 14px', marginBottom:14, borderRadius:8, background:'rgba(239,68,68,0.08)', border:'1px solid rgba(239,68,68,0.25)', color:'#ef4444', fontSize:12 }}>
          {compareError}
        </div>
      )}
      {comparison && <ComparisonTable comparison={comparison} onClose={() => setComparison(null)} onDrillDown={handleDrillDown} />}

      {loading && <div className="empty"><span className="spinner" style={{ width:26, height:26 }} /><div style={{ marginTop:10, color:D.textSec, fontSize:13 }}>Loading runs…</div></div>}
      {error && !loading && (
        <div style={{ padding:'12px 16px', background:'rgba(239,68,68,0.08)', border:'1px solid rgba(239,68,68,0.25)', borderRadius:8, color:'#ef4444', fontSize:13, marginBottom:16 }}>
          <i className="ti ti-alert-circle" style={{ marginRight:7 }} />{error}
        </div>
      )}
      {!loading && !error && displayRuns.length === 0 && (
        <div className="empty">
          <i className="ti ti-chart-line" style={{ fontSize:36, color:D.textTer, marginBottom:8 }} />
          <div className="empty-title" style={{ color:D.textSec }}>No runs match these filters</div>
          <div className="empty-desc" style={{ color:D.textTer }}>Tag a few runs with environment/build/release info, or widen your filters.</div>
        </div>
      )}

      {!loading && !error && displayRuns.length > 0 && (
        <div style={{ overflowX:'auto', border:`1px solid ${D.border}`, borderRadius:10 }}>
          <table className="dark-table" style={{ width:'100%', borderCollapse:'collapse', fontSize:12.5 }}>
            <thead>
              <tr style={{ background:D.cardBg2 }}>
                <th style={{ padding:'9px 10px', width:30 }} />
                <th style={thStyle()}>Run</th>
                <th style={thStyle()}>Started</th>
                <th style={thStyle()}>Status</th>
                <th style={thStyle()}>Users</th>
                <th style={thStyle()}>Environment</th>
                <th style={thStyle()}>Build</th>
                <th style={thStyle()}>Release</th>
                <th style={thStyle()}>Browser</th>
                <th style={thStyle()}>Load Profile</th>
                <th style={thStyle()}></th>
              </tr>
            </thead>
            <tbody>
              {displayRuns.map(r => (
                <tr key={r.id} style={{ borderTop:`1px solid ${D.border}` }}>
                  <td style={tdStyle()}>
                    <input type="checkbox" checked={selectedIds.has(r.id)} onChange={() => toggleSelected(r.id)} />
                  </td>
                  <td style={{ ...tdStyle(), fontWeight:600, color:D.textPri }}>{getRunLabel(r)}</td>
                  <td style={tdStyle()}>{r.started_at ? new Date(r.started_at).toLocaleString() : '—'}</td>
                  <td style={tdStyle()}><StatusPill status={r.status} /></td>
                  <td style={tdStyle()}>{r.run_vusers ?? '—'}</td>
                  <td style={tdStyle()}>{r.suite_env || <span style={{ color:D.textTer }}>—</span>}</td>
                  <td style={tdStyle()}>{r.build_number || <span style={{ color:D.textTer }}>—</span>}</td>
                  <td style={tdStyle()}>{r.release_tag || <span style={{ color:D.textTer }}>—</span>}</td>
                  <td style={tdStyle()}>{r.browser || <span style={{ color:D.textTer }}>—</span>}</td>
                  <td style={tdStyle()}>{r.load_profile || <span style={{ color:D.textTer }}>—</span>}</td>
                  <td style={tdStyle()}>
                    <button
                      onClick={() => setEditingRun(r)}
                      title="Tag run metadata"
                      style={{ padding:'4px 8px', borderRadius:5, border:`1px solid ${D.border}`, background:'transparent', color:D.textSec, cursor:'pointer' }}
                    >
                      <i className="ti ti-tag" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(mode === 'list' || mode === 'custom_range') && pagination.total > pagination.limit && (
        <div style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:12, marginTop:12, fontSize:12, color:D.textSec }}>
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page <= 1}
            style={{ padding:'5px 12px', borderRadius:6, border:`1px solid ${D.border}`, background:'transparent', color: page<=1 ? D.textTer : D.textSec, cursor: page<=1 ? 'not-allowed' : 'pointer' }}
          >
            <i className="ti ti-chevron-left" /> Prev
          </button>
          <span>Page {page} of {Math.max(1, Math.ceil(pagination.total / pagination.limit))} · {pagination.total} runs total</span>
          <button
            onClick={() => setPage(p => (p * pagination.limit < pagination.total ? p + 1 : p))}
            disabled={page * pagination.limit >= pagination.total}
            style={{ padding:'5px 12px', borderRadius:6, border:`1px solid ${D.border}`, background:'transparent', color: page * pagination.limit >= pagination.total ? D.textTer : D.textSec, cursor: page * pagination.limit >= pagination.total ? 'not-allowed' : 'pointer' }}
          >
            Next <i className="ti ti-chevron-right" />
          </button>
        </div>
      )}

      {editingRun && (
        <RunMetadataModal run={editingRun} onClose={() => setEditingRun(null)} onSaved={saveMetadata} />
      )}
    </div>
  );
}

function thStyle() {
  return { padding:'9px 10px', textAlign:'left', color:D.textTer, fontWeight:700, fontSize:10, textTransform:'uppercase', letterSpacing:'.5px', whiteSpace:'nowrap' };
}
function tdStyle() {
  return { padding:'8px 10px', color:D.textSec, whiteSpace:'nowrap' };
}
