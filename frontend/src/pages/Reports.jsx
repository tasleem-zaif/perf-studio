import { useState, useEffect } from 'react';
import api from '../api';
import CustomSelect from '../components/CustomSelect';
import EnvBar from '../components/EnvBar';

async function downloadReportZip(runId, runNum) {
  const token = localStorage.getItem('ps_token');
  const res = await fetch(`/api/execution/runs/${runId}/download-report`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    let msg = `Download failed (${res.status})`;
    try { const j = await res.json(); msg = j.error || msg; } catch {}
    throw new Error(msg);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `JMeter_Report_Run_${runNum}.zip`;
  a.click();
  URL.revokeObjectURL(url);
}

function RunLabel({ run }) {
  const num = run.result_dir?.match(/Run_(\d+)/)?.[1] || run.id;
  const date = run.started_at ? new Date(run.started_at).toLocaleString() : '';
  const duration = run.started_at && run.finished_at
    ? Math.round((new Date(run.finished_at) - new Date(run.started_at)) / 1000)
    : null;
  return `Run ${num} — ${run.suite_name || 'Unknown Suite'} · ${date}${duration != null ? ` · ${duration}s` : ''}`;
}

function StatusBadge({ status }) {
  const map = {
    completed: { cls: 'tag-green', icon: 'ti-circle-check' },
    failed:    { cls: 'tag-red',   icon: 'ti-circle-x' },
    running:   { cls: 'tag-amber', icon: 'ti-loader' },
  };
  const { cls, icon } = map[status] || { cls: 'tag-gray', icon: 'ti-clock' };
  return (
    <span className={`badge ${cls}`} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
      <i className={`ti ${icon}`} style={{ fontSize: '11px' }} />
      {status}
    </span>
  );
}

export default function Reports({ project, collection, env, envs, onEnvChange }) {
  const [runs,     setRuns]     = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [selected, setSelected] = useState(null); // explicit state — avoids timing bugs
  const [loading,  setLoading]  = useState(false);
  const [downloading, setDownloading] = useState(false);

  // Load ALL runs once when project changes
  useEffect(() => {
    if (!project) return;
    setLoading(true);
    setSelectedId('');
    setSelected(null);
    api.get('/execution/runs', { params: { project_id: project.id } })
      .then(({ data }) => setRuns(data.runs || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [project?.id]);

  // Update selected run whenever selectedId or runs change
  useEffect(() => {
    if (!selectedId) { setSelected(null); return; }
    const found = runs.find(r => String(r.id) === selectedId);
    setSelected(found || null);
  }, [selectedId, runs]);

  if (!project) {
    return (
      <div className="page">
        <div className="empty">
          <i className="ti ti-folder-off" />
          <div className="empty-title">Select a project first</div>
        </div>
      </div>
    );
  }

  const jmeterRuns = runs.filter(r => r.engine === 'jmeter');
  const runNum = selected?.result_dir?.match(/Run_(\d+)/)?.[1];

  return (
    <div className="page fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      <EnvBar envs={envs} activeEnv={env} onEnvChange={onEnvChange} hint="Select environment to view JMeter reports" />

      {/* Controls bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '14px', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: '260px' }}>
          <label className="form-label" style={{ marginBottom: '4px', display: 'block' }}>
            <i className="ti ti-history" style={{ marginRight: '5px', color: 'var(--accent)' }} />
            Select Run
          </label>
          {loading ? (
            <div style={{ fontSize: '12px', color: 'var(--color-text-tertiary)' }}><span className="spinner" /> Loading runs…</div>
          ) : runs.length === 0 ? (
            <div style={{ fontSize: '12px', color: 'var(--color-text-tertiary)' }}>No runs found for this project.</div>
          ) : (
            <CustomSelect
              value={selectedId}
              onChange={e => setSelectedId(e.target.value)}
              style={{ width: '100%', maxWidth: '540px' }}
            >
              <option value="">— Select a run —</option>
              {runs.map(r => {
                const num = r.result_dir?.match(/Run_(\d+)/)?.[1] || r.id;
                const date = r.started_at ? new Date(r.started_at).toLocaleString() : '';
                const hasReport = !!r.report_url;
                return (
                  <option key={r.id} value={r.id} disabled={!hasReport && r.engine !== 'jmeter'}>
                    {`Run ${num} — ${r.suite_name || 'Unknown'} — ${r.engine.toUpperCase()} — ${r.status} — ${date}${!hasReport ? ' (no report)' : ''}`}
                  </option>
                );
              })}
            </CustomSelect>
          )}
        </div>

        {selected && (
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', paddingTop: '20px' }}>
            <StatusBadge status={selected.status} />
            <span className="badge tag-gray" style={{ fontSize: '11px' }}>
              <i className={`ti ${selected.engine === 'jmeter' ? 'ti-tool' : 'ti-brand-grafana'}`} style={{ marginRight: '3px' }} />
              {selected.engine}
            </span>
            {runNum && (
              <span className="badge tag-blue" style={{ fontSize: '11px' }}>
                <i className="ti ti-hash" style={{ marginRight: '3px' }} />Run {runNum}
              </span>
            )}
            {selected.report_url && (
              <a
                href={selected.report_url}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-secondary btn-sm"
                style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
              >
                <i className="ti ti-external-link" /> Open in new tab
              </a>
            )}
            {selected.report_url && (
              <button
                className="btn-secondary btn-sm"
                disabled={downloading}
                onClick={async () => {
                  setDownloading(true);
                  try { await downloadReportZip(selected.id, runNum); }
                  catch (e) { alert(e.message || 'Failed to download report ZIP'); }
                  finally { setDownloading(false); }
                }}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
              >
                {downloading ? <span className="spinner" style={{ margin: 0 }} /> : <i className="ti ti-file-zip" />}
                {downloading ? 'Zipping…' : 'Download ZIP'}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Report viewer */}
      {!selectedId && (
        <div className="empty" style={{ flex: 1 }}>
          <i className="ti ti-chart-bar" style={{ fontSize: '40px', color: 'var(--color-text-tertiary)', marginBottom: '10px' }} />
          <div className="empty-title">Select a run to view its report</div>
          <div className="empty-desc">JMeter HTML reports are displayed inline. k6 runs produce JSON output only.</div>
        </div>
      )}

      {selectedId && !selected && (
        <div className="empty" style={{ flex: 1 }}>
          <i className="ti ti-refresh" style={{ fontSize: '36px', color: 'var(--warn)', marginBottom: '10px' }} />
          <div className="empty-title">Run not found</div>
          <div className="empty-desc">The selected run may have been filtered out. Try clearing the environment filter.</div>
        </div>
      )}

      {selectedId && selected && !selected.report_url && (
        <div className="empty" style={{ flex: 1 }}>
          <i className="ti ti-info-circle" style={{ fontSize: '36px', color: 'var(--warn)', marginBottom: '10px' }} />
          <div className="empty-title">No HTML report available</div>
          <div className="empty-desc">
            {selected.engine === 'k6'
              ? 'k6 runs produce JSON output. HTML reports are only generated by JMeter.'
              : selected.status === 'failed'
              ? 'This run failed before a report could be generated.'
              : 'HTML report was not generated for this run.'}
          </div>
          {selected.result_dir && (
            <div style={{ marginTop: '10px', fontSize: '12px', color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>
              Result dir: {selected.result_dir}
            </div>
          )}
        </div>
      )}

      {selectedId && selected?.report_url && (
        <div style={{ border: '1px solid var(--color-border)', borderRadius: '10px', overflow: 'hidden', background: '#fff', height: '72vh' }}>
          <iframe
            key={selected.report_url}
            src={selected.report_url}
            title={`JMeter Report — Run ${runNum}`}
            style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
            sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
          />
        </div>
      )}
    </div>
  );
}
