import { useState, useEffect, useRef } from 'react';
import api from '../api';
import { useToast } from '../hooks/useToast';
import CustomSelect from '../components/CustomSelect';

export default function Runner({ projects, activeProject, activeCollection, activeEnv, onNav }) {
  const { toast } = useToast();
  const [suites, setSuites] = useState([]);           // all generated suites for project
  const [selectedCollectionId, setSelectedCollectionId] = useState('');
  const [selectedEnv, setSelectedEnv] = useState('');
  const [selectedSuiteId, setSelectedSuiteId] = useState('');
  const [engine, setEngine] = useState('jmeter');
  const [deps, setDeps] = useState([]);
  const [depsChecked, setDepsChecked] = useState(false);
  const [checkingDeps, setCheckingDeps] = useState(false);
  const [installingDep, setInstallingDep] = useState(null);
  const [runParams, setRunParams] = useState({ vusers: 50, rampup: 30, iter_mode: 'duration', loops: 1, duration: 300 });
  const [running, setRunning] = useState(false);
  const [autoHeal, setAutoHeal] = useState(true);
  const [healState, setHealState] = useState(null);
  const healPollRef = useRef(null);
  const [logs, setLogs] = useState([
    { type: 'info', message: 'Performance Studio Execution Engine ready.' },
    { type: 'info', message: 'Select a project and test suite, then check Docker before running.' },
  ]);
  const [runs, setRuns] = useState([]);
  const consoleRef = useRef(null);

  const selectedProject = activeProject;
  const selectedProjectId = activeProject?.id || '';

  // Load all generated suites when active project changes
  useEffect(() => {
    if (!activeProject?.id) { setSuites([]); setSelectedCollectionId(''); setSelectedEnv(''); setSelectedSuiteId(''); return; }
    api.get(`/projects/${activeProject.id}/test-suites`)
      .then(({ data }) => {
        const generated = (data.suites || []).filter(s => s.jmx_path || s.js_path);
        setSuites(generated);
        // Auto-select collection + env if navigated from sidebar context
        if (activeCollection?.id) {
          setSelectedCollectionId(String(activeCollection.id));
          setSelectedEnv(activeEnv || '');
        } else {
          setSelectedCollectionId('');
          setSelectedEnv('');
        }
        setSelectedSuiteId('');
      })
      .catch(() => { setSuites([]); });
  }, [activeProject?.id]);

  // Sync when user navigates to runner from sidebar — always override with sidebar context
  useEffect(() => {
    if (activeCollection?.id) {
      setSelectedCollectionId(String(activeCollection.id));
      setSelectedEnv(activeEnv || '');
      setSelectedSuiteId('');  // always reset suite when env changes
      setDepsChecked(false);
      setDeps([]);
    }
  }, [activeCollection?.id, activeEnv]);  // activeEnv changing triggers reset

  // Fetch collections directly — don't rely on parent prop which may not be loaded yet
  const [collections, setCollections] = useState(activeProject?.collections || []);
  useEffect(() => {
    if (!activeProject?.id) return;
    // Use prop if already populated, otherwise fetch fresh
    if (activeProject.collections?.length) {
      setCollections(activeProject.collections);
    } else {
      api.get(`/projects/${activeProject.id}/collections`)
        .then(({ data }) => setCollections(data.collections || []))
        .catch(() => {});
    }
  }, [activeProject?.id]);

  const collectionsWithSuites = collections.filter(c =>
    suites.some(s => String(s.collection_id) === String(c.id))
  );

  // Derived: environments for selected collection
  const envsForCollection = (() => {
    if (!selectedCollectionId) return [];
    const col = collections.find(c => String(c.id) === String(selectedCollectionId));
    if (!col) return [];
    let envs = [];
    try { envs = JSON.parse(col.environments || '[]'); } catch {}
    if (!envs.length && col.environment) envs = [col.environment];
    // Only show envs that have generated suites with matching env
    return envs.filter(env =>
      suites.some(s =>
        String(s.collection_id) === String(selectedCollectionId) &&
        (s.env === env || (!s.env && env === envs[0])) // match env or untagged suites to first env
      )
    );
  })();

  // Derived: suites for selected collection AND selected environment
  // Shows suites matching the selected env OR suites with no env tag (untagged = available for all envs)
  const suitesForSelection = suites.filter(s => {
    if (String(s.collection_id) !== String(selectedCollectionId)) return false;
    if (!selectedEnv) return true;                           // no env filter — show all
    return !s.env || s.env === selectedEnv;                  // match env OR untagged
  });

  // Reset env + suite when collection changes
  useEffect(() => {
    setSelectedEnv(envsForCollection.length === 1 ? envsForCollection[0] : '');
    setSelectedSuiteId('');
  }, [selectedCollectionId]);

  // Reset suite when env changes
  useEffect(() => {
    setSelectedSuiteId('');
  }, [selectedEnv]);

  // Load past runs when active project changes
  useEffect(() => {
    if (!activeProject?.id) { setRuns([]); return; }
    api.get(`/execution/runs?project_id=${activeProject.id}`)
      .then(({ data }) => setRuns(data.runs || []))
      .catch(() => {});
  }, [activeProject?.id]);

  // Auto-detect engine + populate editable run params from selected suite
  useEffect(() => {
    if (!selectedSuiteId || !suites.length) return;
    const suite = suites.find(s => String(s.id) === String(selectedSuiteId));
    if (suite) {
      setEngine(suite.engine || 'jmeter');
      setRunParams({
        vusers:    suite.vusers    ?? 50,
        rampup:    suite.rampup    ?? 30,
        iter_mode: suite.iter_mode || 'duration',
        loops:     suite.loops     ?? 1,
        duration:  suite.duration  ?? 300,
      });
    }
  }, [selectedSuiteId]);

  // Auto-scroll console
  useEffect(() => {
    if (consoleRef.current) consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
  }, [logs]);


  async function checkDeps() {
    setCheckingDeps(true);
    setDepsChecked(false);
    try {
      const { data } = await api.get('/execution/check-deps');
      setDeps(data.deps || []);
      setDepsChecked(true);
      const allOk = (data.deps || []).every(d => d.status === 'ok');
      addLog(allOk ? 'ok' : 'warn', allOk ? 'Docker is running — ready to execute.' : 'Docker is not running. Start Docker Desktop and re-check.');
    } catch (e) {
      addLog('err', 'Dependency check failed: ' + (e.response?.data?.error || e.message));
    } finally { setCheckingDeps(false); }
  }

  async function installDep(tool) {
    setInstallingDep(tool);
    addLog('info', `━━━ Starting ${tool.toUpperCase()} installation ━━━`);
    try {
      const token = localStorage.getItem('ps_token');
      const response = await fetch('/api/execution/install-deps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ tool }),
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
              if (data.error) addLog('err', 'Installation failed: ' + data.error);
              else {
                if (data.path) {
                  if (tool === 'jmeter') setJmeterPath(data.path);
                  else setK6Path(data.path);
                }
                await checkDeps();
              }
            } else {
              addLog(data.type || 'info', data.message || '');
            }
          } catch {}
        }
      }
    } catch (e) {
      addLog('err', 'Installation error: ' + e.message);
    } finally {
      setInstallingDep(null);
    }
  }

  function addLog(type, message) {
    setLogs(prev => [...prev, { type, message }]);
  }

  function startHealPolling(runId) {
    setHealState({ status: 'pending', heal_run_id: null, logs: [] });
    if (healPollRef.current) clearInterval(healPollRef.current);
    healPollRef.current = setInterval(async () => {
      try {
        const { data } = await api.get(`/execution/runs/${runId}/heal-status`);
        setHealState(data);
        const done = ['healed', 'failed', 'exhausted', 'no_errors', 'infra_error'].includes(data.status);
        if (done) {
          clearInterval(healPollRef.current);
          healPollRef.current = null;
          api.get(`/execution/runs?project_id=${selectedProjectId}`)
            .then(({ data: d }) => setRuns(d.runs || []))
            .catch(() => {});
        }
      } catch {}
    }, 2000);
  }

  async function runTest() {
    if (!selectedSuiteId) return toast('Select a test suite first', 'warn');
    if (!selectedProjectId) return toast('Select a project first', 'warn');
    setRunning(true);
    setHealState(null);
    if (healPollRef.current) { clearInterval(healPollRef.current); healPollRef.current = null; }
    setLogs([]);
    try {
      const token = localStorage.getItem('ps_token');
      const payload = {
        project_id: selectedProjectId,
        suite_id: selectedSuiteId,
        engine,
        vusers:         Number(runParams.vusers)   || 50,
        rampup:         Number(runParams.rampup)    || 30,
        iteration_mode: runParams.iter_mode         || 'duration',
        loops:          Number(runParams.loops)     || 1,
        duration:       Number(runParams.duration)  || 300,
        auto_heal:      autoHeal,
      };

      const response = await fetch('/api/execution/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(payload),
      });

      const reader  = response.body.getReader();
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
            const msg = JSON.parse(line.slice(5).trim());
            if (msg.done) {
              api.get(`/execution/runs?project_id=${selectedProjectId}`)
                .then(({ data: d }) => setRuns(d.runs || []))
                .catch(() => {});
              if (msg.auto_heal && msg.run_id) {
                startHealPolling(msg.run_id);
              }
            } else {
              setLogs(prev => [...prev, { type: msg.type || 'info', message: msg.message || '' }]);
            }
          } catch {}
        }
      }
    } catch (e) {
      addLog('err', 'Connection error: ' + e.message);
    } finally {
      setRunning(false);
    }
  }

  const allDepsOk = deps.length > 0 && deps.every(d => d.status === 'ok');
  const missingDeps = deps.filter(d => d.status !== 'ok');

  // Active runs across all projects (for concurrency awareness)
  const activeRuns = runs.filter(r => r.status === 'running');

  return (
    <div className="page fade-in">

      {/* Concurrent runs banner */}
      {activeRuns.length > 0 && !running && (
        <div style={{
          marginBottom: '14px', padding: '10px 14px',
          background: 'rgba(245,158,11,0.10)', border: '1px solid rgba(245,158,11,0.35)',
          borderRadius: '8px', display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px',
        }}>
          <i className="ti ti-loader-2" style={{ color: 'var(--warn)', fontSize: '16px', animation: 'spin 1s linear infinite' }} />
          <div>
            <strong style={{ color: 'var(--warn)' }}>{activeRuns.length} run{activeRuns.length > 1 ? 's' : ''} already in progress</strong>
            <span style={{ color: 'var(--color-text-secondary)', marginLeft: '8px' }}>
              You can start another run simultaneously (max 5 concurrent).
            </span>
          </div>
        </div>
      )}

      {/* Project context + Suite selector */}
      <div className="card" style={{ marginBottom: '14px' }}>
        <div style={{ fontWeight: 600, fontSize: '14px', marginBottom: '14px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <i className="ti ti-target" style={{ color: 'var(--accent)' }} /> Select Test Plan
        </div>
        {!activeProject ? (
          <div style={{ fontSize: '12px', color: 'var(--color-text-tertiary)' }}>
            <i className="ti ti-info-circle" style={{ marginRight: '6px', color: 'var(--warn)' }} />
            No project selected. Choose a project from the sidebar first.
          </div>
        ) : (
          <>
            {/* Project badge */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '14px', padding: '8px 12px', background: 'var(--color-background-secondary)', borderRadius: '8px', border: '1px solid var(--color-border-secondary)' }}>
              <span className="color-dot" style={{ background: activeProject.color, width: '10px', height: '10px' }} />
              <span style={{ fontWeight: 600, fontSize: '13px', color: 'var(--color-text-primary)' }}>{activeProject.name}</span>
            </div>

            {/* 3-level selector: Collection → Environment → Test Plan */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>

              {/* Step 1: API Source (Collection) */}
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">
                  <i className="ti ti-braces" style={{ fontSize: '11px' }} /> API Source
                </label>
                <CustomSelect
                  value={selectedCollectionId}
                  onChange={e => { setSelectedCollectionId(e.target.value); setDepsChecked(false); setDeps([]); }}
                  disabled={collectionsWithSuites.length === 0}
                >
                  <option value="">— Select API Source —</option>
                  {collectionsWithSuites.map(c => (
                    <option key={c.id} value={c.id}>{c.name}_{c.id}</option>
                  ))}
                </CustomSelect>
              </div>

              {/* Step 2: Environment */}
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">
                  <i className="ti ti-server" style={{ fontSize: '11px' }} /> Environment
                </label>
                <CustomSelect
                  value={selectedEnv}
                  onChange={e => { setSelectedEnv(e.target.value); setDepsChecked(false); setDeps([]); }}
                  disabled={!selectedCollectionId || envsForCollection.length === 0}
                >
                  <option value="">— Select Environment —</option>
                  {envsForCollection.map(env => (
                    <option key={env} value={env}>{env}</option>
                  ))}
                </CustomSelect>
              </div>

              {/* Step 3: Test Plan */}
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">
                  <i className="ti ti-test-pipe" style={{ fontSize: '11px' }} /> Test Plan
                </label>
                <CustomSelect
                  value={selectedSuiteId}
                  onChange={e => { setSelectedSuiteId(e.target.value); setDepsChecked(false); setDeps([]); }}
                  disabled={!selectedCollectionId || suitesForSelection.length === 0}
                >
                  <option value="">— Select Test Plan —</option>
                  {suitesForSelection.map(s => (
                    <option key={s.id} value={s.id}>
                      {s.name} · {s.test_type || 'load'} · {s.engine === 'jmeter' ? 'JMeter' : 'K6'}
                    </option>
                  ))}
                </CustomSelect>
              </div>
            </div>

            {collectionsWithSuites.length === 0 && (
              <div style={{ marginTop: '12px', fontSize: '12px', color: 'var(--warn)' }}>
                <i className="ti ti-alert-triangle" style={{ marginRight: '6px' }} />
                No generated scripts found. Go to a collection → Test Plans and generate a script first.
              </div>
            )}
          </>
        )}
      </div>

      {/* Load Parameters — editable runtime overrides */}
      <div className="card" style={{ marginBottom: '14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
          <div style={{ fontWeight: 600, fontSize: '14px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <i className="ti ti-settings" style={{ color: 'var(--accent)' }} /> Load Parameters
            <span style={{ fontSize: '11px', fontWeight: 400, color: 'var(--color-text-tertiary)' }}>— override for this run</span>
          </div>
          {selectedSuiteId && (
            <button className="btn-secondary btn-sm" onClick={() => onNav('test-suites')}>
              <i className="ti ti-edit" /> Edit Defaults
            </button>
          )}
        </div>
        {selectedSuiteId ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '12px' }}>
            {/* Engine — read-only */}
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label"><i className="ti ti-tool" style={{ fontSize: '11px' }} /> Engine</label>
              <div style={{ background: 'var(--color-background-secondary)', borderRadius: '6px', padding: '8px 10px', fontSize: '13px', fontWeight: 600, border: '1px solid var(--color-border-tertiary)', color: 'var(--color-text-secondary)' }}>
                {engine === 'jmeter' ? 'Apache JMeter' : 'Grafana K6'}
              </div>
            </div>

            {/* Virtual Users */}
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label"><i className="ti ti-users" style={{ fontSize: '11px' }} /> Virtual Users</label>
              <input
                type="number" min="1" max="10000"
                value={runParams.vusers}
                onChange={e => setRunParams(p => ({ ...p, vusers: e.target.value }))}
              />
            </div>

            {/* Ramp-up */}
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label"><i className="ti ti-trending-up" style={{ fontSize: '11px' }} /> Ramp-up (s)</label>
              <input
                type="number" min="0"
                value={runParams.rampup}
                onChange={e => setRunParams(p => ({ ...p, rampup: e.target.value }))}
              />
            </div>

            {/* Iteration mode + value */}
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label"><i className="ti ti-repeat" style={{ fontSize: '11px' }} /> Iteration</label>
              <div style={{ display: 'flex', gap: '6px' }}>
                <CustomSelect
                  value={runParams.iter_mode}
                  onChange={e => setRunParams(p => ({ ...p, iter_mode: e.target.value }))}
                  style={{ flex: '0 0 auto', width: 'auto' }}
                >
                  <option value="duration">Duration</option>
                  <option value="loops">Loops</option>
                </CustomSelect>
                {runParams.iter_mode === 'duration' ? (
                  <input
                    type="number" min="1" placeholder="sec"
                    value={runParams.duration}
                    onChange={e => setRunParams(p => ({ ...p, duration: e.target.value }))}
                    style={{ flex: 1, minWidth: 0 }}
                  />
                ) : (
                  <input
                    type="number" min="1" placeholder="loops"
                    value={runParams.loops}
                    onChange={e => setRunParams(p => ({ ...p, loops: e.target.value }))}
                    style={{ flex: 1, minWidth: 0 }}
                  />
                )}
              </div>
            </div>
          </div>
        ) : (
          <div style={{ fontSize: '12px', color: 'var(--color-text-tertiary)' }}>Select a test suite to configure load parameters.</div>
        )}
      </div>


      {/* Step 9 (14): Dependency Check */}
      <div className="card" style={{ marginBottom: '14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: depsChecked ? '14px' : 0 }}>
          <div style={{ fontWeight: 600, fontSize: '14px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <i className="ti ti-package" style={{ color: 'var(--accent)' }} /> Dependencies
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="btn-secondary btn-sm" onClick={checkDeps} disabled={checkingDeps}>
              {checkingDeps ? <><span className="spinner" />Checking...</> : <><i className="ti ti-brand-docker" />Check Docker</>}
            </button>
            {depsChecked && missingDeps.length > 0 && missingDeps.map(d => (
              <button
                key={d.name}
                className="btn-primary btn-sm"
                onClick={() => installDep(d.name)}
                disabled={!!installingDep}
              >
                {installingDep === d.name
                  ? <><span className="spinner" />Installing...</>
                  : <><i className="ti ti-download" />Install {d.name}</>}
              </button>
            ))}
          </div>
        </div>

        {depsChecked && deps.length > 0 && (
          <div>
            {deps.map(d => (
              <div key={d.name} className="dep-row">
                <i className={`ti ${d.status === 'ok' ? 'ti-circle-check dep-ok' : 'ti-circle-x dep-missing'}`} style={{ fontSize: '16px' }} />
                <div className="dep-name">{d.name}</div>
                {d.version && <div className="dep-version">{d.version}</div>}
                {d.path && <div className="dep-version" style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.path}</div>}
                <span className={`badge ${d.status === 'ok' ? 'tag-green' : 'tag-red'}`}>
                  {d.status === 'ok' ? 'Installed' : 'Missing'}
                </span>
              </div>
            ))}
          </div>
        )}

        {!depsChecked && (
          <div style={{ fontSize: '12px', color: 'var(--color-text-tertiary)', marginTop: '8px' }}>
            Click "Check Docker" to verify the Docker daemon is running before executing.
          </div>
        )}
        <div style={{ marginTop: '12px', fontSize: '11px', color: 'var(--color-text-tertiary)' }}>
          <i className="ti ti-brand-docker" style={{ marginRight: '4px', color: '#2496ed' }} />
          All tests run inside Docker containers. Images are configured in{' '}
          <button onClick={() => onNav('config')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent)', fontSize: '11px', padding: 0, fontFamily: 'inherit' }}>Configuration</button>.
        </div>
      </div>

      {/* Auto Healer Toggle */}
      <div className="card" style={{ marginBottom: '14px', padding: '12px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <i className="ti ti-heart-rate-monitor" style={{ color: 'var(--accent)', fontSize: '18px' }} />
            <div>
              <div style={{ fontWeight: 600, fontSize: '14px' }}>Auto Healer</div>
              <div style={{ fontSize: '11px', color: 'var(--color-text-tertiary)', marginTop: '1px' }}>
                AI detects failures, fixes the script, and re-runs automatically — no manual intervention
              </div>
            </div>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', userSelect: 'none' }}>
            <span style={{ fontSize: '12px', color: autoHeal ? 'var(--accent)' : 'var(--color-text-tertiary)', fontWeight: 600 }}>
              {autoHeal ? 'ON' : 'OFF'}
            </span>
            <div
              onClick={() => setAutoHeal(v => !v)}
              style={{
                width: 40, height: 22, borderRadius: 11,
                background: autoHeal ? 'var(--accent)' : 'var(--color-border-secondary)',
                position: 'relative', cursor: 'pointer', transition: 'background .2s',
              }}
            >
              <div style={{
                position: 'absolute', top: 3, left: autoHeal ? 21 : 3,
                width: 16, height: 16, borderRadius: '50%',
                background: '#fff', transition: 'left .2s',
                boxShadow: '0 1px 3px rgba(0,0,0,.4)',
              }} />
            </div>
          </label>
        </div>
      </div>

      {/* Run Button */}
      <div style={{ display: 'flex', gap: '10px', marginBottom: '16px', alignItems: 'center' }}>
        <button
          className="btn-primary"
          onClick={runTest}
          disabled={running || !selectedSuiteId}
          style={{ fontSize: '14px', padding: '10px 24px' }}
        >
          {running ? <><span className="spinner" />Running Test...</> : <><i className="ti ti-player-play" />Run Test</>}
        </button>
        {!depsChecked && (
          <div style={{ fontSize: '12px', color: 'var(--color-text-tertiary)' }}>
            <i className="ti ti-alert-triangle" style={{ marginRight: '4px', color: 'var(--warn)' }} />
            Check dependencies before running
          </div>
        )}
      </div>

      {/* Execution Log */}
      <div className="section-hdr" style={{ marginBottom: '8px' }}>
        <div className="section-title"><i className="ti ti-terminal-2" style={{ marginRight: '6px', color: 'var(--accent)' }} />Execution Log</div>
        <button className="btn-secondary btn-sm" onClick={() => setLogs([])}>
          <i className="ti ti-trash" /> Clear
        </button>
      </div>
      <div className="run-panel" ref={consoleRef} style={{ marginBottom: '20px' }}>
        {logs.filter(Boolean).map((l, i) => (
          <div key={i} className={`run-line run-${l.type}`}>
            {l.message}
          </div>
        ))}
      </div>

      {/* Auto Healer Status Panel */}
      {healState && (
        <div className="card" style={{ marginBottom: '20px', borderLeft: `3px solid ${
          healState.status === 'healed'                        ? 'var(--accent2)' :
          healState.status === 'infra_error'                   ? 'var(--warn)' :
          healState.status === 'failed' || healState.status === 'exhausted' ? 'var(--danger)' :
          'var(--accent)'
        }` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: healState.logs?.length ? '12px' : 0 }}>
            <i className={`ti ${
              healState.status === 'healed'    ? 'ti-circle-check'  :
              healState.status === 'failed' || healState.status === 'exhausted' ? 'ti-circle-x' :
              'ti-loader'
            }`} style={{
              fontSize: '18px',
              color: healState.status === 'healed'     ? 'var(--accent2)' :
                     healState.status === 'infra_error'  ? 'var(--warn)' :
                     healState.status === 'failed' || healState.status === 'exhausted' ? 'var(--danger)' :
                     'var(--accent)',
              animation: !['healed','failed','exhausted','no_errors'].includes(healState.status) ? 'spin 1s linear infinite' : 'none',
            }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: '13px' }}>
                Auto Healer —&nbsp;
                {healState.status === 'pending'       && 'Queued for analysis...'}
                {healState.status === 'diagnosing'    && 'AI is reading logs and diagnosing the issue...'}
                {healState.status === 'applying_fix'  && 'Applying AI-generated fix to the script...'}
                {healState.status === 'rerunning'     && 'Re-running the fixed test...'}
                {healState.status === 'healed'        && 'Issue fixed and test passed!'}
                {healState.status === 'failed'        && 'Could not automatically fix the issue'}
                {healState.status === 'exhausted'     && `Reached max ${3} attempts without success`}
                {healState.status === 'no_errors'     && 'No errors detected — healing not needed'}
                {healState.status === 'infra_error'   && 'Server/infrastructure failure — script changes cannot fix this'}
              </div>
              {healState.heal_run_id && (
                <div style={{ fontSize: '11px', color: 'var(--color-text-tertiary)', marginTop: '2px' }}>
                  Healed re-run ID: #{healState.heal_run_id}
                </div>
              )}
            </div>
          </div>

          {healState.logs?.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {healState.logs.map((l, i) => (
                <div key={i} style={{
                  background: 'var(--color-background-secondary)',
                  borderRadius: '6px',
                  padding: '10px 12px',
                  fontSize: '12px',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                    <span style={{
                      fontSize: '10px', fontWeight: 700, padding: '2px 6px', borderRadius: '4px',
                      background: l.result === 'healed' ? 'var(--accent2)' :
                                  l.result === 'failed' || l.result === 'no_fix' ? 'var(--danger)' :
                                  'var(--color-border-secondary)',
                      color: '#fff',
                    }}>
                      Attempt {l.attempt}
                    </span>
                    <span style={{ fontSize: '10px', color: 'var(--color-text-tertiary)' }}>
                      {l.fix_type === 'script_rewrite' ? 'Script rewrite' : l.fix_type === 'no_fix' ? 'No fix found' : l.fix_type}
                    </span>
                  </div>
                  {l.diagnosis && (
                    <div style={{ marginBottom: '4px' }}>
                      <span style={{ color: 'var(--warn)', fontWeight: 600 }}>Issue: </span>
                      {l.diagnosis}
                    </div>
                  )}
                  {l.fix_applied && (
                    <div>
                      <span style={{ color: 'var(--accent2)', fontWeight: 600 }}>Fix: </span>
                      {l.fix_applied}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Past Runs */}
      {selectedProjectId && (
        <>
          <div className="section-hdr" style={{ marginBottom: '10px' }}>
            <div className="section-title"><i className="ti ti-history" style={{ marginRight: '6px', color: 'var(--accent)' }} />Past Runs</div>
            <button className="btn-secondary btn-sm" onClick={() => {
              api.get(`/execution/runs?project_id=${selectedProjectId}`).then(({ data }) => setRuns(data.runs || [])).catch(() => {});
            }}>
              <i className="ti ti-refresh" /> Refresh
            </button>
          </div>
          {runs.length === 0 ? (
            <div style={{ fontSize: '13px', color: 'var(--color-text-tertiary)', padding: '12px 0' }}>No runs yet for this project.</div>
          ) : (
            runs.map(r => (
              <div key={r.id} className="run-result-row">
                <i className={`ti ${r.status === 'completed' ? 'ti-circle-check' : r.status === 'failed' ? 'ti-circle-x' : 'ti-loader'}`}
                   style={{ color: r.status === 'completed' ? 'var(--accent)' : r.status === 'failed' ? 'var(--danger)' : 'var(--warn)', fontSize: '16px' }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: '13px' }}>
                    {r.suite_name || 'Unknown Suite'} — Run #{r.result_dir?.match(/Run_(\d+)/)?.[1] ?? r.id}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--color-text-tertiary)', marginTop: '2px' }}>
                    {r.engine?.toUpperCase()} · {r.started_at}
                  </div>
                </div>
                <span className={`badge ${r.status === 'completed' ? 'tag-green' : r.status === 'failed' ? 'tag-red' : 'tag-amber'}`}>
                  {r.status}
                </span>
                {r.heal_status === 'healed' && (
                  <span className="badge tag-green" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <i className="ti ti-heart-rate-monitor" style={{ fontSize: 11 }} /> Auto-Healed
                  </span>
                )}
                {r.heal_status && !['healed','no_errors'].includes(r.heal_status) && r.auto_heal && (
                  <span className="badge tag-amber" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <i className="ti ti-heart-rate-monitor" style={{ fontSize: 11 }} /> {r.heal_status}
                  </span>
                )}
                {r.result_dir && (
                  <div style={{ fontSize: '11px', color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.result_dir}
                  </div>
                )}
              </div>
            ))
          )}
        </>
      )}
    </div>
  );
}
