import { useState, useEffect } from 'react';
import { Line } from 'react-chartjs-2';
import api from '../../api';
import { D } from '../../theme/analyticsDark';

const chartFont = { family: "'Inter','Segoe UI',sans-serif", size: 11 };

function lineOpts() {
  const gridColor = 'rgba(48,54,61,0.8)';
  return {
    responsive: true, maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: true, labels: { color: D.textTer, font: chartFont, boxWidth: 12, padding: 14 } },
      tooltip: { backgroundColor: '#1c2330', titleColor: '#e6edf3', bodyColor: '#8b949e', borderColor: '#30363d', borderWidth: 1, cornerRadius: 6, padding: 10 },
    },
    scales: {
      x: { title: { display: true, text: 'Concurrent Users', color: D.textTer, font: chartFont }, ticks: { color: '#6e7681', font: chartFont }, grid: { color: gridColor }, border: { color: gridColor } },
      y: { title: { display: true, text: 'ms', color: D.textTer, font: chartFont }, ticks: { color: '#6e7681', font: chartFont }, grid: { color: gridColor }, border: { color: gridColor } },
      y2: { position: 'right', title: { display: true, text: 'Error %', color: D.textTer, font: chartFont }, ticks: { color: '#6e7681', font: chartFont }, grid: { drawOnChartArea: false }, border: { color: gridColor } },
    },
  };
}

function StatTile({ label, value, suffix, color }) {
  return (
    <div style={{ background: D.cardBg2, border: `1px solid ${D.border}`, borderRadius: 8, padding: '12px 14px' }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: D.textTer, textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 5 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: color || D.textPri }}>
        {value === null || value === undefined ? <span style={{ fontSize: 13, color: D.textTer, fontWeight: 600 }}>N/A</span> : value}
        {value !== null && value !== undefined && suffix && <span style={{ fontSize: 12, color: D.textTer, fontWeight: 500 }}> {suffix}</span>}
      </div>
    </div>
  );
}

/**
 * Capacity Planning — estimates max stable/recommended/breaking-point concurrency
 * and projects response time/TPS/error rate at those loads, from this run's suite's
 * own execution history at different concurrency levels (see predictionEngine.js).
 * Needs at least 2 runs at different run_vusers levels for this suite — most
 * suites tested at only one load level won't have enough data yet.
 */
export default function CapacityPlanningPanel({ project, runId }) {
  const [capacity, setCapacity] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!project || !runId) { setCapacity(null); return; }
    setLoading(true);
    setError('');
    api.get(`/projects/${project.id}/trend-analysis/capacity-planning`, { params: { run_id: runId } })
      .then(({ data }) => setCapacity(data.capacity))
      .catch(e => setError(e.response?.data?.error || 'Failed to estimate capacity'))
      .finally(() => setLoading(false));
  }, [project?.id, runId]);

  if (!runId) return null;

  return (
    <div style={{ background: D.cardBg, border: `1px solid ${D.border}`, borderRadius: 10, padding: 16, marginBottom: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: D.textPri, marginBottom: 4 }}>
        <i className="ti ti-gauge" style={{ marginRight: 7, color: D.accent }} />
        Capacity Planning
      </div>
      <div style={{ fontSize: 11, color: D.textTer, marginBottom: 12 }}>
        Uses this test plan's entire execution history (every run at a known concurrency level), not just the runs selected above.
      </div>

      {loading && <div style={{ fontSize: 12, color: D.textSec }}><span className="spinner" /> Estimating capacity…</div>}
      {error && !loading && <div style={{ fontSize: 12, color: '#ef4444' }}>{error}</div>}

      {!loading && !error && capacity?.insufficientData && (
        <div style={{ fontSize: 12, color: D.textTer }}>
          Not enough data yet — capacity estimates need at least 2 executions of this suite at different concurrency (users) levels. Currently tested: {capacity.distinctLoadLevelsTested} level{capacity.distinctLoadLevelsTested === 1 ? '' : 's'}.
        </div>
      )}

      {!loading && !error && capacity && !capacity.insufficientData && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 14 }}>
            <StatTile label="Max Stable Users" value={capacity.maxStableUsers} color="#22c55e" />
            <StatTile label="Recommended Users" value={capacity.recommendedUsers} color="#58a6ff" />
            <StatTile label="Breaking Point" value={capacity.breakingPointUsers} suffix={capacity.breakingPointDriver ? `(${capacity.breakingPointDriver.replace('_', ' ')})` : ''} color="#ef4444" />
            <StatTile label="Confidence" value={capacity.confidencePct} suffix="%" />
          </div>

          {capacity.projectedAtBreakingPoint && (
            <div style={{ fontSize: 12, color: D.textSec, marginBottom: 14 }}>
              At the projected breaking point (~{capacity.breakingPointUsers} users): avg RT <strong style={{ color: D.textPri }}>{capacity.projectedAtBreakingPoint.avg}ms</strong>, TPS <strong style={{ color: D.textPri }}>{capacity.projectedAtBreakingPoint.tps}</strong>, error rate <strong style={{ color: D.textPri }}>{capacity.projectedAtBreakingPoint.error_rate}%</strong>.
            </div>
          )}

          <div style={{ height: 220 }}>
            <Line
              data={(() => {
                const points = [
                  { label: 'Recommended', proj: capacity.projectedAtRecommended },
                  { label: 'Max Stable', proj: capacity.projectedAtMaxStable },
                  { label: 'Breaking Point', proj: capacity.projectedAtBreakingPoint },
                ].filter(p => p.proj);
                return {
                  labels: points.map(p => `${p.label} (${p.proj.users})`),
                  datasets: [
                    { label: 'Projected Avg RT (ms)', borderColor: '#f59e0b', backgroundColor: '#f59e0b20', borderWidth: 2, pointRadius: 5, tension: 0.3, data: points.map(p => p.proj.avg) },
                    { label: 'Projected Error Rate (%)', borderColor: '#ef4444', backgroundColor: '#ef444420', borderWidth: 2, pointRadius: 5, tension: 0.3, yAxisID: 'y2', data: points.map(p => p.proj.error_rate) },
                  ],
                };
              })()}
              options={lineOpts()}
            />
          </div>
          <div style={{ fontSize: 10.5, color: D.textTer, marginTop: 8 }}>
            <i className="ti ti-info-circle" style={{ marginRight: 4 }} />
            {capacity.formula.description}
          </div>
        </>
      )}
    </div>
  );
}
