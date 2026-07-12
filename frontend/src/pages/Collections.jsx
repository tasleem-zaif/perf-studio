import { useState, useEffect, useRef } from 'react';
import { collectionDirName, collectionPathLabel } from '../utils/displayName';
import Modal from '../components/Modal';
import ConfirmModal from '../components/ConfirmModal';
import { useConfirm } from '../hooks/useConfirm';
import { useToast } from '../hooks/useToast';
import CustomSelect from '../components/CustomSelect';
import api from '../api';

// Module-scope (not defined inside Collections()) so its component identity is stable
// across renders — a component redefined inside a parent's render body gets a new
// identity every render, which makes React remount its subtree (losing input focus on
// every keystroke) instead of just re-rendering it.
function FieldLabel({ text, children }) {
  return (
    <label style={{ display: 'block' }}>
      <div style={{ fontSize: '10px', fontWeight: 600, color: 'var(--color-text-tertiary)', marginBottom: '3px' }}>{text}</div>
      {children}
    </label>
  );
}

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
  const [selectedEnvFile, setSelectedEnvFile] = useState(null);
  // Pre-run state
  const [preRunning, setPreRunning] = useState(null);
  const [preRunData, setPreRunData] = useState({});
  const [logModalCollection, setLogModalCollection] = useState(null);
  const [logModalPos, setLogModalPos] = useState({ x: 0, y: 0 });
  const [expandedLog, setExpandedLog] = useState({});
  // Correlation rules detected by the last pre-run (utils/correlationEngine.js) — a
  // human-review layer over the auto-detected/high-confidence rules script generation
  // will burn into the JMX/k6 output. Keyed by collection id, same as preRunData.
  const [correlationsByCollection, setCorrelationsByCollection] = useState({});
  const [correlationsOpen, setCorrelationsOpen] = useState(true);
  const fileRef = useRef(null);
  const envFileRef = useRef(null);
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
    if (openModalTrigger > 0) { setForm(DEFAULT_FORM); setError(''); setParsedCurl(null); setSelectedFile(null); setSelectedEnvFile(null); setModal('add'); }
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
    setParsedCurl(null); setSelectedFile(null); setSelectedEnvFile(null); setError(''); setModal(c);
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
        if (selectedEnvFile && form.source_type === 'postman') fd.append('environment_file', selectedEnvFile);
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
      setModal(null); setSelectedFile(null); setSelectedEnvFile(null); setParsedCurl(null);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to save API source — check the file format, collection name, and selected environments, then try again.');
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

  // "Show Logs" only ever restores modalResponses from the collection's persisted
  // pre_run_data (see the mount effects above) — correlationsByCollection was never
  // hydrated from anywhere except preRun()'s own response, so opening the modal without
  // re-running pre-run first always showed "Correlations 0" even though the rules were
  // safely persisted server-side all along. Fetch them fresh every time the modal opens.
  async function openLogModal(collection) {
    setLogModalCollection(collection);
    try {
      const { data } = await api.get(`/ai/correlations?collection_id=${collection.id}&project_id=${project.id}`);
      setCorrelationsByCollection(prev => ({ ...prev, [collection.id]: data.correlationRules || [] }));
    } catch (e) {
      toast(e.response?.data?.error || e.message || 'Failed to load correlation rules', 'error');
    }
  }

  async function preRun(c) {
    setPreRunning(c.id);
    try {
      const { data } = await api.post('/ai/pre-run', { collection_id: c.id, project_id: project.id });
      setPreRunData(prev => ({ ...prev, [c.id]: data.responses }));
      setCorrelationsByCollection(prev => ({ ...prev, [c.id]: data.correlationRules || [] }));
      const failed = data.responses.filter(r => r.error || !r.success).length;
      if (failed > 0) toast(`Pre-run complete — ${failed} endpoint(s) failed. Check logs.`, 'warn');
      else toast(`Pre-run complete — all ${data.responses.length} endpoint(s) succeeded`, 'success');
      // Reload collections so pre_run_collection_hash reflects latest state
      api.get(`/projects/${project.id}/collections`).then(({ data: d }) => {
        setOwnCollections(d.collections || []);
      }).catch(() => {});
    } catch (e) {
      toast(e.response?.data?.error || e.message || 'Pre-run failed', 'error');
    } finally { setPreRunning(null); }
  }

  // Per-endpoint "Fix with AI" heal state, keyed by the same `modal_<collectionId>_<idx>`
  // key used for the row's expand/collapse state.
  const [healState, setHealState] = useState({});

  async function healEndpoint(collection, idx) {
    const key = `modal_${collection.id}_${idx}`;
    const instruction = healState[key]?.text?.trim();
    if (!instruction) return;
    setHealState(prev => ({ ...prev, [key]: { ...prev[key], loading: true } }));
    try {
      const { data } = await api.post('/ai/pre-run/heal', {
        project_id: project.id, collection_id: collection.id, index: idx, instruction,
      });
      setPreRunData(prev => {
        const rows = [...(prev[collection.id] || [])];
        if (data.result) rows[idx] = data.result;
        return { ...prev, [collection.id]: rows };
      });
      setHealState(prev => ({ ...prev, [key]: { showing: false, text: '', loading: false, diagnosis: data.diagnosis } }));
      if (data.diagnosis?.fix_type === 'no_fix') toast(data.diagnosis.issue || 'AI could not determine a fix', 'warn');
      else if (data.result?.success) toast('Fix applied — endpoint now passes', 'success');
      else toast('Fix applied, but the endpoint still fails — see details', 'warn');
    } catch (e) {
      toast(e.response?.data?.error || e.message || 'Heal failed', 'error');
      setHealState(prev => ({ ...prev, [key]: { ...prev[key], loading: false } }));
    }
  }

  async function setCorrelationStatus(collection, rule, status) {
    try {
      const { data } = await api.post('/ai/correlations/status', {
        collection_id: collection.id, project_id: project.id, id: rule.id, status,
      });
      setCorrelationsByCollection(prev => ({ ...prev, [collection.id]: data.correlationRules }));
    } catch (e) {
      toast(e.response?.data?.error || e.message || 'Failed to update correlation rule', 'error');
    }
  }

  async function deleteCorrelation(collection, rule) {
    try {
      const { data } = await api.post('/ai/correlations/delete', {
        collection_id: collection.id, project_id: project.id, id: rule.id,
      });
      setCorrelationsByCollection(prev => ({ ...prev, [collection.id]: data.correlationRules }));
    } catch (e) {
      toast(e.response?.data?.error || e.message || 'Failed to remove correlation rule', 'error');
    }
  }

  // Removes one recorded endpoint from a collection (e.g. garbage/noise traffic swept up
  // during recording — a static asset request, a framework prefetch call) — the backend
  // reindexes every correlation rule/field generator/endpoint override that referenced an
  // endpoint by array index, so those need refreshing here too, not just the endpoint list.
  // `label` is passed in by the caller (built from the SAME pre-run response row already
  // rendered on screen) rather than re-derived from `collection.json_content` here — that
  // list can lag behind what's actually displayed if the collection was refreshed elsewhere
  // since the modal opened, which would show the wrong endpoint's name in the confirmation.
  async function deleteEndpoint(collection, idx, label) {
    const ok = await confirm(
      `Remove "${label}" from this collection? Any correlation rules or AI fixes tied to it will be removed too. This cannot be undone.`,
      'Delete Endpoint'
    );
    if (!ok) return;
    try {
      const { data } = await api.post(`/projects/${project.id}/collections/${collection.id}/endpoints/delete`, { index: idx });
      setOwnCollections(prev => prev.map(c => (c.id === collection.id ? data.collection : c)));
      setLogModalCollection(data.collection);
      setPreRunData(prev => {
        const rows = [...(prev[collection.id] || [])];
        rows.splice(idx, 1);
        return { ...prev, [collection.id]: rows };
      });
      // Rule/generator indices shifted server-side — refetch rather than try to patch them
      // up locally, since this collection's endpoint list just changed shape.
      try {
        const { data: corrData } = await api.get(`/ai/correlations?collection_id=${collection.id}&project_id=${project.id}`);
        setCorrelationsByCollection(prev => ({ ...prev, [collection.id]: corrData.correlationRules || [] }));
      } catch {}
      toast('Endpoint removed', 'success');
    } catch (e) {
      toast(e.response?.data?.error || e.message || 'Failed to remove endpoint', 'error');
    }
  }

  // Manual correlation add form — the fallback for anything auto-detection missed (a
  // transformed value, a source field it couldn't confidently match, etc.). Keyed by
  // collection id so the form's own open/closed + field state doesn't leak across collections.
  const [manualRuleForm, setManualRuleForm] = useState({});
  function manualFormFor(collectionId) {
    return manualRuleForm[collectionId] || {
      open: false, sourceEndpointIndex: '', sourceJsonPath: '', sourceLocation: 'body',
      // targetEndpointIndices: one rule gets created per selected target — e.g. a session
      // token pulled from Login's cookie, injected as a header into many APIs at once.
      targetEndpointIndices: [], targetLocation: 'body', targetKey: '', varName: '', value: '', transform: '',
      injectIfMissing: false,
    };
  }
  function updateManualForm(collectionId, patch) {
    setManualRuleForm(prev => ({ ...prev, [collectionId]: { ...manualFormFor(collectionId), ...patch } }));
  }
  function toggleManualFormTarget(collectionId, index) {
    const f = manualFormFor(collectionId);
    const next = f.targetEndpointIndices.includes(index)
      ? f.targetEndpointIndices.filter(i => i !== index)
      : [...f.targetEndpointIndices, index];
    updateManualForm(collectionId, { targetEndpointIndices: next });
  }

  async function addManualCorrelation(collection) {
    const f = manualFormFor(collection.id);
    if (f.sourceEndpointIndex === '' || !f.sourceJsonPath.trim() || !f.targetEndpointIndices.length || !f.targetKey.trim()) {
      toast('Source endpoint, source field, at least one target endpoint, and target key are required', 'warn');
      return;
    }
    try {
      const { data } = await api.post('/ai/correlations/manual', {
        collection_id: collection.id, project_id: project.id,
        sourceEndpointIndex: Number(f.sourceEndpointIndex), sourceJsonPath: f.sourceJsonPath.trim(), sourceLocation: f.sourceLocation,
        targetEndpointIndex: f.targetEndpointIndices.map(Number), targetLocation: f.targetLocation,
        targetKey: f.targetLocation === 'urlPath' ? Number(f.targetKey) : f.targetKey.trim(),
        varName: f.varName.trim() || undefined,
        value: f.value.trim() || undefined,
        transform: f.transform || undefined,
        injectIfMissing: f.targetLocation === 'header' ? f.injectIfMissing : undefined,
      });
      setCorrelationsByCollection(prev => ({ ...prev, [collection.id]: data.correlationRules }));
      updateManualForm(collection.id, { open: false, sourceJsonPath: '', targetEndpointIndices: [], targetKey: '', varName: '', value: '', transform: '', injectIfMissing: false });
      if (data.skipped?.length) {
        toast(`${data.created.length} rule(s) added, ${data.skipped.length} skipped: ${data.skipped.map(s => s.reason).join('; ')}`, 'warn');
      } else {
        toast(`${data.created.length} correlation rule(s) added`, 'success');
      }
    } catch (e) {
      toast(e.response?.data?.error || e.message || 'Failed to add correlation rule', 'error');
    }
  }

  function isPreRunFresh(c) {
    if (!c.pre_run_collection_hash) return false;
    return simpleHash(c.json_content || '') === c.pre_run_collection_hash;
  }

  // Display label for an endpoint index referenced by a correlation rule — falls back to
  // the raw index if the collection's own endpoint list can't be parsed for some reason.
  function epLabel(collection, index) {
    try {
      const eps = JSON.parse(collection.json_content || '[]');
      const ep = eps[index];
      return ep ? (ep.name || ep.url || `#${index}`) : `#${index}`;
    } catch { return `#${index}`; }
  }

  const LOCATION_LABEL = { urlPath: 'URL path', query: 'query param', header: 'header', body: 'body field' };

  // Matches backend/src/utils/transforms.js's TRANSFORMS registry exactly — keep in sync.
  const TRANSFORM_OPTIONS = [
    { value: '', label: '(none — copy value as-is)' },
    { value: 'md5', label: 'MD5 hash (hex)' },
    { value: 'sha1', label: 'SHA-1 hash (hex)' },
    { value: 'sha256', label: 'SHA-256 hash (hex)' },
    { value: 'urlEncode', label: 'URL-encode' },
    { value: 'urlDecode', label: 'URL-decode' },
    { value: 'upperCase', label: 'Upper case' },
    { value: 'lowerCase', label: 'Lower case' },
  ];

  function getEndpointList(collection) {
    try { return JSON.parse(collection.json_content || '[]'); } catch { return []; }
  }

  function onLogDragStart(e) {
    e.preventDefault();
    const startMouseX = e.clientX;
    const startMouseY = e.clientY;
    const startX = logModalPos.x;
    const startY = logModalPos.y;
    function onMove(e) {
      setLogModalPos({ x: startX + e.clientX - startMouseX, y: Math.max(0, startY + e.clientY - startMouseY) });
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
                  <span className="spinner" /> Running Pre-run against collection endpoints...
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
                      <button className="btn-secondary btn-sm" onClick={() => openLogModal(c)}>
                        <i className="ti ti-list-details" /> Show Logs
                      </button>
                    )}
                    <button className="btn-primary btn-sm" onClick={() => preRun(c)}>
                      <i className="ti ti-player-play" />Pre-run
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
                    <button className="btn-secondary btn-sm" onClick={() => openLogModal(c)}>
                      <i className="ti ti-list-details" /> Show Logs
                    </button>
                  </div>
                  <button className="btn-secondary btn-sm" onClick={() => preRun(c)}>
                    <i className="ti ti-refresh" /> Pre-run
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
        <Modal onClose={() => { setModal(null); setSelectedFile(null); setSelectedEnvFile(null); setParsedCurl(null); }}>
          <div className="modal-hdr">
            <div className="modal-title">{modal === 'add' ? 'Add' : 'Edit'} API Source</div>
            <button className="btn-icon" onClick={() => { setModal(null); setSelectedFile(null); setSelectedEnvFile(null); setParsedCurl(null); }}><i className="ti ti-x" /></button>
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
                  onClick={() => { setForm(f => ({ ...f, source_type: st.value, source_content: '' })); setSelectedFile(null); setSelectedEnvFile(null); setParsedCurl(null); setError(''); }}
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

          {form.source_type === 'postman' && (
            <div className="form-group">
              <label className="form-label">Postman Environment (optional)</label>
              <input ref={envFileRef} type="file" accept=".json" style={{ display: 'none' }}
                onChange={e => { setSelectedEnvFile(e.target.files?.[0] || null); setError(''); }} />
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                <button className="btn-secondary" type="button" onClick={() => envFileRef.current?.click()}>
                  <i className="ti ti-upload" /> Choose Environment File
                </button>
                {selectedEnvFile
                  ? <span style={{ fontSize: '13px', color: 'var(--color-text-secondary)' }}>{selectedEnvFile.name}</span>
                  : null}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--color-text-tertiary)', marginTop: '4px' }}>
                Upload a Postman environment export (e.g. <code>{'{{url}}'}</code>, <code>{'{{token}}'}</code>) so pre-run can resolve variables instead of failing. Any defaults embedded in the collection itself are picked up automatically.
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
            <button className="btn-secondary" onClick={() => { setModal(null); setSelectedFile(null); setSelectedEnvFile(null); setParsedCurl(null); }}>Cancel</button>
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
        const modalCorrelations = correlationsByCollection[logModalCollection.id] || [];
        return (
          <div style={{ position: 'fixed', inset: 0, zIndex: 1000, pointerEvents: 'none' }}>
            <div style={{
              position: 'absolute', left: logModalPos.x, top: logModalPos.y,
              width: '860px', minWidth: '400px', minHeight: '300px',
              height: `${Math.min(620, window.innerHeight - logModalPos.y - 24)}px`,
              maxHeight: `calc(100vh - ${logModalPos.y}px - 24px)`,
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
              {/* Correlations detected — tokens/params/paths carried from one endpoint's
                  response into a later one's request. Only 'confirmed' rules (or an
                  unreviewed 'high' confidence auto-guess) are ever burned into a generated
                  script — 'low' confidence guesses sit here until a human confirms them. */}
              {(() => {
                const manualForm = manualFormFor(logModalCollection.id);
                const eps = getEndpointList(logModalCollection);
                return (
                <div style={{ borderBottom: '1px solid var(--color-border-secondary)', flexShrink: 0 }}>
                  <div onClick={() => setCorrelationsOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 20px', cursor: 'pointer', userSelect: 'none' }}>
                    <i className={`ti ti-chevron-${correlationsOpen ? 'down' : 'right'}`} style={{ fontSize: '11px', color: 'var(--color-text-tertiary)' }} />
                    <i className="ti ti-link" style={{ fontSize: '14px', color: 'var(--accent)' }} />
                    <span style={{ fontSize: '12px', fontWeight: 700 }}>Correlations</span>
                    <span style={{ fontSize: '11px', padding: '1px 7px', borderRadius: '10px', background: 'var(--color-background-secondary)', fontWeight: 600 }}>{modalCorrelations.length}</span>
                    {modalCorrelations.some(r => r.status === 'auto' && r.confidence === 'low') && (
                      <span style={{ fontSize: '10px', fontWeight: 700, padding: '2px 6px', borderRadius: '4px', background: 'rgba(240,167,50,0.15)', color: 'var(--warn)' }}>
                        {modalCorrelations.filter(r => r.status === 'auto' && r.confidence === 'low').length} need review
                      </span>
                    )}
                  </div>
                  {correlationsOpen && (
                    // Capped + independently scrollable so this section (rule list + the
                    // manual-add form, which can get tall once its target-endpoint
                    // checklist and every field is showing) can never squeeze the endpoint
                    // response list below down to zero height via flexShrink — without this
                    // cap, adding more correlations left nothing to scroll to see the
                    // endpoints that were actually fired in pre-run.
                    <div style={{ padding: '0 20px 12px 20px', display: 'flex', flexDirection: 'column', gap: '10px', maxHeight: '340px', overflowY: 'auto' }}>
                      {modalCorrelations.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '220px', overflowY: 'auto' }}>
                          {modalCorrelations.map(rule => {
                            const badgeColor = rule.status === 'confirmed' ? '#00c896' : rule.status === 'rejected' ? 'var(--danger)' : rule.confidence === 'high' ? 'var(--accent)' : 'var(--warn)';
                            const badgeLabel = rule.status === 'confirmed' ? 'CONFIRMED' : rule.status === 'rejected' ? 'REJECTED' : rule.confidence === 'high' ? 'AUTO (HIGH)' : 'NEEDS REVIEW';
                            return (
                              <div key={rule.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 10px', borderRadius: '6px', background: 'var(--color-background-secondary)', fontSize: '11px' }}>
                                <span style={{ fontWeight: 700, padding: '2px 6px', borderRadius: '4px', background: `${badgeColor}22`, color: badgeColor, flexShrink: 0 }}>{badgeLabel}</span>
                                <span style={{ flex: 1, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  <strong>{epLabel(logModalCollection, rule.sourceEndpointIndex)}</strong> ({rule.sourceJsonPath}) &rarr;{' '}
                                  <strong>{epLabel(logModalCollection, rule.targetEndpointIndex)}</strong> {LOCATION_LABEL[rule.targetLocation] || rule.targetLocation}
                                  {rule.targetLocation !== 'urlPath' ? ` "${rule.targetKey}"` : ''} as <code>${'{' + rule.varName + '}'}</code>
                                  {rule.transform ? <> via <code>{rule.transform}</code></> : null}
                                </span>
                                {rule.status !== 'confirmed' && (
                                  <button className="btn-secondary btn-sm" style={{ fontSize: '10px', padding: '2px 8px', color: '#00c896', flexShrink: 0 }}
                                    onClick={() => setCorrelationStatus(logModalCollection, rule, 'confirmed')}>Confirm</button>
                                )}
                                {rule.status !== 'rejected' && (
                                  <button className="btn-secondary btn-sm" style={{ fontSize: '10px', padding: '2px 8px', color: 'var(--danger)', flexShrink: 0 }}
                                    onClick={() => setCorrelationStatus(logModalCollection, rule, 'rejected')}>Reject</button>
                                )}
                                <button className="btn-icon" style={{ fontSize: '10px', padding: '2px 6px', flexShrink: 0, color: 'var(--danger)' }}
                                  title="Delete this rule permanently"
                                  onClick={() => deleteCorrelation(logModalCollection, rule)}><i className="ti ti-trash" /></button>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {/* Manual add — the fallback for anything auto-detection missed: a
                          transformed value, a source it couldn't confidently match, a
                          value that only appears in a format detection doesn't scan. */}
                      {!manualForm.open ? (
                        <button className="btn-secondary btn-sm" style={{ fontSize: '11px', alignSelf: 'flex-start' }}
                          onClick={() => updateManualForm(logModalCollection.id, { open: true })}>
                          <i className="ti ti-plus" /> Add correlation
                        </button>
                      ) : (
                        <div style={{ padding: '12px', borderRadius: '8px', border: '1px dashed var(--color-border-secondary)', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                          <FieldLabel text="Source endpoint">
                            <select value={manualForm.sourceEndpointIndex} onChange={e => updateManualForm(logModalCollection.id, { sourceEndpointIndex: e.target.value })}
                              style={{ width: '100%', fontSize: '11px', boxSizing: 'border-box' }}>
                              <option value="">Select the endpoint whose response has the value…</option>
                              {eps.map((ep, i) => <option key={i} value={i}>{i}: {ep.method || 'GET'} {ep.name || ep.url}</option>)}
                            </select>
                          </FieldLabel>
                          <div style={{ display: 'flex', gap: '6px' }}>
                            <div style={{ width: '110px', flexShrink: 0 }}>
                              <FieldLabel text="Source location">
                                <select value={manualForm.sourceLocation} onChange={e => updateManualForm(logModalCollection.id, { sourceLocation: e.target.value })}
                                  style={{ width: '100%', fontSize: '11px', boxSizing: 'border-box' }}>
                                  <option value="body">body</option>
                                  <option value="header">header</option>
                                  <option value="cookie">cookie</option>
                                </select>
                              </FieldLabel>
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <FieldLabel text="Field name">
                                <input value={manualForm.sourceJsonPath} onChange={e => updateManualForm(logModalCollection.id, { sourceJsonPath: e.target.value })}
                                  placeholder={manualForm.sourceLocation === 'body' ? 'e.g. accessToken (or full path $.data.token)' : 'e.g. sessionId'}
                                  style={{ width: '100%', fontSize: '11px', boxSizing: 'border-box' }} />
                              </FieldLabel>
                            </div>
                          </div>

                          <FieldLabel text={`Target endpoint(s) — select one or more${manualForm.targetEndpointIndices.length ? ` (${manualForm.targetEndpointIndices.length} selected)` : ''}`}>
                            <div style={{
                              display: 'flex', flexDirection: 'column', gap: '2px', maxHeight: '140px', overflowY: 'auto',
                              border: '1px solid var(--color-border-secondary)', borderRadius: '6px', padding: '6px', boxSizing: 'border-box',
                            }}>
                              {eps.map((ep, i) => (
                                <label key={i} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', padding: '3px 4px', cursor: 'pointer', borderRadius: '4px' }}>
                                  <input type="checkbox" checked={manualForm.targetEndpointIndices.includes(i)}
                                    onChange={() => toggleManualFormTarget(logModalCollection.id, i)} />
                                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i}: {ep.method || 'GET'} {ep.name || ep.url}</span>
                                </label>
                              ))}
                            </div>
                          </FieldLabel>
                          <div style={{ display: 'flex', gap: '6px' }}>
                            <div style={{ width: '140px', flexShrink: 0 }}>
                              <FieldLabel text="Target location">
                                <select value={manualForm.targetLocation} onChange={e => updateManualForm(logModalCollection.id, { targetLocation: e.target.value })}
                                  style={{ width: '100%', fontSize: '11px', boxSizing: 'border-box' }}>
                                  <option value="urlPath">URL path segment</option>
                                  <option value="query">query param</option>
                                  <option value="header">header</option>
                                  <option value="body">body field</option>
                                </select>
                              </FieldLabel>
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <FieldLabel text="Target key">
                                <input value={manualForm.targetKey} onChange={e => updateManualForm(logModalCollection.id, { targetKey: e.target.value })}
                                  placeholder={manualForm.targetLocation === 'urlPath' ? 'segment index, e.g. 2' : manualForm.targetLocation === 'body' ? 'field name, e.g. orderId' : 'name'}
                                  style={{ width: '100%', fontSize: '11px', boxSizing: 'border-box' }} />
                              </FieldLabel>
                            </div>
                          </div>

                          {manualForm.targetLocation === 'header' && (
                            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', cursor: 'pointer' }}>
                              <input type="checkbox" checked={manualForm.injectIfMissing}
                                onChange={e => updateManualForm(logModalCollection.id, { injectIfMissing: e.target.checked })} />
                              Always add this header, even on endpoints that never recorded it
                            </label>
                          )}

                          <div style={{ display: 'flex', gap: '6px' }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <FieldLabel text="Variable name (optional)">
                                <input value={manualForm.varName} onChange={e => updateManualForm(logModalCollection.id, { varName: e.target.value })}
                                  placeholder="auto-suggested from the field name" style={{ width: '100%', fontSize: '11px', boxSizing: 'border-box' }} />
                              </FieldLabel>
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <FieldLabel text="Transform (optional)">
                                <select value={manualForm.transform} onChange={e => updateManualForm(logModalCollection.id, { transform: e.target.value })}
                                  style={{ width: '100%', fontSize: '11px', boxSizing: 'border-box' }}>
                                  {TRANSFORM_OPTIONS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                                </select>
                              </FieldLabel>
                            </div>
                          </div>

                          {!manualForm.injectIfMissing && (
                            <FieldLabel text="Explicit value override (optional — only needed if the target field wraps the value, e.g. a header reading Bearer <token>)">
                              <input value={manualForm.value} onChange={e => updateManualForm(logModalCollection.id, { value: e.target.value })}
                                placeholder="the exact substring to replace" style={{ width: '100%', fontSize: '11px', boxSizing: 'border-box' }} />
                            </FieldLabel>
                          )}

                          <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
                            <button className="btn-secondary btn-sm" style={{ fontSize: '11px' }}
                              onClick={() => updateManualForm(logModalCollection.id, { open: false })}>Cancel</button>
                            <button className="btn-primary btn-sm" style={{ fontSize: '11px' }}
                              onClick={() => addManualCorrelation(logModalCollection)}>Add</button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
                );
              })()}
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
                        {r.aiFixed && <span style={{ fontSize: '10px', fontWeight: 700, padding: '2px 6px', borderRadius: '4px', background: 'rgba(168,85,247,0.15)', color: '#a855f7', flexShrink: 0 }}>AI FIXED</span>}
                        {r.status ? (
                          <span style={{ fontSize: '11px', fontWeight: 700, color: statusColor, flexShrink: 0 }}>{r.status} {r.statusText}</span>
                        ) : isErr ? (
                          <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--danger)', flexShrink: 0 }}>{r.skipped ? 'SKIPPED' : 'ERROR'}</span>
                        ) : null}
                        {!r.success && (
                          <button className="btn-secondary btn-sm" style={{ fontSize: '10px', padding: '3px 8px', flexShrink: 0 }}
                            onClick={e => { e.stopPropagation(); setHealState(prev => ({ ...prev, [key]: { ...prev[key], showing: !prev[key]?.showing } })); }}>
                            <i className="ti ti-wand" /> Fix with AI
                          </button>
                        )}
                        <button className="btn-icon" style={{ fontSize: '10px', padding: '3px 6px', flexShrink: 0, color: 'var(--danger)' }}
                          title="Remove this endpoint from the collection"
                          onClick={e => { e.stopPropagation(); deleteEndpoint(logModalCollection, idx, `${r.method || 'GET'} ${r.url || r.endpoint}`); }}>
                          <i className="ti ti-trash" />
                        </button>
                      </div>
                      {healState[key]?.showing && !healState[key]?.loading && (
                        <div style={{ padding: '0 20px 12px 44px' }}>
                          <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: '6px' }}>
                            Describe what this endpoint needs — AI will apply it and re-check
                          </div>
                          <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
                            <textarea
                              value={healState[key]?.text || ''}
                              onChange={e => setHealState(prev => ({ ...prev, [key]: { ...prev[key], text: e.target.value } }))}
                              placeholder="e.g. Use the refreshToken from the login response, not the accessToken"
                              rows={2}
                              style={{ flex: 1, fontSize: '12px', padding: '7px 10px', borderRadius: '6px', border: '1px solid var(--color-border)', background: 'var(--color-background)', color: 'var(--color-text)', fontFamily: 'inherit', resize: 'vertical', boxSizing: 'border-box', outline: 'none', minHeight: '52px' }}
                            />
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                              <button className="btn-primary btn-sm" style={{ padding: '6px 14px', fontSize: '11px', whiteSpace: 'nowrap' }}
                                disabled={!healState[key]?.text?.trim()}
                                onClick={() => healEndpoint(logModalCollection, idx)}>
                                <i className="ti ti-wand" /> Heal
                              </button>
                              <button className="btn-secondary btn-sm" style={{ padding: '4px 14px', fontSize: '11px' }}
                                onClick={() => setHealState(prev => ({ ...prev, [key]: { showing: false, text: '' } }))}>
                                Cancel
                              </button>
                            </div>
                          </div>
                        </div>
                      )}
                      {healState[key]?.loading && (
                        <div style={{ padding: '0 20px 12px 44px', fontSize: '12px', color: 'var(--color-text-secondary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span className="spinner" /> AI is analyzing this endpoint…
                        </div>
                      )}
                      {healState[key]?.diagnosis && (
                        <div style={{ margin: '0 20px 10px 44px', padding: '8px 12px', borderRadius: '6px', fontSize: '11px', background: healState[key].diagnosis.fix_type === 'no_fix' ? 'rgba(240,167,50,0.08)' : 'rgba(168,85,247,0.08)', color: healState[key].diagnosis.fix_type === 'no_fix' ? 'var(--warn)' : '#a855f7' }}>
                          <div><strong>Issue:</strong> {healState[key].diagnosis.issue}</div>
                          {healState[key].diagnosis.fix_type !== 'no_fix' && <div><strong>Fix:</strong> {healState[key].diagnosis.fix}</div>}
                        </div>
                      )}
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
              {/* Footer — fixed, outside the scrolling body */}
              <div style={{ flexShrink: 0, display: 'flex', justifyContent: 'flex-end', gap: '8px', padding: '14.4px 20px', borderTop: '1px solid var(--color-border-secondary)' }}>
                <button className="btn-primary" onClick={() => setLogModalCollection(null)}>Close</button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
