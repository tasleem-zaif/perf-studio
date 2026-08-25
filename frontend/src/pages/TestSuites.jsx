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

// Must match simpleHash in ai.js exactly
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString();
}

export default function TestSuites({ project, collection, env, envs, onEnvChange, onNav, onProjectUpdated, openModalTrigger, onAfterSave }) {
  const [suites, setSuites] = useState([]);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState(DEFAULT_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [generating, setGenerating] = useState(null);
  const [genError, setGenError] = useState({});
  const [testDataFiles, setTestDataFiles] = useState([]);
  const [testDataSearch, setTestDataSearch] = useState('');
  const [ownCollections, setOwnCollections] = useState(project?.collections || []);
  const [filterCollectionId, setFilterCollectionId] = useState('');
  const [filterEnv,          setFilterEnv]          = useState('');
  const dlRef = useRef(null);
  const firstRender = useRef(true);
  const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm();
  const { toast } = useToast();

  // Derived envs for filter bar
  const filterCollection = ownCollections.find(c => String(c.id) === String(filterCollectionId));
  const filterEnvOptions = (() => {
    if (!filterCollection) return [];
    let e = [];
    try { e = JSON.parse(filterCollection.environments || '[]'); } catch {}
    if (!e.length && filterCollection.environment) e = [filterCollection.environment];
    return e;
  })();

  // Load collections once, reload suites when filter changes
  useEffect(() => {
    if (project) {
      api.get(`/projects/${project.id}/collections`)
        .then(r => setOwnCollections(r.data.collections || []))
        .catch(() => {});
    }
  }, [project?.id]);

  useEffect(() => {
    if (project) { loadSuites(); loadTestDataFiles(); }
  }, [project?.id, filterCollectionId, filterEnv]);

  // Load test data filtered by collection + env.
  // When called from inside the modal, pass the modal's form values directly
  // so it filters by what the user selected — not the top filter bar.
  async function loadTestDataFiles(colId, envName) {
    if (!project) return;
    try {
      const p = new URLSearchParams();
      const resolvedCol = colId ?? filterCollectionId;
      const resolvedEnv = envName ?? filterEnv;
      if (resolvedCol) p.set('collection_id', resolvedCol);
      if (resolvedEnv) p.set('env', resolvedEnv);
      const params = p.toString() ? `?${p.toString()}` : '';
      const { data } = await api.get(`/projects/${project.id}/test-data${params}`);
      setTestDataFiles(data.files || []);
    } catch (e) {
      console.error('Failed to load test data files:', e.response?.data || e.message);
      setTestDataFiles([]);
    }
  }

  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    if (openModalTrigger > 0) {
      const initCol = collection?.id ? String(collection.id) : '';
      const initEnv = env || '';
      setForm({ ...DEFAULT_FORM, collection_id: initCol, env: initEnv });
      setError('');
      setModal('add');
      loadTestDataFiles(initCol, initEnv);
    }
  }, [openModalTrigger]);

  async function loadSuites() {
    const params = new URLSearchParams();
    if (filterCollectionId) params.set('collection_id', filterCollectionId);
    if (filterEnv)          params.set('env', filterEnv);
    const qs = params.toString() ? `?${params.toString()}` : '';
    const { data } = await api.get(`/projects/${project.id}/test-suites${qs}`);
    setSuites(data.suites || []);
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
      if (onAfterSave) onAfterSave();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to save test plan — verify the name, collection, and environment fields are correct.');
    } finally { setSaving(false); }
  }

  async function del(id) {
    const suite = suites.find(s => s.id === id);
    const ok = await confirm(
      `Delete "${suite?.name || 'this test suite'}\"? Any generated scripts will also be removed. This cannot be undone.`,
      'Delete Test Plan'
    );
    if (!ok) return;
    await api.delete(`/projects/${project.id}/test-suites/${id}`);
    loadSuites();
    if (onAfterSave) onAfterSave();
  }

  async function generate(suite) {
    const wasGenerated = suite.jmx_path || suite.js_path;
    setGenerating(suite.id); setGenError(prev => ({ ...prev, [suite.id]: '' }));
    try {
      await api.post(`/projects/${project.id}/test-suites/${suite.id}/generate`, {});
      await loadSuites();
      // Tell Runner.jsx (kept permanently mounted elsewhere in the workspace) that its
      // own test-suites list is now stale — otherwise a freshly generated script only
      // shows up in the "Run Test" dropdown after a hard browser refresh.
      if (onAfterSave) onAfterSave();
      const ext = suite.engine === 'jmeter' ? '.jmx' : '.js';
      toast(`Script ${wasGenerated ? 're-generated' : 'generated'} successfully — ${suite.name}${ext} is ready to download`, 'success');
    } catch (e) {
      const msg = e.response?.data?.error || 'Generation failed';
      setGenError(prev => ({ ...prev, [suite.id]: msg }));
      toast(msg, 'error');
    } finally { setGenerating(null); }
  }

  async function download(suite, type) {
    try {
      const token = localStorage.getItem('ps_token');
      const res = await fetch(`/api/projects/${project.id}/test-suites/${suite.id}/download/${type}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        let msg = `Download failed (${res.status})`;
        try { const j = await res.json(); msg = j.error || msg; } catch {}
        throw new Error(msg);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = dlRef.current;
      a.href = url;
      a.download = `${suite.name}.${type}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast(e.message || 'Download failed', 'error');
    }
  }

  function openEdit(s) {
    let dataIds = [];
    try { dataIds = JSON.parse(s.test_data_ids || '[]'); } catch {}
    if (!dataIds.length && s.test_data_id) dataIds = [s.test_data_id];
    setForm({ name: s.name, test_type: s.test_type, collection_id: s.collection_id || '', env: s.env || '', test_data_ids: dataIds, engine: s.engine, config: JSON.parse(s.config_json || '{}'), vusers: s.vusers || 50, rampup: s.rampup || 30, iter_mode: s.iter_mode || 'duration', loops: s.loops || 1, duration: s.duration || 300 });
    setError(''); setModal(s);
    loadTestDataFiles();
  }

  const typeInfo = t => TEST_TYPES.find(x => x.value === t) || TEST_TYPES[0];

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

      {/* Filter bar: API Source → Environment */}
      <div style={{ display:'flex', alignItems:'flex-end', gap:16, padding:'12px 16px', background:'var(--color-background-secondary)', border:'1px solid var(--color-border-secondary)', borderRadius:10, marginBottom:16 }}>
        <i className="ti ti-filter" style={{ color:'var(--accent)', fontSize:15, flexShrink:0, marginBottom:4 }} />
        <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
          <label style={{ fontSize:11, fontWeight:600, color:'var(--color-text-tertiary)', textTransform:'uppercase', letterSpacing:0.6 }}>API Source</label>
          <select value={filterCollectionId} onChange={e => { setFilterCollectionId(e.target.value); setFilterEnv(''); }}
            style={{ padding:'6px 10px', borderRadius:7, border:'1px solid var(--color-border-secondary)', background:'var(--input-bg)', color:'var(--color-text-primary)', fontSize:13, fontFamily:'inherit', width:'auto', maxWidth:320 }}>
            <option value="">— All API Sources —</option>
            {ownCollections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
          <label style={{ fontSize:11, fontWeight:600, color:'var(--color-text-tertiary)', textTransform:'uppercase', letterSpacing:0.6 }}>Environment</label>
          <select value={filterEnv} onChange={e => setFilterEnv(e.target.value)} disabled={!filterCollectionId}
            style={{ padding:'6px 10px', borderRadius:7, border:'1px solid var(--color-border-secondary)', background:'var(--input-bg)', color:'var(--color-text-primary)', fontSize:13, fontFamily:'inherit', width:'auto', minWidth:140, opacity: filterCollectionId ? 1 : 0.5, cursor: filterCollectionId ? 'pointer' : 'not-allowed' }}>
            <option value="">— All Environments —</option>
            {filterEnvOptions.map(e => <option key={e} value={e}>{e}</option>)}
          </select>
        </div>
        {(filterCollectionId || filterEnv) && (
          <button onClick={() => { setFilterCollectionId(''); setFilterEnv(''); }}
            style={{ background:'none', border:'none', cursor:'pointer', color:'#64748b', fontSize:12, display:'flex', alignItems:'center', gap:4, fontFamily:'inherit', marginBottom:4 }}>
            <i className="ti ti-x" style={{ fontSize:12 }} /> Clear
          </button>
        )}
        <span style={{ marginLeft:'auto', fontSize:12, color:'var(--color-text-tertiary)', marginBottom:4 }}>
          {suites.length} plan{suites.length !== 1 ? 's' : ''}
        </span>
      </div>

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
        // Use ownCollections so pre_run_collection_hash is available
        const linkedCollection = ownCollections.find(c => String(c.id) === String(s.collection_id));
        const collectionPreRunFresh = linkedCollection
          ? (!!linkedCollection.pre_run_collection_hash && simpleHash(linkedCollection.json_content || '') === linkedCollection.pre_run_collection_hash)
          : !s.collection_id; // no collection assigned → don't block generate

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
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 600, fontSize: '15px' }}>{s.name}</span>
                      {linkedCollection && (
                        <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 12, background: '#dcfce7', color: '#16a34a' }}>{linkedCollection.name}</span>
                      )}
                    </div>
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

              {/* Generate action bar */}
              <div style={{ marginTop: '14px', paddingTop: '12px', borderTop: '1px solid var(--color-border-tertiary)' }}>
                {isGenerating ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: 'var(--color-text-secondary)', padding: '6px 0' }}>
                    <span className="spinner" /> Generating script...
                  </div>
                ) : !collectionPreRunFresh ? (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '10px 14px', background: 'rgba(240,167,50,0.08)', border: '1px solid rgba(240,167,50,0.25)', borderRadius: '8px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: 'var(--warn)' }}>
                      <i className="ti ti-alert-triangle" style={{ fontSize: '15px' }} />
                      {linkedCollection
                        ? <span><strong>Pre-run required</strong> — Run a pre-run on the <strong>{linkedCollection.name}</strong> API Source before generating the script.</span>
                        : <span><strong>No API Source assigned</strong> — Assign a collection to this test plan to enable script generation.</span>
                      }
                    </div>
                    {linkedCollection && (
                      <button className="btn-secondary btn-sm" style={{ flexShrink: 0 }} onClick={() => onNav('collections')}>
                        <i className="ti ti-braces" /> Go to API Sources
                      </button>
                    )}
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <button className="btn-primary btn-sm" onClick={() => generate(s)}>
                      <i className="ti ti-sparkles" />{hasScript ? 'Re-generate Script' : 'Generate Script'}
                    </button>
                    {hasScript && s.engine === 'jmeter' && s.jmx_path && (
                      <button className="btn-secondary btn-sm" onClick={() => download(s, 'jmx')}><i className="ti ti-download" />.jmx</button>
                    )}
                    {hasScript && s.engine === 'k6' && s.js_path && (
                      <button className="btn-secondary btn-sm" onClick={() => download(s, 'js')}><i className="ti ti-download" />.js</button>
                    )}
                  </div>
                )}
              </div>

              {genError[s.id] && <div className="auth-error" style={{ marginTop: '10px' }}>{genError[s.id]}</div>}
            </div>
          </div>
        );
      }) : (
        <div className="empty">
          <i className="ti ti-test-pipe" />
          <div className="empty-title">No test plans yet</div>
          <div className="empty-sub">Create a test plan to generate JMeter or K6 scripts</div>
          <button className="btn-primary" style={{ marginTop: '16px' }} onClick={() => { const c = collection?.id ? String(collection.id) : ''; const e = env || ''; setForm({ ...DEFAULT_FORM, collection_id: c, env: e }); setError(''); loadTestDataFiles(c, e); setModal('add'); }}>New Test Plan</button>
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
              <CustomSelect
                value={form.engine}
                onChange={e => setForm(f => ({ ...f, engine: e.target.value }))}
              >
                <option value="jmeter">Apache JMeter (.jmx)</option>
                <option value="k6">Grafana K6 (.js)</option>
              </CustomSelect>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div className="form-group">
              <label className="form-label">Collection</label>
              <CustomSelect value={form.collection_id} onChange={e => {
                const newCol = e.target.value;
                setForm(f => ({ ...f, collection_id: newCol, env: '', test_data_ids: [] }));
                setTestDataSearch('');
                loadTestDataFiles(newCol, '');
              }}>
                <option value="">— None —</option>
                {ownCollections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </CustomSelect>
            </div>
            <div className="form-group">
              <label className="form-label">Environment</label>
              {(() => {
                const col = ownCollections.find(c => String(c.id) === String(form.collection_id));
                let envOptions = [];
                try { envOptions = JSON.parse(col?.environments || '[]'); } catch {}
                if (!envOptions.length && col?.environment) envOptions = [col.environment];
                return (
                  <CustomSelect value={form.env || ''} onChange={e => {
                    const newEnv = e.target.value;
                    setForm(f => ({ ...f, env: newEnv, test_data_ids: [] }));
                    setTestDataSearch('');
                    loadTestDataFiles(form.collection_id, newEnv);
                  }}>
                    <option value="">— Select environment —</option>
                    {envOptions.map(e => <option key={e} value={e}>{e}</option>)}
                  </CustomSelect>
                );
              })()}
            </div>
            <div className="form-group">
              <label className="form-label" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span>Test Data (CSV) <span style={{ fontWeight: 400, color: 'var(--color-text-tertiary)' }}>— select multiple</span></span>
                <button type="button" onClick={() => loadTestDataFiles(form.collection_id, form.env)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent)', fontSize: 11, display: 'flex', alignItems: 'center', gap: 3, padding: '0 2px' }}
                  title="Refresh file list">
                  <i className="ti ti-refresh" style={{ fontSize: 12 }} /> Refresh
                </button>
              </label>
              {/* Search input — only shown when there are files to search */}
              {form.env && testDataFiles.length > 0 && (
                <div style={{ position: 'relative', marginBottom: '4px' }}>
                  <i className="ti ti-search" style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', fontSize: 13, color: 'var(--color-text-tertiary)', pointerEvents: 'none' }} />
                  <input
                    type="text"
                    value={testDataSearch}
                    onChange={e => setTestDataSearch(e.target.value)}
                    placeholder="Search files…"
                    style={{ width: '100%', paddingLeft: 28, paddingRight: testDataSearch ? 28 : 8, paddingTop: 6, paddingBottom: 6, fontSize: 12, borderRadius: 6, border: '1px solid var(--color-border, #3a3c42)', background: 'var(--color-background)', color: 'var(--color-text-primary)', fontFamily: 'inherit', boxSizing: 'border-box' }}
                  />
                  {testDataSearch && (
                    <button type="button" onClick={() => setTestDataSearch('')}
                      style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-tertiary)', padding: 2, lineHeight: 1 }}>
                      <i className="ti ti-x" style={{ fontSize: 11 }} />
                    </button>
                  )}
                </div>
              )}
              <div style={{ border: '1px solid var(--color-border, #3a3c42)', borderRadius: '6px', maxHeight: '130px', overflowY: 'auto', padding: '4px 2px', background: 'var(--color-background)' }}>
                {!form.env ? (
                  <div style={{ padding: '6px 10px', fontSize: '12px', color: 'var(--color-text-tertiary)' }}>Select an environment first to see available test data files</div>
                ) : testDataFiles.length === 0 ? (
                  <div style={{ padding: '6px 10px', fontSize: '12px', color: 'var(--color-text-tertiary)' }}>No CSV files uploaded for {form.env}</div>
                ) : (() => {
                  const q = testDataSearch.trim().toLowerCase();
                  const filtered = q ? testDataFiles.filter(f => f.original_name.toLowerCase().includes(q)) : testDataFiles;
                  if (!filtered.length) return (
                    <div style={{ padding: '6px 10px', fontSize: '12px', color: 'var(--color-text-tertiary)' }}>No files match "{testDataSearch}"</div>
                  );
                  return filtered.map(f => {
                    const checked = form.test_data_ids.includes(f.id) || form.test_data_ids.includes(String(f.id));
                    // Highlight matching portion of the filename
                    const name = f.original_name;
                    const idx = q ? name.toLowerCase().indexOf(q) : -1;
                    const nameNode = idx >= 0
                      ? <span>{name.slice(0, idx)}<mark style={{ background: 'rgba(74,158,255,0.25)', color: 'inherit', borderRadius: 2, padding: '0 1px' }}>{name.slice(idx, idx + q.length)}</mark>{name.slice(idx + q.length)}</span>
                      : name;
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
                        <i className="ti ti-table" style={{ fontSize: '12px', color: checked ? 'var(--accent)' : 'var(--color-text-tertiary)', flexShrink: 0 }} />
                        {nameNode}
                        {checked && <i className="ti ti-check" style={{ fontSize: '11px', color: 'var(--accent)', marginLeft: 'auto' }} />}
                      </label>
                    );
                  });
                })()}
              </div>
              {/* Selected count summary */}
              {form.test_data_ids.length > 0 && (
                <div style={{ marginTop: 4, fontSize: 11, color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <i className="ti ti-check" style={{ fontSize: 11 }} /> {form.test_data_ids.length} file{form.test_data_ids.length !== 1 ? 's' : ''} selected
                </div>
              )}
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
