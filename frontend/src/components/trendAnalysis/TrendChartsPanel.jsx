import { useState, useEffect } from 'react';
import { Line } from 'react-chartjs-2';
import api from '../../api';
import CustomSelect from '../CustomSelect';
import { D } from '../../theme/analyticsDark';

const chartFont = { family: "'Inter','Segoe UI',sans-serif", size: 11 };

function chartTheme() {
  const gridColor = 'rgba(48,54,61,0.8)';
  return {
    tooltip: { backgroundColor: '#1c2330', titleColor: '#e6edf3', bodyColor: '#8b949e', borderColor: '#30363d', borderWidth: 1, cornerRadius: 6, padding: 10 },
    scaleX: { ticks: { color: '#6e7681', font: chartFont }, grid: { color: gridColor }, border: { color: gridColor } },
    scaleY: { ticks: { color: '#6e7681', font: chartFont }, grid: { color: gridColor }, border: { color: gridColor } },
  };
}

function lineOpts({ dualAxis, y2Label, yLabel } = {}) {
  const { tooltip, scaleX, scaleY } = chartTheme();
  return {
    responsive: true, maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { display: true, labels: { color: D.textTer, font: chartFont, boxWidth: 12, padding: 14 } }, tooltip },
    scales: {
      x: scaleX,
      y: { ...scaleY, title: yLabel ? { display: true, text: yLabel, color: D.textTer, font: chartFont } : undefined },
      ...(dualAxis ? { y2: { ...scaleY, position: 'right', grid: { drawOnChartArea: false }, title: y2Label ? { display: true, text: y2Label, color: D.textTer, font: chartFont } : undefined } } : {}),
    },
  };
}

function Card({ children }) {
  return <div style={{ background: D.cardBg, border: `1px solid ${D.border}`, borderRadius: 10, padding: 16 }}>{children}</div>;
}

function TrendBadge({ label, regression }) {
  if (!regression) return null;
  const { direction, slope, rSquared } = regression;
  const color = direction === 'up' ? '#ef4444' : direction === 'down' ? '#22c55e' : D.textTer;
  const icon = direction === 'up' ? 'ti-trending-up' : direction === 'down' ? 'ti-trending-down' : 'ti-minus';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color, fontWeight: 600 }}>
      <i className={`ti ${icon}`} />
      {label}: {direction === 'flat' ? 'stable' : `${slope > 0 ? '+' : ''}${slope.toFixed(2)}/run`}
      <span style={{ color: D.textTer, fontWeight: 400 }}>(R²={rSquared.toFixed(2)})</span>
    </span>
  );
}

/**
 * Cross-execution trend charts for the currently filtered/selected run set. Shows
 * response time (avg + p95) and throughput/error-rate over the run sequence, with
 * an optional moving-average overlay and a linear-regression trend slope readout.
 */
export default function TrendChartsPanel({ project, runs, focusScope, focusToken }) {
  const [scope, setScope] = useState('__overall__');
  const [apiOptions, setApiOptions] = useState([]);
  const [showMovingAvg, setShowMovingAvg] = useState(true);
  const [showForecast, setShowForecast] = useState(true);
  const [window, setWindowSize] = useState(3);
  const [trend, setTrend] = useState(null);
  const [forecastData, setForecastData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const runIds = runs.map(r => r.id);
  const runIdsKey = runIds.join(',');

  useEffect(() => {
    if (!project || runIds.length < 2) return;
    api.get(`/projects/${project.id}/trend-analysis/apis`, { params: { run_ids: runIdsKey } })
      .then(({ data }) => setApiOptions(data.labels || []))
      .catch(() => setApiOptions([]));
  }, [project?.id, runIdsKey]);

  // Drill-down from the Comparison table — jump this chart's scope to a specific
  // API. Keyed off focusToken (not just focusScope) so clicking the same API twice
  // in a row still re-triggers the scroll/focus behavior in the parent.
  useEffect(() => {
    if (focusScope) setScope(focusScope);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusToken]);

  useEffect(() => {
    if (!project || runIds.length < 2) { setTrend(null); return; }
    setLoading(true);
    setError('');
    api.get(`/projects/${project.id}/trend-analysis/trend`, { params: { run_ids: runIdsKey, scope, window } })
      .then(({ data }) => setTrend(data))
      .catch(e => setError(e.response?.data?.error || 'Failed to load trend data'))
      .finally(() => setLoading(false));
  }, [project?.id, runIdsKey, scope, window]);

  useEffect(() => {
    if (!project || runIds.length < 2) { setForecastData(null); return; }
    api.get(`/projects/${project.id}/trend-analysis/forecast`, { params: { run_ids: runIdsKey, scope, metric: 'avg' } })
      .then(({ data }) => setForecastData(data))
      .catch(() => setForecastData(null));
  }, [project?.id, runIdsKey, scope]);

  if (runIds.length < 2) {
    return (
      <div style={{ fontSize: 12, color: D.textTer, padding: '10px 2px' }}>
        Select at least 2 runs (via a filter/mode above) to plot a trend.
      </div>
    );
  }

  const runLabels = trend?.runs.map(r => new Date(r.started_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })) || [];

  // Anomaly points (z-score or IQR outlier) get a highlighted marker on the Avg RT line.
  const outlierIndices = new Set([
    ...(forecastData?.anomalies?.zScore || []),
    ...(forecastData?.anomalies?.iqr || []),
  ].map(a => a.index));
  const avgPointColors = (trend?.series.avg || []).map((_, i) => (outlierIndices.has(i) ? '#ef4444' : '#49CC3D'));
  const avgPointRadii = (trend?.series.avg || []).map((_, i) => (outlierIndices.has(i) ? 6 : 3));

  const canForecast = showForecast && forecastData && !forecastData.forecast?.insufficientData;
  const forecastChartLabels = trend ? [...runLabels, 'Next (forecast)'] : [];
  const forecastLine = canForecast && trend
    ? [...Array(Math.max(0, trend.series.avg.length - 1)).fill(null), trend.series.avg[trend.series.avg.length - 1], forecastData.forecast.linearForecast]
    : [];

  const rtChart = trend && {
    labels: canForecast ? forecastChartLabels : runLabels,
    datasets: [
      { label: 'Avg RT', data: trend.series.avg, borderColor: '#49CC3D', backgroundColor: '#49CC3D20', borderWidth: 2, pointRadius: avgPointRadii, pointBackgroundColor: avgPointColors, tension: 0.3 },
      { label: 'P95', data: trend.series.p95, borderColor: '#58a6ff', backgroundColor: '#58a6ff20', borderWidth: 2, pointRadius: 3, tension: 0.3 },
      ...(showMovingAvg ? [{ label: `Avg RT (moving avg, w=${trend.window})`, data: trend.movingAverage.avg, borderColor: '#f59e0b', borderWidth: 2, borderDash: [5, 4], pointRadius: 0, tension: 0.3 }] : []),
      ...(canForecast ? [{
        label: 'Forecast (next execution)', data: forecastLine, borderColor: '#a855f7', borderWidth: 2, borderDash: [3, 3],
        pointRadius: [...Array(Math.max(0, forecastLine.length - 1)).fill(0), 6], pointBackgroundColor: '#a855f7', tension: 0,
      }] : []),
    ],
  };

  const throughputChart = trend && {
    labels: runLabels,
    datasets: [
      { label: 'TPS', data: trend.series.tps, borderColor: '#06b6d4', backgroundColor: '#06b6d420', borderWidth: 2, pointRadius: 3, tension: 0.3, yAxisID: 'y' },
      { label: 'Error Rate (%)', data: trend.series.error_rate, borderColor: '#ef4444', backgroundColor: '#ef444420', borderWidth: 2, pointRadius: 3, tension: 0.3, yAxisID: 'y2' },
    ],
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 180 }}>
          <CustomSelect value={scope} onChange={e => setScope(e.target.value)}>
            <option value="__overall__">Overall (all APIs)</option>
            {apiOptions.map(l => <option key={l} value={l}>{l}</option>)}
          </CustomSelect>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: D.textSec, cursor: 'pointer' }}>
          <input type="checkbox" checked={showMovingAvg} onChange={e => setShowMovingAvg(e.target.checked)} />
          Moving average
        </label>
        {showMovingAvg && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 11, color: D.textTer }}>Window</span>
            <input
              type="number" min={1} max={20} value={window}
              onChange={e => setWindowSize(Math.max(1, Math.min(20, parseInt(e.target.value, 10) || 1)))}
              style={{ width: 50, padding: '4px 6px', borderRadius: 5, border: `1px solid ${D.border}`, background: D.cardBg2, color: D.textPri, fontSize: 12 }}
            />
          </div>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: D.textSec, cursor: 'pointer' }}>
          <input type="checkbox" checked={showForecast} onChange={e => setShowForecast(e.target.checked)} />
          Forecast next execution
        </label>
      </div>

      {loading && <div style={{ fontSize: 12, color: D.textSec }}><span className="spinner" /> Loading trend…</div>}
      {error && !loading && <div style={{ fontSize: 12, color: '#ef4444' }}>{error}</div>}

      {trend && !loading && !error && (
        <>
          <Card>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: D.textSec }}>
                <i className="ti ti-clock" style={{ marginRight: 6, color: D.accent }} />Response Time Trend {scope !== '__overall__' && `— ${scope}`}
              </div>
              <TrendBadge label="Trend" regression={trend.regression.avg} />
            </div>
            <div style={{ height: 260 }}><Line data={rtChart} options={lineOpts({ yLabel: 'ms' })} /></div>
            {(canForecast || outlierIndices.size > 0 || forecastData?.seasonality?.detected) && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 10, paddingTop: 10, borderTop: `1px solid ${D.border}`, fontSize: 11.5, color: D.textSec }}>
                {canForecast && (
                  <span>
                    <i className="ti ti-chart-dots" style={{ marginRight: 5, color: '#a855f7' }} />
                    Next execution forecast: <strong style={{ color: D.textPri }}>{forecastData.forecast.linearForecast}ms</strong> (linear) / <strong style={{ color: D.textPri }}>{forecastData.forecast.exponentialSmoothingForecast}ms</strong> (smoothed)
                    <span style={{ color: D.textTer }}> — {forecastData.forecast.confidencePct}% confidence</span>
                  </span>
                )}
                {outlierIndices.size > 0 && (
                  <span><i className="ti ti-alert-triangle" style={{ marginRight: 5, color: '#ef4444' }} />{outlierIndices.size} anomalous execution{outlierIndices.size === 1 ? '' : 's'} detected (highlighted)</span>
                )}
                {forecastData?.seasonality?.detected && (
                  <span><i className="ti ti-repeat" style={{ marginRight: 5, color: '#f59e0b' }} />Recurring pattern detected — repeats roughly every {forecastData.seasonality.period} executions</span>
                )}
              </div>
            )}
          </Card>

          <Card>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: D.textSec }}>
                <i className="ti ti-bolt" style={{ marginRight: 6, color: '#06b6d4' }} />Throughput &amp; Error Rate Trend
              </div>
              <div style={{ display: 'flex', gap: 12 }}>
                <TrendBadge label="TPS" regression={trend.regression.tps} />
                <TrendBadge label="Errors" regression={trend.regression.error_rate} />
              </div>
            </div>
            <div style={{ height: 260 }}><Line data={throughputChart} options={lineOpts({ dualAxis: true, yLabel: 'Req/s', y2Label: 'Error %' })} /></div>
          </Card>
        </>
      )}
    </div>
  );
}
