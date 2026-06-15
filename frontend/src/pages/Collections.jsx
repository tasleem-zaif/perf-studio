import { useState, useEffect, useRef } from 'react';
import { collectionDirName, collectionPathLabel } from '../utils/displayName';
import Modal from '../components/Modal';
import ConfirmModal from '../components/ConfirmModal';
import { useConfirm } from '../hooks/useConfirm';
import { useToast } from '../hooks/useToast';
import CustomSelect from '../components/CustomSelect';
import api from '../api';

const SOURCE_TYPES = [
  { value: 'postman', label: 'Postman Collection', icon: 'ti-brand-chrome', desc: 'Import from Postman v2.1 JSON export', accept: '.json' },
  { value: 'swagger', label: 'Swagger / OpenAPI', icon: 'ti-code', desc: 'Import OpenAPI 3 or Swagger 2 (JSON or YAML)', accept: '.json,.yaml,.yml' },
  { value: 'curl',    label: 'cURL Command', icon: 'ti-terminal', desc: 'Paste a cURL command to generate a request' },
  { value: 'json',    label: 'Raw JSON / Endpoints', icon: 'ti-braces', desc: 'Manually enter endpoint JSON array' },
];

const DEFAULT_FORM = { name: '', description: '', environments: [], source_type: 'postman', tool_target: 'jmeter', source_content: '', json_content: '[]' };

const ENV_OPTIONS = ['Development', 'QA', 'UAT', 'Staging', 'Production'];

function envTagClass(env) {
  const e = (env || '').toLowerCase();
  if (e.includes('prod')) return 'tag-red';
  if (e.includes('stag') || e.includes('uat')) return 'tag-amber';
  if (e.includes('qa') || e.includes('test')) return 'tag-blue';
  if (e.includes('dev')) return 'tag-gray';
  return 'tag-gray';
}

// Must match simpleHash in ai.js exactly
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString();
}

export default function Collections({ project, collection: activeCollection, onNav, onProjectUpdated, openModalTrigger }) {
  const [modal, setModal] = useState(null);
  const [viewModal, setViewModal] = useState(null);
  const [endpointsExpanded, setEndpointsExpanded] = useState(true);
  // Fetch collections directly — don't rely solely on project.collections prop
  const [ownCollections, setOwnCollections] = useState(project?.collections || []);
  const [form, setForm] = useState(DEFAULT_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [parsedCurl, setParsedCurl] = useState(null);
  const [parsing, setParsing] = useState(false);
  const [selectedFile, setSelectedFile] = useState(null);
  // Pre-run state
  const [preRunning, setPreRunning] = useState(null);
  const [preRunData, setPreRunData] = useState({});
  const [logModalCollection, setLogModalCollection] = useState(null);
  const [logModalPos, setLogModalPos] = useState({ x: 0, y: 0 });
  const [expandedLog, setExpandedLog] = useState({});
  const fileRef = useRef(null);
  const firstRender = useRef(true);
  const { confirm, confirmState, handleConfirm, handleCancel } = useConfirm();
  const { toast } = useToast();

  useEffect(() => {
    if (!project?.id) return;
    api.get(`/projects/${project.id}/collections`)
      .then(({ data }) => {
        const cols = data.collections || [];
        setOwnCollections(cols);
        // Restore persisted pre-run data so logs survive page refresh
        const restored = {};
        for (const c of cols) {
          if (c.pre_run_data) {
            try { restored[c.id] = JSON.parse(c.pre_run_data); } catch {}
          }
        }
        setPreRunData(prev => ({ ...prev, ...restored }));
      })
      .catch(() => {});
  }, [project?.id]);

  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    if (openModalTrigger > 0) { setForm(DEFAULT_FORM); setError(''); setParsedCurl(null); setSelectedFile(null); setModal('add'); }
  }, [openModalTrigger]);

  // Center log modal when it opens
  useEffect(() => {
    if (logModalCollection) {
      setLogModalPos({
        x: Math.max(0, (window.innerWidth - 860) / 2),
        y: Math.max(0, (window.innerHeight - 620) / 2),
      });
    }
  }, [logModalCollection?.id]);

  if (!project) return <div className="page"><div className="empty"><i className="ti ti-folder-off" /><div className="empty-title">Select a project first</div></div></div>;

  function openEdit(c) {
    let envs = [];
    try { envs = JSON.parse(c.environments || '[]'); if (!Array.isArray(envs)) envs = []; } catch { envs = []; }
    setForm({ name: c.name, description: c.description, environments: envs, source_type: c.source_type || 'json', tool_target: c.tool_target || 'jmeter', source_content: c.source_content || '', json_content: c.json_content || '[]' });
    setParsedCurl(null); setSelectedFile(null); setError(''); setModal(c);
  }

  async function doParseCurl() {
    if (!form.source_content.trim()) return setError('Paste a cURL command first');
    setParsing(true); setError('');
    try {
      const { data } = await api.post(`/projects/${project.id}/collections/parse-curl`, { curl: form.source_content });
      setParsedCurl(data.parsed);
    } catch (e) {
      setError(e.response?.data?.error || 'Parse failed');
    } finally { setParsing(false); }
  }

  async function save() {
    if (!form.name.trim()) return setError('Name required');
    setSaving(true); setError('');
    try {
      const fd = new FormData();
      fd.append('name', form.name);
      fd.append('description', form.description);
      fd.append('environments', JSON.stringify(form.environments));
      fd.append('source_type', form.source_type);
      fd.append('tool_target', form.tool_target);

      if (selectedFile && (form.source_type === 'postman' || form.source_type === 'swagger')) {
        fd.append('file', selectedFile);
      } else if (form.source_type === 'curl') {
        fd.append('source_content', form.source_content);
      } else {
        fd.append('json_content', form.json_content);
      }

      if (modal === 'add') {
        await api.post(`/projects/${project.id}/collections`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      } else {
        await api.put(`/projects/${project.id}/collections/${modal.id}`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      }
      await onProjectUpdated();
      // Refresh local list and restore pre-run data
      api.get(`/projects/${project.id}/collections`).then(({ data }) => {
        const cols = data.collections || [];
        setOwnCollections(cols);
        const restored = {};
        for (const c of cols) {
          if (c.pre_run_data) {
            try { restored[c.id] = JSON.parse(c.pre_run_data); } catch {}
          }
        }
        setPreRunData(prev => ({ ...prev, ...restored }));
      }).catch(() => {});
      setModal(null); setSelectedFile(null); setParsedCurl(null);
    } catch (e) {
      setError(e.response?.data?.error || 'Save failed');
    } finally { setSaving(false); }
  }

  async function del(id) {
    const col = ownCollections?.find(c => c.id === id) || p?.collections?.find(c => c.id === id);
    let envList = [];
    try { envList = JSON.parse(col?.environments || '[]'); } catch {}
    if (!envList.length && col?.environment) envList = [col.environment];

    const ok = await confirm(
      <div>
        <div style={{ marginBottom: 12 }}>
          Are you sure you want to delete <strong>"{col?.name}"</strong>?
        </div>
        <div style={{ background: 'rgba(247,84,100,0.07)', border: '1px solid rgba(247,84,100,0.2)', borderRadius: 8, padding: '10px 14px', marginBottom: 10 }}>
          <div style={{ fontWeight: 600, color: '#dc2626', marginBottom: 6, fontSize: 13 }}>
            <i className="ti ti-alert-triangle" style={{ marginRight: 6 }} />The following will be permanently deleted:
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: '#475569', lineHeight: 1.8 }}>
            <li>All API endpoints in this collection</li>
            <li>Folder structure from your local git workspace</li>
            <li>Test data files (CSV/XLSX) in all environment folders</li>
            <li>Generated test scripts (.jmx / .js)</li>
            <li>Environment config files (config.json)</li>
          </ul>
        </div>
        {envList.length > 0 && (
          <div style={{ fontSize: 12, color: '#64748b' }}>
            <strong>Affected environments:</strong> {envList.join(', ')}
          </div>
        )}
        <div style={{ marginTop: 10, fontSize: 12, fontWeight: 600, color: '#dc2626' }}>
          This action cannot be undone.
        </div>
      </div>,
      'Delete Collection'
    );
    if (!ok) return;
    await api.delete(`/projects/${project.id}/collections/${id}`);
    api.get(`/projects/${project.id}/collections`).then(({ data }) => setOwnCollections(data.collections || [])).catch(() => {});
    onProjectUpdated();
  }

  async function preRun(c) {
    setPreRunning(c.id);
    try {
      const { data } = await api.post('/ai/pre-run', { collection_id: c.id, project_id: project.id });
      setPreRunData(prev => ({ ...prev, [c.id]: data.responses }));
      const failed = data.responses.filter(r => r.error || !r.success).length;
      if (failed > 0) toast(`Pre-run complete — ${failed} endpoint(s) failed. Check logs.`, 'warn');
      else toast(`Pre-run complete — all ${data.responses.length} endpoint(s) succeeded`, 'success');
      // Reload collections so pre_run_collection_hash reflects latest state
      api.get(`/projects/${project.id}/collections`).then(({ data: d }) => {
        setOwnCollections(d.collections || []);
      }).catch(() => {});
    } catch (e) {
      toast(e.response?.data?.error || 'Pre-run failed', 'error');
    } finally { setPreRunning(null); }
  }

  function isPreRunFresh(c) {
    if (!c.pre_run_collection_hash) return false;
    return simpleHash(c.json_content || '') === c.pre_run_collection_hash;
  }

  function onLogDragStart(e) {
    e.preventDefault();
    const startMouseX = e.clientX;
    const startMouseY = e.clientY;
    const startX = logModalPos.x;
    const startY = logModalPos.y;
    function onMove(e) {
      setLogModalPos({ x: startX + e.clientX - startMouseX, y: startY + e.clientY - startMouseY });
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function toggleEndpoint(key) {
    setExpandedLog(prev => ({ ...prev, [key]: !prev[key] }));
  }

  function getEndpoints(c) {
    try { const arr = JSON.parse(c.json_content); return Array.isArray(arr) ? arr : []; } catch { return []; }
  }

  const sourceInfo = v => SOURCE_TYPES.find(s => s.value === v);
  const p = { ...project, collections: ownCollections };

  const METHOD_COLOR = { GET: 'var(--accent)', POST: '#00c896', PUT: '#f0a732', PATCH: '#8b5cf6', DELETE: '#f75464' };

  return (
    <div className="page fade-in">
      {/* All API Sources — always shown in card format */}
      {p.collections?.length > 0 && (
        <div className="section-hdr">
          <div className="section-title">
            <i className="ti ti-braces" style={{ marginRight: '8px', color: 'var(--accent)' }} />
            API Sources <span className="badge tag-gray">{p.collections.length}</span>
          </div>
        </div>
      )}

      {p.collections?.length ? p.collections.map(c => {
        const endpoints = getEndpoints(c);
        const si = sourceInfo(c.source_type);
        const isSelected = activeCollection?.id === c.id;
        const responses = preRunData[c.id] || null;
        const preRunFresh = isPreRunFresh(c);
        const successCount = responses ? responses.filter(r => r.success).length : 0;
        const failCount = responses ? responses.filter(r => r.error || r.skipped || !r.success).length : 0;

        return (
          <div className="card" key={c.id} style={{ marginBottom: '12px', border: isSelected ? '2px solid var(--accent)' : undefined }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
                <div style={{ width: '40px', height: '40px', borderRadius: '8px', background: '#e8f0ff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <i className={`ti ${si?.icon || 'ti-braces'}`} style={{ color: 'var(--accent)' }} />
                </div>
                <div>
                  <div style={{ fontWeight: 600, fontSize: '15px' }}>{collectionDirName(c)}</div>
                  <div style={{ color: 'var(--color-text-secondary)', fontSize: '12px', margin: '2px 0' }}>{c.description}</div>
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '6px' }}>
                    <span className="tag tag-blue">{si?.label || c.source_type}</span>
                    <span className="tag tag-gray"><i className="ti ti-list" style={{ fontSize: '11px' }} /> {endpoints.length} endpoint{endpoints.length !== 1 ? 's' : ''}</span>
                    {(() => { let envs = []; try { envs = JSON.parse(c.environments || '[]'); if (!Array.isArray(envs)) envs = []; } catch {} return envs.map(env => <span key={env} className={`tag ${envTagClass(env)}`}><i className="ti ti-server" style={{ fontSize: '11px' }} /> {env}</span>); })()}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: '6px' }}>
                <button className="btn-secondary btn-sm" onClick={() => setViewModal(c)}><i className="ti ti-eye" /> View</button>
                <button className="btn-secondary btn-sm" onClick={() => openEdit(c)}><i className="ti ti-edit" /> Edit</button>
                <button className="btn-secondary btn-sm" style={{ color: 'var(--danger)', borderColor: 'rgba(247,84,100,0.3)' }} onClick={() => del(c.id)}><i className="ti ti-trash" /> Delete</button>
              </div>
            </div>

            {/* Pre-run action bar */}
            <div style={{ marginTop: '14px', paddingTop: '12px', borderTop: '1px solid var(--color-border-tertiary)' }}>
              {preRunning === c.id ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: 'var(--color-text-secondary)', padding: '6px 0' }}>
                  <span className="spinner" /> Running pre-run against collection endpoints...
                </div>
              ) : !preRunFresh ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '10px 14px', background: 'rgba(240,167,50,0.08)', border: '1px solid rgba(240,167,50,0.25)', borderRadius: '8px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: 'var(--warn)' }}>
                    <i className="ti ti-alert-triangle" style={{ fontSize: '15px' }} />
                    {responses && !preRunFresh
                      ? <span><strong>Collection changed</strong> — Re-run pre-run to reflect the latest endpoints.</span>
                      : <span><strong>Pre-run required</strong> — Fire all endpoints to capture live responses for script generation.</span>
                    }
                  </div>
                  <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                    {responses && (
                      <button className="btn-secondary btn-sm" onClick={() => setLogModalCollection(c)}>
                        <i className="ti ti-list-details" /> Show Logs
                      </button>
                    )}
                    <button className="btn-primary btn-sm" onClick={() => preRun(c)}>
                      <i className="ti ti-player-play" />{responses ? 'Re-run Pre-run' : 'Run Pre-run'}
                    </button>
                  </div>
                </div>
              ) : (
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
                    <button className="btn-secondary btn-sm" onClick={() => setLogModalCollection(c)}>
                      <i className="ti ti-list-details" /> Show Logs
                    </button>
                  </div>
                  <button className="btn-secondary btn-sm" onClick={() => preRun(c)}>
                    <i className="ti ti-refresh" /> Re-run Pre-run
                  </button>
                </div>
              )}
            </div>
          </div>
        );
      }) : (
        <div className="empty">
          <i className="ti ti-braces" />
          <div className="empty-title">No collections yet</div>
          <div className="empty-sub">Import from Postman, Swagger, or paste a cURL command</div>
          <button className="btn-primary" style={{ marginTop: '16px' }} onClick={() => { setForm(DEFAULT_FORM); setError(''); setModal('add'); }}>Add API Source</button>
        </div>
      )}

      {/* Add/Edit Modal */}
      {modal && (
        <Modal onClose={() => { setModal(null); setSelectedFile(null); setParsedCurl(null); }}>
          <div className="modal-hdr">
            <div className="modal-title">{modal === 'add' ? 'Add' : 'Edit'} API Source</div>
            <button className="btn-icon" onClick={() => { setModal(null); setSelectedFile(null); setParsedCurl(null); }}><i className="ti ti-x" /></button>
          </div>
          {error && <div className="auth-error">{error}</div>}

          <div className="form-group">
            <label className="form-label">API Source Name</label>
            <input type="text" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Auth API" autoFocus autoComplete="new-password" name="collection-name-x7k" />
          </div>

          {/* Hidden dummy inputs — stops Chrome from injecting saved emails into Description */}
          <input type="text"     style={{ display: 'none' }} aria-hidden="true" readOnly />
          <input type="password" style={{ display: 'none' }} aria-hidden="true" readOnly />

          <div className="form-group">
            <label className="form-label">Description</label>
            <input
              type="text"
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              placeholder="What APIs does this collection cover?"
              autoComplete="off"
              data-form-type="other"
            />
          </div>

          <div className="form-group">
            <label className="form-label">Environments <span style={{ fontWeight: 400, color: 'var(--color-text-tertiary)', fontSize: '11px' }}>— select one or more</span></label>
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '4px' }}>
              {ENV_OPTIONS.map(env => {
                const checked = form.environments.includes(env);
                return (
                  <label key={env} style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', padding: '6px 12px', borderRadius: '8px', border: `2px solid ${checked ? 'var(--color-success, #00c896)' : 'var(--color-border-secondary)'}`, background: checked ? 'rgba(0,200,150,0.10)' : 'transparent', userSelect: 'none', fontSize: '13px', fontWeight: checked ? 600 : 400, color: checked ? 'var(--color-success, #00c896)' : 'var(--color-text-secondary)', transition: 'all 0.15s' }}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => setForm(f => ({ ...f, environments: checked ? f.environments.filter(e => e !== env) : [...f.environments, env] }))}
                      style={{ display: 'none' }}
                    />
                    {checked && <i className="ti ti-check" style={{ fontSize: '12px' }} />}
                    {env}
                  </label>
                );
              })}
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Source Type</label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
              {SOURCE_TYPES.map(st => (
                <div key={st.value}
                  onClick={() => { setForm(f => ({ ...f, source_type: st.value, source_content: '' })); setSelectedFile(null); setParsedCurl(null); setError(''); }}
                  style={{ padding: '10px 12px', borderRadius: '8px', border: `2px solid ${form.source_type === st.value ? 'var(--accent)' : 'var(--color-border-secondary)'}`, cursor: 'pointer', background: form.source_type === st.value ? 'rgba(74,158,255,0.12)' : 'transparent' }}>
                  <div style={{ fontWeight: 600, fontSize: '13px', color: form.source_type === st.value ? 'var(--accent)' : 'var(--color-text-primary)' }}><i className={`ti ${st.icon}`} style={{ marginRight: '6px' }} />{st.label}</div>
                  <div style={{ fontSize: '11px', color: form.source_type === st.value ? 'var(--color-text-secondary)' : 'var(--color-text-tertiary)', marginTop: '2px' }}>{st.desc}</div>
                </div>
              ))}
            </div>
          </div>

          {(form.source_type === 'postman' || form.source_type === 'swagger') && (
            <div className="form-group">
              <label className="form-label">Upload File</label>
              <input ref={fileRef} type="file" accept={sourceInfo(form.source_type)?.accept} style={{ display: 'none' }}
                onChange={e => { setSelectedFile(e.target.files?.[0] || null); setError(''); }} />
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                <button className="btn-secondary" type="button" onClick={() => fileRef.current?.click()}>
                  <i className="ti ti-upload" /> Choose File
                </button>
                {selectedFile
                  ? <span style={{ fontSize: '13px', color: 'var(--color-text-secondary)' }}>{selectedFile.name}</span>
                  : modal !== 'add' && form.source_content
                    ? <span style={{ fontSize: '12px', color: 'var(--color-text-tertiary)' }}>File already imported — upload new to replace</span>
                    : null}
              </div>
            </div>
          )}

          {form.source_type === 'curl' && (
            <div className="form-group">
              <label className="form-label">cURL Command</label>
              <textarea
                value={form.source_content}
                onChange={e => { setForm(f => ({ ...f, source_content: e.target.value })); setParsedCurl(null); }}
                placeholder={'curl -X POST https://api.example.com/login \\\n  -H \'Content-Type: application/json\' \\\n  -d \'{"username":"test","password":"test"}\''}
                style={{ height: '100px', fontFamily: 'monospace', fontSize: '12px' }}
              />
              <div style={{ marginTop: '8px', display: 'flex', gap: '8px', alignItems: 'center' }}>
                <button type="button" className="btn-secondary btn-sm" onClick={doParseCurl} disabled={parsing}>
                  {parsing ? <><span className="spinner" />Parsing...</> : <><i className="ti ti-terminal" />Parse cURL</>}
                </button>
                {parsedCurl && <span style={{ fontSize: '12px', color: '#00c896' }}><i className="ti ti-check" /> {parsedCurl.method} {parsedCurl.url?.slice(0, 50)}</span>}
              </div>
            </div>
          )}

          {form.source_type === 'json' && (
            <div className="form-group">
              <label className="form-label">Endpoints JSON Array</label>
              <textarea
                value={form.json_content}
                onChange={e => setForm(f => ({ ...f, json_content: e.target.value }))}
                placeholder='[{"name":"Login","method":"POST","url":"https://api.example.com/login","headers":{},"body":""}]'
                style={{ height: '120px', fontFamily: 'monospace', fontSize: '12px' }}
              />
            </div>
          )}

          <div className="modal-footer">
            <button className="btn-secondary" onClick={() => { setModal(null); setSelectedFile(null); setParsedCurl(null); }}>Cancel</button>
            <button className="btn-primary" onClick={save} disabled={saving}>{saving && <span className="spinner" />}Save</button>
          </div>
        </Modal>
      )}

      <ConfirmModal {...confirmState} onConfirm={handleConfirm} onCancel={handleCancel} />

      {/* View Modal */}
      {viewModal && (
        <Modal onClose={() => setViewModal(null)}>
          <div className="modal-hdr">
            <div className="modal-title">{viewModal.name}</div>
            <button className="btn-icon" onClick={() => setViewModal(null)}><i className="ti ti-x" /></button>
          </div>
          <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)', marginBottom: '12px' }}>
            {getEndpoints(viewModal).length} endpoints · {sourceInfo(viewModal.source_type)?.label}
          </div>
          {getEndpoints(viewModal).map((ep, i) => (
            <div key={i} style={{ padding: '10px 12px', marginBottom: '8px', background: 'var(--color-background-secondary)', borderRadius: '8px', fontSize: '13px' }}>
              <div style={{ fontWeight: 600, marginBottom: '4px' }}>{ep.name || `Endpoint ${i + 1}`}</div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <span className="tag tag-blue">{ep.method}</span>
                <code style={{ fontSize: '12px', color: 'var(--color-text-secondary)', wordBreak: 'break-all' }}>{ep.url}</code>
              </div>
              {ep.body && <pre style={{ marginTop: '8px', fontSize: '11px', color: 'var(--color-text-secondary)', maxHeight: '80px', overflow: 'auto' }}>{ep.body}</pre>}
            </div>
          ))}
          <div className="modal-footer"><button className="btn-primary" onClick={() => setViewModal(null)}>Close</button></div>
        </Modal>
      )}

      {/* Pre-run Logs Modal */}
      {logModalCollection && (() => {
        const modalResponses = preRunData[logModalCollection.id] || [];
        return (
          <div style={{ position: 'fixed', inset: 0, zIndex: 1000, pointerEvents: 'none' }}>
            <div style={{
              position: 'absolute', left: logModalPos.x, top: logModalPos.y,
              width: '860px', minWidth: '400px', minHeight: '300px',
              background: 'var(--color-background-primary)', borderRadius: '12px',
              display: 'flex', flexDirection: 'column',
              boxShadow: '0 24px 64px rgba(0,0,0,0.35)',
              resize: 'both', overflow: 'hidden',
              pointerEvents: 'all',
            }}>
              {/* Header — drag handle */}
              <div
                onMouseDown={onLogDragStart}
                style={{ padding: '16px 20px', borderBottom: '1px solid var(--color-border-secondary)', display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0, cursor: 'move', userSelect: 'none' }}>
                <i className="ti ti-list-details" style={{ fontSize: '18px', color: 'var(--accent)' }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: '15px' }}>Pre-run Logs</div>
                  <div style={{ fontSize: '12px', color: 'var(--color-text-tertiary)', marginTop: '2px' }}>{logModalCollection.name} — {modalResponses.length} endpoint{modalResponses.length !== 1 ? 's' : ''}</div>
                </div>
                <button className="btn-icon" onClick={() => setLogModalCollection(null)}><i className="ti ti-x" /></button>
              </div>
              {/* Body */}
              <div style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
                {modalResponses.map((r, idx) => {
                  const key = `modal_${logModalCollection.id}_${idx}`;
                  const expanded = expandedLog[key];
                  const isErr = r.error || r.skipped;
                  const statusColor = !r.status ? 'var(--color-text-tertiary)' : r.status < 300 ? '#00c896' : r.status < 400 ? 'var(--accent)' : 'var(--danger)';
                  return (
                    <div key={idx} style={{ borderBottom: idx < modalResponses.length - 1 ? '1px solid var(--color-border-tertiary)' : 'none' }}>
                      <div onClick={() => toggleEndpoint(key)} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 20px', cursor: 'pointer', userSelect: 'none' }}
                        onMouseEnter={e => e.currentTarget.style.background = 'var(--color-background-hover)'}
                        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                        <i className={`ti ti-chevron-${expanded ? 'down' : 'right'}`} style={{ fontSize: '11px', color: 'var(--color-text-tertiary)', flexShrink: 0 }} />
                        {r.method && (
                          <span style={{ fontSize: '10px', fontWeight: 700, padding: '2px 6px', borderRadius: '4px', background: `${METHOD_COLOR[r.method] || '#888'}22`, color: METHOD_COLOR[r.method] || '#888', flexShrink: 0 }}>{r.method}</span>
                        )}
                        <span style={{ fontSize: '12px', flex: 1, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.url || r.endpoint}</span>
                        {r.tokenExtracted && <span style={{ fontSize: '10px', fontWeight: 700, padding: '2px 6px', borderRadius: '4px', background: 'rgba(0,200,150,0.15)', color: '#00c896', flexShrink: 0 }}>TOKEN EXTRACTED</span>}
                        {r.tokenInjected && <span style={{ fontSize: '10px', fontWeight: 700, padding: '2px 6px', borderRadius: '4px', background: 'rgba(78,158,255,0.15)', color: 'var(--accent)', flexShrink: 0 }}>AUTH INJECTED</span>}
                        {r.status ? (
                          <span style={{ fontSize: '11px', fontWeight: 700, color: statusColor, flexShrink: 0 }}>{r.status} {r.statusText}</span>
                        ) : isErr ? (
                          <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--danger)', flexShrink: 0 }}>{r.skipped ? 'SKIPPED' : 'ERROR'}</span>
                        ) : null}
                      </div>
                      {expanded && (
                        <div style={{ padding: '0 20px 12px 44px', fontSize: '12px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
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
                                    {open && <pre style={{ margin: 0, padding: '8px 10px', fontSize: '11px', overflowX: 'auto', maxHeight: '300px', color: 'var(--color-text-secondary)' }}>{bodyStr}</pre>}
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
            </div>
          </div>
        );
      })()}
    </div>
  );
}
