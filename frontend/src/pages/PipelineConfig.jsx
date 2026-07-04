import { useState, useEffect } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import { useToast } from '../hooks/useToast';

const DEFAULT_FORM = { name: '', description: '', steps: [], stop_on_failure: true, environment: '' };

const DEFAULT_CI = {
  gitlab_enabled: false, gitlab_url: 'https://gitlab.com', gitlab_project_id: '',
  gitlab_auth_method: 'pat', gitlab_token: '', gitlab_ref: 'main',
  github_enabled: false, github_repo: '', github_auth_method: 'pat',
  github_token: '', github_workflow_file: 'perf-test.yml', github_ref: 'main',
  bitbucket_enabled: false, bitbucket_workspace: '', bitbucket_username: '',
  bitbucket_auth_method: 'pat', bitbucket_app_password: '', bitbucket_repo_slug: '', bitbucket_ref: 'main',
  ssh_private_key: '',
};

function AuthToggle({ value, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 0, borderRadius: 6, overflow: 'hidden', border: '1px solid var(--color-border-secondary)', width: 'fit-content' }}>
      {['pat', 'ssh'].map(method => (
        <button
          key={method}
          onClick={() => onChange(method)}
          style={{
            padding: '4px 14px', fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer',
            background: value === method ? 'var(--accent)' : 'var(--input-bg)',
            color: value === method ? '#fff' : 'var(--color-text-secondary)',
            transition: 'background 0.15s',
          }}
        >
          {method === 'pat' ? 'Token / PAT' : 'SSH Key'}
        </button>
      ))}
    </div>
  );
}

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
  const isProjectOwner = project && user && String(project.user_id) === String(user.id);
  const isAdmin = user?.role === 'org_admin' || user?.role === 'super_admin';
  // Local Pipelines tab removed — only CI/CD Integration remains
  const [pipelines, setPipelines]   = useState([]);
  const [suites,    setSuites]      = useState([]);
  const [modal,     setModal]       = useState(null);
  const [form,      setForm]        = useState(DEFAULT_FORM);
  const [saving,    setSaving]      = useState(false);
  const [runs,      setRuns]        = useState({});
  const [running,   setRunning]     = useState(null);

  // CI/CD config state
  const [ciForm,       setCiForm]       = useState(DEFAULT_CI);
  const [ciSaving,     setCiSaving]     = useState(null); // provider string | null
  const [ciTesting,    setCiTesting]    = useState(null); // 'gitlab'|'github'|'bitbucket'
  const [ciTestResult, setCiTestResult] = useState({});
  const [ciCreatingToken, setCiCreatingToken] = useState(false);
  const [ciGenerating, setCiGenerating] = useState(null); // provider string | null
  const [ciConfig,     setCiConfig]     = useState(null); // loaded from DB
  const [userBranch,   setUserBranch]   = useState('main');

  useEffect(() => {
    if (!project?.id) return;
    load();

    const isRegularUser = user?.role === 'user';
    const fallbackBranch = isRegularUser && user?.name
      ? `users/${user.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-')}`
      : 'main';

    // Fire all three requests in parallel — don't wait for identity before loading ci/config
    Promise.all([
      api.get(`/projects/${project.id}/test-suites`).catch(() => ({ data: { suites: [] } })),
      isRegularUser
        ? api.get(`/projects/${project.id}/git/identity`).catch(() => ({ data: {} }))
        : Promise.resolve({ data: {} }),
      api.get(`/projects/${project.id}/ci/config`).catch(() => ({ data: {} })),
    ]).then(([suitesRes, identityRes, ciRes]) => {
      setSuites(suitesRes.data.suites || []);

      const resolved = identityRes.data.identity?.branch_name || fallbackBranch;
      setUserBranch(resolved);

      const cfg = ciRes.data.config;
      if (cfg) {
        setCiConfig(cfg);
        setCiForm(f => ({
          ...f,
          gitlab_enabled: !!cfg.gitlab_enabled,
          gitlab_url: cfg.gitlab_url || 'https://gitlab.com',
          gitlab_project_id: cfg.gitlab_project_id || '',
          gitlab_ref: cfg.gitlab_ref || resolved,
          github_enabled: !!cfg.github_enabled,
          github_repo: cfg.github_repo || '',
          github_workflow_file: cfg.github_workflow_file || 'perf-test.yml',
          github_ref: cfg.github_ref || resolved,
          gitlab_auth_method: cfg.gitlab_auth_method || 'pat',
          bitbucket_enabled: !!cfg.bitbucket_enabled,
          bitbucket_workspace: cfg.bitbucket_workspace || '',
          bitbucket_username: cfg.bitbucket_username || '',
          bitbucket_repo_slug: cfg.bitbucket_repo_slug || '',
          bitbucket_ref: cfg.bitbucket_ref || resolved,
          bitbucket_auth_method: cfg.bitbucket_auth_method || 'pat',
          github_auth_method: cfg.github_auth_method || 'pat',
          ssh_private_key: '',
        }));
      } else {
        setCiForm(f => ({ ...f, gitlab_ref: resolved, github_ref: resolved }));
      }
    });
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
    } catch (e) { toast(e.response?.data?.error || 'Failed to save pipeline — ensure the pipeline name is unique and all steps are valid.', 'error'); }
    finally { setSaving(false); }
  }

  async function deletePipeline(id) {
    if (!window.confirm('Delete this pipeline?')) return;
    await api.delete(`/projects/${project.id}/pipelines/${id}`).catch(e => toast(e.response?.data?.error || 'Failed to delete pipeline — please try again.', 'error'));
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
  async function saveCiConfig(provider) {
    setCiSaving(provider);
    try {
      await api.put(`/projects/${project.id}/ci/config`, ciForm);
      toast('CI/CD configuration saved', 'success');
      const { data } = await api.get(`/projects/${project.id}/ci/config`);
      if (data.config) setCiConfig(data.config);
      // Clear sensitive fields from form — they're now stored; placeholder will show "saved" state
      setCiForm(f => ({ ...f, ssh_private_key: '' }));
    } catch (e) { toast(e.response?.data?.error || 'Failed to save CI/CD configuration — check the provider token and repository name are correct.', 'error'); }
    finally { setCiSaving(null); }
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

  async function generateYaml(provider) {
    setCiGenerating(provider);
    try {
      await api.put(`/projects/${project.id}/ci/config`, ciForm);
      const { data } = await api.post(`/projects/${project.id}/ci/generate-yaml`, { providers: [provider] });
      toast(data.message || `Generated: ${data.created?.join(', ')}`, 'success');
    } catch (e) { toast(e.response?.data?.error || 'Generation failed', 'error'); }
    finally { setCiGenerating(null); }
  }

  function StatusBadge({ status }) {
    const map = { running: ['#dbeafe','#1d4ed8'], completed: ['#dcfce7','#16a34a'], failed: ['#fee2e2','#dc2626'], pending: ['#f1f5f9','#64748b'] };
    const [bg, color] = map[status] || map.pending;
    return <span style={{ padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 700, background: bg, color }}>{status}</span>;
  }

  const ciInputStyle = { width: '100%', padding: '7px 10px', borderRadius: 6, border: '1px solid var(--color-border-secondary)', background: 'var(--input-bg)', color: 'var(--color-text-primary)', fontSize: 13, fontFamily: 'inherit' };

  return (
    <div className="page fade-in">

      {/* ── CI/CD Integration ─────────────────────────────────────── */}
        <div>
          {/* Per-user info banner */}
          <div style={{ display:'flex', alignItems:'center', gap:8, padding:'10px 14px', background:'#f0fdf4', border:'1px solid #86efac', borderRadius:8, marginBottom:16, fontSize:12, color:'#15803d' }}>
            <i className="ti ti-user-check" style={{ fontSize:14, flexShrink:0 }}/>
            <span>This is <strong>your personal CI/CD configuration</strong>. Each team member has their own independent setup — pipelines run on{user?.role === 'user' ? <strong> {userBranch}</strong> : ' main'}.</span>
          </div>
          <div style={{ marginBottom: 16, padding: '12px 16px', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, fontSize: 13, color: '#1d4ed8' }}>
            <i className="ti ti-info-circle" style={{ marginRight: 6 }}/>
            Configure GitLab, GitHub, or Bitbucket to run JMeter tests on their infrastructure. After saving settings, generate the YAML file, commit + push it, then trigger from the <strong>Run Test</strong> page.
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

                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">Authentication Method</label>
                  <AuthToggle value={ciForm.gitlab_auth_method} onChange={v => setCiForm(f => ({ ...f, gitlab_auth_method: v }))} />
                </div>

                {ciForm.gitlab_auth_method === 'pat' ? (
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
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label className="form-label">SSH Private Key</label>
                      <textarea style={{ ...ciInputStyle, fontFamily: 'monospace', fontSize: 11, minHeight: 90, resize: 'vertical' }} value={ciForm.ssh_private_key} onChange={e => setCiForm(f => ({ ...f, ssh_private_key: e.target.value }))} placeholder={ciConfig?.ssh_private_key_set ? '(saved — paste new key to replace)' : '-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----'} autoComplete="off" spellCheck={false} />
                      <div style={{ fontSize: 11, color: '#64748b', marginTop: 3 }}>Add <strong>SSH_PRIVATE_KEY</strong> as a masked variable in GitLab → Settings → CI/CD → Variables</div>
                    </div>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label className="form-label">Branch / Ref</label>
                      <input style={ciInputStyle} value={ciForm.gitlab_ref} onChange={e => setCiForm(f => ({ ...f, gitlab_ref: e.target.value }))} placeholder="main" />
                    </div>
                  </div>
                )}

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

                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <button className="btn-secondary btn-sm" onClick={() => testCiConnection('gitlab')} disabled={!!ciTesting}>
                    {ciTesting === 'gitlab' ? <><span className="spinner"/> Testing…</> : <><i className="ti ti-wifi"/> Test Connection</>}
                  </button>
                  <button className="btn-primary btn-sm" onClick={() => saveCiConfig('gitlab')} disabled={!!ciSaving}>
                    {ciSaving === 'gitlab' ? <><span className="spinner"/> Saving…</> : <><i className="ti ti-device-floppy"/> Save Settings</>}
                  </button>
                  {isAdmin && <button className="btn-secondary btn-sm" onClick={() => generateYaml('gitlab')} disabled={!!ciGenerating} title="Generates .gitlab-ci.yml in your workspace">
                    {ciGenerating === 'gitlab' ? <><span className="spinner"/> Generating…</> : <><i className="ti ti-file-code"/> Generate &amp; Commit YAML</>}
                  </button>}
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
                    <input style={ciInputStyle} value={ciForm.github_repo} onChange={e => setCiForm(f => ({ ...f, github_repo: e.target.value }))} placeholder="e.g. tasleemzaif85/Project-Demo" />
                    {ciForm.github_repo && ciForm.github_repo.includes('@') && (
                      <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 4 }}>
                        This looks like an email address. Enter the GitHub repository in <strong>owner/repo</strong> format, e.g. <code>tasleemzaif85/Project-Demo</code>
                      </div>
                    )}
                  </div>
                  <div className="form-group" style={{ margin: 0 }}>
                    <label className="form-label">Workflow file</label>
                    <input style={ciInputStyle} value={ciForm.github_workflow_file} onChange={e => setCiForm(f => ({ ...f, github_workflow_file: e.target.value }))} placeholder="perf-test.yml" />
                  </div>
                </div>

                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">Authentication Method</label>
                  <AuthToggle value={ciForm.github_auth_method} onChange={v => setCiForm(f => ({ ...f, github_auth_method: v }))} />
                </div>

                {ciForm.github_auth_method === 'pat' ? (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label className="form-label">Personal Access Token <span style={{ color: '#94a3b8', fontWeight: 400 }}>(workflow scope)</span></label>
                      <input style={ciInputStyle} type="password" autoComplete="off" value={ciForm.github_token} onChange={e => setCiForm(f => ({ ...f, github_token: e.target.value }))} placeholder={ciConfig?.github_token_set ? '(saved — enter new to replace)' : 'ghp_xxxxxxxxxxxx'} />
                    </div>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label className="form-label">Branch / Ref</label>
                      <input style={ciInputStyle} value={ciForm.github_ref} onChange={e => setCiForm(f => ({ ...f, github_ref: e.target.value }))} placeholder="main" />
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label className="form-label">SSH Private Key</label>
                      <textarea style={{ ...ciInputStyle, fontFamily: 'monospace', fontSize: 11, minHeight: 90, resize: 'vertical' }} value={ciForm.ssh_private_key} onChange={e => setCiForm(f => ({ ...f, ssh_private_key: e.target.value }))} placeholder={ciConfig?.ssh_private_key_set ? '(saved — paste new key to replace)' : '-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----'} autoComplete="off" spellCheck={false} />
                      <div style={{ fontSize: 11, color: '#64748b', marginTop: 3 }}>Used to push workflow files from Peako to your repository. Not stored in GitHub Actions.</div>
                    </div>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label className="form-label">Branch / Ref</label>
                      <input style={ciInputStyle} value={ciForm.github_ref} onChange={e => setCiForm(f => ({ ...f, github_ref: e.target.value }))} placeholder="main" />
                    </div>
                  </div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <button className="btn-secondary btn-sm" onClick={() => testCiConnection('github')} disabled={!!ciTesting}>
                    {ciTesting === 'github' ? <><span className="spinner"/> Testing…</> : <><i className="ti ti-wifi"/> Test Connection</>}
                  </button>
                  <button className="btn-primary btn-sm" onClick={() => saveCiConfig('github')} disabled={!!ciSaving}>
                    {ciSaving === 'github' ? <><span className="spinner"/> Saving…</> : <><i className="ti ti-device-floppy"/> Save Settings</>}
                  </button>
                  {isAdmin && <button className="btn-secondary btn-sm" onClick={() => generateYaml('github')} disabled={!!ciGenerating} title="Generates .github/workflows/perf-test.yml in your workspace">
                    {ciGenerating === 'github' ? <><span className="spinner"/> Generating…</> : <><i className="ti ti-file-code"/> Generate &amp; Commit YAML</>}
                  </button>}
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

          {/* ── Bitbucket Pipelines ────────────────────────── */}
          <div style={{ border: '1px solid #e2e8f0', borderRadius: 12, padding: '20px', marginBottom: 16, background: '#fff' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
              <div style={{ width: 36, height: 36, borderRadius: 9, background: '#e0f2fe', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <i className="ti ti-brand-bitbucket" style={{ color: '#0052cc', fontSize: 18 }}/>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: '#0f172a' }}>Bitbucket Pipelines</div>
                <div style={{ fontSize: 12, color: '#64748b' }}>Trigger custom pipelines on Bitbucket Cloud</div>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
                <input type="checkbox" checked={ciForm.bitbucket_enabled} onChange={e => setCiForm(f => ({ ...f, bitbucket_enabled: e.target.checked }))} style={{ width: 16, height: 16, accentColor: 'var(--accent)', cursor: 'pointer' }}/>
                Enable
              </label>
            </div>

            {ciForm.bitbucket_enabled && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div className="form-group" style={{ margin: 0 }}>
                    <label className="form-label">Workspace</label>
                    <input style={ciInputStyle} value={ciForm.bitbucket_workspace} onChange={e => setCiForm(f => ({ ...f, bitbucket_workspace: e.target.value }))} placeholder="your-workspace-slug" />
                  </div>
                  <div className="form-group" style={{ margin: 0 }}>
                    <label className="form-label">Repository Slug</label>
                    <input style={ciInputStyle} value={ciForm.bitbucket_repo_slug} onChange={e => setCiForm(f => ({ ...f, bitbucket_repo_slug: e.target.value }))} placeholder="your-repo-name" />
                  </div>
                </div>

                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">Authentication Method</label>
                  <AuthToggle value={ciForm.bitbucket_auth_method} onChange={v => setCiForm(f => ({ ...f, bitbucket_auth_method: v }))} />
                </div>

                {ciForm.bitbucket_auth_method === 'pat' ? (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label className="form-label">Email</label>
                      <input style={ciInputStyle} value={ciForm.bitbucket_username} onChange={e => setCiForm(f => ({ ...f, bitbucket_username: e.target.value }))} placeholder="you@example.com" />
                      <div style={{ fontSize: 11, color: '#64748b', marginTop: 3 }}>
                        For API tokens (ATATT): enter your <strong>Atlassian account email</strong>. For App Passwords: enter your Bitbucket username.
                      </div>
                    </div>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label className="form-label">API Token / App Password <span style={{ color: '#94a3b8', fontWeight: 400 }}>(Pipelines read/write)</span></label>
                      <input style={ciInputStyle} type="password" autoComplete="off" value={ciForm.bitbucket_app_password} onChange={e => setCiForm(f => ({ ...f, bitbucket_app_password: e.target.value }))} placeholder={ciConfig?.bitbucket_app_password_set ? '(saved — enter new to replace)' : 'ATATT… or ATBB…'} />
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label className="form-label">SSH Private Key</label>
                      <textarea style={{ ...ciInputStyle, fontFamily: 'monospace', fontSize: 11, minHeight: 90, resize: 'vertical' }} value={ciForm.ssh_private_key} onChange={e => setCiForm(f => ({ ...f, ssh_private_key: e.target.value }))} placeholder={ciConfig?.ssh_private_key_set ? '(saved — paste new key to replace)' : '-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----'} autoComplete="off" spellCheck={false} />
                      <div style={{ fontSize: 11, color: '#64748b', marginTop: 3 }}>Add <strong>SSH_PRIVATE_KEY</strong> as a secured variable in Bitbucket → Repository Settings → Repository Variables</div>
                    </div>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label className="form-label">Username</label>
                      <input style={ciInputStyle} value={ciForm.bitbucket_username} onChange={e => setCiForm(f => ({ ...f, bitbucket_username: e.target.value }))} placeholder="your-bitbucket-username" />
                    </div>
                  </div>
                )}
                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">Branch / Ref</label>
                  <input style={ciInputStyle} value={ciForm.bitbucket_ref} onChange={e => setCiForm(f => ({ ...f, bitbucket_ref: e.target.value }))} placeholder="main" />
                </div>
                {ciForm.bitbucket_auth_method === 'pat' && (
                <div style={{ padding: '10px 12px', background: '#eff6ff', borderRadius: 8, border: '1px solid #bfdbfe', fontSize: 12, color: '#1e40af' }}>
                  <i className="ti ti-info-circle" style={{ marginRight: 6 }}/>
                  Add <strong>BB_USERNAME</strong> and <strong>BB_APP_PASSWORD</strong> as secured <strong>Repository Variables</strong> in Bitbucket → Repository Settings → Repository Variables.
                </div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <button className="btn-secondary btn-sm" onClick={() => testCiConnection('bitbucket')} disabled={!!ciTesting}>
                    {ciTesting === 'bitbucket' ? <><span className="spinner"/> Testing…</> : <><i className="ti ti-wifi"/> Test Connection</>}
                  </button>
                  <button className="btn-primary btn-sm" onClick={() => saveCiConfig('bitbucket')} disabled={!!ciSaving}>
                    {ciSaving === 'bitbucket' ? <><span className="spinner"/> Saving…</> : <><i className="ti ti-device-floppy"/> Save Settings</>}
                  </button>
                  {isAdmin && <button className="btn-secondary btn-sm" onClick={() => generateYaml('bitbucket')} disabled={!!ciGenerating} title="Generates bitbucket-pipelines.yml in your workspace">
                    {ciGenerating === 'bitbucket' ? <><span className="spinner"/> Generating…</> : <><i className="ti ti-file-code"/> Generate &amp; Commit YAML</>}
                  </button>}
                  {ciTestResult.bitbucket && (
                    <span style={{ fontSize: 12, color: ciTestResult.bitbucket.ok ? '#16a34a' : '#dc2626', display: 'flex', alignItems: 'center', gap: 4 }}>
                      <i className={`ti ${ciTestResult.bitbucket.ok ? 'ti-circle-check' : 'ti-circle-x'}`}/>
                      {ciTestResult.bitbucket.message}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

        </div>
    </div>
  );
}
