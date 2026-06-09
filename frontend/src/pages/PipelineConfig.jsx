import { useState, useEffect } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import { useToast } from '../hooks/useToast';

const DEFAULT_FORM = { name: '', description: '', steps: [], stop_on_failure: true, environment: '' };

const DEFAULT_CI = {
  gitlab_enabled: false, gitlab_url: 'https://gitlab.com', gitlab_project_id: '',
  gitlab_token: '', gitlab_ref: 'main',
  github_enabled: false, github_repo: '', github_token: '',
  github_workflow_file: 'perf-test.yml', github_ref: 'main',
};

function StepRow({ step, index, total, onRemove, onMoveUp, onMoveDown }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, marginBottom: 6 }}>
      <span style={{ width: 22, height: 22, borderRadius: '50%', background: '#e0e7ff', color: '#4338ca', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, flexShrink: 0 }}>{index + 1}</span>
      <i className="ti ti-test-pipe" style={{ color: '#4338ca', fontSize: 14, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a' }}>{step.name}</div>
        {step.engine && <div style={{ fontSize: 11, color: '#64748b' }}>{step.engine.toUpperCase()} · {step.test_type || 'load'}</div>}
      </div>
      <div style={{ display: 'flex', gap: 4 }}>
        <button onClick={() => onMoveUp(index)} disabled={index === 0} className="btn-secondary btn-sm" style={{ padding: '3px 7px' }}><i className="ti ti-arrow-up" style={{ fontSize: 11 }} /></button>
        <button onClick={() => onMoveDown(index)} disabled={index === total - 1} className="btn-secondary btn-sm" style={{ padding: '3px 7px' }}><i className="ti ti-arrow-down" style={{ fontSize: 11 }} /></button>
        <button onClick={() => onRemove(index)} className="btn-secondary btn-sm" style={{ padding: '3px 7px', color: '#ef4444', borderColor: 'rgba(239,68,68,0.3)' }}><i className="ti ti-x" style={{ fontSize: 11 }} /></button>
      </div>
    </div>
  );
}

export default function PipelineConfig({ project, envs, user }) {
  const { toast } = useToast();
  const [configTab,  setConfigTab]  = useState('local'); // 'local' | 'ci'
  const [pipelines, setPipelines]   = useState([]);
  const [suites,    setSuites]      = useState([]);
  const [modal,     setModal]       = useState(null);
  const [form,      setForm]        = useState(DEFAULT_FORM);
  const [saving,    setSaving]      = useState(false);
  const [runs,      setRuns]        = useState({});
  const [running,   setRunning]     = useState(null);

  // CI/CD config state
  const [ciForm,       setCiForm]       = useState(DEFAULT_CI);
  const [ciSaving,     setCiSaving]     = useState(false);
  const [ciTesting,    setCiTesting]    = useState(null); // 'gitlab'|'github'
  const [ciTestResult, setCiTestResult] = useState({});
  const [ciCreatingToken, setCiCreatingToken] = useState(false);
  const [ciGenerating, setCiGenerating] = useState(false);
  const [ciConfig,     setCiConfig]     = useState(null); // loaded from DB

  useEffect(() => {
    if (!project?.id) return;
    load();
    api.get(`/projects/${project.id}/test-suites`).then(r => setSuites(r.data.suites || [])).catch(() => {});
    api.get(`/projects/${project.id}/ci/config`)
      .then(({ data }) => {
        if (data.config) {
          setCiConfig(data.config);
          setCiForm(f => ({
            ...f,
            gitlab_enabled: !!data.config.gitlab_enabled,
            gitlab_url: data.config.gitlab_url || 'https://gitlab.com',
            gitlab_project_id: data.config.gitlab_project_id || '',
            gitlab_ref: data.config.gitlab_ref || 'main',
            github_enabled: !!data.config.github_enabled,
            github_repo: data.config.github_repo || '',
            github_workflow_file: data.config.github_workflow_file || 'perf-test.yml',
            github_ref: data.config.github_ref || 'main',
          }));
        }
      }).catch(() => {});
  }, [project?.id]);

  function load() {
    api.get(`/projects/${project.id}/pipelines`).then(r => setPipelines(r.data.pipelines || [])).catch(() => {});
  }

  function openAdd() {
    setForm(DEFAULT_FORM);
    setModal('add');
  }

  function openEdit(p) {
    setForm({ name: p.name, description: p.description || '', steps: JSON.parse(p.steps || '[]'), stop_on_failure: !!p.stop_on_failure, environment: p.environment || '' });
    setModal(p);
  }

  async function save() {
    if (!form.name.trim()) return toast('Pipeline name is required', 'warn');
    setSaving(true);
    try {
      if (modal === 'add') await api.post(`/projects/${project.id}/pipelines`, form);
      else await api.put(`/projects/${project.id}/pipelines/${modal.id}`, form);
      toast(modal === 'add' ? 'Pipeline created' : 'Pipeline updated', 'success');
      setModal(null);
      load();
    } catch (e) { toast(e.response?.data?.error || 'Save failed', 'error'); }
    finally { setSaving(false); }
  }

  async function deletePipeline(id) {
    if (!window.confirm('Delete this pipeline?')) return;
    await api.delete(`/projects/${project.id}/pipelines/${id}`).catch(() => {});
    toast('Pipeline deleted', 'success');
    load();
  }

  async function runPipeline(pipeline) {
    setRunning(pipeline.id);
    try {
      const { data } = await api.post(`/projects/${project.id}/pipelines/${pipeline.id}/run`);
      toast(`Pipeline "${pipeline.name}" started`, 'success');
      // Refresh run history
      loadRuns(pipeline.id);
    } catch (e) { toast(e.response?.data?.error || 'Run failed', 'error'); }
    finally { setRunning(null); }
  }

  async function loadRuns(pipelineId) {
    const { data } = await api.get(`/projects/${project.id}/pipelines/${pipelineId}/runs`).catch(() => ({ data: { runs: [] } }));
    setRuns(prev => ({ ...prev, [pipelineId]: data.runs || [] }));
  }

  function addStep(suite) {
    if (form.steps.find(s => s.suite_id === suite.id)) return;
    setForm(f => ({ ...f, steps: [...f.steps, { suite_id: suite.id, name: suite.name, engine: suite.engine, test_type: suite.test_type }] }));
  }

  function removeStep(i) { setForm(f => ({ ...f, steps: f.steps.filter((_, idx) => idx !== i) })); }
  function moveUp(i)      { if (i === 0) return; const s = [...form.steps]; [s[i-1], s[i]] = [s[i], s[i-1]]; setForm(f => ({ ...f, steps: s })); }
  function moveDown(i)    { if (i === form.steps.length - 1) return; const s = [...form.steps]; [s[i], s[i+1]] = [s[i+1], s[i]]; setForm(f => ({ ...f, steps: s })); }

  const availableSuites = suites.filter(s => !form.steps.find(st => st.suite_id === s.id));

  // ── CI/CD helpers ─────────────────────────────────────────────────────────
  async function saveCiConfig() {
    setCiSaving(true);
    try {
      await api.put(`/projects/${project.id}/ci/config`, ciForm);
      toast('CI/CD configuration saved', 'success');
      const { data } = await api.get(`/projects/${project.id}/ci/config`);
      if (data.config) setCiConfig(data.config);
    } catch (e) { toast(e.response?.data?.error || 'Save failed', 'error'); }
    finally { setCiSaving(false); }
  }

  async function testCiConnection(provider) {
    setCiTesting(provider);
    setCiTestResult(r => ({ ...r, [provider]: null }));
    try {
      // Save first so the token is stored
      await api.put(`/projects/${project.id}/ci/config`, ciForm);
      const { data } = await api.post(`/projects/${project.id}/ci/config/test`, { provider });
      setCiTestResult(r => ({ ...r, [provider]: { ok: true, message: data.message } }));
    } catch (e) { setCiTestResult(r => ({ ...r, [provider]: { ok: false, message: e.response?.data?.error || 'Connection failed' } })); }
    finally { setCiTesting(null); }
  }

  async function createTriggerToken() {
    setCiCreatingToken(true);
    try {
      await api.put(`/projects/${project.id}/ci/config`, ciForm);
      const { data } = await api.post(`/projects/${project.id}/ci/config/trigger-token`);
      toast(data.message, 'success');
      const cfg = await api.get(`/projects/${project.id}/ci/config`);
      if (cfg.data.config) setCiConfig(cfg.data.config);
    } catch (e) { toast(e.response?.data?.error || 'Failed to create trigger token', 'error'); }
    finally { setCiCreatingToken(false); }
  }

  async function generateYaml() {
    setCiGenerating(true);
    try {
      await api.put(`/projects/${project.id}/ci/config`, ciForm);
      const providers = [];
      if (ciForm.gitlab_enabled) providers.push('gitlab');
      if (ciForm.github_enabled) providers.push('github');
      if (!providers.length) providers.push('gitlab', 'github');
      const { data } = await api.post(`/projects/${project.id}/ci/generate-yaml`, { providers });
      toast(data.message || `Generated: ${data.created?.join(', ')}`, 'success');
    } catch (e) { toast(e.response?.data?.error || 'Generation failed', 'error'); }
    finally { setCiGenerating(false); }
  }

  function StatusBadge({ status }) {
    const map = { running: ['#dbeafe','#1d4ed8'], completed: ['#dcfce7','#16a34a'], failed: ['#fee2e2','#dc2626'], pending: ['#f1f5f9','#64748b'] };
    const [bg, color] = map[status] || map.pending;
    return <span style={{ padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 700, background: bg, color }}>{status}</span>;
  }

  const ciInputStyle = { width: '100%', padding: '7px 10px', borderRadius: 6, border: '1px solid var(--color-border-secondary)', background: 'var(--input-bg)', color: 'var(--color-text-primary)', fontSize: 13, fontFamily: 'inherit' };

  return (
    <div className="page fade-in">

      {/* ── Tab switcher — CI/CD tab only visible to Org Admin ──────── */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '2px solid #e2e8f0' }}>
        {[
          { id: 'local', icon: 'ti-git-merge',   label: 'Local Pipelines',   show: true },
          { id: 'ci',    icon: 'ti-brand-gitlab', label: 'CI/CD Integration', show: user?.role === 'org_admin' || user?.role === 'super_admin' },
        ].filter(t => t.show).map(t => (
          <button key={t.id} onClick={() => setConfigTab(t.id)}
            style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '8px 16px', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: configTab === t.id ? 700 : 500, background: 'transparent', color: configTab === t.id ? 'var(--accent)' : 'var(--color-text-secondary)', borderBottom: configTab === t.id ? '2px solid var(--accent)' : '2px solid transparent', marginBottom: -2, transition: 'all .12s' }}>
            <i className={`ti ${t.icon}`} style={{ fontSize: 14 }}/>{t.label}
          </button>
        ))}
      </div>

      {/* ── CI/CD Integration tab ─────────────────────────────────────── */}
      {configTab === 'ci' && (
        <div>
          <div style={{ marginBottom: 16, padding: '12px 16px', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, fontSize: 13, color: '#1d4ed8' }}>
            <i className="ti ti-info-circle" style={{ marginRight: 6 }}/>
            Configure GitLab or GitHub to run JMeter tests on their infrastructure. After saving settings, generate the YAML file, commit + push it, then trigger from the <strong>Run Test</strong> page.
          </div>

          {/* ── GitLab ─────────────────────────────────────────── */}
          <div style={{ border: '1px solid #e2e8f0', borderRadius: 12, padding: '20px', marginBottom: 16, background: '#fff' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
              <div style={{ width: 36, height: 36, borderRadius: 9, background: '#fce7f3', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <i className="ti ti-brand-gitlab" style={{ color: '#e24329', fontSize: 18 }}/>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: '#0f172a' }}>GitLab CI/CD</div>
                <div style={{ fontSize: 12, color: '#64748b' }}>Trigger pipelines on GitLab.com or self-hosted GitLab</div>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
                <input type="checkbox" checked={ciForm.gitlab_enabled} onChange={e => setCiForm(f => ({ ...f, gitlab_enabled: e.target.checked }))} style={{ width: 16, height: 16, accentColor: 'var(--accent)', cursor: 'pointer' }}/>
                Enable
              </label>
            </div>

            {ciForm.gitlab_enabled && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div className="form-group" style={{ margin: 0 }}>
                    <label className="form-label">GitLab URL</label>
                    <input style={ciInputStyle} value={ciForm.gitlab_url} onChange={e => setCiForm(f => ({ ...f, gitlab_url: e.target.value }))} placeholder="https://gitlab.com" />
                  </div>
                  <div className="form-group" style={{ margin: 0 }}>
                    <label className="form-label">Project ID or Path</label>
                    <input style={ciInputStyle} value={ciForm.gitlab_project_id} onChange={e => setCiForm(f => ({ ...f, gitlab_project_id: e.target.value }))} placeholder="123456 or org/repo" />
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div className="form-group" style={{ margin: 0 }}>
                    <label className="form-label">Personal Access Token <span style={{ color: '#94a3b8', fontWeight: 400 }}>(api scope)</span></label>
                    <input style={ciInputStyle} type="password" autoComplete="off" value={ciForm.gitlab_token} onChange={e => setCiForm(f => ({ ...f, gitlab_token: e.target.value }))} placeholder={ciConfig?.gitlab_token_set ? '(saved — enter new to replace)' : 'glpat-xxxxxxxxxxxx'} />
                  </div>
                  <div className="form-group" style={{ margin: 0 }}>
                    <label className="form-label">Branch / Ref</label>
                    <input style={ciInputStyle} value={ciForm.gitlab_ref} onChange={e => setCiForm(f => ({ ...f, gitlab_ref: e.target.value }))} placeholder="main" />
                  </div>
                </div>

                {/* Trigger token */}
                <div style={{ padding: '12px 14px', background: '#f8fafc', borderRadius: 8, border: '1px solid #e2e8f0' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a' }}>Trigger Token</div>
                      <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
                        {ciConfig?.gitlab_trigger_token_set ? '✅ Trigger token saved' : 'Required to trigger pipelines. Click Create to generate one automatically.'}
                      </div>
                    </div>
                    <button className="btn-secondary btn-sm" onClick={createTriggerToken} disabled={ciCreatingToken || !ciForm.gitlab_project_id}>
                      {ciCreatingToken ? <><span className="spinner"/> Creating…</> : <><i className="ti ti-key"/> {ciConfig?.gitlab_trigger_token_set ? 'Regenerate' : 'Create Token'}</>}
                    </button>
                  </div>
                </div>

                {/* Test + result */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <button className="btn-secondary btn-sm" onClick={() => testCiConnection('gitlab')} disabled={ciTesting === 'gitlab'}>
                    {ciTesting === 'gitlab' ? <><span className="spinner"/> Testing…</> : <><i className="ti ti-wifi"/> Test Connection</>}
                  </button>
                  {ciTestResult.gitlab && (
                    <span style={{ fontSize: 12, color: ciTestResult.gitlab.ok ? '#16a34a' : '#dc2626', display: 'flex', alignItems: 'center', gap: 4 }}>
                      <i className={`ti ${ciTestResult.gitlab.ok ? 'ti-circle-check' : 'ti-circle-x'}`}/>
                      {ciTestResult.gitlab.message}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* ── GitHub Actions ─────────────────────────────────── */}
          <div style={{ border: '1px solid #e2e8f0', borderRadius: 12, padding: '20px', marginBottom: 16, background: '#fff' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
              <div style={{ width: 36, height: 36, borderRadius: 9, background: '#f0fdf4', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <i className="ti ti-brand-github" style={{ color: '#24292f', fontSize: 18 }}/>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: '#0f172a' }}>GitHub Actions</div>
                <div style={{ fontSize: 12, color: '#64748b' }}>Trigger workflow_dispatch on GitHub.com</div>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
                <input type="checkbox" checked={ciForm.github_enabled} onChange={e => setCiForm(f => ({ ...f, github_enabled: e.target.checked }))} style={{ width: 16, height: 16, accentColor: 'var(--accent)', cursor: 'pointer' }}/>
                Enable
              </label>
            </div>

            {ciForm.github_enabled && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div className="form-group" style={{ margin: 0 }}>
                    <label className="form-label">Repository <span style={{ color: '#94a3b8', fontWeight: 400 }}>(owner/repo)</span></label>
                    <input style={ciInputStyle} value={ciForm.github_repo} onChange={e => setCiForm(f => ({ ...f, github_repo: e.target.value }))} placeholder="org/perf-studio" />
                  </div>
                  <div className="form-group" style={{ margin: 0 }}>
                    <label className="form-label">Personal Access Token <span style={{ color: '#94a3b8', fontWeight: 400 }}>(workflow scope)</span></label>
                    <input style={ciInputStyle} type="password" autoComplete="off" value={ciForm.github_token} onChange={e => setCiForm(f => ({ ...f, github_token: e.target.value }))} placeholder={ciConfig?.github_token_set ? '(saved — enter new to replace)' : 'ghp_xxxxxxxxxxxx'} />
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div className="form-group" style={{ margin: 0 }}>
                    <label className="form-label">Workflow file</label>
                    <input style={ciInputStyle} value={ciForm.github_workflow_file} onChange={e => setCiForm(f => ({ ...f, github_workflow_file: e.target.value }))} placeholder="perf-test.yml" />
                  </div>
                  <div className="form-group" style={{ margin: 0 }}>
                    <label className="form-label">Branch / Ref</label>
                    <input style={ciInputStyle} value={ciForm.github_ref} onChange={e => setCiForm(f => ({ ...f, github_ref: e.target.value }))} placeholder="main" />
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <button className="btn-secondary btn-sm" onClick={() => testCiConnection('github')} disabled={ciTesting === 'github'}>
                    {ciTesting === 'github' ? <><span className="spinner"/> Testing…</> : <><i className="ti ti-wifi"/> Test Connection</>}
                  </button>
                  {ciTestResult.github && (
                    <span style={{ fontSize: 12, color: ciTestResult.github.ok ? '#16a34a' : '#dc2626', display: 'flex', alignItems: 'center', gap: 4 }}>
                      <i className={`ti ${ciTestResult.github.ok ? 'ti-circle-check' : 'ti-circle-x'}`}/>
                      {ciTestResult.github.message}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* ── Actions ───────────────────────────────────────── */}
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn-primary" onClick={saveCiConfig} disabled={ciSaving}>
              {ciSaving ? <><span className="spinner"/> Saving…</> : <><i className="ti ti-device-floppy"/> Save Settings</>}
            </button>
            <button className="btn-secondary" onClick={generateYaml} disabled={ciGenerating} title="Generates .gitlab-ci.yml and/or .github/workflows/perf-test.yml in your workspace">
              {ciGenerating ? <><span className="spinner"/> Generating…</> : <><i className="ti ti-file-code"/> Generate &amp; Commit YAML Files</>}
            </button>
          </div>
          <div style={{ marginTop: 10, padding: '10px 14px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, fontSize: 12, color: '#92400e' }}>
            <i className="ti ti-alert-triangle" style={{ marginRight: 6 }}/>
            <strong>Important:</strong> YAML files are generated into the <strong>admin workspace</strong> and must be committed and pushed by an <strong>Org Admin</strong> whose GitHub PAT has the <strong>"workflow" scope</strong> enabled.
            Regular user PATs will be rejected by GitHub when pushing <code>.github/workflows/</code> files.
            <br/><br/>
            To add workflow scope: GitHub → Settings → Developer Settings → Personal Access Tokens → edit token → tick <strong>workflow</strong> → Save → update your PAT in Git Identity.
          </div>
        </div>
      )}

      {/* ── Local Pipelines tab ───────────────────────────────────────── */}
      {configTab === 'local' && <>
      {pipelines.length === 0 ? (
        <div className="empty">
          <i className="ti ti-git-merge" />
          <div className="empty-title">No pipelines yet</div>
          <div className="empty-sub">Create a pipeline to run multiple test plans in sequence</div>
          <button className="btn-primary" style={{ marginTop: 16 }} onClick={openAdd}>
            <i className="ti ti-plus" /> Create Pipeline
          </button>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
            <button className="btn-primary" onClick={openAdd}><i className="ti ti-plus" /> Create Pipeline</button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {pipelines.map(p => {
              const steps = JSON.parse(p.steps || '[]');
              const pipelineRuns = runs[p.id] || [];
              return (
                <div key={p.id} style={{ border: '1px solid #e2e8f0', borderRadius: 12, padding: '16px 20px', background: '#fff' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                        <div style={{ width: 34, height: 34, borderRadius: 9, background: '#e0e7ff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          <i className="ti ti-git-merge" style={{ color: '#4338ca', fontSize: 16 }} />
                        </div>
                        <div>
                          <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a' }}>{p.name}</div>
                          {p.description && <div style={{ fontSize: 12, color: '#64748b' }}>{p.description}</div>}
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 16, fontSize: 12, color: '#64748b', marginTop: 8 }}>
                        <span><i className="ti ti-list-numbers" style={{ marginRight: 4 }} />{steps.length} step{steps.length !== 1 ? 's' : ''}</span>
                        {p.environment && <span><i className="ti ti-tag" style={{ marginRight: 4 }} />{p.environment}</span>}
                        <span><i className="ti ti-player-stop" style={{ marginRight: 4, color: p.stop_on_failure ? '#ef4444' : '#94a3b8' }} />{p.stop_on_failure ? 'Stop on failure' : 'Continue on failure'}</span>
                      </div>
                      {/* Steps preview */}
                      {steps.length > 0 && (
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
                          {steps.map((s, i) => (
                            <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 10px', background: '#f1f5f9', borderRadius: 20, fontSize: 11, color: '#475569' }}>
                              <span style={{ fontWeight: 700, color: '#4338ca' }}>{i + 1}.</span> {s.name}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                      <button className="btn-primary btn-sm" onClick={() => runPipeline(p)} disabled={running === p.id}>
                        {running === p.id ? <span className="spinner" /> : <i className="ti ti-player-play" />} Run
                      </button>
                      <button className="btn-secondary btn-sm" onClick={() => { openEdit(p); }}><i className="ti ti-pencil" /></button>
                      <button className="btn-secondary btn-sm" style={{ color: '#ef4444', borderColor: 'rgba(239,68,68,0.3)' }} onClick={() => deletePipeline(p.id)}><i className="ti ti-trash" /></button>
                    </div>
                  </div>

                  {/* Run history toggle */}
                  <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid #f1f5f9' }}>
                    <button onClick={() => pipelineRuns.length ? setRuns(prev => ({ ...prev, [p.id]: [] })) : loadRuns(p.id)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12, color: '#64748b', display: 'flex', alignItems: 'center', gap: 4, fontFamily: 'inherit' }}>
                      <i className={`ti ti-history`} style={{ fontSize: 13 }} />
                      {pipelineRuns.length ? 'Hide' : 'Show'} run history
                    </button>
                    {pipelineRuns.length > 0 && (
                      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {pipelineRuns.map(r => (
                          <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', background: '#f8fafc', borderRadius: 6, fontSize: 12 }}>
                            <StatusBadge status={r.status} />
                            <span style={{ color: '#475569' }}>{r.started_at?.slice(0, 16).replace('T', ' ')}</span>
                            {r.finished_at && <span style={{ color: '#94a3b8' }}>→ {r.finished_at?.slice(0, 16).replace('T', ' ')}</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Add/Edit Modal */}
      {modal && (
        <Modal onClose={() => setModal(null)} closeOnOutsideClick={false} style={{ width: '620px', maxWidth: '95vw' }}>
          <div className="modal-hdr">
            <div className="modal-title"><i className="ti ti-git-merge" style={{ marginRight: 8, color: '#4338ca' }} />{modal === 'add' ? 'Create Pipeline' : 'Edit Pipeline'}</div>
            <button className="btn-icon" onClick={() => setModal(null)}><i className="ti ti-x" /></button>
          </div>

          <div className="form-group">
            <label className="form-label">Pipeline Name *</label>
            <input type="text" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Full Regression" autoFocus />
          </div>

          <div className="form-group">
            <label className="form-label">Description</label>
            <input type="text" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="What does this pipeline test?" />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="form-group">
              <label className="form-label">Environment</label>
              <input type="text" value={form.environment} onChange={e => setForm(f => ({ ...f, environment: e.target.value }))} placeholder="e.g. QA, Staging, UAT" />
            </div>
            <div className="form-group">
              <label className="form-label">On step failure</label>
              <select value={form.stop_on_failure ? 'stop' : 'continue'} onChange={e => setForm(f => ({ ...f, stop_on_failure: e.target.value === 'stop' }))} style={{ width: '100%', padding: '7px 10px', borderRadius: 6, border: '1px solid var(--color-border-secondary)', background: 'var(--input-bg)', color: 'var(--color-text-primary)', fontSize: 13, fontFamily: 'inherit' }}>
                <option value="stop">Stop pipeline</option>
                <option value="continue">Continue to next step</option>
              </select>
            </div>
          </div>

          {/* Steps */}
          <div className="form-group">
            <label className="form-label">Test Plan Steps <span style={{ fontWeight: 400, color: '#64748b' }}>— drag to reorder</span></label>
            {form.steps.length === 0 ? (
              <div style={{ padding: '14px', textAlign: 'center', color: '#94a3b8', fontSize: 13, border: '1px dashed #e2e8f0', borderRadius: 8 }}>
                No steps added yet. Select test plans below.
              </div>
            ) : (
              form.steps.map((s, i) => (
                <StepRow key={s.suite_id} step={s} index={i} total={form.steps.length} onRemove={removeStep} onMoveUp={moveUp} onMoveDown={moveDown} />
              ))
            )}
          </div>

          {/* Available test plans to add */}
          {availableSuites.length > 0 && (
            <div className="form-group">
              <label className="form-label" style={{ color: '#64748b' }}>Add test plans</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {availableSuites.map(s => (
                  <button key={s.id} onClick={() => addStep(s)}
                    style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 12px', border: '1px solid #e2e8f0', borderRadius: 20, background: '#f8fafc', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, color: '#475569', transition: 'all .12s' }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = '#4338ca'; e.currentTarget.style.color = '#4338ca'; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = '#e2e8f0'; e.currentTarget.style.color = '#475569'; }}>
                    <i className="ti ti-plus" style={{ fontSize: 11 }} /> {s.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {suites.length === 0 && (
            <div style={{ padding: '10px 14px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, fontSize: 12, color: '#92400e', marginBottom: 12 }}>
              <i className="ti ti-alert-triangle" style={{ marginRight: 6 }} />No test plans found. Create test plans first before building a pipeline.
            </div>
          )}

          <div className="modal-footer">
            <button className="btn-secondary" onClick={() => setModal(null)}>Cancel</button>
            <button className="btn-primary" onClick={save} disabled={saving}>
              {saving && <span className="spinner" />}
              <i className="ti ti-device-floppy" /> {modal === 'add' ? 'Create Pipeline' : 'Save Changes'}
            </button>
          </div>
        </Modal>
      )}
      </> /* end local tab */}
    </div>
  );
}
