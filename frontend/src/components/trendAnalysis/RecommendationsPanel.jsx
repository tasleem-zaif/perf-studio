import { useState, useEffect } from 'react';
import api from '../../api';
import { D } from '../../theme/analyticsDark';

const PRIORITY_STYLE = {
  critical: { color: '#ef4444', bg: 'rgba(239,68,68,0.12)' },
  high:     { color: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
  medium:   { color: '#58a6ff', bg: 'rgba(88,166,255,0.12)' },
  low:      { color: D.textTer, bg: 'rgba(122,142,170,0.12)' },
};

/**
 * Ranked, actionable recommendations (worst-priority first) — rule-based by
 * default, automatically reworded by AI when a provider is configured (see
 * recommendationEngine.js). The `source` badge shows which produced the wording.
 */
export default function RecommendationsPanel({ project, runIds }) {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const runIdsKey = runIds.join(',');

  useEffect(() => {
    if (!project || runIds.length < 2) { setResult(null); return; }
    setLoading(true);
    setError('');
    api.get(`/projects/${project.id}/trend-analysis/recommendations`, { params: { run_ids: runIdsKey } })
      .then(({ data }) => setResult(data))
      .catch(e => setError(e.response?.data?.error || 'Failed to build recommendations'))
      .finally(() => setLoading(false));
  }, [project?.id, runIdsKey]);

  if (runIds.length < 2) return null;
  const recommendations = result?.recommendations || [];

  return (
    <div style={{ background: D.cardBg, border: `1px solid ${D.border}`, borderRadius: 10, padding: 16, marginBottom: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: D.textPri, marginBottom: 12 }}>
        <i className="ti ti-checklist" style={{ marginRight: 7, color: D.accent }} />
        AI Performance Recommendations
      </div>

      {loading && <div style={{ fontSize: 12, color: D.textSec }}><span className="spinner" /> Building recommendations…</div>}
      {error && !loading && <div style={{ fontSize: 12, color: '#ef4444' }}>{error}</div>}
      {!loading && !error && recommendations.length === 0 && (
        <div style={{ fontSize: 12, color: D.textTer }}>No recommendations — nothing regressed between the selected runs.</div>
      )}

      {!loading && !error && recommendations.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {recommendations.map((rec, i) => {
            const p = PRIORITY_STYLE[rec.priority] || PRIORITY_STYLE.low;
            return (
              <div key={i} style={{ padding: '10px 12px', borderRadius: 8, border: `1px solid ${D.border}`, background: D.cardBg2 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: p.color, background: p.bg, borderRadius: 10, padding: '2px 8px', textTransform: 'uppercase', letterSpacing: '.4px' }}>{rec.priority}</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: D.textPri }}>{rec.title}</span>
                  {rec.source === 'ai' && (
                    <span style={{ fontSize: 9.5, fontWeight: 700, color: '#58a6ff', background: 'rgba(88,166,255,0.12)', borderRadius: 10, padding: '2px 7px' }}>AI</span>
                  )}
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: D.textTer }}>{rec.confidence_pct}% confidence</span>
                </div>
                <div style={{ fontSize: 12.5, color: D.textSec, lineHeight: 1.5 }}>{rec.description}</div>
              </div>
            );
          })}
        </div>
      )}
      {result?.truncated && (
        <div style={{ fontSize: 11, color: D.textTer, marginTop: 8 }}>
          Showing top {recommendations.length} of {result.totalCount} — refine your run selection to see the rest.
        </div>
      )}
    </div>
  );
}
