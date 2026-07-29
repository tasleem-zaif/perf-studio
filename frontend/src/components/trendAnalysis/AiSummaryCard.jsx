import { useState, useEffect } from 'react';
import api from '../../api';
import { D } from '../../theme/analyticsDark';

/**
 * Plain-English executive summary of the baseline-vs-latest comparison (see
 * aiSummaryEngine.js). AI-narrated when a provider is configured, otherwise the
 * same underlying facts in a deterministic template — either way the badge says
 * which one produced the text on screen.
 */
export default function AiSummaryCard({ project, runIds }) {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const runIdsKey = runIds.join(',');

  useEffect(() => {
    if (!project || runIds.length < 2) { setSummary(null); return; }
    setLoading(true);
    setError('');
    api.get(`/projects/${project.id}/trend-analysis/ai-summary`, { params: { run_ids: runIdsKey } })
      .then(({ data }) => setSummary(data))
      .catch(e => setError(e.response?.data?.error || 'Failed to generate summary'))
      .finally(() => setLoading(false));
  }, [project?.id, runIdsKey]);

  if (runIds.length < 2) return null;

  return (
    <div style={{ background: 'linear-gradient(135deg, rgba(73,204,61,0.07), rgba(88,166,255,0.05))', border: `1px solid ${D.border}`, borderRadius: 10, padding: 18, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <i className="ti ti-sparkles" style={{ color: D.accent, fontSize: 16 }} />
        <span style={{ fontSize: 13, fontWeight: 700, color: D.textPri }}>Executive Summary</span>
        {summary && (
          <span style={{
            marginLeft: 'auto', fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10, textTransform: 'uppercase', letterSpacing: '.4px',
            color: summary.source === 'ai' ? '#58a6ff' : D.textTer,
            background: summary.source === 'ai' ? 'rgba(88,166,255,0.12)' : 'rgba(122,142,170,0.12)',
          }}>
            {summary.source === 'ai' ? 'AI-generated' : 'Rule-based'}
          </span>
        )}
      </div>

      {loading && <div style={{ fontSize: 12, color: D.textSec }}><span className="spinner" /> Generating summary…</div>}
      {error && !loading && <div style={{ fontSize: 12, color: '#ef4444' }}>{error}</div>}
      {summary && !loading && !error && (
        <ul style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {(summary.bullets || []).map((bullet, i) => (
            <li key={i} style={{ fontSize: 13.5, lineHeight: 1.5, color: D.textPri }}>{bullet}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
