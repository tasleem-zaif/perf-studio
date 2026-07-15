import { useState, useEffect } from 'react';
import api from '../../api';
import { D } from '../../theme/analyticsDark';

const SCORE_DEFS = [
  { key: 'apiHealth',    label: 'API Health',         icon: 'ti-api' },
  { key: 'appHealth',    label: 'Application Health', icon: 'ti-apps' },
  { key: 'regression',   label: 'Regression',         icon: 'ti-git-compare' },
  { key: 'reliability',  label: 'Reliability',        icon: 'ti-shield-check' },
  { key: 'scalability',  label: 'Scalability',        icon: 'ti-chart-arrows-vertical' },
];

function colorFor(value) {
  if (value === null || value === undefined) return D.textTer;
  if (value >= 80) return '#22c55e';
  if (value >= 50) return '#f59e0b';
  return '#ef4444';
}

function ScoreCard({ label, icon, score, big }) {
  const value = score?.value;
  const color = colorFor(value);
  const title = score?.formula?.description || '';
  return (
    <div
      title={title}
      style={{
        background: D.cardBg, border: `1px solid ${D.border}`, borderRadius: 10,
        padding: big ? '18px 20px' : '14px 16px', display: 'flex', flexDirection: 'column', gap: 6,
        cursor: title ? 'help' : 'default',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: big ? 12.5 : 11, color: D.textTer, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px' }}>
        <i className={`ti ${icon}`} />
        {label}
        {title && <i className="ti ti-info-circle" style={{ marginLeft: 'auto', fontSize: 12 }} />}
      </div>
      <div style={{ fontSize: big ? 34 : 24, fontWeight: 800, color }}>
        {value === null || value === undefined ? <span style={{ fontSize: big ? 15 : 13, color: D.textTer, fontWeight: 600 }}>N/A</span> : value}
        {value !== null && value !== undefined && <span style={{ fontSize: big ? 15 : 12, color: D.textTer, fontWeight: 500 }}> / 100</span>}
      </div>
      {score?.formula?.insufficientData && (
        <div style={{ fontSize: 10.5, color: D.textTer }}>Needs more runs at different load levels</div>
      )}
    </div>
  );
}

/**
 * The 6 weighted Performance Scores (see scoringEngine.js) for the most recent run
 * in the current selection. Hover any card to see its exact formula.
 */
export default function ScoreCards({ project, runId }) {
  const [scores, setScores] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!project || !runId) { setScores(null); return; }
    setLoading(true);
    setError('');
    api.get(`/projects/${project.id}/trend-analysis/scores`, { params: { run_ids: runId } })
      .then(({ data }) => setScores(data.scores?.[0] || null))
      .catch(e => setError(e.response?.data?.error || 'Failed to compute scores'))
      .finally(() => setLoading(false));
  }, [project?.id, runId]);

  if (!runId) return null;
  if (loading) return <div style={{ fontSize: 12, color: D.textSec, marginBottom: 16 }}><span className="spinner" /> Computing scores…</div>;
  if (error) return <div style={{ fontSize: 12, color: '#ef4444', marginBottom: 16 }}>{error}</div>;
  if (!scores) return null;

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, fontSize: 11, color: D.textTer }}>
        <i className="ti ti-info-circle" />
        Latest Execution Scores — always reflect the most recent run in view; independent of "Number of Executions" or other filters above (those control the Trend/Insights/Comparison sections below).
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr 1fr 1fr 1fr 1fr', gap: 12 }}>
        <ScoreCard label="Performance Score" icon="ti-gauge" score={scores.overall} big />
        {SCORE_DEFS.map(def => (
          <ScoreCard key={def.key} label={def.label} icon={def.icon} score={scores[def.key]} />
        ))}
      </div>
    </div>
  );
}
