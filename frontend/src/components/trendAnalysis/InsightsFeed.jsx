import { useState, useEffect } from 'react';
import api from '../../api';
import { D } from '../../theme/analyticsDark';

const SEVERITY_STYLE = {
  critical: { color: '#ef4444', bg: 'rgba(239,68,68,0.08)', border: 'rgba(239,68,68,0.25)', icon: 'ti-alert-triangle' },
  warn:     { color: '#f59e0b', bg: 'rgba(245,158,11,0.08)', border: 'rgba(245,158,11,0.25)', icon: 'ti-alert-circle' },
  good:     { color: '#22c55e', bg: 'rgba(34,197,94,0.08)', border: 'rgba(34,197,94,0.25)', icon: 'ti-trending-up' },
  info:     { color: '#58a6ff', bg: 'rgba(88,166,255,0.08)', border: 'rgba(88,166,255,0.25)', icon: 'ti-circle-check' },
};

/**
 * Deterministic, threshold-based trend insight bullets (see insightsEngine.js) for
 * the currently selected/filtered run set — response time & throughput deltas,
 * consecutive per-API degradation/improvement streaks, and build/release boundary
 * shifts (e.g. "Failures increased after Build 241").
 */
export default function InsightsFeed({ project, runIds }) {
  const [insights, setInsights] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(true);
  const runIdsKey = runIds.join(',');

  useEffect(() => {
    if (!project || runIds.length < 2) { setInsights([]); return; }
    setLoading(true);
    setError('');
    api.get(`/projects/${project.id}/trend-analysis/insights`, { params: { run_ids: runIdsKey } })
      .then(({ data }) => setInsights(data.insights || []))
      .catch(e => setError(e.response?.data?.error || 'Failed to generate insights'))
      .finally(() => setLoading(false));
  }, [project?.id, runIdsKey]);

  if (runIds.length < 2) return null;

  return (
    <div style={{ background: D.cardBg, border: `1px solid ${D.border}`, borderRadius: 10, padding: 16, marginBottom: 16 }}>
      <button
        onClick={() => setExpanded(e => !e)}
        style={{ display: 'flex', alignItems: 'center', width: '100%', gap: 7, background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', marginBottom: expanded ? 12 : 0 }}
      >
        <i className="ti ti-bulb" style={{ color: D.accent }} />
        <span style={{ fontSize: 13, fontWeight: 700, color: D.textPri }}>Trend Insights</span>
        {insights.length > 0 && (
          <span style={{ fontSize: 11, color: D.textTer, background: D.cardBg2, borderRadius: 10, padding: '1px 8px' }}>{insights.length}</span>
        )}
        <i className={`ti ${expanded ? 'ti-chevron-up' : 'ti-chevron-down'}`} style={{ marginLeft: 'auto', color: D.textTer }} />
      </button>

      {expanded && (
        <>
          {loading && <div style={{ fontSize: 12, color: D.textSec }}><span className="spinner" /> Analyzing…</div>}
          {error && !loading && <div style={{ fontSize: 12, color: '#ef4444' }}>{error}</div>}
          {!loading && !error && insights.length === 0 && (
            <div style={{ fontSize: 12, color: D.textTer }}>No notable changes detected across the selected runs.</div>
          )}

          {!loading && !error && insights.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {insights.map((insight, i) => {
                const s = SEVERITY_STYLE[insight.severity] || SEVERITY_STYLE.info;
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 9, padding: '8px 12px', borderRadius: 7, background: s.bg, border: `1px solid ${s.border}` }}>
                    <i className={`ti ${s.icon}`} style={{ color: s.color, fontSize: 15, marginTop: 1, flexShrink: 0 }} />
                    <span style={{ fontSize: 12.5, color: D.textPri }}>{insight.message}</span>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
