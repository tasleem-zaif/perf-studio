import { useState, useEffect, useRef, startTransition } from 'react';
import api from '../api';
import { useToast } from '../hooks/useToast';
import CustomSelect from '../components/CustomSelect';

export default function Runner({ projects, activeProject, activeCollection, activeEnv, onNav, suitesVersion }) {
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
  const [jmeterDockerImage, setJmeterDockerImage] = useState('tasleemzaif/Peako:latest');
  const [k6DockerImage, setK6DockerImage] = useState('tasleemzaif/Peako:latest');
  const [pullingImage, setPullingImage] = useState(null); // 'jmeter' | 'k6' | null
  const [runParams, setRunParams] = useState({ vusers: 50, rampup: 30, iter_mode: 'duration', loops: 1, duration: 300 });
  const [running, setRunning] = useState(false);
  const [autoHeal, setAutoHeal] = useState(true);
  const [healState, setHealState] = useState(null);
  const healPollRef = useRef(null);
  const [logs, setLogs] = useState([
    { type: 'info', message: 'Peako Execution Engine ready.' },
    { type: 'info', message: 'Select a project and test suite, then check Docker before running.' },
  ]);
  const [runs, setRuns] = useState([]);
  const consoleRef = useRef(null);

  const selectedProject = activeProject;
  const selectedProjectId = activeProject?.id || '';

  // Load the configured Docker image names (used for both CI YAML and local pulls)
  useEffect(() => {
    api.get('/config').then(({ data }) => {
      if (data.config?.jmeter_docker_image) setJmeterDockerImage(data.config.jmeter_docker_image);
      if (data.config?.k6_docker_image) setK6DockerImage(data.config.k6_docker_image);
    }).catch(() => {});
  }, []);

  // Load all generated suites when active project changes, or when suitesVersion is bumped
  // (Runner is kept permanently mounted — display:none toggle, not unmount — when the user
  // navigates elsewhere and back, so a project-id-only dependency would never re-fetch after
  // a script is generated on the Test Plans page; suitesVersion is ProjectWorkspace's signal
  // that something about this project's test suites changed).
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
        // Keep the current suite selection if it's still in the refreshed list (a
        // suitesVersion bump can be for a totally unrelated suite) — only clear it if
        // it's genuinely gone.
        setSelectedSuiteId(prev => (prev && generated.some(s => String(s.id) === String(prev))) ? prev : '');
      })
      .catch(() => { setSuites([]); });
  }, [activeProject?.id, suitesVersion]);

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
      // Only check Docker — JMeter/K6/Java run inside the custom CI image
      const { data } = await api.get('/execution/check-docker');
      const dockerOk = data.status === 'ok';
      const dockerDep = {
        name:    'docker',
        status:  dockerOk ? 'ok' : 'missing',
        version: data.version || null,
        path:    null,
      };
      setDeps([dockerDep]);
      setDepsChecked(true);
      addLog(dockerOk ? 'ok' : 'warn',
        dockerOk
          ? '✔ Docker is installed and running — ready to execute.'
          : '✘ Docker is not running. Start Docker Desktop and re-check.');
    } catch (e) {
      addLog('err', 'Docker check failed: ' + (e.response?.data?.error || e.message));
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

  async function saveDockerImages() {
    try {
      const { data } = await api.get('/config');
      await api.put('/config', { config: { ...(data.config || {}), jmeter_docker_image: jmeterDockerImage, k6_docker_image: k6DockerImage } });
      toast('Docker images saved.', 'ok');
    } catch { toast('Failed to save.', 'err'); }
  }

  async function pullImage(tool) {
    const image = tool === 'k6' ? k6DockerImage : jmeterDockerImage;
    setPullingImage(tool);
    addLog('info', `━━━ Pulling ${image} ━━━`);
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
              if (data.error) addLog('err', 'Pull failed: ' + data.error);
              else addLog('ok', `${image} is ready.`);
            } else {
              addLog(data.type || 'info', data.message || '');
            }
          } catch {}
        }
      }
    } catch (e) {
      addLog('err', 'Pull error: ' + e.message);
    } finally {
      setPullingImage(null);
    }
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

  function startCiHealPolling(runId) {
    if (ciHealPollRef.current[runId]) clearInterval(ciHealPollRef.current[runId]);
    setCiHealStates(prev => ({ ...prev, [runId]: { status: 'pending', logs: [] } }));
    ciHealPollRef.current[runId] = setInterval(async () => {
      try {
        const { data } = await api.get(`/projects/${selectedProjectId}/ci/runs/${runId}/heal-status`);
        setCiHealStates(prev => ({ ...prev, [runId]: data }));
        const done = ['healed', 'failed', 'exhausted', 'infra_error'].includes(data.status);
        if (done) {
          clearInterval(ciHealPollRef.current[runId]);
          delete ciHealPollRef.current[runId];
          api.get(`/projects/${selectedProjectId}/ci/runs`).then(({ data: d }) => setCiRuns(d.runs || [])).catch(() => {});
        }
      } catch {
        clearInterval(ciHealPollRef.current[runId]);
        delete ciHealPollRef.current[runId];
      }
    }, 3000);
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
              // Use startTransition to let React render each log line immediately
              // without batching multiple lines into a single deferred render
              startTransition(() => {
                setLogs(prev => [...prev, { type: msg.type || 'info', message: msg.message || '' }]);
              });
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

  // ── CI Pipeline state ────────────────────────────────────────────────────
  const [ciConfig,       setCiConfig]       = useState(null);
  const [ciProvider,     setCiProvider]     = useState('gitlab');
  const [ciScriptName,   setCiScriptName]   = useState('');
  const [ciScriptPath,   setCiScriptPath]   = useState('');
  const [ciVars,         setCiVars]         = useState({ jmeter_users: 10, jmeter_rampup: 30, jmeter_loops: 1, jmeter_duration: 300, iter_mode: 'duration' });
  const [ciTriggering,   setCiTriggering]   = useState(false);
  const [ciRuns,         setCiRuns]         = useState([]);
  const [ciPolling,      setCiPolling]      = useState(null); // runId being polled
  const [ciExpandedRun,  setCiExpandedRun]  = useState(null); // runId with expanded terminal
  const [ciSteps,        setCiSteps]        = useState({});   // runId → { steps, job }
  const [ciExpandedHealChain, setCiExpandedHealChain] = useState({}); // rootRunId → bool
  const [ciHealPanelCollapsed, setCiHealPanelCollapsed] = useState({}); // runId → bool (attempt logs + exhaustion summary)
  const ciStepsPollerRef = useRef(null);
  // CI Auto Heal state
  const [ciAutoHeal,    setCiAutoHeal]    = useState(true);  // toggle on trigger form
  const [ciHealStates,  setCiHealStates]  = useState({});    // runId → { status, logs, heal_ci_run_id }
  const [ciManualHeal,  setCiManualHeal]  = useState({});    // runId → { showing, text, loading }
  const ciHealPollRef = useRef({});
  // Tracks which runIds already have a real pollCiStatus() loop resumed this session, so the
  // effect below doesn't start a second overlapping poller for the same run on every re-render.
  const ciStatusResumedRef = useRef({});

  // Auto-poll heal status for any run with an active heal in progress when history loads
  useEffect(() => {
    const ACTIVE = ['pending','diagnosing','applying_fix','rerunning','rerunning_full'];
    ciRuns.forEach(r => {
      if (r.heal_status && ACTIVE.includes(r.heal_status) && !ciHealPollRef.current[r.id]) {
        startCiHealPolling(r.id);
      }
    });
  }, [ciRuns]); // eslint-disable-line react-hooks/exhaustive-deps

  // Resume REAL status polling (pollCiStatus, which actually calls the CI provider and is
  // what triggers auto-sync + email server-side) for any run still in-flight when the list
  // loads or refreshes — e.g. after a page reload, or the tab having been left open/backgrounded
  // since before the run finished. Without this, only the plain `/ci/runs` list re-fetch below
  // ever ran automatically, which just re-reads whatever's already in the DB — it never asks
  // the provider anything, so a run that finished with nobody watching stayed "pending"/
  // "running" forever until someone opened this page and manually clicked refresh, which is
  // also the only thing that ever kicked off auto-sync/email. This closes that gap.
  useEffect(() => {
    const IN_FLIGHT_RUN = new Set(['pending','queued','running','in_progress']);
    ciRuns.forEach(r => {
      if (IN_FLIGHT_RUN.has(r.status) && !ciStatusResumedRef.current[r.id]) {
        ciStatusResumedRef.current[r.id] = true;
        pollCiStatus(r.id);
      }
    });
  }, [ciRuns]); // eslint-disable-line react-hooks/exhaustive-deps

  const [runTab, setRunTab] = useState('ci-pipeline'); // 'single' | 'ci-pipeline' — declared here so useEffect below can reference it

  useEffect(() => {
    if (!selectedProjectId) { setCiConfig(null); setCiRuns([]); return; }
    // Re-fetch every time the CI Pipeline tab becomes active so freshly-saved configs are picked up
    if (runTab !== 'ci-pipeline') return;
    api.get(`/projects/${selectedProjectId}/ci/config`).then(({ data }) => {
      setCiConfig(data.config);
      if (data.config?.bitbucket_enabled && !data.config?.gitlab_enabled && !data.config?.github_enabled) setCiProvider('bitbucket');
      else if (data.config?.github_enabled && !data.config?.gitlab_enabled) setCiProvider('github');
      else if (data.config?.gitlab_enabled) setCiProvider('gitlab');
    }).catch(() => {});
    api.get(`/projects/${selectedProjectId}/ci/runs`).then(({ data }) => setCiRuns(data.runs || [])).catch(() => {});
  }, [selectedProjectId, runTab]);

  // Background refresh for the CI Run History list. pollCiStatus()/startCiHealPolling()
  // only run while a status-changing action (trigger/heal/manual refresh) happened in THIS
  // browser session — reloading the page (or just having left it open since before a run
  // finished) leaves nothing polling, so a run completing or auto-heal progressing server-side
  // never reaches the UI until the user manually refreshes. This interval re-fetches the run
  // list on its own whenever anything shown is still in flight, so those changes show up live.
  const ciRunsRef = useRef([]);
  useEffect(() => { ciRunsRef.current = ciRuns; }, [ciRuns]);
  useEffect(() => {
    if (!selectedProjectId || runTab !== 'ci-pipeline') return;
    const IN_FLIGHT_RUN  = new Set(['pending','queued','running','in_progress']);
    const IN_FLIGHT_HEAL = new Set(['pending','diagnosing','applying_fix','rerunning','rerunning_full']);
    const tick = setInterval(() => {
      const hasInFlight = ciRunsRef.current.some(r =>
        IN_FLIGHT_RUN.has(r.status) || IN_FLIGHT_HEAL.has(r.heal_status));
      if (!hasInFlight) return;
      api.get(`/projects/${selectedProjectId}/ci/runs`).then(({ data }) => setCiRuns(data.runs || [])).catch(() => {});
    }, 6000);
    return () => clearInterval(tick);
  }, [selectedProjectId, runTab]);

  // Poll live steps when a terminal is expanded
  useEffect(() => {
    if (ciStepsPollerRef.current) { clearInterval(ciStepsPollerRef.current); ciStepsPollerRef.current = null; }
    if (!ciExpandedRun || !selectedProjectId) return;

    const fetchSteps = async () => {
      try {
        const { data } = await api.get(`/projects/${selectedProjectId}/ci/runs/${ciExpandedRun}/steps`);
        setCiSteps(prev => ({ ...prev, [ciExpandedRun]: data }));
        // Stop polling when run is done
        const done = ['completed','failed','cancelled','success','failure'].includes(data.status);
        if (done && ciStepsPollerRef.current) { clearInterval(ciStepsPollerRef.current); ciStepsPollerRef.current = null; }
      } catch {}
    };

    fetchSteps(); // immediate first fetch
    ciStepsPollerRef.current = setInterval(fetchSteps, 4000); // then every 4s
    return () => { if (ciStepsPollerRef.current) { clearInterval(ciStepsPollerRef.current); ciStepsPollerRef.current = null; } };
  }, [ciExpandedRun, selectedProjectId]);

  async function triggerCiPipeline() {
    setCiTriggering(true);
    try {
      const { data } = await api.post(`/projects/${selectedProjectId}/ci/trigger`, {
        provider:      ciProvider,
        script_name:   ciScriptName,
        script_path:   ciScriptPath,
        jmeter_users:    ciVars.jmeter_users,
        jmeter_rampup:   ciVars.jmeter_rampup,
        // Pass only the active param; set the other to -1 so JMeter ignores it
        jmeter_duration: ciVars.iter_mode === 'duration' ? ciVars.jmeter_duration : -1,
        jmeter_loops:    ciVars.iter_mode === 'loops'    ? ciVars.jmeter_loops    : -1,
        auto_heal: ciAutoHeal ? 1 : 0,
      });
      const providerLabel = ciProvider === 'gitlab' ? 'GitLab' : ciProvider === 'github' ? 'GitHub Actions' : 'Bitbucket Pipelines';
      toast(`Pipeline triggered on ${providerLabel}`, 'success');
      setCiRuns(prev => [{ id: data.run_id, provider: ciProvider, status: data.status, web_url: data.web_url, script_name: ciScriptName, run_name: data.run_name, started_at: new Date().toISOString() }, ...prev]);
      // Start polling
      pollCiStatus(data.run_id);
    } catch (e) { toast(e.response?.data?.error || 'Trigger failed', 'error'); }
    finally { setCiTriggering(false); }
  }

  async function pollCiStatus(runId) {
    setCiPolling(runId);
    const DONE = new Set(['completed','failed','cancelled','success','failure','skipped']);
    const poll = async () => {
      try {
        const { data } = await api.get(`/projects/${selectedProjectId}/ci/runs/${runId}/status`);
        setCiRuns(prev => prev.map(r => r.id === runId ? { ...r, ...data.run } : r));
        if (!DONE.has(data.run?.status)) setTimeout(poll, 5000); // poll every 5s until done
        else {
          setCiPolling(null);
          // The backend kicks off auto-sync (and, if auto_heal is on and the run failed,
          // auto-heal) via setImmediate right after this same status response — start
          // heal-status polling now instead of waiting for the next full ciRuns refresh to
          // notice, otherwise the heal cycle can start and finish entirely invisibly (this
          // polling loop already stopped, and nothing else re-fetches ciRuns in between).
          if (data.run?.status === 'failed' && data.run?.auto_heal && !ciHealPollRef.current[runId]) {
            startCiHealPolling(runId);
          }
          // Refresh full run list to pick up any runs triggered outside Peako
          api.get(`/projects/${selectedProjectId}/ci/runs`)
            .then(({ data: d }) => setCiRuns(d.runs || []))
            .catch(() => {});
        }
      } catch { setCiPolling(null); }
    };
    setTimeout(poll, 5000); // first poll after 5s (GitHub needs a moment to register the run)
  }

  // ── Pipeline runner state ─────────────────────────────────────────────────
  const [pipelines,        setPipelines]        = useState([]);
  const [selectedPipeline, setSelectedPipeline] = useState('');
  const [pipelineRunning,  setPipelineRunning]  = useState(false);
  const [pipelineLogs,     setPipelineLogs]     = useState([]);
  const [pipelineSteps,    setPipelineSteps]    = useState([]);
  const [pipelineRunId,    setPipelineRunId]    = useState(null);
  const [pipelineStatus,   setPipelineStatus]   = useState(null); // 'running'|'completed'|'failed'
  const pipelineConsoleRef = useRef(null);

  useEffect(() => {
    if (pipelineConsoleRef.current) {
      pipelineConsoleRef.current.scrollTop = pipelineConsoleRef.current.scrollHeight;
    }
  }, [pipelineLogs]);

  useEffect(() => {
    if (!selectedProjectId) { setPipelines([]); setSelectedPipeline(''); return; }
    api.get(`/projects/${selectedProjectId}/pipelines`)
      .then(({ data }) => setPipelines(data.pipelines || []))
      .catch(() => setPipelines([]));
  }, [selectedProjectId]);

  async function runPipeline() {
    if (!selectedPipeline) return toast('Select a pipeline first', 'warn');
    setPipelineRunning(true);
    setPipelineLogs([{ type: 'info', message: 'Starting pipeline...' }]);
    setPipelineStatus('running');
    setPipelineRunId(null);

    // Reset step statuses from selected pipeline definition
    const pl = pipelines.find(p => String(p.id) === String(selectedPipeline));
    const steps = pl ? JSON.parse(pl.steps || '[]') : [];
    setPipelineSteps(steps.map(s => ({ ...s, status: 'pending' })));

    try {
      const token = localStorage.getItem('ps_token');
      const response = await fetch(`/api/projects/${selectedProjectId}/pipelines/${selectedPipeline}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
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
            if (msg.run_id && !msg.done) {
              setPipelineRunId(msg.run_id);
            }
            if (msg.step_update) {
              const { index, status, error } = msg.step_update;
              setPipelineSteps(prev => prev.map((s, i) => i === index ? { ...s, status, error } : s));
            }
            if (msg.done) {
              setPipelineStatus(msg.status || 'completed');
              // Reload run history
              api.get(`/projects/${selectedProjectId}/pipelines/${selectedPipeline}/runs`).catch(e => console.warn('Could not refresh pipeline run history:', e?.message));
            } else if (msg.type && msg.message) {
              startTransition(() => {
                setPipelineLogs(prev => [...prev, { type: msg.type, message: msg.message }]);
              });
            }
          } catch {}
        }
      }
    } catch (e) {
      setPipelineLogs(prev => [...prev, { type: 'err', message: 'Connection error: ' + e.message }]);
      setPipelineStatus('failed');
    } finally {
      setPipelineRunning(false);
    }
  }

  return (
    <div className="page fade-in">

      {/* ── Run mode tabs ─────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '2px solid #e2e8f0' }}>
        {[
          { id: 'ci-pipeline', icon: 'ti-brand-gitlab',   label: 'CI Pipeline'    },
          false && { id: 'single', icon: 'ti-player-play', label: 'Local Test Run' }, // hidden — keep code for future use
        ].filter(t => t).map(t => (
          <button key={t.id} onClick={() => setRunTab(t.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 7,
              padding: '8px 16px', border: 'none', cursor: 'pointer',
              fontFamily: 'inherit', fontSize: 13, fontWeight: runTab === t.id ? 700 : 500,
              background: 'transparent',
              color: runTab === t.id ? 'var(--accent)' : 'var(--color-text-secondary)',
              borderBottom: runTab === t.id ? '2px solid var(--accent)' : '2px solid transparent',
              marginBottom: -2, transition: 'all .12s',
            }}>
            <i className={`ti ${t.icon}`} style={{ fontSize: 14 }}/>{t.label}
          </button>
        ))}
      </div>

      {/* ── Pipeline Run tab — hidden, keep code for future use ────────── */}
      {false && runTab === 'pipeline' && (
        <div>
          {/* Pipeline selector */}
          <div className="card" style={{ marginBottom: 14 }}>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
              <i className="ti ti-git-merge" style={{ color: 'var(--accent)' }}/> Select Pipeline
            </div>
            {!activeProject ? (
              <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
                <i className="ti ti-info-circle" style={{ marginRight: 6, color: 'var(--warn)' }}/>
                No project selected. Choose a project from the sidebar first.
              </div>
            ) : pipelines.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
                <i className="ti ti-info-circle" style={{ marginRight: 6, color: 'var(--warn)' }}/>
                No pipelines found. Go to <strong>Configuration → Pipeline</strong> to create one.
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
                <div style={{ flex: 1 }}>
                  <label className="form-label">Pipeline</label>
                  <CustomSelect value={selectedPipeline} onChange={e => { setSelectedPipeline(e.target.value); setPipelineLogs([]); setPipelineSteps([]); setPipelineStatus(null); }}>
                    <option value="">— Select a pipeline —</option>
                    {pipelines.map(p => {
                      const steps = JSON.parse(p.steps || '[]');
                      return <option key={p.id} value={p.id}>{p.name} ({steps.length} step{steps.length !== 1 ? 's' : ''}){p.environment ? ` · ${p.environment}` : ''}</option>;
                    })}
                  </CustomSelect>
                </div>
                <button className="btn-primary" onClick={runPipeline}
                  disabled={pipelineRunning || !selectedPipeline}
                  style={{ flexShrink: 0, minWidth: 130 }}>
                  {pipelineRunning
                    ? <><span className="spinner"/> Running…</>
                    : <><i className="ti ti-player-play"/> Run Pipeline</>}
                </button>
              </div>
            )}

            {/* Pipeline details preview */}
            {selectedPipeline && (() => {
              const pl = pipelines.find(p => String(p.id) === String(selectedPipeline));
              if (!pl) return null;
              const steps = JSON.parse(pl.steps || '[]');
              return (
                <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid #f1f5f9' }}>
                  {pl.description && <div style={{ fontSize: 12, color: '#64748b', marginBottom: 10 }}>{pl.description}</div>}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {steps.map((s, i) => (
                      <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 10px', background: '#f1f5f9', borderRadius: 20, fontSize: 11, color: '#475569' }}>
                        <span style={{ fontWeight: 700, color: '#4338ca' }}>{i + 1}.</span>{s.name}
                        <span style={{ fontSize: 10, color: '#94a3b8' }}>{s.engine?.toUpperCase()}</span>
                      </span>
                    ))}
                  </div>
                  <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 8 }}>
                    <i className="ti ti-player-stop" style={{ marginRight: 4, color: pl.stop_on_failure ? '#ef4444' : '#94a3b8' }}/>
                    {pl.stop_on_failure ? 'Stops on first failure' : 'Continues on failure'}
                  </div>
                </div>
              );
            })()}
          </div>

          {/* Step progress */}
          {pipelineSteps.length > 0 && (
            <div className="card" style={{ marginBottom: 14 }}>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                <i className="ti ti-list-check" style={{ color: 'var(--accent)' }}/> Step Progress
                {pipelineStatus && (
                  <span style={{
                    marginLeft: 'auto', padding: '3px 12px', borderRadius: 20, fontSize: 11, fontWeight: 700,
                    background: pipelineStatus === 'completed' ? '#dcfce7' : pipelineStatus === 'failed' ? '#fee2e2' : '#dbeafe',
                    color:      pipelineStatus === 'completed' ? '#16a34a' : pipelineStatus === 'failed' ? '#dc2626' : '#1d4ed8',
                  }}>
                    {pipelineStatus === 'completed' ? '✔ Completed' : pipelineStatus === 'failed' ? '✘ Failed' : '⟳ Running'}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {pipelineSteps.map((s, i) => {
                  const statusColors = {
                    pending:   { bg: '#f1f5f9', color: '#64748b', icon: 'ti-circle',        label: 'Pending'   },
                    running:   { bg: '#dbeafe', color: '#1d4ed8', icon: 'ti-loader-2',      label: 'Running'   },
                    completed: { bg: '#dcfce7', color: '#16a34a', icon: 'ti-circle-check',  label: 'Passed'    },
                    failed:    { bg: '#fee2e2', color: '#dc2626', icon: 'ti-circle-x',      label: 'Failed'    },
                    skipped:   { bg: '#fef3c7', color: '#b45309', icon: 'ti-circle-dashed', label: 'Skipped'   },
                  };
                  const sc = statusColors[s.status] || statusColors.pending;
                  return (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 8, background: sc.bg, border: `1px solid ${sc.bg}` }}>
                      <i className={`ti ${sc.icon}`} style={{ color: sc.color, fontSize: 16, flexShrink: 0, animation: s.status === 'running' ? 'spin 1s linear infinite' : 'none' }}/>
                      <span style={{ fontSize: 12, fontWeight: 700, color: '#0f172a', flex: 1 }}>
                        <span style={{ color: '#94a3b8', marginRight: 6 }}>Step {i + 1}.</span>{s.name}
                        {s.engine && <span style={{ marginLeft: 8, fontSize: 10, color: '#94a3b8', fontWeight: 400 }}>{s.engine.toUpperCase()}</span>}
                      </span>
                      <span style={{ fontSize: 11, fontWeight: 700, color: sc.color }}>{sc.label}</span>
                      {s.error && <span style={{ fontSize: 10, color: '#dc2626', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.error}>{s.error}</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Pipeline execution log */}
          {pipelineLogs.length > 0 && (
            <>
              <div className="section-hdr" style={{ marginBottom: 8 }}>
                <div className="section-title"><i className="ti ti-terminal-2" style={{ marginRight: 6, color: 'var(--accent)' }}/>Pipeline Log</div>
                <button className="btn-secondary btn-sm" onClick={() => { setPipelineLogs([]); setPipelineSteps([]); setPipelineStatus(null); }}>
                  <i className="ti ti-trash"/> Clear
                </button>
              </div>
              <div className="run-panel" ref={pipelineConsoleRef} style={{ marginBottom: 20 }}>
                {pipelineLogs.map((l, i) => (
                  <div key={i} className={`run-line run-${l.type}`}>{l.message}</div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── CI Pipeline tab ─────────────────────────────────────────────── */}
      {runTab === 'ci-pipeline' && (
        <div>
          {!ciConfig ? (
            <div style={{ padding: '32px', textAlign: 'center', color: '#64748b', fontSize: 13 }}>
              <i className="ti ti-settings-2" style={{ fontSize: 40, display: 'block', marginBottom: 12, color: '#cbd5e1' }}/>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>CI/CD not configured</div>
              <div>Go to <strong>Configuration → Pipeline → CI/CD Integration</strong> to set up GitLab or GitHub Actions first.</div>
            </div>
          ) : (
            <>
              {/* Provider + settings */}
              <div className="card" style={{ marginBottom: 14 }}>
                <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <i className="ti ti-brand-gitlab" style={{ color: 'var(--accent)' }}/> Trigger CI Pipeline
                </div>

                {/* Provider selector */}
                <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
                  {[
                    { id: 'gitlab',     icon: 'ti-brand-gitlab',     label: 'GitLab',              enabled: ciConfig?.gitlab_enabled },
                    { id: 'github',     icon: 'ti-brand-github',     label: 'GitHub Actions',      enabled: ciConfig?.github_enabled },
                    { id: 'bitbucket',  icon: 'ti-brand-bitbucket',  label: 'Bitbucket Pipelines', enabled: ciConfig?.bitbucket_enabled },
                  ].filter(p => p.enabled).map(p => (
                    <button key={p.id} onClick={() => setCiProvider(p.id)}
                      style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 16px', border: `1.5px solid ${ciProvider === p.id ? 'var(--accent)' : '#e2e8f0'}`, borderRadius: 8, background: ciProvider === p.id ? '#f0fdf4' : '#f8fafc', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: ciProvider === p.id ? 700 : 500, color: ciProvider === p.id ? '#16a34a' : '#374151', transition: 'all .12s' }}>
                      <i className={`ti ${p.icon}`}/>{p.label}
                    </button>
                  ))}
                  {!ciConfig?.gitlab_enabled && !ciConfig?.github_enabled && !ciConfig?.bitbucket_enabled && (
                    <div style={{ fontSize: 12, color: '#94a3b8' }}>No providers enabled. Enable GitLab, GitHub, or Bitbucket in CI/CD settings.</div>
                  )}
                </div>

                {/* Script — dropdown only, filename/path calculated automatically */}
                <div className="form-group" style={{ marginBottom: 14 }}>
                  <label className="form-label">Test Plan</label>
                  {suites.filter(s => s.jmx_path || s.js_path).length === 0 ? (
                    <div style={{ fontSize: 12, color: '#94a3b8', padding: '8px 0' }}>
                      <i className="ti ti-alert-triangle" style={{ marginRight: 5, color: '#f59e0b' }}/>
                      No generated scripts found. Go to Test Plans and generate a script first.
                    </div>
                  ) : (
                    <>
                      <CustomSelect
                        value={ciScriptName}
                        onChange={e => {
                          const selected = suites.find(s => {
                            const file = (s.jmx_path || s.js_path || '').replace(/\\/g, '/');
                            return file.split('/').pop() === e.target.value;
                          });
                          if (selected) {
                            const file = (selected.jmx_path || selected.js_path || '').replace(/\\/g, '/');
                            // Content inside the repo always starts with <ProjectName>/<Collection>/<Env>/...,
                            // repeating the project name a second time after the workspace-bucket segment(s)
                            // that precede it on local disk (git-workspaces/<Project>/<actor>/... normally, or
                            // git-workspaces/<Organization>/<Project>/<actor>/... for a project created after
                            // the org-prefix folder structure shipped). Anchor on that repeated project-name
                            // segment via lastIndexOf rather than assuming a fixed number of leading
                            // directories — a fixed-depth regex here was exactly why a real CI run failed on
                            // the "Patch JMX parameters" step for an org-prefixed project: it stripped the
                            // wrong number of segments and sent a script_path that doesn't exist in the repo.
                            const cleanProjName = (selectedProject?.name || '').replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
                            const marker = `/${cleanProjName}/`;
                            const lastIdx = cleanProjName ? file.lastIndexOf(marker) : -1;
                            const relPath = lastIdx >= 0 ? file.slice(lastIdx + 1) : file.replace(/.*git-workspaces\/[^/]+\/[^/]+\//, '');
                            const fileName = file.split('/').pop();
                            setCiScriptName(fileName);
                            setCiScriptPath(relPath);
                            // Pre-fill load parameters from the saved test suite configuration
                            setCiVars(v => ({
                              ...v,
                              jmeter_users:    selected.vusers    || v.jmeter_users,
                              jmeter_rampup:   selected.rampup    || v.jmeter_rampup,
                              jmeter_duration: selected.duration  || v.jmeter_duration,
                              jmeter_loops:    selected.loops     || v.jmeter_loops,
                              iter_mode:       selected.iter_mode || v.iter_mode,
                            }));
                          }
                        }}
                      >
                        <option value="">— Select a test plan —</option>
                        {suites.filter(s => s.jmx_path || s.js_path).map(s => {
                          const file = (s.jmx_path || s.js_path || '').replace(/\\/g, '/');
                          const fileName = file.split('/').pop();
                          return <option key={s.id} value={fileName}>{s.name}</option>;
                        })}
                      </CustomSelect>
                      {ciScriptName && (
                        <div style={{ marginTop: 6, fontSize: 11, color: '#64748b', display: 'flex', alignItems: 'center', gap: 4 }}>
                          <i className="ti ti-file-code" style={{ fontSize: 11, color: '#4338ca' }}/>
                          <code style={{ fontSize: 10, color: '#475569' }}>{ciScriptPath || ciScriptName}</code>
                        </div>
                      )}
                    </>
                  )}
                </div>

                {/* Variables */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 14 }}>
                  <div className="form-group" style={{ margin: 0 }}>
                    <label className="form-label" style={{ fontSize: 11 }}>Virtual Users</label>
                    <input type="number" value={ciVars.jmeter_users} min={1} onChange={e => setCiVars(v => ({ ...v, jmeter_users: e.target.value }))} placeholder="10" />
                  </div>
                  <div className="form-group" style={{ margin: 0 }}>
                    <label className="form-label" style={{ fontSize: 11 }}>Ramp-up (secs)</label>
                    <input type="number" value={ciVars.jmeter_rampup} min={0} onChange={e => setCiVars(v => ({ ...v, jmeter_rampup: e.target.value }))} placeholder="30" />
                  </div>
                  <div className="form-group" style={{ margin: 0 }}>
                    <label className="form-label" style={{ fontSize: 11 }}>Iteration Mode</label>
                    <CustomSelect value={ciVars.iter_mode} onChange={e => setCiVars(v => ({ ...v, iter_mode: e.target.value }))}>
                      <option value="duration">Test Duration (secs)</option>
                      <option value="loops">Fixed Loops</option>
                    </CustomSelect>
                  </div>
                  {ciVars.iter_mode === 'duration' ? (
                    <div className="form-group" style={{ margin: 0 }}>
                      <label className="form-label" style={{ fontSize: 11 }}>Duration (secs)</label>
                      <input type="number" value={ciVars.jmeter_duration} min={1} onChange={e => setCiVars(v => ({ ...v, jmeter_duration: e.target.value }))} placeholder="300" />
                    </div>
                  ) : (
                    <div className="form-group" style={{ margin: 0 }}>
                      <label className="form-label" style={{ fontSize: 11 }}>Loops</label>
                      <input type="number" value={ciVars.jmeter_loops} min={1} onChange={e => setCiVars(v => ({ ...v, jmeter_loops: e.target.value }))} placeholder="1" />
                    </div>
                  )}
                </div>

                {/* ── Auto Heal toggle ── */}
                <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 12, marginTop: 4,
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                    <i className="ti ti-heart-rate-monitor" style={{ color: 'var(--accent)', fontSize: 16 }}/>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>Auto Heal</div>
                      <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 1 }}>
                        {ciAutoHeal
                          ? 'AI will fix and re-run automatically if the pipeline fails'
                          : 'Heal button appears in run history to fix manually'}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', userSelect: 'none' }}
                    onClick={() => setCiAutoHeal(v => !v)}>
                    <span style={{ fontSize: 12, color: ciAutoHeal ? 'var(--accent)' : 'var(--color-text-tertiary)', fontWeight: 600 }}>
                      {ciAutoHeal ? 'ON' : 'OFF'}
                    </span>
                    <div style={{ width: 38, height: 21, borderRadius: 11, background: ciAutoHeal ? 'var(--accent)' : 'var(--color-border-secondary)', position: 'relative', transition: 'background .2s' }}>
                      <div style={{ position: 'absolute', top: 3, left: ciAutoHeal ? 19 : 3, width: 15, height: 15, borderRadius: '50%', background: '#fff', transition: 'left .2s', boxShadow: '0 1px 3px rgba(0,0,0,.4)' }}/>
                    </div>
                  </div>
                </div>

                <div style={{ marginTop: 14 }}>
                  <button className="btn-primary" onClick={triggerCiPipeline} disabled={ciTriggering || !ciScriptName || (!ciConfig?.gitlab_enabled && !ciConfig?.github_enabled && !ciConfig?.bitbucket_enabled)}>
                    {ciTriggering
                      ? <><span className="spinner"/> Triggering…</>
                      : <><i className="ti ti-send"/> Trigger {ciProvider === 'gitlab' ? 'GitLab' : ciProvider === 'github' ? 'GitHub Actions' : 'Bitbucket'} Pipeline</>}
                  </button>
                </div>
              </div>

              {/* Run history */}
              {ciRuns.length > 0 && (
                <div className="card">
                  <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <i className="ti ti-history" style={{ color: 'var(--accent)' }}/> CI Run History
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {(() => {
                      // Heal-run children (is_heal_run=1) are quick/full-verify re-runs spawned
                      // by auto-heal — they're steps of an existing attempt, not new pipeline
                      // triggers a user asked for, so they collapse under their root run instead
                      // of appearing as their own top-level history entries.
                      const runsById = new Map(ciRuns.map(x => [x.id, x]));
                      const rootRuns = ciRuns.filter(x => !x.is_heal_run);
                      const healChainFor = root => {
                        const chain = [];
                        const seen = new Set([root.id]);
                        let cur = root;
                        while (cur.heal_ci_run_id && runsById.has(cur.heal_ci_run_id) && !seen.has(cur.heal_ci_run_id)) {
                          cur = runsById.get(cur.heal_ci_run_id);
                          seen.add(cur.id);
                          chain.push(cur);
                        }
                        return chain;
                      };
                      const statusMap = { pending: ['#dbeafe','#1d4ed8'], queued: ['#dbeafe','#1d4ed8'], running: ['#fef9c3','#b45309'], in_progress: ['#fef9c3','#b45309'], completed: ['#dcfce7','#16a34a'], success: ['#dcfce7','#16a34a'], failed: ['#fee2e2','#dc2626'], failure: ['#fee2e2','#dc2626'], cancelled: ['#f1f5f9','#64748b'] };
                      return rootRuns.map(r => {
                      const healChain    = healChainFor(r);
                      const latestInChain = healChain[healChain.length - 1] || r;
                      const [bg, color] = statusMap[latestInChain.status] || statusMap.pending;
                      const isPolling  = ciPolling === r.id || ciPolling === latestInChain.id;
                      const isExpanded = ciExpandedRun === r.id;
                      const isChainExpanded = !!ciExpandedHealChain[r.id];
                      const vars = (() => { try { return JSON.parse(r.variables || '{}'); } catch { return {}; } })();
                      const healStatus = ciHealStates[r.id]?.status || r.heal_status;
                      const healActive = ['pending','diagnosing','applying_fix','rerunning','rerunning_full'].includes(healStatus);
                      return (
                        <div key={r.id} style={{ borderRadius: 8, background: '#f8fafc', border: '1px solid #e2e8f0', overflow: 'hidden' }}>
                          {/* Run row */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px' }}>
                            <i className={`ti ${r.provider === 'github' ? 'ti-brand-github' : r.provider === 'bitbucket' ? 'ti-brand-bitbucket' : 'ti-brand-gitlab'}`} style={{ fontSize: 14, color: r.provider === 'github' ? '#24292f' : r.provider === 'bitbucket' ? '#0052cc' : '#e24329', flexShrink: 0 }}/>
                            <span style={{ flex: 1, fontSize: 12, color: '#374151', fontWeight: 500 }}>{r.exec_result_dir ? r.exec_result_dir.replace(/\\/g, '/').split('/').pop() : (r.run_name || r.script_name || '—')}</span>
                            <span style={{ fontSize: 11, color: '#94a3b8' }}>{r.started_at?.slice(0, 16).replace('T', ' ')}</span>
                            <span style={{ padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 700, background: bg, color, display: 'flex', alignItems: 'center', gap: 4 }}
                              title={healChain.length ? `Latest of ${healChain.length} auto-heal attempt(s)` : undefined}>
                              {isPolling && <span className="spinner" style={{ width: 8, height: 8 }}/>}{latestInChain.status}
                            </span>
                            {/* Heal-attempts chain toggle */}
                            {healChain.length > 0 && (
                              <button className="btn-secondary btn-sm"
                                onClick={() => setCiExpandedHealChain(prev => ({ ...prev, [r.id]: !prev[r.id] }))}
                                style={{ padding: '2px 8px', fontSize: 11 }} title="Show/hide auto-heal attempts">
                                <i className={`ti ${isChainExpanded ? 'ti-chevron-up' : 'ti-git-branch'}`} style={{ fontSize: 11 }}/> {healChain.length}
                              </button>
                            )}
                            {/* Terminal toggle */}
                            <button className="btn-secondary btn-sm" onClick={() => setCiExpandedRun(isExpanded ? null : r.id)}
                              style={{ padding: '2px 8px', fontSize: 11 }} title="Show/hide execution log">
                              <i className={`ti ${isExpanded ? 'ti-chevron-up' : 'ti-terminal-2'}`} style={{ fontSize: 11 }}/>
                            </button>
                            {!isPolling && ['pending','queued','running','in_progress'].includes(latestInChain.status) && (
                              <button className="btn-secondary btn-sm" onClick={() => pollCiStatus(latestInChain.id)} style={{ padding: '2px 8px', fontSize: 11 }}>
                                <i className="ti ti-refresh"/>
                              </button>
                            )}
                            {['completed','success'].includes(latestInChain.status) && (
                              <button className="btn-secondary btn-sm"
                                style={{ padding: '2px 8px', fontSize: 11, color: '#16a34a', borderColor: '#86efac' }}
                                onClick={async () => {
                                  try {
                                    const { data } = await api.post(`/projects/${selectedProjectId}/ci/runs/${latestInChain.id}/sync-results`);
                                    if (data.already_synced) {
                                      toast('Already synced — results available in Analytics', 'info');
                                    } else {
                                      const shortPath = data.result_dir?.split(/[\\/]/).slice(-2).join('/') || data.message || 'disk';
                                      toast(`Results saved to ${shortPath}`, 'success');
                                    }
                                  } catch (e) { toast(e.response?.data?.error || 'Sync failed', 'error'); }
                                }}>
                                <i className="ti ti-download" style={{ fontSize: 11 }}/> Sync Results
                              </button>
                            )}
                            {latestInChain.web_url && (
                              <a href={latestInChain.web_url} target="_blank" rel="noreferrer"
                                style={{ fontSize: 11, color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: 3 }}>
                                <i className="ti ti-external-link" style={{ fontSize: 11 }}/> View
                              </a>
                            )}
                            {/* Heal button — shown when the run failed, or its heal chain gave up
                                (exhausted/failed/infra_error), regardless of whether this particular
                                row is itself a heal-run — a run's own heal attempts exhausting is
                                exactly when a manual "Heal Again" retry needs to be offered. */}
                            {(['failed','failure'].includes(r.status) || ['exhausted','failed','infra_error'].includes(healStatus)) &&
                              !healActive && (
                              <button className="btn-secondary btn-sm"
                                style={{ padding: '2px 8px', fontSize: 11, color: '#dc2626', borderColor: '#fca5a5' }}
                                onClick={() => setCiManualHeal(prev => ({ ...prev, [r.id]: { showing: true, text: '', loading: false } }))}>
                                <i className="ti ti-heart-rate-monitor" style={{ fontSize: 11 }}/>
                                {['failed','exhausted','infra_error'].includes(healStatus) ? ' Heal Again' : ' Heal'}
                              </button>
                            )}
                          </div>

                          {/* Auto-heal attempt chain — collapsed by default, one compact row
                              per quick/full-verify re-run spawned while healing this run. */}
                          {isChainExpanded && healChain.length > 0 && (
                            <div style={{ padding: '6px 12px 8px 34px', borderTop: '1px solid #e2e8f0', background: '#fbfdff', display: 'flex', flexDirection: 'column', gap: 4 }}>
                              {healChain.map((h, i) => {
                                const [hbg, hcolor] = statusMap[h.status] || statusMap.pending;
                                return (
                                  <div key={h.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
                                    <i className="ti ti-corner-down-right" style={{ fontSize: 11, color: '#94a3b8' }}/>
                                    <span style={{ color: '#64748b' }}>Attempt {i + 1} — {h.run_name || h.script_name || `Run #${h.id}`}</span>
                                    <span style={{ color: '#94a3b8' }}>{h.started_at?.slice(0, 16).replace('T', ' ')}</span>
                                    <span style={{ padding: '1px 7px', borderRadius: 20, fontSize: 9, fontWeight: 700, background: hbg, color: hcolor }}>{h.status}</span>
                                    {h.web_url && (
                                      <a href={h.web_url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: 3 }}>
                                        <i className="ti ti-external-link" style={{ fontSize: 10 }}/> View
                                      </a>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}

                          {/* Manual Heal inline form */}
                          {ciManualHeal[r.id]?.showing && !['pending','diagnosing','applying_fix','rerunning','rerunning_full'].includes(ciHealStates[r.id]?.status) && (
                            <div style={{ padding: '10px 12px', borderTop: '1px solid #e2e8f0', background: '#fafafa' }}>
                              <div style={{ fontSize: 11, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
                                Describe what to fix — AI will apply it and re-run the pipeline
                              </div>
                              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                                <textarea
                                  value={ciManualHeal[r.id]?.text || ''}
                                  onChange={e => setCiManualHeal(prev => ({ ...prev, [r.id]: { ...prev[r.id], text: e.target.value } }))}
                                  placeholder="e.g. The login endpoint changed to /api/v2/auth — update all request paths accordingly"
                                  rows={2}
                                  style={{ flex: 1, fontSize: 12, padding: '7px 10px', borderRadius: 6,
                                    border: '1px solid var(--color-border)', background: 'var(--color-background)',
                                    color: 'var(--color-text)', fontFamily: 'inherit', resize: 'vertical',
                                    boxSizing: 'border-box', outline: 'none', minHeight: 60 }}
                                />
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                  <button className="btn-primary btn-sm"
                                    disabled={!ciManualHeal[r.id]?.text?.trim() || ciManualHeal[r.id]?.loading}
                                    style={{ padding: '6px 14px', fontSize: 11, whiteSpace: 'nowrap' }}
                                    onClick={async () => {
                                      const instruction = ciManualHeal[r.id]?.text?.trim();
                                      if (!instruction) return;
                                      setCiManualHeal(prev => ({ ...prev, [r.id]: { ...prev[r.id], loading: true } }));
                                      try {
                                        await api.post(`/projects/${selectedProjectId}/ci/runs/${r.id}/heal`, { instruction });
                                        setCiManualHeal(prev => ({ ...prev, [r.id]: { showing: false, text: '', loading: false } }));
                                        startCiHealPolling(r.id);
                                      } catch (e) {
                                        toast(e.response?.data?.error || 'Failed to start heal', 'error');
                                        setCiManualHeal(prev => ({ ...prev, [r.id]: { ...prev[r.id], loading: false } }));
                                      }
                                    }}>
                                    {ciManualHeal[r.id]?.loading ? <><span className="spinner"/> Healing…</> : <><i className="ti ti-heart-rate-monitor"/> Heal</>}
                                  </button>
                                  <button className="btn-secondary btn-sm"
                                    style={{ padding: '4px 14px', fontSize: 11 }}
                                    onClick={() => setCiManualHeal(prev => ({ ...prev, [r.id]: { showing: false, text: '', loading: false } }))}>
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            </div>
                          )}

                          {/* CI Heal Status Panel */}
                          {(ciHealStates[r.id]?.status || r.heal_status) && (() => {
                            const hs = ciHealStates[r.id] || { status: r.heal_status, heal_ci_run_id: r.heal_ci_run_id, heal_summary: r.heal_summary, logs: [] };
                            const isActive = ['pending','diagnosing','applying_fix','rerunning','rerunning_full'].includes(hs.status);
                            const accentColor = hs.status === 'healed' ? '#16a34a' : hs.status === 'infra_error' ? '#f59e0b' : isActive ? 'var(--accent)' : '#dc2626';
                            const hasDetails = hs.logs?.length > 0 || (hs.status === 'exhausted' && hs.heal_summary);
                            // Defaults to expanded (undefined !== true) so a heal in progress or a
                            // freshly-loaded exhausted run still shows details right away — collapsing
                            // is an explicit user action, not the default state.
                            const isPanelCollapsed = hasDetails && ciHealPanelCollapsed[r.id] === true;
                            return (
                              <div style={{ padding: '10px 12px', borderTop: '1px solid #e2e8f0', background: '#f0f9ff', borderLeft: `3px solid ${accentColor}` }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: (hasDetails && !isPanelCollapsed) ? 10 : 0 }}>
                                  <i className={`ti ${hs.status === 'healed' ? 'ti-circle-check' : ['failed','exhausted'].includes(hs.status) ? 'ti-circle-x' : 'ti-loader'}`}
                                    style={{ fontSize: 15, color: accentColor, animation: isActive ? 'spin 1s linear infinite' : 'none' }}/>
                                  <div style={{ fontSize: 12, fontWeight: 600, color: '#0f172a', flex: 1 }}>
                                    Auto Heal —{' '}
                                    {hs.status === 'pending'        && 'Queued…'}
                                    {hs.status === 'diagnosing'     && 'AI diagnosing failure…'}
                                    {hs.status === 'applying_fix'   && 'Applying fix to script…'}
                                    {hs.status === 'rerunning'      && 'Re-running quick verify on Bitbucket…'}
                                    {hs.status === 'rerunning_full' && 'Quick verify passed — running full test…'}
                                    {hs.status === 'healed'         && 'Issue fixed and CI test passed!'}
                                    {hs.status === 'failed'         && 'Could not fix automatically'}
                                    {hs.status === 'exhausted'      && 'Auto-heal attempt unsuccessful — use "Heal Again" below for a targeted retry'}
                                    {hs.status === 'infra_error'    && 'Server/infrastructure failure — script changes cannot fix this'}
                                  </div>
                                  {hasDetails && (
                                    <button className="btn-secondary btn-sm"
                                      onClick={() => setCiHealPanelCollapsed(prev => ({ ...prev, [r.id]: !isPanelCollapsed }))}
                                      style={{ padding: '2px 8px', fontSize: 11 }}
                                      title={isPanelCollapsed ? 'Show auto-heal details' : 'Hide auto-heal details'}>
                                      <i className={`ti ${isPanelCollapsed ? 'ti-chevron-down' : 'ti-chevron-up'}`} style={{ fontSize: 11 }}/>
                                    </button>
                                  )}
                                </div>
                                {!isPanelCollapsed && hs.logs?.length > 0 && (
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                    {hs.logs.map((l, i) => (
                                      <div key={i} style={{ background: '#fff', borderRadius: 6, padding: '8px 10px', fontSize: 11, border: '1px solid #e2e8f0' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                                          <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 4, background: l.result === 'healed' ? '#16a34a' : ['failed','no_fix','still_failing'].includes(l.result) ? '#dc2626' : '#64748b', color: '#fff' }}>
                                            Attempt {i + 1}
                                          </span>
                                          <span style={{ fontSize: 10, color: '#64748b' }}>{l.fix_type === 'script_rewrite' ? 'Script rewrite' : l.fix_type === 'no_fix' ? 'No fix found' : l.fix_type || ''}</span>
                                        </div>
                                        {l.diagnosis && <div style={{ marginBottom: 2 }}><span style={{ color: '#b45309', fontWeight: 600 }}>Issue: </span>{l.diagnosis}</div>}
                                        {l.fix_applied && <div><span style={{ color: '#16a34a', fontWeight: 600 }}>Fix: </span>{l.fix_applied}</div>}
                                      </div>
                                    ))}
                                  </div>
                                )}
                                {!isPanelCollapsed && hs.status === 'exhausted' && hs.heal_summary && (
                                  <div style={{ marginTop: 8, padding: '8px 10px', background: '#fff7ed', borderRadius: 6, border: '1px solid #fed7aa', fontSize: 11 }}>
                                    <div style={{ fontWeight: 700, color: '#c2410c', marginBottom: 5 }}>Exhaustion Summary</div>
                                    <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'inherit', color: '#374151', lineHeight: 1.5 }}>{hs.heal_summary}</pre>
                                  </div>
                                )}
                              </div>
                            );
                          })()}

                          {/* Expandable terminal */}
                          {isExpanded && (() => {
                            const stepsData = ciSteps[r.id];
                            const steps     = stepsData?.steps || [];
                            const job       = stepsData?.job;
                            const stepIcon  = s => {
                              if (s.status === 'in_progress') return { icon: '⟳', color: '#f59e0b' };
                              if (s.conclusion === 'success')  return { icon: '✔', color: '#3fb950' };
                              if (s.conclusion === 'failure')  return { icon: '✘', color: '#f85149' };
                              if (s.conclusion === 'skipped')  return { icon: '⊘', color: '#8b949e' };
                              return { icon: '○', color: '#484f58' };
                            };
                            return (
                              <div style={{ borderTop: '1px solid #21262d', background: '#0d1117', padding: '10px 14px', fontFamily: '"Fira Mono",Consolas,monospace', fontSize: 11, maxHeight: 320, overflowY: 'auto' }}>
                                {/* Header */}
                                <div style={{ color: '#58a6ff', marginBottom: 8, fontSize: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
                                  <span>── CI Pipeline Execution Log ──</span>
                                  {['running','in_progress'].includes(r.status) && (
                                    <span style={{ color: '#f59e0b', animation: 'pulse 1s infinite' }}>● LIVE</span>
                                  )}
                                </div>

                                {/* Trigger info */}
                                <div style={{ color: '#8b949e', marginBottom: 6 }}>
                                  <div>{r.started_at?.replace('T',' ').slice(0,19)}  Triggered on <span style={{ color: '#c9d1d9' }}>{r.provider === 'github' ? 'GitHub Actions' : r.provider === 'bitbucket' ? 'Bitbucket Pipelines' : 'GitLab CI'}</span></div>
                                  {r.external_id && <div>Run ID: <span style={{ color: '#58a6ff' }}>#{r.external_id}</span>  {job?.runner_name ? `· Runner: ${job.runner_name}` : ''}</div>}
                                </div>

                                {/* Test params */}
                                {vars.jmeter_users && (
                                  <div style={{ color: '#8b949e', borderLeft: '2px solid #21262d', paddingLeft: 8, marginBottom: 8 }}>
                                    <div>Run      <span style={{ color: '#e6edf3' }}>{r.run_name || r.script_name}</span></div>
                                    <div>Users    <span style={{ color: '#e6edf3' }}>{vars.jmeter_users}</span>  Ramp <span style={{ color: '#e6edf3' }}>{vars.jmeter_rampup}s</span>  {vars.jmeter_duration > 0 ? <>Duration <span style={{ color: '#e6edf3' }}>{vars.jmeter_duration}s</span></> : <>Loops <span style={{ color: '#e6edf3' }}>{vars.jmeter_loops}</span></>}</div>
                                  </div>
                                )}

                                {/* Live steps */}
                                {steps.length > 0 ? (
                                  <div style={{ marginBottom: 8 }}>
                                    <div style={{ color: '#484f58', fontSize: 10, marginBottom: 4 }}>── Steps ──</div>
                                    {steps.map((s, i) => {
                                      const ic = stepIcon(s);
                                      const dur = s.duration_s != null ? ` (${s.duration_s}s)` : '';
                                      const startTs = s.started_at ? s.started_at.replace('T',' ').slice(0,19) : '';
                                      return (
                                        <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 2 }}>
                                          <span style={{ color: ic.color, width: 12, flexShrink: 0 }}>{ic.icon}</span>
                                          <span style={{ color: '#e6edf3', flex: 1 }}>{s.name}</span>
                                          {startTs && <span style={{ color: '#484f58', fontSize: 10 }}>{startTs}{dur}</span>}
                                        </div>
                                      );
                                    })}
                                  </div>
                                ) : (
                                  <div style={{ color: '#484f58', marginBottom: 8 }}>
                                    {['running','in_progress','queued','pending'].includes(r.status)
                                      ? `⟳ Fetching live steps from ${r.provider === 'gitlab' ? 'GitLab' : r.provider === 'bitbucket' ? 'Bitbucket' : 'GitHub'}…`
                                      : 'No step details available'}
                                  </div>
                                )}

                                {/* Status + finish time — this panel is the ROOT run's own log,
                                    so its status line reflects r's own outcome, not the heal
                                    chain's latest (which the header badge above shows instead). */}
                                <div style={{ color: '#8b949e', borderTop: '1px solid #21262d', paddingTop: 6 }}>
                                  <span>Status: </span><span style={{ color: (statusMap[r.status] || statusMap.pending)[1] }}>{r.status.toUpperCase()}</span>
                                  {r.finished_at && <span style={{ color: '#484f58' }}>  · Finished: {r.finished_at?.replace('T',' ').slice(0,19)}</span>}
                                </div>

                                {/* GitHub link */}
                                {(r.web_url || job?.html_url) && (
                                  <div style={{ marginTop: 6 }}>
                                    <a href={job?.html_url || r.web_url} target="_blank" rel="noreferrer" style={{ color: '#58a6ff', fontSize: 10 }}>
                                      → View full step logs on {r.provider === 'github' ? 'GitHub' : r.provider === 'bitbucket' ? 'Bitbucket' : 'GitLab'} ↗
                                    </a>
                                  </div>
                                )}
                              </div>
                            );
                          })()}
                        </div>
                      );
                      });
                    })()}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── Local Test Run tab ───────────────────────────────────────────── */}
      {runTab === 'single' && <>

      {/* ── Local/native execution UI — retired, backend routes return 410.
          Hidden (not deleted) per the CI-pipeline-only migration; wrap in
          {false && ...} so it's easy to find/restore later if needed. ── */}
      {false && <>
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
            {depsChecked && missingDeps.length > 0 && (
              <button className="btn-primary btn-sm" onClick={() => installDep('docker')} disabled={!!installingDep}>
                {installingDep === 'docker'
                  ? <><span className="spinner" />Installing...</>
                  : <><i className="ti ti-download" />Install Docker</>}
              </button>
            )}
          </div>
        </div>

        {depsChecked && deps.length > 0 && (
          <div>
            {deps.map(d => (
              <div key={d.name} className="dep-row">
                <i className={`ti ${d.status === 'ok' ? 'ti-circle-check dep-ok' : 'ti-circle-x dep-missing'}`} style={{ fontSize: '16px' }} />
                <div className="dep-name">
                  <i className="ti ti-brand-docker" style={{ marginRight: 5, color: '#2496ed', fontSize: 13 }}/>
                  Docker Desktop
                </div>
                {d.version && <div className="dep-version">{d.version}</div>}
                <span className={`badge ${d.status === 'ok' ? 'tag-green' : 'tag-red'}`}>
                  {d.status === 'ok' ? 'Running' : 'Not Running'}
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
          All tests run inside Docker containers — configure the image below.
        </div>

        {/* Docker Image — used for both local pulls and generated CI YAML */}
        <div style={{ marginTop: '16px', paddingTop: '14px', borderTop: '1px solid var(--color-border-secondary)' }}>
          <div style={{ fontWeight: 600, fontSize: '13px', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <i className="ti ti-brand-docker" style={{ color: '#0ea5e9', fontSize: '14px' }} />
            Docker Image
          </div>
          <div style={{ fontSize: '12px', color: 'var(--color-text-secondary)', marginBottom: '12px' }}>
            Contains JMeter, K6, Java and Node.js. The image name here is also embedded in generated CI YAML files — update it before generating YAML if you use a custom image. Pull is only needed for local execution; cloud CI pulls automatically on the runner.
          </div>
          <div style={{ display: 'flex', gap: '6px', maxWidth: 520, marginBottom: '10px' }}>
            <input
              type="text"
              value={jmeterDockerImage}
              onChange={e => setJmeterDockerImage(e.target.value)}
              placeholder="tasleemzaif/Peako:latest"
              style={{ flex: 1, minWidth: 0 }}
            />
            <button
              className="btn-primary btn-sm"
              onClick={() => pullImage('jmeter')}
              disabled={!!pullingImage || !jmeterDockerImage.trim() || (depsChecked && deps[0]?.status !== 'ok')}
              style={{ whiteSpace: 'nowrap' }}
              title={depsChecked && deps[0]?.status !== 'ok' ? 'Start Docker Desktop first to pull locally' : 'docker pull'}
            >
              {pullingImage === 'jmeter' ? <><span className="spinner" />Pulling...</> : <><i className="ti ti-download" />Pull</>}
            </button>
          </div>
          <button className="btn-secondary btn-sm" onClick={saveDockerImages}>
            <i className="ti ti-device-floppy" /> Save Image
          </button>
          {depsChecked && deps[0]?.status !== 'ok' && (
            <div style={{ marginTop: '8px', fontSize: '11px', color: 'var(--warn)', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <i className="ti ti-alert-triangle" />
              Docker Desktop is not running — Pull is disabled. Check Docker above first, or use cloud CI which pulls automatically.
            </div>
          )}
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
                {healState.status === 'exhausted'     && 'Auto-heal attempt unsuccessful — re-run the test to try again'}
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
                      Attempt {i + 1}
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
          {healState?.status === 'exhausted' && healState?.heal_summary && (
            <div style={{ marginTop: '10px', padding: '10px 12px', background: 'var(--color-background-secondary)', borderRadius: '6px', border: '1px solid var(--warn)', fontSize: '12px' }}>
              <div style={{ fontWeight: 700, color: 'var(--warn)', marginBottom: '6px' }}>Exhaustion Summary</div>
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'inherit', color: 'var(--color-text-primary)', lineHeight: 1.55 }}>{healState.heal_summary}</pre>
            </div>
          )}
        </div>
      )}
      </>}

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
      </> /* end single tab */}
    </div>
  );
}
