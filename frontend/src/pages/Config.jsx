import { useState, useEffect } from 'react';
import api from '../api';
import { useToast } from '../hooks/useToast';
import CustomSelect from '../components/CustomSelect';
import EnvBar from '../components/EnvBar';

const BLANK_URL = { protocol: 'https', url: '', port: '443' };
function normalizeConfig(raw) {
  if (!raw) return { urls: [{ ...BLANK_URL }] };
  // Strip deprecated fields — Docker handles paths, test plans handle load params
  const { urls, url, protocol, port, jmeter_path, k6_path, java_home, threads, rampup, duration, loops, ...rest } = raw;
  let normalizedUrls;
  if (urls && Array.isArray(urls)) {
    normalizedUrls = urls;
  } else if (url !== undefined) {
    normalizedUrls = [{ protocol: protocol || 'https', url: url || '', port: port || '443' }];
  } else {
    normalizedUrls = [{ ...BLANK_URL }];
  }
  return { urls: normalizedUrls, ...rest };
}

function LoadParamsEditor({ cfg, setCfg }) {
  function set(k, v) { setCfg(c => ({ ...c, [k]: v })); }
  return (
    <div>
      <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: '10px', marginTop: '16px', display: 'flex', alignItems: 'center', gap: '6px' }}>
        <i className="ti ti-settings-2" style={{ color: 'var(--accent)' }} /> Default Load Parameters
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px' }}>
        {[
          { key: 'threads',  label: 'Virtual Users',   placeholder: 'e.g. 50',  hint: 'threads' },
          { key: 'rampup',   label: 'Ramp-up (s)',     placeholder: 'e.g. 30',  hint: 'seconds' },
          { key: 'duration', label: 'Duration (s)',     placeholder: 'e.g. 300', hint: 'seconds' },
          { key: 'loops',    label: 'Iterations',       placeholder: 'e.g. 1',   hint: 'loop count' },
        ].map(({ key, label, placeholder, hint }) => (
          <div className="form-group" key={key} style={{ marginBottom: 0 }}>
            <label className="form-label">{label}</label>
            <input
              type="number" min="1"
              value={cfg[key] ?? ''}
              onChange={e => set(key, e.target.value)}
              placeholder={placeholder}
            />
            <div style={{ fontSize: '10px', color: 'var(--color-text-tertiary)', marginTop: '3px' }}>{hint}</div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: '11px', color: 'var(--color-text-tertiary)', marginTop: '8px' }}>
        <i className="ti ti-info-circle" style={{ marginRight: '4px' }} />
        Used as defaults when creating test suites. Individual suites can override these values.
      </div>
    </div>
  );
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

export default function Config({ project, collection, env, envs, onEnvChange }) {
  const { toast } = useToast();
  const [globalCfg, setGlobalCfg]   = useState({ urls: [{ ...BLANK_URL }] });
  const [projectCfg, setProjectCfg] = useState({ urls: [{ ...BLANK_URL }] });
  const [envCfg, setEnvCfg]         = useState({ urls: [{ ...BLANK_URL }] }); // env-specific config
  const [envReadiness, setEnvReadiness] = useState(null); // env health status
  const [saving, setSaving] = useState(null);
  const [saved, setSaved] = useState(null);
  const [open, setOpen] = useState({ sysCheck: true, docker: false, global: false, project: false, effective: false, envReady: true });
  const [sysChecks, setSysChecks] = useState([]);
  const [sysOverall, setSysOverall] = useState(null); // null | 'ok' | 'warn' | 'fail'
  const [sysRunning, setSysRunning] = useState(false);
  const [dockerStatus, setDockerStatus] = useState(null); // null | 'ok' | 'installed' | 'missing'
  const [dockerVersion, setDockerVersion] = useState('');
  const [checkingDocker, setCheckingDocker] = useState(false);
  const [installingDocker, setInstallingDocker] = useState(false);
  const [startingDocker, setStartingDocker] = useState(false);
  const [sysDockerMsg, setSysDockerMsg] = useState(''); // inline status inside System Requirements
  const [enablingVirt, setEnablingVirt] = useState(false);
  const [virtMsg, setVirtMsg] = useState('');
  const [dockerLogs, setDockerLogs] = useState([]);
  const [jmeterDockerImage, setJmeterDockerImage] = useState('justb4/jmeter:latest');
  const [k6DockerImage, setK6DockerImage] = useState('grafana/k6:latest');
  const [pullingImage, setPullingImage] = useState(null); // 'jmeter' | 'k6' | null

  useEffect(() => {
    api.get('/config').then(({ data }) => {
      setGlobalCfg(normalizeConfig(data.config));
      if (data.config?.jmeter_docker_image) setJmeterDockerImage(data.config.jmeter_docker_image);
      if (data.config?.k6_docker_image) setK6DockerImage(data.config.k6_docker_image);
    }).catch(() => {});
    if (project) {
      api.get(`/projects/${project.id}/config`).then(({ data }) => {
        setProjectCfg(normalizeConfig(data.project));
      }).catch(() => {});
    }
    runSystemCheck();
  }, [project?.id, project?.collections?.length]);

  // When env context changes: reset check state + reload env config
  useEffect(() => {
    if (!project) return;

    // Reset system check and docker state so each env gets a fresh check
    if (collection?.id && env) {
      setSysChecks([]);
      setSysOverall(null);
      setDockerStatus(null);
      setDockerLogs([]);
    }

    if (collection?.id && env) {
      api.get(`/projects/${project.id}/collections/${collection.id}/env-config/${encodeURIComponent(env)}`)
        .then(({ data }) => {
          setEnvCfg(normalizeConfig(data.env || { urls: [{ ...BLANK_URL }] }));
        }).catch(() => setEnvCfg({ urls: [{ ...BLANK_URL }] }));

      // Load env readiness summary
      Promise.all([
        api.get(`/projects/${project.id}/test-data?collection_id=${collection.id}&env=${encodeURIComponent(env)}`),
        api.get(`/projects/${project.id}/test-suites`),
        api.get(`/projects/${project.id}/collections/${collection.id}/env-config/${encodeURIComponent(env)}`),
      ]).then(([tdRes, tsRes, cfgRes]) => {
        // Only count files actually in THIS env's folder — no cross-env sharing
        const testData = tdRes.data.files || [];
        const allSuites = tsRes.data.suites || [];
        const envSuites = allSuites.filter(s => String(s.collection_id) === String(collection.id) && s.env === env);
        const generated = envSuites.filter(s => s.jmx_path || s.js_path);
        const envUrls   = (cfgRes.data.env?.urls || []).filter(u => u.url);
        setEnvReadiness({
          configuredUrls:  envUrls.length,
          testDataFiles:   testData.length,
          testPlans:       envSuites.length,
          generatedScripts: generated.length,
          isReady: envUrls.length > 0 && generated.length > 0,
        });
      }).catch(() => setEnvReadiness(null));
    }
  }, [project?.id, collection?.id, env]);

  async function runSystemCheck() {
    setSysRunning(true);
    setSysChecks([]);
    setSysOverall(null);
    try {
      const { data } = await api.get('/execution/system-check');
      setSysChecks(data.checks || []);
      setSysOverall(data.overall || 'ok');
    } catch {
      setSysChecks([{ id: 'error', name: 'System Check', status: 'fail', detail: 'Could not reach backend — is the server running?' }]);
      setSysOverall('fail');
    } finally {
      setSysRunning(false);
    }
  }

  function autoPopulateFromCollection() {
    if (!project?.collections?.length) return toast('No collections found on this project. Import a collection first.', 'warn');
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
          const port = u.port || (protocol === 'https' ? '443' : '80');
          const key = `${protocol}|${hostname}|${port}`;
          if (!seen.has(key)) {
            seen.add(key);
            urlSets.push({ protocol, url: hostname, port });
          }
        } catch { continue; }
      }
    }
    if (!urlSets.length) return toast('No valid URLs found in collection endpoints.', 'warn');
    setProjectCfg({ urls: urlSets });
    setOpen(o => ({ ...o, project: true }));
  }

  async function checkDocker() {
    setCheckingDocker(true);
    try {
      const { data } = await api.get('/execution/check-docker');
      setDockerStatus(data.status);
      setDockerVersion(data.version || '');
    } catch {
      setDockerStatus('missing');
    } finally {
      setCheckingDocker(false);
    }
  }

  async function startDocker() {
    setStartingDocker(true);
    setSysDockerMsg('Launching Docker Desktop…');
    setDockerLogs([{ type: 'info', message: 'Launching Docker Desktop, please wait...' }]);
    try {
      // Fire the start request — backend polls up to 30s internally
      await api.post('/execution/start-docker').catch(() => {});

      // Frontend-side: poll system-check every 5s for up to 90s until daemon is OK
      setSysDockerMsg('Waiting for Docker daemon to start…');
      const deadline = Date.now() + 90000;
      let ready = false;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 5000));
        try {
          const { data } = await api.get('/execution/system-check');
          const daemonCheck = (data.checks || []).find(c => c.id === 'docker_daemon');
          if (daemonCheck && daemonCheck.status === 'ok') {
            setSysChecks(data.checks);
            setSysOverall(data.overall || 'ok');
            setSysDockerMsg('');
            setDockerLogs(prev => [...prev, { type: 'ok', message: 'Docker is running.' }]);
            await checkDocker();
            ready = true;
            break;
          }
          // Update the checks so the user sees live state
          setSysChecks(data.checks || []);
          setSysOverall(data.overall || 'fail');
        } catch (_) {}
      }
      if (!ready) {
        setSysDockerMsg('Docker is taking longer than usual — click Run Check once Docker Desktop finishes loading.');
        setDockerLogs(prev => [...prev, { type: 'warn', message: 'Docker daemon not ready after 90s. Start Docker Desktop manually and click Run Check.' }]);
      }
    } catch (e) {
      setSysDockerMsg('');
      setDockerLogs(prev => [...prev, { type: 'err', message: 'Failed to start Docker: ' + (e.response?.data?.message || e.message) }]);
    } finally {
      setStartingDocker(false);
    }
  }

  async function enableVirtualization() {
    setEnablingVirt(true);
    setVirtMsg('Launching UAC prompt — accept it to enable the features…');
    try {
      const { data } = await api.post('/execution/enable-virtualization');
      if (data.ok) {
        setVirtMsg('Features are being enabled. ⚠️ A system restart is required once the window closes.');
      } else {
        setVirtMsg(data.message || 'Failed to launch. Please run the commands manually as Administrator.');
      }
    } catch (e) {
      setVirtMsg('Error: ' + (e.response?.data?.message || e.message));
    } finally {
      setEnablingVirt(false);
    }
  }

  async function installDocker() {
    setInstallingDocker(true);
    setDockerLogs([]);
    try {
      const token = localStorage.getItem('ps_token');
      const response = await fetch('/api/execution/install-deps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ tool: 'docker' }),
      });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop();
        for (const event of events) {
          const line = event.trim();
          if (!line.startsWith('data:')) continue;
          try {
            const data = JSON.parse(line.slice(5).trim());
            if (data.done) {
              if (data.error) {
                setDockerLogs(prev => [...prev, { type: 'err', message: 'Installation failed: ' + data.error }]);
              } else {
                setDockerLogs(prev => [...prev, { type: 'ok', message: 'Docker installation complete.' }]);
                await checkDocker();
              }
            } else {
              setDockerLogs(prev => [...prev, { type: data.type || 'info', message: data.message || '' }]);
            }
          } catch {}
        }
      }
    } catch (e) {
      setDockerLogs(prev => [...prev, { type: 'err', message: 'Installation error: ' + e.message }]);
    } finally {
      setInstallingDocker(false);
    }
  }

  async function saveDockerImages() {
    try {
      await api.put('/config', { config: { ...globalCfg, jmeter_docker_image: jmeterDockerImage, k6_docker_image: k6DockerImage } });
      setGlobalCfg(c => ({ ...c, jmeter_docker_image: jmeterDockerImage, k6_docker_image: k6DockerImage }));
      toast('Docker images saved.', 'ok');
    } catch { toast('Failed to save.', 'err'); }
  }

  async function pullImage(tool) {
    const image = tool === 'k6' ? k6DockerImage : jmeterDockerImage;
    setPullingImage(tool);
    setDockerLogs([]);
    try {
      const token = localStorage.getItem('ps_token');
      const response = await fetch('/api/execution/jmeter/pull-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ image }),
      });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop();
        for (const event of events) {
          const line = event.trim();
          if (!line.startsWith('data:')) continue;
          try {
            const data = JSON.parse(line.slice(5).trim());
            if (data.done) {
              if (data.error) setDockerLogs(prev => [...prev, { type: 'err', message: 'Pull failed: ' + data.error }]);
              else setDockerLogs(prev => [...prev, { type: 'ok', message: `${image} is ready.` }]);
            } else {
              setDockerLogs(prev => [...prev, { type: data.type || 'info', message: data.message || '' }]);
            }
          } catch {}
        }
      }
    } catch (e) {
      setDockerLogs(prev => [...prev, { type: 'err', message: 'Pull error: ' + e.message }]);
    } finally {
      setPullingImage(null);
    }
  }

  function stripDeprecated(cfg) {
    const { jmeter_path, k6_path, java_home, threads, rampup, duration, loops, ...clean } = cfg || {};
    return clean;
  }

  async function saveGlobal() {
    setSaving('global');
    try {
      await api.put('/config', { config: stripDeprecated(globalCfg) });
      setSaved('global'); setTimeout(() => setSaved(null), 3000);
    } finally { setSaving(null); }
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
    if (!project || !collection?.id || !env) return;
    setSaving('env');
    try {
      await api.put(`/projects/${project.id}/collections/${collection.id}/env-config/${encodeURIComponent(env)}`,
        { config: stripDeprecated(envCfg) });
      setSaved('env'); setTimeout(() => setSaved(null), 3000);
    } finally { setSaving(null); }
  }

  function getMergedUrls() {
    const base = (globalCfg.urls || []).length ? globalCfg.urls : [{ ...BLANK_URL }];
    const proj = (projectCfg.urls || []).filter(u => u.url);
    return proj.length ? proj : base;
  }

  return (
    <div className="page fade-in">
      <EnvBar envs={envs} activeEnv={env} onEnvChange={onEnvChange} hint="Select environment to configure server settings" />
      <div className="section-hdr" style={{ marginBottom: '4px' }}>
        <div className="section-title"><i className="ti ti-settings-2" style={{ marginRight: '8px', color: 'var(--accent)' }} />Configuration</div>
      </div>
      <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)', marginBottom: '20px' }}>
        Base URLs are auto-populated from your API source collections and stored as JMeter User Defined Variables.
      </div>

      {/* System Requirements removed — use Docker Engine section below */}
      {null && <CollapsibleSection title="" open={false} onToggle={() => {}}>
        <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)', marginBottom: '14px' }}>
          Verifies all dependencies, permissions, and configuration needed to run PerfStudio and execute tests.
        </div>

        <button
          className="btn-secondary btn-sm"
          onClick={runSystemCheck}
          disabled={sysRunning}
          style={{ marginBottom: '14px' }}
        >
          {sysRunning ? <><span className="spinner" />Running check…</> : <><i className="ti ti-refresh" />Run Check</>}
        </button>

        {sysChecks.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {/* Overall banner */}
            {sysOverall && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: '10px',
                padding: '10px 14px', borderRadius: '8px', marginBottom: '6px',
                background: sysOverall === 'ok' ? 'rgba(34,197,94,0.1)' : sysOverall === 'fail' ? 'rgba(247,84,100,0.1)' : 'rgba(240,167,50,0.1)',
                border: `1px solid ${sysOverall === 'ok' ? '#22c55e' : sysOverall === 'fail' ? 'var(--danger)' : 'var(--warn)'}`,
              }}>
                <i className={`ti ${sysOverall === 'ok' ? 'ti-circle-check' : sysOverall === 'fail' ? 'ti-circle-x' : 'ti-alert-triangle'}`}
                   style={{ fontSize: '18px', color: sysOverall === 'ok' ? '#22c55e' : sysOverall === 'fail' ? 'var(--danger)' : 'var(--warn)' }} />
                <div style={{ fontWeight: 600, fontSize: '13px', color: sysOverall === 'ok' ? '#22c55e' : sysOverall === 'fail' ? 'var(--danger)' : 'var(--warn)' }}>
                  {sysOverall === 'ok' ? 'All requirements met — ready to run tests.' :
                   sysOverall === 'fail' ? `${sysChecks.filter(c => c.status === 'fail').length} requirement(s) failed — fix before running tests.` :
                   `${sysChecks.filter(c => c.status === 'warn').length} warning(s) — tests may still run but review items below.`}
                </div>
              </div>
            )}

            {/* Check rows */}
            {sysChecks.map(c => {
              const icon = c.status === 'ok' ? 'ti-circle-check' : c.status === 'fail' ? 'ti-circle-x' : 'ti-alert-triangle';
              const color = c.status === 'ok' ? '#22c55e' : c.status === 'fail' ? 'var(--danger)' : 'var(--warn)';
              const isDaemonNotRunning = c.id === 'docker_daemon' && c.status === 'fail' && c.detail && c.detail.includes('daemon not running');
              const isVirtFail = c.id === 'virtualization' && c.status === 'fail';
              return (
                <div key={c.id} style={{
                  display: 'flex', alignItems: 'flex-start', gap: '10px',
                  padding: '9px 12px',
                  background: c.status === 'ok' ? 'rgba(34,197,94,0.06)' : 'var(--color-background-primary)',
                  border: `1px solid ${c.status === 'ok' ? 'rgba(34,197,94,0.25)' : 'var(--color-border-secondary)'}`,
                  borderRadius: '7px',
                }}>
                  <i className={`ti ${icon}`} style={{ fontSize: '16px', color, marginTop: '1px', flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: '12px', color: 'var(--color-text-primary)' }}>{c.name}</div>
                    <div style={{ fontSize: '11px', color: 'var(--color-text-tertiary)', marginTop: '2px', wordBreak: 'break-word', fontFamily: c.status !== 'ok' ? 'var(--font-mono)' : undefined }}>
                      {c.detail}
                    </div>
                    {isDaemonNotRunning && (
                      <div style={{ marginTop: '7px', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                        <button
                          className="btn-primary btn-sm"
                          onClick={startDocker}
                          disabled={startingDocker || checkingDocker}
                        >
                          {startingDocker
                            ? <><span className="spinner" />Starting…</>
                            : <><i className="ti ti-player-play" />Start Docker</>}
                        </button>
                        {sysDockerMsg && (
                          <span style={{ fontSize: '11px', color: 'var(--color-text-tertiary)', fontStyle: 'italic' }}>
                            {sysDockerMsg}
                          </span>
                        )}
                      </div>
                    )}
                    {isVirtFail && (
                      <div style={{ marginTop: '8px' }}>
                        <div style={{
                          fontSize: '11px', color: 'var(--color-text-tertiary)',
                          marginBottom: '7px', lineHeight: '1.5',
                          padding: '7px 10px',
                          background: 'rgba(240,167,50,0.08)',
                          border: '1px solid rgba(240,167,50,0.25)',
                          borderRadius: '6px',
                        }}>
                          <i className="ti ti-info-circle" style={{ marginRight: '5px', color: 'var(--warn)' }} />
                          This will open an elevated PowerShell window (UAC prompt). Accept it to enable the features.
                          A <strong>system restart</strong> is required after completion.
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                          <button
                            className="btn-primary btn-sm"
                            onClick={enableVirtualization}
                            disabled={enablingVirt}
                          >
                            {enablingVirt
                              ? <><span className="spinner" />Launching…</>
                              : <><i className="ti ti-cpu" />Enable Hyper-V &amp; WSL2</>}
                          </button>
                          {virtMsg && (
                            <span style={{ fontSize: '11px', color: virtMsg.includes('restart') ? 'var(--warn)' : 'var(--color-text-tertiary)', fontStyle: 'italic', maxWidth: '380px' }}>
                              {virtMsg}
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                  <span style={{
                    flexShrink: 0, fontSize: '10px', fontWeight: 700, letterSpacing: '.4px',
                    padding: '2px 8px', borderRadius: '20px', textTransform: 'uppercase',
                    background: c.status === 'ok' ? 'rgba(34,197,94,0.15)' : c.status === 'fail' ? 'rgba(247,84,100,0.15)' : 'rgba(240,167,50,0.15)',
                    color,
                    border: `1px solid ${color}`,
                  }}>
                    {c.status === 'ok' ? 'OK' : c.status === 'fail' ? 'FAIL' : 'WARN'}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </CollapsibleSection>}

      {/* Docker Engine */}
      <CollapsibleSection
        title="Docker Engine"
        icon="ti-brand-docker"
        iconColor="#2496ed"
        open={open.docker}
        onToggle={() => setOpen(o => ({ ...o, docker: !o.docker }))}
        badge={dockerStatus === 'ok' ? 'Running' : dockerStatus === 'installed' ? 'Installed' : dockerStatus === 'missing' ? 'Missing' : undefined}
      >
        <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)', marginBottom: '14px' }}>
          Docker is required to run containerized test environments. Check its status or install it automatically for your platform.
        </div>

        {/* Status display */}
        {dockerStatus && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 14px', borderRadius: '8px', marginBottom: '14px',
            background: dockerStatus === 'ok' ? 'rgba(34,197,94,0.08)' : dockerStatus === 'installed' ? 'rgba(255,165,0,0.1)' : 'rgba(255,77,77,0.1)',
            border: `1px solid ${dockerStatus === 'ok' ? '#22c55e' : dockerStatus === 'installed' ? 'var(--warn)' : 'var(--danger)'}`
          }}>
            <i className={`ti ${dockerStatus === 'ok' ? 'ti-circle-check' : dockerStatus === 'installed' ? 'ti-circle-dot' : 'ti-circle-x'}`}
              style={{ fontSize: '18px', color: dockerStatus === 'ok' ? '#22c55e' : dockerStatus === 'installed' ? 'var(--warn)' : 'var(--danger)' }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: '13px', color: dockerStatus === 'ok' ? '#22c55e' : dockerStatus === 'installed' ? 'var(--warn)' : 'var(--danger)' }}>
                {dockerStatus === 'ok' ? 'Docker is running' : dockerStatus === 'installed' ? 'Docker is installed but not running' : 'Docker is not installed'}
              </div>
              {dockerVersion && <div style={{ fontSize: '11px', color: 'var(--color-text-tertiary)', marginTop: '2px', fontFamily: 'var(--font-mono)' }}>{dockerVersion}</div>}
            </div>
            {dockerStatus === 'installed' && (
              <button className="btn-primary btn-sm" onClick={startDocker} disabled={startingDocker || checkingDocker}>
                {startingDocker ? <><span className="spinner" />Starting...</> : <><i className="ti ti-player-play" />Start Docker</>}
              </button>
            )}
          </div>
        )}

        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginBottom: dockerLogs.length ? '14px' : 0 }}>
          <button className="btn-secondary btn-sm" onClick={checkDocker} disabled={checkingDocker || installingDocker || startingDocker}>
            {checkingDocker ? <><span className="spinner" />Checking...</> : <><i className="ti ti-refresh" />Check Docker</>}
          </button>
          {dockerStatus === 'missing' && (
            <button className="btn-primary btn-sm" onClick={installDocker} disabled={installingDocker || checkingDocker}>
              {installingDocker ? <><span className="spinner" />Installing...</> : <><i className="ti ti-download" />Install Docker</>}
            </button>
          )}
          {dockerStatus === null && (
            <span style={{ fontSize: '12px', color: 'var(--color-text-tertiary)' }}>Click "Check Docker" to verify installation.</span>
          )}
        </div>

        {dockerLogs.length > 0 && (
          <div style={{ background: 'var(--color-background-primary)', border: '1px solid var(--color-border-secondary)', borderRadius: '6px', padding: '10px 12px', maxHeight: '200px', overflowY: 'auto', fontFamily: 'var(--font-mono)', fontSize: '12px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
            {dockerLogs.map((l, i) => (
              <div key={i} className={`run-line run-${l.type}`}>{l.message}</div>
            ))}
          </div>
        )}

        {dockerStatus === 'ok' && (
          <div style={{ marginTop: '10px', fontSize: '11px', color: '#22c55e' }}>
            <i className="ti ti-circle-check" style={{ marginRight: '4px', color: '#22c55e' }} />
            Docker is ready. You can now run tests.
          </div>
        )}
        {dockerStatus === 'installed' && !startingDocker && (
          <div style={{ marginTop: '10px', fontSize: '11px', color: 'var(--color-text-tertiary)' }}>
            <i className="ti ti-info-circle" style={{ marginRight: '4px' }} />
            Docker Desktop is installed but the daemon is not running. Click <strong>Start Docker</strong> to launch it automatically.
          </div>
        )}
        {dockerStatus === 'missing' && !installingDocker && (
          <div style={{ marginTop: '10px', fontSize: '11px', color: 'var(--color-text-tertiary)' }}>
            <i className="ti ti-info-circle" style={{ marginRight: '4px' }} />
            Docker Desktop is not installed. Click <strong>Install Docker</strong> to download and install it.
          </div>
        )}

        {/* Docker Test Tool Images */}
        <div style={{ marginTop: '20px', paddingTop: '16px', borderTop: '1px solid var(--color-border-secondary)' }}>
          <div style={{ fontWeight: 600, fontSize: '13px', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <i className="ti ti-test-pipe" style={{ color: '#22c55e', fontSize: '14px' }} />
            Test Tool Images
          </div>
          <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)', marginBottom: '14px' }}>
            Docker images used to run JMeter and K6 tests. Pull them once to cache locally; they'll be used for all test executions.
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
            {/* JMeter image */}
            <div>
              <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '5px' }}>
                <i className="ti ti-test-pipe" style={{ fontSize: '12px' }} /> Apache JMeter
              </div>
              <div style={{ display: 'flex', gap: '6px' }}>
                <input
                  type="text"
                  value={jmeterDockerImage}
                  onChange={e => setJmeterDockerImage(e.target.value)}
                  placeholder="justb4/jmeter:latest"
                  style={{ flex: 1, minWidth: 0 }}
                />
                <button
                  className="btn-primary btn-sm"
                  onClick={() => pullImage('jmeter')}
                  disabled={!!pullingImage || !jmeterDockerImage.trim()}
                  style={{ whiteSpace: 'nowrap' }}
                  title="docker pull"
                >
                  {pullingImage === 'jmeter' ? <><span className="spinner" />Pulling...</> : <><i className="ti ti-download" />Pull</>}
                </button>
              </div>
            </div>

            {/* K6 image */}
            <div>
              <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '5px' }}>
                <i className="ti ti-brand-grafana" style={{ fontSize: '12px' }} /> Grafana K6
              </div>
              <div style={{ display: 'flex', gap: '6px' }}>
                <input
                  type="text"
                  value={k6DockerImage}
                  onChange={e => setK6DockerImage(e.target.value)}
                  placeholder="grafana/k6:latest"
                  style={{ flex: 1, minWidth: 0 }}
                />
                <button
                  className="btn-primary btn-sm"
                  onClick={() => pullImage('k6')}
                  disabled={!!pullingImage || !k6DockerImage.trim()}
                  style={{ whiteSpace: 'nowrap' }}
                  title="docker pull"
                >
                  {pullingImage === 'k6' ? <><span className="spinner" />Pulling...</> : <><i className="ti ti-download" />Pull</>}
                </button>
              </div>
            </div>
          </div>

          <button className="btn-secondary btn-sm" onClick={saveDockerImages}>
            <i className="ti ti-device-floppy" /> Save Images
          </button>
          <div style={{ marginTop: '8px', fontSize: '11px', color: 'var(--color-text-tertiary)' }}>
            <i className="ti ti-info-circle" style={{ marginRight: '4px' }} />
            Pull downloads images from Docker Hub to your local cache. Only needed once per version tag.
          </div>
        </div>
      </CollapsibleSection>


      {/* Global Defaults + Project Override — only shown when NOT in a specific env context */}
      {(!collection || !env) && <>

      {/* Global Defaults */}
      <CollapsibleSection
        title="Global Defaults"
        icon="ti-world"
        iconColor="var(--accent)"
        open={open.global}
        onToggle={() => setOpen(o => ({ ...o, global: !o.global }))}
        badge={`${(globalCfg.urls || []).filter(u => u.url).length || 0} URL(s)`}
      >
        <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)', marginBottom: '14px' }}>
          Default base URLs applied to all projects and test suites.
        </div>
        {saved === 'global' && <div style={{ marginBottom: '12px', padding: '8px 12px', background: 'rgba(34,197,94,0.12)', borderRadius: '6px', fontSize: '12px', color: '#22c55e' }}>Global defaults saved.</div>}
        <UrlsEditor cfg={globalCfg} setCfg={setGlobalCfg} />
        <div style={{ marginTop: '16px' }}>
          <button className="btn-primary" onClick={saveGlobal} disabled={saving === 'global'}>
            {saving === 'global' && <span className="spinner" />}Save Global Defaults
          </button>
        </div>
      </CollapsibleSection>

      {/* Project Override */}
      <CollapsibleSection
        title={`Project Override${project ? ` — ${project.name}` : ''}`}
        icon="ti-folder"
        iconColor="var(--warn)"
        open={open.project}
        onToggle={() => setOpen(o => ({ ...o, project: !o.project }))}
        badge={project ? `${(projectCfg.urls || []).filter(u => u.url).length || 0} URL(s)` : 'No project selected'}
      >
        <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)', marginBottom: '14px' }}>
          {project
            ? <>Overrides for <strong>{project.name}</strong>. Blank URLs fall back to global defaults. Config is written to <code>projects/{project.name}/config/</code></>
            : 'Select a project to configure overrides.'}
        </div>
        {saved === 'project' && <div style={{ marginBottom: '12px', padding: '8px 12px', background: 'rgba(34,197,94,0.12)', borderRadius: '6px', fontSize: '12px', color: '#22c55e' }}>Project config saved.</div>}
        <UrlsEditor cfg={projectCfg} setCfg={setProjectCfg} />
        <div style={{ marginTop: '16px', display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn-primary" onClick={saveProject} disabled={!project || saving === 'project'}>
            {saving === 'project' && <span className="spinner" />}Save Project Config
          </button>
          {project && (
            <div style={{ fontSize: '11px', color: 'var(--color-text-tertiary)' }}>
              <i className="ti ti-file-text" style={{ marginRight: '4px' }} />
              Also writes to <code>projects/{project.name}/config/config.properties</code>
            </div>
          )}
        </div>
      </CollapsibleSection>

      </> /* end of (!collection || !env) block */}

      {/* ── Env Readiness Dashboard — shown when in collection+env context ── */}
      {collection && env && envReadiness && (
        <CollapsibleSection
          title={`${env} Environment Readiness`}
          icon="ti-checklist"
          iconColor={envReadiness.isReady ? '#22c55e' : 'var(--warn)'}
          open={open.envReady}
          onToggle={() => setOpen(o => ({ ...o, envReady: !o.envReady }))}
          badge={envReadiness.isReady ? 'Ready' : 'Setup Needed'}
        >
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px', marginBottom: '14px' }}>
            {[
              { label: 'Target URLs',      val: envReadiness.configuredUrls,   icon: 'ti-world',      ok: envReadiness.configuredUrls > 0,    hint: 'Set in Environment Config below' },
              { label: 'Test Data Files',  val: envReadiness.testDataFiles,    icon: 'ti-table',      ok: envReadiness.testDataFiles >= 0,    hint: 'Upload via Test Data' },
              { label: 'Test Plans',       val: envReadiness.testPlans,        icon: 'ti-test-pipe',  ok: envReadiness.testPlans > 0,         hint: 'Create via Test Plans' },
              { label: 'Generated Scripts',val: envReadiness.generatedScripts, icon: 'ti-code',       ok: envReadiness.generatedScripts > 0,  hint: 'Generate from Test Plans' },
            ].map(({ label, val, icon, ok, hint }) => (
              <div key={label} style={{
                padding: '12px 14px',
                background: ok ? 'rgba(34,197,94,0.07)' : 'rgba(245,158,11,0.07)',
                border: `1px solid ${ok ? 'rgba(34,197,94,0.25)' : 'rgba(245,158,11,0.25)'}`,
                borderRadius: '8px',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '6px' }}>
                  <i className={`ti ${icon}`} style={{ fontSize: '14px', color: ok ? '#22c55e' : 'var(--warn)' }} />
                  <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '.4px' }}>{label}</span>
                </div>
                <div style={{ fontSize: '22px', fontWeight: 700, color: ok ? '#22c55e' : 'var(--warn)', fontFamily: 'var(--font-mono)' }}>{val}</div>
                {!ok && <div style={{ fontSize: '10px', color: 'var(--color-text-tertiary)', marginTop: '3px' }}>{hint}</div>}
              </div>
            ))}
          </div>
          {envReadiness.isReady
            ? <div style={{ fontSize: '13px', color: '#22c55e', display: 'flex', alignItems: 'center', gap: '7px' }}>
                <i className="ti ti-circle-check" /> This environment is fully configured and ready to run tests.
              </div>
            : <div style={{ fontSize: '13px', color: 'var(--warn)', display: 'flex', alignItems: 'center', gap: '7px' }}>
                <i className="ti ti-alert-triangle" /> Complete the setup steps above before running tests in this environment.
              </div>
          }
        </CollapsibleSection>
      )}

      {/* Environment-Specific Config — shown only when inside a collection+env context */}
      {collection && env && (
        <CollapsibleSection
          title={`Environment Config — ${collection.name} / ${env}`}
          icon="ti-server"
          iconColor="var(--accent)"
          open={open.envConfig !== false}
          onToggle={() => setOpen(o => ({ ...o, envConfig: !o.envConfig }))}
          badge={`${(envCfg.urls || []).filter(u => u.url).length || 0} URL(s)`}
        >
          <div style={{ padding: '10px 14px', background: 'rgba(73,204,61,0.07)', border: '1px solid rgba(73,204,61,0.2)', borderRadius: '8px', marginBottom: '14px', fontSize: '12px', color: 'var(--color-text-secondary)' }}>
            <i className="ti ti-shield-check" style={{ color: 'var(--accent)', marginRight: '6px' }} />
            <strong>Enter the target server URL for {env}.</strong> Each environment must have its own server URL
            (e.g. QA → <code>qa-api.company.com</code>, Staging → <code>staging-api.company.com</code>).
            <strong style={{ color: 'var(--danger)', marginLeft: '4px' }}>This is not shared with any other environment.</strong>
            <div style={{ marginTop: '6px', fontSize: '11px', color: 'var(--color-text-tertiary)' }}>
              Priority: <strong style={{ color: 'var(--accent)' }}>{env} URL</strong> (used in JMX) → Project → Global (fallback)
            </div>
          </div>
          {saved === 'env' && <div style={{ marginBottom: '12px', padding: '8px 12px', background: 'rgba(34,197,94,0.12)', borderRadius: '6px', fontSize: '12px', color: '#22c55e' }}>Environment config saved.</div>}
          <UrlsEditor cfg={envCfg} setCfg={setEnvCfg} />
          <div style={{ marginTop: '16px', display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="btn-primary" onClick={saveEnv} disabled={saving === 'env'}>
              {saving === 'env' && <span className="spinner" />}Save {env} Config
            </button>
            <div style={{ fontSize: '11px', color: 'var(--color-text-tertiary)' }}>
              <i className="ti ti-info-circle" style={{ marginRight: '4px' }} />
              Stored separately per environment — QA and Staging have independent configs
            </div>
          </div>
        </CollapsibleSection>
      )}

      {/* Effective Configuration */}
      {(!collection || !env) && <CollapsibleSection
        title="Effective Configuration (Global + Project Merged)"
        icon="ti-eye"
        iconColor="#22c55e"
        open={open.effective}
        onToggle={() => setOpen(o => ({ ...o, effective: !o.effective }))}
      >
        <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)', marginBottom: '14px' }}>
          The actual values that will be used in JMeter User Defined Variables.
        </div>
        <div style={{ display: 'grid', gap: '8px' }}>
          {getMergedUrls().map((entry, idx) => (
            <div key={idx} style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '8px' }}>
              {[
                { key: `PROTOCOL${getMergedUrls().length > 1 ? `_${idx + 1}` : ''}`, val: entry.protocol },
                { key: `URL${getMergedUrls().length > 1 ? `_${idx + 1}` : ''}`, val: entry.url || '(not set)' },
                { key: `PORT${getMergedUrls().length > 1 ? `_${idx + 1}` : ''}`, val: entry.port },
              ].map(({ key, val }) => (
                <div key={key} style={{ padding: '10px 12px', background: 'var(--color-background-secondary)', borderRadius: '8px' }}>
                  <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--color-text-tertiary)', marginBottom: '4px', fontFamily: 'var(--font-mono)' }}>{key}</div>
                  <div style={{ fontWeight: 600, fontSize: '13px', color: 'var(--color-text-primary)', wordBreak: 'break-all' }}>{val}</div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </CollapsibleSection>}
    </div>
  );
}
