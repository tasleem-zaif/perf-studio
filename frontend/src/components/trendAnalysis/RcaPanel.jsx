import { useState, useEffect } from 'react';
import api from '../../api';
import { D } from '../../theme/analyticsDark';

const CATEGORY_STYLE = {
  database:       { color: '#ef4444', icon: 'ti-database' },
  network:        { color: '#f59e0b', icon: 'ti-wifi' },
  application:    { color: '#8b5cf6', icon: 'ti-code' },
  infrastructure: { color: '#06b6d4', icon: 'ti-server-2' },
  unknown:        { color: D.textTer, icon: 'ti-help-circle' },
};

/**
 * Root Cause Analysis — for every API classified "regressed," breaks its response-
 * time increase into connect/processing/transfer/error-rate components and reports
 * the dominant driver (see recommendationEngine.js's diagnoseRootCause).
 */
export default function RcaPanel({ project, runIds }) {
  const [rca, setRca] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(true);
  const runIdsKey = runIds.join(',');

  useEffect(() => {
    if (!project || runIds.length < 2) { setRca([]); return; }
    setLoading(true);
    setError('');
    api.get(`/projects/${project.id}/trend-analysis/rca`, { params: { run_ids: runIdsKey } })
      .then(({ data }) => setRca(data.rca || []))
      .catch(e => setError(e.response?.data?.error || 'Failed to compute RCA'))
      .finally(() => setLoading(false));
  }, [project?.id, runIdsKey]);

  if (runIds.length < 2) return null;

  return (
    <div style={{ background: D.cardBg, border: `1px solid ${D.border}`, borderRadius: 10, padding: 16, marginBottom: 16 }}>
      <button
        onClick={() => setExpanded(e => !e)}
        style={{ display: 'flex', alignItems: 'center', width: '100%', gap: 7, background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', marginBottom: expanded ? 12 : 0 }}
      >
        <i className="ti ti-microscope" style={{ color: D.accent }} />
        <span style={{ fontSize: 13, fontWeight: 700, color: D.textPri }}>Root Cause Analysis</span>
        {rca.length > 0 && (
          <span style={{ fontSize: 11, color: D.textTer, background: D.cardBg2, borderRadius: 10, padding: '1px 8px' }}>{rca.length}</span>
        )}
        <i className={`ti ${expanded ? 'ti-chevron-up' : 'ti-chevron-down'}`} style={{ marginLeft: 'auto', color: D.textTer }} />
      </button>

      {expanded && (
        <>
          {loading && <div style={{ fontSize: 12, color: D.textSec }}><span className="spinner" /> Diagnosing…</div>}
          {error && !loading && <div style={{ fontSize: 12, color: '#ef4444' }}>{error}</div>}
          {!loading && !error && rca.length === 0 && (
            <div style={{ fontSize: 12, color: D.textTer }}>No regressed APIs to diagnose between the selected runs.</div>
          )}

          {!loading && !error && rca.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {rca.map(entry => {
                const s = CATEGORY_STYLE[entry.category] || CATEGORY_STYLE.unknown;
                return (
                  <div key={entry.scope} style={{ display: 'flex', gap: 12, padding: '10px 12px', borderRadius: 8, border: `1px solid ${D.border}`, background: D.cardBg2 }}>
                    <div style={{ width: 34, height: 34, borderRadius: 8, background: `${s.color}22`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <i className={`ti ${s.icon}`} style={{ color: s.color, fontSize: 16 }} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: D.textPri }}>{entry.scope}</span>
                        <span style={{ fontSize: 10, fontWeight: 700, color: s.color, textTransform: 'uppercase', letterSpacing: '.4px' }}>{entry.category}</span>
                      </div>
                      <div style={{ fontSize: 12, color: D.textSec }}>{entry.rootCause}</div>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ fontSize: 15, fontWeight: 700, color: D.textPri }}>{entry.confidencePct}%</div>
                      <div style={{ fontSize: 9.5, color: D.textTer, textTransform: 'uppercase' }}>confidence</div>
                    </div>
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
