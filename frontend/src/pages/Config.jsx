import { useState, useEffect } from 'react';
import api from '../api';
import CustomSelect from '../components/CustomSelect';

const BLANK_URL = { protocol: 'https', url: '', port: '443' };
function normalizeConfig(raw) {
  if (!raw) return { urls: [] };
  // Strip deprecated fields — Docker handles paths, test plans handle load params
  const { urls, url, protocol, port, jmeter_path, k6_path, java_home, threads, rampup, duration, loops, ...rest } = raw;
  let normalizedUrls;
  if (Array.isArray(urls)) {
    // Missing key and explicit empty array both mean "no URLs configured" — treat them
    // identically. Previously a missing key alone would synthesize one blank template
    // row, which contradicted the "0 URL(s)" badge shown right next to it.
    normalizedUrls = urls;
  } else if (url !== undefined) {
    normalizedUrls = [{ protocol: protocol || 'https', url: url || '', port: port || '443' }];
  } else {
    normalizedUrls = [];
  }
  return { urls: normalizedUrls, ...rest };
}

function getCollectionEnvs(col) {
  if (!col) return [];
  let envs = [];
  try { envs = JSON.parse(col.environments || '[]'); } catch {}
  if (!envs.length && col.environment) envs = [col.environment];
  return envs;
}

function UrlRow({ entry, idx, onChange, onRemove, canRemove }) {
  return (
    <div className="url-row">
      <div className="form-group" style={{ marginBottom: 0 }}>
        {idx === 0 && <label className="form-label">Protocol</label>}
        <CustomSelect value={entry.protocol} onChange={e => onChange(idx, 'protocol', e.target.value)}>
          <option value="https">HTTPS</option>
          <option value="http">HTTP</option>
        </CustomSelect>
      </div>
      <div className="form-group" style={{ marginBottom: 0 }}>
        {idx === 0 && <label className="form-label">Base URL</label>}
        <input
          type="text"
          value={entry.url}
          onChange={e => onChange(idx, 'url', e.target.value)}
          placeholder="api.example.com"
        />
      </div>
      <div className="form-group" style={{ marginBottom: 0 }}>
        {idx === 0 && <label className="form-label">Port</label>}
        <input
          type="text"
          value={entry.port}
          onChange={e => onChange(idx, 'port', e.target.value)}
          placeholder="443"
        />
      </div>
      <div style={{ display: 'flex', alignItems: idx === 0 ? 'flex-end' : 'center', paddingBottom: idx === 0 ? '2px' : 0 }}>
        <button
          className="btn-icon"
          onClick={() => onRemove(idx)}
          disabled={!canRemove}
          title="Remove URL set"
          style={{ color: 'var(--danger)', opacity: canRemove ? 1 : 0.3 }}
        >
          <i className="ti ti-trash" />
        </button>
      </div>
    </div>
  );
}

function UrlsEditor({ cfg, setCfg }) {
  const urls = cfg.urls || [{ ...BLANK_URL }];

  function updateUrl(idx, field, value) {
    const next = urls.map((u, i) => i === idx ? { ...u, [field]: value } : u);
    setCfg(c => ({ ...c, urls: next }));
  }

  function addUrl() {
    setCfg(c => ({ ...c, urls: [...(c.urls || []), { ...BLANK_URL }] }));
  }

  function removeUrl(idx) {
    const next = urls.filter((_, i) => i !== idx);
    setCfg(c => ({ ...c, urls: next.length ? next : [{ ...BLANK_URL }] }));
  }

  return (
    <div>
      {urls.map((entry, idx) => (
        <div key={idx} style={{ marginBottom: '4px' }}>
          {idx > 0 && (
            <div style={{ fontSize: '10px', color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: '4px' }}>
              URL Set {idx + 1}
            </div>
          )}
          <UrlRow
            entry={entry}
            idx={idx}
            onChange={updateUrl}
            onRemove={removeUrl}
            canRemove={urls.length > 1}
          />
        </div>
      ))}
      <button className="btn-secondary btn-sm" style={{ marginTop: '6px' }} onClick={addUrl}>
        <i className="ti ti-plus" /> Add URL Set
      </button>
      {urls.length > 1 && (
        <div style={{ marginTop: '8px', fontSize: '11px', color: 'var(--color-text-tertiary)' }}>
          <i className="ti ti-info-circle" style={{ marginRight: '4px' }} />
          Multiple URL sets are stored as PROTOCOL_1/URL_1/PORT_1, PROTOCOL_2/URL_2/PORT_2, etc. in JMeter config.
        </div>
      )}
    </div>
  );
}

function VariablesEditor({ cfg, setCfg }) {
  const varsObj = cfg.variables || {};
  const rows = Object.keys(varsObj).length ? Object.entries(varsObj).map(([key, value]) => ({ key, value })) : [{ key: '', value: '' }];

  function commit(newRows) {
    const obj = {};
    for (const r of newRows) if (r.key.trim()) obj[r.key.trim()] = r.value;
    setCfg(c => ({ ...c, variables: obj }));
  }

  function updateRow(idx, field, value) {
    commit(rows.map((r, i) => i === idx ? { ...r, [field]: value } : r));
  }

  function addRow() {
    commit([...rows, { key: '', value: '' }]);
  }

  function removeRow(idx) {
    const next = rows.filter((_, i) => i !== idx);
    commit(next.length ? next : [{ key: '', value: '' }]);
  }

  return (
    <div style={{ marginTop: '18px', paddingTop: '16px', borderTop: '1px solid var(--color-border-secondary)' }}>
      <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '6px' }}>
        <i className="ti ti-variable" style={{ color: 'var(--accent)' }} /> Variables (<code>{'{{var}}'}</code>)
      </div>
      <div style={{ fontSize: '11px', color: 'var(--color-text-tertiary)', marginBottom: '10px' }}>
        Values for any <code>{'{{var}}'}</code> placeholders used in this collection's endpoints (URL, headers, body) — required for Pre-Run to resolve them. Auto-filled from an uploaded Postman environment file or the collection's own defaults where possible; add or correct any that couldn't be auto-derived (e.g. a value a Postman pre-request script computes dynamically, which Peako does not execute).
      </div>
      <div style={{ maxHeight: '400px', overflowY: 'auto', paddingRight: '6px' }}>
        {rows.map((r, idx) => (
          <div key={idx} style={{ display: 'flex', gap: '10px', marginBottom: '8px', alignItems: 'center' }}>
            <input type="text" value={r.key} onChange={e => updateRow(idx, 'key', e.target.value)} placeholder="url" style={{ flex: '0 0 160px' }} />
            <input type="text" value={r.value} onChange={e => updateRow(idx, 'value', e.target.value)} placeholder="https://api.example.com" style={{ flex: 1 }} />
            <button className="btn-icon" onClick={() => removeRow(idx)} title="Remove variable" style={{ color: 'var(--danger)' }}>
              <i className="ti ti-trash" />
            </button>
          </div>
        ))}
      </div>
      <button className="btn-secondary btn-sm" onClick={addRow} style={{ marginTop: '4px' }}>
        <i className="ti ti-plus" /> Add Variable
      </button>
    </div>
  );
}

function CollapsibleSection({ title, icon, iconColor, open, onToggle, children, badge }) {
  return (
    <div className="collapsible-card">
      <div className="collapsible-hdr" onClick={onToggle}>
        <div className="collapsible-title">
          <i className={`ti ${icon}`} style={{ color: iconColor }} />
          {title}
          {badge && <span className="badge tag-gray" style={{ marginLeft: '6px', fontSize: '10px' }}>{badge}</span>}
        </div>
        <i className={`ti ti-chevron-right collapsible-chevron${open ? ' open' : ''}`} />
      </div>
      {open && <div className="collapsible-body">{children}</div>}
    </div>
  );
}

export default function Config({ project }) {
  const [globalCfg, setGlobalCfg]   = useState({ urls: [{ ...BLANK_URL }] });
  const [projectCfg, setProjectCfg] = useState({ urls: [{ ...BLANK_URL }] });
  const [envCfg, setEnvCfg]         = useState({ urls: [{ ...BLANK_URL }] }); // env-specific config
  const [saving, setSaving] = useState(null);
  const [saved, setSaved] = useState(null);
  const [open, setOpen] = useState({ project: false, envConfig: true });

  const collections = project?.collections || [];
  // Collection/environment selection is local to this tab — a project can have multiple
  // collections, each with its own independent set of {{var}} values and URLs per env.
  const [selectedCollectionId, setSelectedCollectionId] = useState('');
  const [selectedEnv, setSelectedEnv] = useState('');
  const selectedCollection = collections.find(c => String(c.id) === String(selectedCollectionId)) || null;
  const selectedCollectionEnvs = getCollectionEnvs(selectedCollection);

  // Default to the first collection once the list is available (and keep it valid if
  // collections are added/removed) — same idea as picking a sensible default, but the
  // user can change it via the dropdown below at any time.
  useEffect(() => {
    if (!collections.length) { setSelectedCollectionId(''); return; }
    if (!collections.some(c => String(c.id) === String(selectedCollectionId))) {
      setSelectedCollectionId(collections[0].id);
    }
  }, [collections.map(c => c.id).join(','), selectedCollectionId]);

  // Keep the selected env valid for whichever collection is currently selected.
  useEffect(() => {
    if (!selectedCollectionEnvs.length) { setSelectedEnv(''); return; }
    if (!selectedCollectionEnvs.includes(selectedEnv)) setSelectedEnv(selectedCollectionEnvs[0]);
  }, [selectedCollection?.id]);

  useEffect(() => {
    api.get('/config').then(({ data }) => {
      setGlobalCfg(normalizeConfig(data.config));
    }).catch(() => {});
    if (project) {
      api.get(`/projects/${project.id}/config`).then(({ data }) => {
        setProjectCfg(normalizeConfig(data.project));
      }).catch(() => {});
    }
  }, [project?.id]);

  // Load env-specific config whenever the locally-selected collection/env changes
  useEffect(() => {
    if (!project || !selectedCollection?.id || !selectedEnv) return;
    api.get(`/projects/${project.id}/collections/${selectedCollection.id}/env-config/${encodeURIComponent(selectedEnv)}`)
      .then(({ data }) => {
        setEnvCfg(normalizeConfig(data.env || { urls: [{ ...BLANK_URL }] }));
      }).catch(() => setEnvCfg({ urls: [{ ...BLANK_URL }] }));
  }, [project?.id, selectedCollection?.id, selectedEnv]);

  function autoPopulateFromCollection() {
    if (!project?.collections?.length) return;
    const urlSets = [];
    const seen = new Set();
    for (const col of project.collections) {
      let endpoints = [];
      try { endpoints = JSON.parse(col.json_content || '[]'); } catch { continue; }
      for (const ep of endpoints) {
        if (!ep.url) continue;
        try {
          const u = new URL(ep.url.startsWith('http') ? ep.url : `https://${ep.url}`);
          const protocol = u.protocol.replace(':', '');
          const hostname = u.hostname;
          // Skip unresolved Postman {{var}} templates — not a real hostname.
          if (!hostname || hostname.includes('{{')) continue;
          // Only use the port if the URL actually specified one — don't assume 443/80.
          const port = u.port || '';
          const key = `${protocol}|${hostname}|${port}`;
          if (!seen.has(key)) {
            seen.add(key);
            urlSets.push({ protocol, url: hostname, port });
          }
        } catch { continue; }
      }
    }
    if (!urlSets.length) return;
    setProjectCfg({ urls: urlSets });
    setOpen(o => ({ ...o, project: true }));
  }

  function stripDeprecated(cfg) {
    const { jmeter_path, k6_path, java_home, threads, rampup, duration, loops, ...clean } = cfg || {};
    return clean;
  }

  async function saveProject() {
    if (!project) return;
    setSaving('project');
    try {
      await api.put(`/projects/${project.id}/config`, { config: stripDeprecated(projectCfg) });
      setSaved('project'); setTimeout(() => setSaved(null), 3000);
    } finally { setSaving(null); }
  }

  async function saveEnv() {
    if (!project || !selectedCollection?.id || !selectedEnv) return;
    setSaving('env');
    try {
      await api.put(`/projects/${project.id}/collections/${selectedCollection.id}/env-config/${encodeURIComponent(selectedEnv)}`,
        { config: stripDeprecated(envCfg) });
      setSaved('env'); setTimeout(() => setSaved(null), 3000);
    } finally { setSaving(null); }
  }

  return (
    <div className="page fade-in">
      <div className="section-hdr" style={{ marginBottom: '4px' }}>
        <div className="section-title"><i className="ti ti-settings-2" style={{ marginRight: '8px', color: 'var(--accent)' }} />Configuration</div>
      </div>
      <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)', marginBottom: '20px' }}>
        Base URLs are auto-populated from your API source collections and stored as JMeter User Defined Variables.
      </div>

      {/* Endpoint Details — only shown when NOT in a specific env context */}
      {(!selectedCollection || !selectedEnv) && (
      <CollapsibleSection
        title={`Endpoint Details${project ? ` — ${project.name}` : ''}`}
        icon="ti-folder"
        iconColor="var(--warn)"
        open={open.project}
        onToggle={() => setOpen(o => ({ ...o, project: !o.project }))}
        badge={project ? `${(projectCfg.urls || []).filter(u => u.url).length || 0} URL(s)` : 'No project selected'}
      >
        <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)', marginBottom: '14px' }}>
          {project
            ? <>Endpoint configuration for <strong>{project.name}</strong>.</>
            : 'Select a project to configure endpoints.'}
        </div>
        {saved === 'project' && <div style={{ marginBottom: '12px', padding: '8px 12px', background: 'rgba(34,197,94,0.12)', borderRadius: '6px', fontSize: '12px', color: '#22c55e' }}>Endpoint details saved.</div>}
        <UrlsEditor cfg={projectCfg} setCfg={setProjectCfg} />
        <div style={{ marginTop: '16px' }}>
          <button className="btn-primary" onClick={saveProject} disabled={!project || saving === 'project'}>
            {saving === 'project' && <span className="spinner" />}Save Endpoint Details
          </button>
        </div>
      </CollapsibleSection>
      )}

      {/* Collection + Environment selector — variables/URLs are stored per collection, per env */}
      {collections.length > 0 && (
        <div className="collapsible-card" style={{ padding: '14px 18px' }}>
          <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div className="form-group" style={{ marginBottom: 0, minWidth: '260px' }}>
              <label className="form-label">API Source Collection</label>
              <CustomSelect value={selectedCollectionId} onChange={e => setSelectedCollectionId(e.target.value)}>
                {collections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </CustomSelect>
            </div>
            <div className="form-group" style={{ marginBottom: 0, minWidth: '200px' }}>
              <label className="form-label">Environment</label>
              <CustomSelect value={selectedEnv} onChange={e => setSelectedEnv(e.target.value)}>
                {selectedCollectionEnvs.map(e => <option key={e} value={e}>{e}</option>)}
              </CustomSelect>
            </div>
          </div>
        </div>
      )}

      {/* Environment-Specific Config — shown only when inside a collection+env context */}
      {selectedCollection && selectedEnv && (
        <CollapsibleSection
          title={`Environment Config — ${selectedCollection.name} / ${selectedEnv}`}
          icon="ti-server"
          iconColor="var(--accent)"
          open={open.envConfig !== false}
          onToggle={() => setOpen(o => ({ ...o, envConfig: !o.envConfig }))}
          badge={`${(envCfg.urls || []).filter(u => u.url).length || 0} URL(s)`}
        >
          <div style={{ padding: '10px 14px', background: 'rgba(73,204,61,0.07)', border: '1px solid rgba(73,204,61,0.2)', borderRadius: '8px', marginBottom: '14px', fontSize: '12px', color: 'var(--color-text-secondary)' }}>
            <i className="ti ti-shield-check" style={{ color: 'var(--accent)', marginRight: '6px' }} />
            <strong>Enter the target server URL for {selectedEnv}.</strong> Each environment must have its own server URL
            (e.g. QA → <code>qa-api.company.com</code>, Staging → <code>staging-api.company.com</code>).
            <strong style={{ color: 'var(--danger)', marginLeft: '4px' }}>This is not shared with any other environment.</strong>
            <div style={{ marginTop: '6px', fontSize: '11px', color: 'var(--color-text-tertiary)' }}>
              Priority: <strong style={{ color: 'var(--accent)' }}>{selectedEnv} URL</strong> (used in JMX) → Project → Global (fallback)
            </div>
          </div>
          {saved === 'env' && <div style={{ marginBottom: '12px', padding: '8px 12px', background: 'rgba(34,197,94,0.12)', borderRadius: '6px', fontSize: '12px', color: '#22c55e' }}>Environment config saved.</div>}
          <UrlsEditor cfg={envCfg} setCfg={setEnvCfg} />
          <VariablesEditor cfg={envCfg} setCfg={setEnvCfg} />
          <div style={{ marginTop: '16px', display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="btn-primary" onClick={saveEnv} disabled={saving === 'env'}>
              {saving === 'env' && <span className="spinner" />}Save {selectedEnv} Config
            </button>
            <div style={{ fontSize: '11px', color: 'var(--color-text-tertiary)' }}>
              <i className="ti ti-info-circle" style={{ marginRight: '4px' }} />
              Stored separately per environment — QA and Staging have independent configs
            </div>
          </div>
        </CollapsibleSection>
      )}

    </div>
  );
}
