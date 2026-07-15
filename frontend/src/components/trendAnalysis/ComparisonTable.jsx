import { useState } from 'react';
import { D } from '../../theme/analyticsDark';

function pct(v) {
  if (v === undefined || v === null || Number.isNaN(v)) return '—';
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
}

const SECTIONS = [
  { key: 'regressed', label: 'Regressed', icon: 'ti-trending-down', color: '#ef4444' },
  { key: 'improved',  label: 'Improved',  icon: 'ti-trending-up',   color: '#22c55e' },
  { key: 'new',       label: 'New APIs',  icon: 'ti-sparkles',      color: '#58a6ff' },
  { key: 'removed',   label: 'Removed APIs', icon: 'ti-trash',      color: '#7a8eaa' },
];

function ApiLabelCell({ label, onDrillDown }) {
  if (!onDrillDown) return <td style={{ padding: '7px 10px', color: D.textPri, fontWeight: 600 }}>{label}</td>;
  return (
    <td style={{ padding: '7px 10px' }}>
      <button
        onClick={() => onDrillDown(label)}
        title={`View ${label}'s own trend chart`}
        style={{ background: 'transparent', border: 'none', padding: 0, color: D.accentBlue, fontWeight: 600, cursor: 'pointer', textDecoration: 'underline', textDecorationStyle: 'dotted', fontSize: 'inherit' }}
      >
        {label}
      </button>
    </td>
  );
}

function DeltaRow({ entry, onDrillDown }) {
  const { label, deltas, baseline, latest } = entry;
  return (
    <tr style={{ borderTop: `1px solid ${D.border}` }}>
      <ApiLabelCell label={label} onDrillDown={onDrillDown} />
      <td style={{ padding: '7px 10px', color: D.textSec }}>{baseline.avg}ms → {latest.avg}ms</td>
      <td style={{ padding: '7px 10px', color: deltas.avgPct > 0 ? '#ef4444' : '#22c55e' }}>{pct(deltas.avgPct)}</td>
      <td style={{ padding: '7px 10px', color: deltas.p95Pct > 0 ? '#ef4444' : '#22c55e' }}>{pct(deltas.p95Pct)}</td>
      <td style={{ padding: '7px 10px', color: deltas.errorRatePts > 0 ? '#ef4444' : (deltas.errorRatePts < 0 ? '#22c55e' : D.textSec) }}>
        {deltas.errorRatePts > 0 ? '+' : ''}{deltas.errorRatePts.toFixed(1)} pts
      </td>
      <td style={{ padding: '7px 10px', color: deltas.tpsPct < 0 ? '#ef4444' : '#22c55e' }}>{pct(deltas.tpsPct)}</td>
    </tr>
  );
}

function SimpleRow({ label, metrics, onDrillDown }) {
  return (
    <tr style={{ borderTop: `1px solid ${D.border}` }}>
      <ApiLabelCell label={label} onDrillDown={onDrillDown} />
      <td style={{ padding: '7px 10px', color: D.textSec }} colSpan={5}>
        avg {metrics.avg}ms · p95 {metrics.p95}ms · error rate {metrics.error_rate}% · {metrics.tps} tps
      </td>
    </tr>
  );
}

/**
 * Improved / Regressed / New / Removed API breakdown between the baseline and
 * latest of the compared runs — see comparisonEngine.js for the weighted-delta
 * classification formula (shown in the footer for transparency).
 */
export default function ComparisonTable({ comparison, onClose, onDrillDown }) {
  const [expanded, setExpanded] = useState(() => new Set(['regressed', 'improved']));

  function toggle(key) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  return (
    <div style={{ background: D.cardBg, border: `1px solid ${D.border}`, borderRadius: 10, padding: 16, marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: D.textPri }}>
          <i className="ti ti-git-compare" style={{ marginRight: 7, color: D.accent }} />
          Comparison — Run {comparison.baselineRunId} vs Run {comparison.latestRunId}
        </div>
        {onClose && (
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: D.textTer, cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>×</button>
        )}
      </div>
      {onDrillDown && (
        <div style={{ fontSize: 11, color: D.textTer, marginBottom: 10 }}>
          <i className="ti ti-hand-click" style={{ marginRight: 4 }} />Click any API name to view its own trend chart.
        </div>
      )}

      {SECTIONS.map(s => {
        const items = comparison[s.key] || [];
        const isOpen = expanded.has(s.key);
        return (
          <div key={s.key} style={{ marginBottom: 10 }}>
            <button
              onClick={() => toggle(s.key)}
              style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 10px', borderRadius: 7, border: `1px solid ${D.border}`, background: D.cardBg2, color: s.color, fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
            >
              <i className={`ti ${s.icon}`} />
              {s.label}
              <span style={{ marginLeft: 4, background: `${s.color}22`, borderRadius: 10, padding: '1px 8px', fontSize: 11 }}>{items.length}</span>
              <i className={`ti ${isOpen ? 'ti-chevron-up' : 'ti-chevron-down'}`} style={{ marginLeft: 'auto', color: D.textTer }} />
            </button>
            {isOpen && items.length > 0 && (
              <div style={{ overflowX: 'auto', border: `1px solid ${D.border}`, borderTop: 'none', borderRadius: '0 0 7px 7px' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  {(s.key === 'regressed' || s.key === 'improved') && (
                    <thead>
                      <tr style={{ background: D.cardBg2 }}>
                        <th style={thStyle()}>API</th>
                        <th style={thStyle()}>Avg RT</th>
                        <th style={thStyle()}>Δ Avg RT</th>
                        <th style={thStyle()}>Δ P95</th>
                        <th style={thStyle()}>Δ Error Rate</th>
                        <th style={thStyle()}>Δ TPS</th>
                      </tr>
                    </thead>
                  )}
                  <tbody>
                    {items.map(entry => (
                      s.key === 'regressed' || s.key === 'improved'
                        ? <DeltaRow key={entry.label} entry={entry} onDrillDown={onDrillDown} />
                        : <SimpleRow key={entry.label} label={entry.label} metrics={entry.latest || entry.baseline} onDrillDown={onDrillDown} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {isOpen && items.length === 0 && (
              <div style={{ padding: '8px 10px', fontSize: 12, color: D.textTer, border: `1px solid ${D.border}`, borderTop: 'none', borderRadius: '0 0 7px 7px' }}>
                None.
              </div>
            )}
          </div>
        );
      })}

      {comparison.formula && (
        <div style={{ marginTop: 8, fontSize: 10.5, color: D.textTer, lineHeight: 1.5 }}>
          <i className="ti ti-info-circle" style={{ marginRight: 4 }} />
          Classification formula ({comparison.formula.version}): {comparison.formula.description}
        </div>
      )}
    </div>
  );
}

function thStyle() {
  return { padding: '7px 10px', textAlign: 'left', color: D.textTer, fontWeight: 700, fontSize: 10, textTransform: 'uppercase', letterSpacing: '.5px' };
}
