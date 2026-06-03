import { useState, useEffect, useRef } from 'react';
import Modal from '../components/Modal';
import ConfirmModal from '../components/ConfirmModal';
import { useConfirm } from '../hooks/useConfirm';
import { useToast } from '../hooks/useToast';
import CustomSelect from '../components/CustomSelect';
import api from '../api';
import EnvBar from '../components/EnvBar';

const TEST_TYPES = [
  { value: 'load',      label: 'Load Test',      desc: 'Constant virtual users — baseline performance', icon: 'ti-chart-line', color: 'var(--accent)' },
  { value: 'stress',    label: 'Stress Test',     desc: 'Ramping users — find breaking point', icon: 'ti-flame', color: '#e24b4a' },
  { value: 'spike',     label: 'Spike Test',      desc: 'Sudden traffic spike — recovery behavior', icon: 'ti-bolt', color: '#ef9f27' },
  { value: 'endurance', label: 'Endurance Test',  desc: 'Sustained load — memory leaks & degradation', icon: 'ti-clock', color: '#8b5cf6' },
];

const DEFAULT_FORM = { name: '', test_type: 'load', collection_id: '', env: '', test_data_ids: [], engine: 'jmeter', config: {}, vusers: 50, rampup: 30, iter_mode: 'duration', loops: 1, duration: 300 };

// Must match the simpleHash in ai.js exactly
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString();
}

export default function TestSuites({ project, collection, env, envs, onEnvChange, onNav, onProjectUpdated, openModalTrigger }) {
  const [suites, setSuites] = useState([]);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(DEFAULT_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [generating, setGenerating] = useState(null);
  const [genError, setGenError] = useState({});
  const [preRunData, setPreRunData] = useState({});
  const [preRunning, setPreRunning] = useState(null);
  const [showLogs, setShowLogs] = useState({});
  const [expandedLog, setExpandedLog] = useState({});
  const [testDataFiles, setTestDataFiles] = useState([]);
  const dlRef = useRef(null);
  const firstRender = useRef(true);
  const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm();
  const { toast } = useToast();

  useEffect(() => {
    if (project) {
      loadSuites();
      loadTestDataFiles();
    }
  }, [project?.id, collection?.id, env]);

  async function loadTestDataFiles() {
    if (!project) return;
    try {
      // Filter by collection + env so only files for the current env appear in the dropdown
      const params = collection?.id
        ? `?collection_id=${collection.id}${env ? `&env=${encodeURIComponent(env)}` : ''}`
        : '';
      const { data } = await api.get(`/projects/${project.id}/test-data${params}`);
      // Deduplicate by original_name (safety net against legacy duplicate records)
      const seen = new Set();
      const unique = (data.files || []).filter(f => {
        if (seen.has(f.original_name)) return false;
        seen.add(f.original_name);
        return true;
      });
      setTestDataFiles(unique);
    } catch (e) {
      console.error('Failed to load test data files:', e.response?.data || e.message);
    }
  }

  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    if (openModalTrigger > 0) {
      setForm({ ...DEFAULT_FORM, collection_id: collection?.id ? String(collection.id) : '', env: env || '' });
      setError('');
      setModal('add');
      loadTestDataFiles(); // always refresh when modal opens
    }
  }, [openModalTrigger]);

  async function loadSuites() {
    // Pass collection+env to backend for server-side isolation
    const params = collection?.id
      ? `?collection_id=${collection.id}${env ? `&env=${encodeURIComponent(env)}` : ''}`
      : '';
    const { data } = await api.get(`/projects/${project.id}/test-suites${params}`);
    let suites = data.suites || [];
    if (env) {
      // Client-side safety net: exclude suites with wrong env tag
      suites = suites.filter(s => !s.env || s.env === env);
    }
    setSuites(suites);
    // Restore persisted pre-run data so logs survive page refresh
    const restored = {};
    for (const s of suites) {
      if (s.pre_run_data) {
        try { restored[s.id] = JSON.parse(s.pre_run_data); } catch {}
      }
    }
    setPreRunData(prev => ({ ...prev, ...restored }));
  }

  if (!project) return <div className="page"><div className="empty"><i className="ti ti-folder-off" /><div className="empty-title">Select a project first</div></div></div>;

  async function save() {
    if (!form.name.trim()) return setError('Name required');
    setSaving(true); setError('');
    try {
      // Always stamp collection_id + env from current context so the
      // suite is properly tagged and appears when loadSuites() filters by them
      const payload = {
        ...form,
        collection_id: form.collection_id || (collection?.id ? String(collection.id) : ''),
        env: form.env || env || '',
      };
      if (modal === 'add') await api.post(`/projects/${project.id}/test-suites`, payload);
      else await api.put(`/projects/${project.id}/test-suites/${modal.id}`, payload);
      await loadSuites();
      setModal(null);
    } catch (e) {
      setError(e.response?.data?.error || 'Save failed');
    } finally { setSaving(false); }
  }

  async function del(id) {
    const suite = suites.find(s => s.id === id);
    const ok = await confirm(
      `Delete "${suite?.name || 'this test suite'}"? Any generated scripts will also be removed. This cannot be undone.`,
      'Delete Test Plan'
    );
    if (!ok) return;
    await api.delete(`/projects/${project.id}/test-suites/${id}`);
    loadSuites();
  }

  async function generate(suite) {
    const wasGenerated = suite.jmx_path || suite.js_path;
    setGenerating(suite.id); setGenError(prev => ({ ...prev, [suite.id]: '' }));
    try {
      await api.post(`/projects/${project.id}/test-suites/${suite.id}/generate`, {
        preRunData: preRunData[suite.id] || null,
      });
      await loadSuites();
      const ext = suite.engine === 'jmeter' ? '.jmx' : '.js';
      toast(`Script ${wasGenerated ? 're-generated' : 'generated'} successfully — ${suite.name}${ext} is ready to download`, 'success');
    } catch (e) {
      const msg = e.response?.data?.error || 'Generation failed';
      setGenError(prev => ({ ...prev, [suite.id]: msg }));
      toast(msg, 'error');
    } finally { setGenerating(null); }
  }

  async function preRun(suite) {
    if (!suite.collection_id) return toast('Assign a collection to this suite first', 'warn');
    setPreRunning(suite.id);
    setShowLogs(prev => ({ ...prev, [suite.id]: false }));
    try {
      const { data } = await api.post('/ai/pre-run', { collection_id: suite.collection_id, project_id: project.id, suite_id: suite.id });
      setPreRunData(prev => ({ ...prev, [suite.id]: data.responses }));
      setShowLogs(prev => ({ ...prev, [suite.id]: true }));
      const failed = data.responses.filter(r => r.error || !r.success).length;
      if (failed > 0) toast(`Pre-run complete — ${failed} endpoint(s) failed. Check logs.`, 'warn');
      else toast(`Pre-run complete — all ${data.responses.length} endpoint(s) succeeded`, 'success');
      await loadSuites(); // reload so pre_run_collection_hash is up to date
    } catch (e) {
      toast(e.response?.data?.error || 'Pre-run failed', 'error');
    } finally { setPreRunning(null); }
  }

  function toggleLog(suiteId) {
    setShowLogs(prev => ({ ...prev, [suiteId]: !prev[suiteId] }));
  }
  function toggleEndpoint(key) {
    setExpandedLog(prev => ({ ...prev, [key]: !prev[key] }));
  }

  function download(suite, type) {
    const a = dlRef.current;
    a.href = `/api/projects/${project.id}/test-suites/${suite.id}/download/${type}`;
    a.download = '';
    a.click();
  }

  function openEdit(s) {
    let dataIds = [];
    try { dataIds = JSON.parse(s.test_data_ids || '[]'); } catch {}
    if (!dataIds.length && s.test_data_id) dataIds = [s.test_data_id];
    setForm({ name: s.name, test_type: s.test_type, collection_id: s.collection_id || '', env: s.env || '', test_data_ids: dataIds, engine: s.engine, config: JSON.parse(s.config_json || '{}'), vusers: s.vusers || 50, rampup: s.rampup || 30, iter_mode: s.iter_mode || 'duration', loops: s.loops || 1, duration: s.duration || 300 });
    setError(''); setModal(s);
    loadTestDataFiles(); // refresh in case files were added/removed
  }

  const typeInfo = t => TEST_TYPES.find(x => x.value === t) || TEST_TYPES[0];

  function isPreRunFresh(suite) {
    if (!suite.pre_run_data || !suite.pre_run_collection_hash) return false;
    const col = project.collections?.find(c => String(c.id) === String(suite.collection_id));
    if (!col) return false;
    return simpleHash(col.json_content || '') === suite.pre_run_collection_hash;
  }

  function envTagClass(env) {
    const e = (env || '').toLowerCase();
    if (e.includes('prod')) return 'tag-red';
    if (e.includes('stag') || e.includes('uat')) return 'tag-amber';
    if (e.includes('qa') || e.includes('test')) return 'tag-blue';
    return 'tag-gray';
  }

  return (
    <div className="page fade-in">
      <a ref={dlRef} style={{ display: 'none' }} />
      <div className="breadcrumb">
        <a onClick={() => onNav('dashboard')}><i className="ti ti-layout-dashboard" style={{ fontSize: '12px', marginRight: '4px' }} />Dashboard</a>
        <i className="ti ti-chevron-right" style={{ fontSize: '12px' }} />
        <a onClick={() => onNav('project-home')}><i className="ti ti-folder" style={{ fontSize: '12px', marginRight: '4px' }} />{project.name}</a>
        <i className="ti ti-chevron-right" style={{ fontSize: '12px' }} />
        <span><i className="ti ti-test-pipe" style={{ fontSize: '12px', marginRight: '4px' }} />Test Plans</span>
      </div>
      <EnvBar envs={envs} activeEnv={env} onEnvChange={onEnvChange} hint="Select environment to view or create test plans" />

      <div className="section-hdr">
        <div className="section-title"><i className="ti ti-test-pipe" style={{ marginRight: '8px', color: 'var(--accent)' }} />Test Plans <span className="badge tag-gray">{suites.length}</span></div>
      </div>

      {/* Test type info cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '10px', marginBottom: '20px' }}>
        {TEST_TYPES.map(t => (
          <div key={t.value} style={{ padding: '12px 14px', background: 'var(--color-background-secondary)', borderRadius: '10px', borderLeft: `3px solid ${t.color}` }}>
            <div style={{ fontWeight: 600, fontSize: '13px', marginBottom: '4px' }}><i className={`ti ${t.icon}`} style={{ color: t.color, marginRight: '6px' }} />{t.label}</div>
            <div style={{ fontSize: '11px', color: 'var(--color-text-secondary)' }}>{t.desc}</div>
          </div>
        ))}
      </div>

      {suites.length ? suites.map(s => {
        const ti = typeInfo(s.test_type);
        const isGenerating = generating === s.id;
        const hasScript = s.jmx_path || s.js_path;
        const linkedCollection = project.collections?.find(c => String(c.id) === String(s.collection_id));
        const responses = preRunData[s.id] || null;
        const preRunFresh = isPreRunFresh(s);
        const successCount = responses ? responses.filter(r => r.success).length : 0;
        const failCount = responses ? responses.filter(r => r.error || r.skipped || !r.success).length : 0;
        const logsVisible = showLogs[s.id];

        const METHOD_COLOR = { GET: 'var(--accent)', POST: '#00c896', PUT: '#f0a732', PATCH: '#8b5cf6', DELETE: '#f75464' };

        return (
          <div key={s.id} style={{ marginBottom: '12px' }}>
            <div className="card">
              {/* Header row */}
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
                  <div style={{ width: '40px', height: '40px', borderRadius: '8px', background: `${ti.color}22`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <i className={`ti ${ti.icon}`} style={{ color: ti.color }} />
                  </div>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '15px' }}>{s.name}</div>
                    <div style={{ display: 'flex', gap: '6px', marginTop: '4px', flexWrap: 'wrap' }}>
                      <span className="tag tag-blue">{ti.label}</span>
                      <span className="tag tag-gray"><i className="ti ti-tool" style={{ fontSize: '11px' }} /> {s.engine === 'jmeter' ? 'JMeter' : 'K6'}</span>
                      {linkedCollection?.environment && <span className={`tag ${envTagClass(linkedCollection.environment)}`}><i className="ti ti-server" style={{ fontSize: '11px' }} /> {linkedCollection.environment}</span>}
                      {s.status === 'generated' && <span className="tag tag-green"><i className="ti ti-check" style={{ fontSize: '11px' }} /> Generated</span>}
                      {s.status === 'pending' && <span className="tag tag-gray">Pending</span>}
                    </div>
                    <div style={{ display: 'flex', gap: '6px', marginTop: '4px' }}>
                      <span className="tag tag-gray"><i className="ti ti-users" style={{ fontSize: '11px' }} /> {s.vusers || 50} VUsers</span>
                      <span className="tag tag-gray"><i className="ti ti-trending-up" style={{ fontSize: '11px' }} /> {s.rampup || 30}s ramp</span>
                      <span className="tag tag-gray"><i className="ti ti-clock" style={{ fontSize: '11px' }} /> {s.iter_mode === 'loops' ? `${s.loops || 1} loops` : `${s.duration || 300}s`}</span>
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <button className="btn-secondary btn-sm" onClick={() => openEdit(s)}><i className="ti ti-edit" /></button>
                  <button className="btn-secondary btn-sm" style={{ color: 'var(--danger)', borderColor: 'rgba(247,84,100,0.3)' }} onClick={() => del(s.id)}><i className="ti ti-trash" /></button>
                </div>
              </div>

              {/* Pre-run / Generate action bar */}
              <div style={{ marginTop: '14px', paddingTop: '12px', borderTop: '1px solid var(--color-border-tertiary)' }}>
                {preRunning === s.id ? (
                  /* ── Running spinner ── */
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: 'var(--color-text-secondary)', padding: '6px 0' }}>
                    <span className="spinner" /> Running pre-run against collection endpoints...
                  </div>
                ) : !preRunFresh ? (
                  /* ── Pre-run required / stale ── */
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '10px 14px', background: 'rgba(240,167,50,0.08)', border: '1px solid rgba(240,167,50,0.25)', borderRadius: '8px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: 'var(--warn)' }}>
                      <i className="ti ti-alert-triangle" style={{ fontSize: '15px' }} />
                      {responses && !preRunFresh
                        ? <span><strong>Collection changed</strong> — Re-run pre-run to reflect the latest endpoints before generating.</span>
                        : <span><strong>Pre-run required</strong> — Run a pre-run against your collection endpoints before generating the script.</span>
                      }
                    </div>
                    <button className="btn-primary btn-sm" style={{ flexShrink: 0 }} onClick={() => preRun(s)}>
                      <i className="ti ti-player-play" />{responses ? 'Re-run Pre-run' : 'Run Pre-run'}
                    </button>
                  </div>
                ) : (
                  /* ── Pre-run fresh ── */
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontSize: '12px', color: '#00c896', display: 'flex', alignItems: 'center', gap: '5px' }}>
                        <i className="ti ti-circle-check" /> {successCount} passed
                      </span>
                      {failCount > 0 && (
                        <span style={{ fontSize: '12px', color: 'var(--danger)', display: 'flex', alignItems: 'center', gap: '5px' }}>
                          <i className="ti ti-circle-x" /> {failCount} failed
                        </span>
                      )}
                      <button className="btn-secondary btn-sm" onClick={() => toggleLog(s.id)}>
                        <i className={`ti ti-${logsVisible ? 'chevron-up' : 'chevron-down'}`} /> {logsVisible ? 'Hide Logs' : 'View Logs'}
                      </button>
                    </div>
                    <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                      {failCount > 0 ? (
                        <span style={{ fontSize: '12px', color: 'var(--danger)', display: 'flex', alignItems: 'center', gap: '5px' }}>
                          <i className="ti ti-lock" /> Fix failed endpoints and re-run to generate
                        </span>
                      ) : (
                        <>
                          <button className="btn-primary btn-sm" onClick={() => generate(s)} disabled={isGenerating}>
                            {isGenerating ? <><span className="spinner" />Generating...</> : <><i className="ti ti-sparkles" />{hasScript ? 'Re-generate Script' : 'Generate Script'}</>}
                          </button>
                          {hasScript && s.engine === 'jmeter' && s.jmx_path && (
                            <button className="btn-secondary btn-sm" onClick={() => download(s, 'jmx')}><i className="ti ti-download" />.jmx</button>
                          )}
                          {hasScript && s.engine === 'k6' && s.js_path && (
                            <button className="btn-secondary btn-sm" onClick={() => download(s, 'js')}><i className="ti ti-download" />.js</button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {genError[s.id] && <div className="auth-error" style={{ marginTop: '10px' }}>{genError[s.id]}</div>}
            </div>

            {/* ── Pre-run log panel ── */}
            {responses && logsVisible && (
              <div style={{ border: '1px solid var(--color-border-secondary)', borderTop: 'none', borderRadius: '0 0 10px 10px', background: 'var(--color-background-secondary)', overflow: 'hidden' }}>
                <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--color-border-tertiary)', fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--color-text-tertiary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <i className="ti ti-list-details" /> Pre-run Logs — {responses.length} endpoint{responses.length !== 1 ? 's' : ''}
                </div>
                {responses.map((r, idx) => {
                  const key = `${s.id}_${idx}`;
                  const expanded = expandedLog[key];
                  const isErr = r.error || r.skipped;
                  const statusColor = !r.status ? 'var(--color-text-tertiary)' : r.status < 300 ? '#00c896' : r.status < 400 ? 'var(--accent)' : 'var(--danger)';
                  return (
                    <div key={idx} style={{ borderBottom: idx < responses.length - 1 ? '1px solid var(--color-border-tertiary)' : 'none' }}>
                      {/* Endpoint summary row */}
                      <div onClick={() => toggleEndpoint(key)} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 14px', cursor: 'pointer', userSelect: 'none' }}
                        onMouseEnter={e => e.currentTarget.style.background = 'var(--color-background-hover)'}
                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                        <i className={`ti ti-chevron-${expanded ? 'down' : 'right'}`} style={{ fontSize: '11px', color: 'var(--color-text-tertiary)', flexShrink: 0 }} />
                        {r.method && (
                          <span style={{ fontSize: '10px', fontWeight: 700, padding: '2px 6px', borderRadius: '4px', background: `${METHOD_COLOR[r.method] || '#888'}22`, color: METHOD_COLOR[r.method] || '#888', flexShrink: 0 }}>{r.method}</span>
                        )}
                        <span style={{ fontSize: '12px', flex: 1, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.url || r.endpoint}</span>
                        {r.tokenExtracted && (
                          <span style={{ fontSize: '10px', fontWeight: 700, padding: '2px 6px', borderRadius: '4px', background: 'rgba(0,200,150,0.15)', color: '#00c896', flexShrink: 0 }}>TOKEN EXTRACTED</span>
                        )}
                        {r.tokenInjected && (
                          <span style={{ fontSize: '10px', fontWeight: 700, padding: '2px 6px', borderRadius: '4px', background: 'rgba(78,158,255,0.15)', color: 'var(--accent)', flexShrink: 0 }}>AUTH INJECTED</span>
                        )}
                        {r.endpoint !== r.url && r.endpoint && (
                          <span style={{ fontSize: '11px', color: 'var(--color-text-tertiary)', flexShrink: 0 }}>{r.endpoint}</span>
                        )}
                        {r.status ? (
                          <span style={{ fontSize: '11px', fontWeight: 700, color: statusColor, flexShrink: 0 }}>{r.status} {r.statusText}</span>
                        ) : isErr ? (
                          <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--danger)', flexShrink: 0 }}>{r.skipped ? 'SKIPPED' : 'ERROR'}</span>
                        ) : null}
                      </div>

                      {/* Expanded detail */}
                      {expanded && (
                        <div style={{ padding: '0 14px 10px 36px', fontSize: '12px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          {isErr ? (
                            <div style={{ padding: '8px 12px', background: 'rgba(247,84,100,0.08)', borderRadius: '6px', color: 'var(--danger)', fontFamily: 'monospace', fontSize: '12px' }}>
                              <i className="ti ti-alert-circle" style={{ marginRight: '6px' }} />{r.error || r.reason}
                            </div>
                          ) : (
                            <>
                              {r.requestHeaders && (() => {
                                const open = expandedLog[`${key}_hdrs`];
                                return (
                                  <div style={{ border: '1px solid var(--color-border-tertiary)', borderRadius: '6px', overflow: 'hidden' }}>
                                    <div onClick={() => toggleEndpoint(`${key}_hdrs`)} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 10px', cursor: 'pointer', background: 'var(--color-background-secondary)', userSelect: 'none' }}
                                      onMouseEnter={e => e.currentTarget.style.opacity = '0.8'} onMouseLeave={e => e.currentTarget.style.opacity = '1'}>
                                      <i className={`ti ti-chevron-${open ? 'down' : 'right'}`} style={{ fontSize: '10px', color: 'var(--color-text-tertiary)' }} />
                                      <span style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--color-text-tertiary)' }}>Request Headers</span>
                                      <span style={{ fontSize: '10px', color: 'var(--color-text-tertiary)', marginLeft: 'auto' }}>{Object.keys(r.requestHeaders).length} keys</span>
                                    </div>
                                    {open && <pre style={{ margin: 0, padding: '8px 10px', fontSize: '11px', overflowX: 'auto', color: 'var(--color-text-secondary)' }}>{JSON.stringify(r.requestHeaders, null, 2)}</pre>}
                                  </div>
                                );
                              })()}

                              {r.requestBody && (() => {
                                const open = expandedLog[`${key}_rbody`];
                                return (
                                  <div style={{ border: '1px solid var(--color-border-tertiary)', borderRadius: '6px', overflow: 'hidden' }}>
                                    <div onClick={() => toggleEndpoint(`${key}_rbody`)} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 10px', cursor: 'pointer', background: 'var(--color-background-secondary)', userSelect: 'none' }}
                                      onMouseEnter={e => e.currentTarget.style.opacity = '0.8'} onMouseLeave={e => e.currentTarget.style.opacity = '1'}>
                                      <i className={`ti ti-chevron-${open ? 'down' : 'right'}`} style={{ fontSize: '10px', color: 'var(--color-text-tertiary)' }} />
                                      <span style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--color-text-tertiary)' }}>Request Body</span>
                                    </div>
                                    {open && <pre style={{ margin: 0, padding: '8px 10px', fontSize: '11px', overflowX: 'auto', color: 'var(--color-text-secondary)' }}>{r.requestBody}</pre>}
                                  </div>
                                );
                              })()}

                              {(() => {
                                const open = expandedLog[`${key}_resp`];
                                const bodyStr = typeof r.body === 'string' ? r.body : JSON.stringify(r.body, null, 2);
                                return (
                                  <div style={{ border: '1px solid var(--color-border-tertiary)', borderRadius: '6px', overflow: 'hidden' }}>
                                    <div onClick={() => toggleEndpoint(`${key}_resp`)} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 10px', cursor: 'pointer', background: 'var(--color-background-secondary)', userSelect: 'none' }}
                                      onMouseEnter={e => e.currentTarget.style.opacity = '0.8'} onMouseLeave={e => e.currentTarget.style.opacity = '1'}>
                                      <i className={`ti ti-chevron-${open ? 'down' : 'right'}`} style={{ fontSize: '10px', color: 'var(--color-text-tertiary)' }} />
                                      <span style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--color-text-tertiary)' }}>Response Body</span>
                                      <span style={{ fontSize: '10px', color: statusColor, marginLeft: 'auto', fontWeight: 600 }}>{r.status} {r.statusText}</span>
                                    </div>
                                    {open && <pre style={{ margin: 0, padding: '8px 10px', fontSize: '11px', overflowX: 'auto', maxHeight: '220px', color: 'var(--color-text-secondary)' }}>{bodyStr}</pre>}
                                  </div>
                                );
                              })()}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      }) : (
        <div className="empty">
          <i className="ti ti-test-pipe" />
          <div className="empty-title">No test plans yet</div>
          <div className="empty-sub">Create a test plan to generate JMeter or K6 scripts</div>
          <button className="btn-primary" style={{ marginTop: '16px' }} onClick={() => { setForm({ ...DEFAULT_FORM, collection_id: collection?.id ? String(collection.id) : '', env: env || '' }); setError(''); setModal('add'); }}>New Test Plan</button>
        </div>
      )}

      <ConfirmModal {...confirmState} onConfirm={handleConfirm} onCancel={handleCancel} />

      {modal && (
        <Modal onClose={() => setModal(null)}>
          <div className="modal-hdr">
            <div className="modal-title">{modal === 'add' ? 'New' : 'Edit'} Test Plan</div>
            <button className="btn-icon" onClick={() => setModal(null)}><i className="ti ti-x" /></button>
          </div>
          {error && <div className="auth-error">{error}</div>}

          <div className="form-group">
            <label className="form-label">Suite Name</label>
            <input type="text" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. API Load Test" autoFocus />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div className="form-group">
              <label className="form-label">Test Type</label>
              <CustomSelect value={form.test_type} onChange={e => setForm(f => ({ ...f, test_type: e.target.value }))}>
                {TEST_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </CustomSelect>
            </div>
            <div className="form-group">
              <label className="form-label">Engine</label>
              <CustomSelect value={form.engine} onChange={e => setForm(f => ({ ...f, engine: e.target.value }))}>
                <option value="jmeter">Apache JMeter (.jmx)</option>
                <option value="k6">Grafana K6 (.js)</option>
              </CustomSelect>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div className="form-group">
              <label className="form-label">Collection</label>
              <CustomSelect value={form.collection_id} onChange={e => setForm(f => ({ ...f, collection_id: e.target.value }))}>
                <option value="">— None —</option>
                {project.collections?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </CustomSelect>
            </div>
            <div className="form-group">
              <label className="form-label">Test Data (CSV) <span style={{ fontWeight: 400, color: 'var(--color-text-tertiary)' }}>— select multiple</span></label>
              <div style={{ border: '1px solid var(--color-border, #3a3c42)', borderRadius: '6px', maxHeight: '110px', overflowY: 'auto', padding: '4px 2px', background: 'var(--color-background)' }}>
                {testDataFiles.length === 0
                  ? <div style={{ padding: '6px 10px', fontSize: '12px', color: 'var(--color-text-tertiary)' }}>No CSV files uploaded</div>
                  : testDataFiles.map(f => {
                      const checked = form.test_data_ids.includes(f.id) || form.test_data_ids.includes(String(f.id));
                      return (
                        <label key={f.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '5px 10px', cursor: 'pointer', borderRadius: '4px', fontSize: '13px' }}
                          onMouseEnter={e => e.currentTarget.style.background = 'var(--color-background-secondary)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                        >
                          <input type="checkbox" checked={checked} onChange={e => setForm(prev => ({
                            ...prev,
                            test_data_ids: e.target.checked
                              ? [...prev.test_data_ids, f.id]
                              : prev.test_data_ids.filter(id => String(id) !== String(f.id))
                          }))} style={{ accentColor: 'var(--accent)', width: '14px', height: '14px', flexShrink: 0 }} />
                          <i className="ti ti-table" style={{ fontSize: '12px', color: 'var(--color-text-tertiary)', flexShrink: 0 }} />
                          {f.original_name}
                        </label>
                      );
                    })
                }
              </div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
            <div className="form-group">
              <label className="form-label">Virtual Users</label>
              <input type="number" value={form.vusers} onChange={e => setForm(f => ({ ...f, vusers: +e.target.value }))} min="1" />
            </div>
            <div className="form-group">
              <label className="form-label">Ramp-up (secs)</label>
              <input type="number" value={form.rampup} onChange={e => setForm(f => ({ ...f, rampup: +e.target.value }))} min="0" />
            </div>
            <div className="form-group">
              <label className="form-label">Iteration Mode</label>
              <CustomSelect value={form.iter_mode} onChange={e => setForm(f => ({ ...f, iter_mode: e.target.value }))}>
                <option value="duration">Test Duration (secs)</option>
                <option value="loops">Loop Count</option>
              </CustomSelect>
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">{form.iter_mode === 'duration' ? 'Duration (seconds)' : 'Number of Loops'}</label>
            <input type="number" value={form.iter_mode === 'duration' ? form.duration : form.loops} onChange={e => setForm(f => form.iter_mode === 'duration' ? { ...f, duration: +e.target.value } : { ...f, loops: +e.target.value })} min="1" />
          </div>

          <div className="modal-footer">
            <button className="btn-secondary" onClick={() => setModal(null)}>Cancel</button>
            <button className="btn-primary" onClick={save} disabled={saving}>{saving && <span className="spinner" />}Save</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
