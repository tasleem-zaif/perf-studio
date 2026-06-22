import { useState, useEffect } from 'react';
import api from '../api';
import { useToast } from '../hooks/useToast';
import EnvBar from '../components/EnvBar';

const BLANK_CFG = {
  smtp_host: '', smtp_port: '587', smtp_secure: false,
  smtp_user: '', smtp_pass: '',
  from_name: 'Peako', from_email: '',
  enabled: false,
};

export default function Alerts({ project, collection, env, envs, onEnvChange }) {
  const { toast } = useToast();
  const [cfg, setCfg]             = useState({ ...BLANK_CFG });
  const [saving, setSaving]       = useState(false);
  const [testing, setTesting]     = useState(false);
  const [testEmail, setTestEmail] = useState('');
  const [globalRecs, setGlobalRecs]   = useState([]);
  const [projectRecs, setProjectRecs] = useState([]);
  const [newGlobal, setNewGlobal]     = useState({ email: '', name: '' });
  const [newProject, setNewProject]   = useState({ email: '', name: '' });
  const [addingG, setAddingG]   = useState(false);
  const [addingP, setAddingP]   = useState(false);

  useEffect(() => { loadConfig(); loadGlobalRecs(); }, []);
  useEffect(() => { if (project) loadProjectRecs(); }, [project?.id]);

  async function loadConfig() {
    try {
      const { data } = await api.get('/alerts/config');
      if (data.config) setCfg({ ...BLANK_CFG, ...data.config, smtp_pass: data.config.smtp_pass || '' });
    } catch (_) {}
  }

  async function loadGlobalRecs() {
    try {
      const { data } = await api.get('/alerts/recipients');
      setGlobalRecs(data.recipients || []);
    } catch (_) {}
  }

  async function loadProjectRecs() {
    try {
      const { data } = await api.get(`/alerts/projects/${project.id}/recipients`);
      setProjectRecs(data.recipients || []);
    } catch (_) {}
  }

  async function saveCfg() {
    setSaving(true);
    try {
      await api.put('/alerts/config', cfg);
      toast('Alert configuration saved', 'success');
    } catch (e) {
      toast(e.response?.data?.error || 'Failed to save SMTP alert configuration — verify your host, port and credentials are correct.', 'error');
    } finally { setSaving(false); }
  }

  async function testSmtp() {
    setTesting(true);
    try {
      const { data } = await api.post('/alerts/test-smtp');
      toast(data.message, 'success');
    } catch (e) {
      toast(e.response?.data?.error || 'SMTP test failed', 'error');
    } finally { setTesting(false); }
  }

  async function sendTestEmail() {
    if (!testEmail) return toast('Enter a recipient email address first', 'warn');
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(testEmail)) return toast(`"${testEmail}" is not a valid email address`, 'error');
    setTesting(true);
    try {
      const { data } = await api.post('/alerts/send-test', { to: testEmail });
      toast(data.message, 'success');
    } catch (e) {
      toast(e.response?.data?.error || 'Send failed', 'error');
    } finally { setTesting(false); }
  }

  async function addGlobalRec() {
    if (!newGlobal.email) return toast('Enter email', 'warn');
    setAddingG(true);
    try {
      await api.post('/alerts/recipients', newGlobal);
      setNewGlobal({ email: '', name: '' });
      await loadGlobalRecs();
      toast('Recipient added', 'success');
    } catch (e) {
      toast(e.response?.data?.error || 'Failed to add recipient — the email address may already be in the list or be invalid.', 'error');
    } finally { setAddingG(false); }
  }

  async function removeGlobalRec(id) {
    try {
      await api.delete(`/alerts/recipients/${id}`);
      await loadGlobalRecs();
    } catch (_) {}
  }

  async function addProjectRec() {
    if (!newProject.email) return toast('Enter email', 'warn');
    setAddingP(true);
    try {
      await api.post(`/alerts/projects/${project.id}/recipients`, newProject);
      setNewProject({ email: '', name: '' });
      await loadProjectRecs();
      toast('Recipient added', 'success');
    } catch (e) {
      toast(e.response?.data?.error || 'Failed to add project recipient — the email address may already be in the list or be invalid.', 'error');
    } finally { setAddingP(false); }
  }

  async function removeProjectRec(id) {
    try {
      await api.delete(`/alerts/projects/${project.id}/recipients/${id}`);
      await loadProjectRecs();
    } catch (_) {}
  }

  function set(k, v) { setCfg(c => ({ ...c, [k]: v })); }

  return (
    <div className="page fade-in">
      <EnvBar envs={envs} activeEnv={env} onEnvChange={onEnvChange} hint="Select environment to configure alert settings" />
      <div style={{ maxWidth: 740, display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* SMTP Config */}
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <i className="ti ti-mail-cog" style={{ fontSize: 18, color: 'var(--accent)' }} />
              <span style={{ fontWeight: 700, fontSize: 14 }}>SMTP Configuration</span>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
              <span style={{ color: 'var(--color-text-secondary)' }}>Email Alerts</span>
              <div
                onClick={() => set('enabled', !cfg.enabled)}
                style={{
                  width: 40, height: 22, borderRadius: 11, cursor: 'pointer', position: 'relative',
                  background: cfg.enabled ? 'var(--accent)' : 'var(--color-border)',
                  transition: 'background .2s',
                }}
              >
                <div style={{
                  position: 'absolute', top: 3, left: cfg.enabled ? 21 : 3,
                  width: 16, height: 16, borderRadius: '50%', background: '#fff',
                  transition: 'left .2s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                }} />
              </div>
              <span style={{ fontWeight: 600, fontSize: 12, color: cfg.enabled ? 'var(--accent)' : 'var(--color-text-tertiary)' }}>
                {cfg.enabled ? 'Enabled' : 'Disabled'}
              </span>
            </label>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 80px', gap: 10, marginBottom: 10 }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">SMTP Host</label>
              <input type="text" value={cfg.smtp_host} onChange={e => set('smtp_host', e.target.value)} placeholder="smtp.gmail.com" />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Port</label>
              <input type="number" value={cfg.smtp_port} onChange={e => set('smtp_port', e.target.value)} placeholder="587" />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">SSL/TLS</label>
              <div style={{ display: 'flex', alignItems: 'center', height: 34, gap: 8 }}>
                <input type="checkbox" checked={!!cfg.smtp_secure} onChange={e => set('smtp_secure', e.target.checked)} style={{ accentColor: 'var(--accent)', width: 16, height: 16 }} />
                <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>Secure</span>
              </div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">SMTP Username</label>
              <input type="text" value={cfg.smtp_user} onChange={e => set('smtp_user', e.target.value)} placeholder="user@gmail.com" />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">SMTP Password</label>
              <input type="password" value={cfg.smtp_pass} onChange={e => set('smtp_pass', e.target.value)} placeholder="App password or SMTP password" />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">From Name</label>
              <input type="text" value={cfg.from_name} onChange={e => set('from_name', e.target.value)} placeholder="Peako" />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">From Email</label>
              <input type="email" value={cfg.from_email} onChange={e => set('from_email', e.target.value)} placeholder="alerts@yourcompany.com" />
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="btn-primary btn-sm" onClick={saveCfg} disabled={saving}>
              {saving ? <><span className="spinner" />Saving…</> : <><i className="ti ti-device-floppy" />Save Config</>}
            </button>
            <button className="btn-secondary btn-sm" onClick={testSmtp} disabled={testing}>
              {testing ? <><span className="spinner" />Testing…</> : <><i className="ti ti-plug" />Test Connection</>}
            </button>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 'auto' }}>
              <input
                type="email" value={testEmail} onChange={e => setTestEmail(e.target.value)}
                placeholder="recipient@example.com"
                style={{ fontSize: 12, padding: '5px 10px', width: 200 }}
              />
              <button className="btn-secondary btn-sm" onClick={sendTestEmail} disabled={testing}>
                <i className="ti ti-send" />Send
              </button>
            </div>
          </div>
        </div>

        {/* Global Recipients */}
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
            <i className="ti ti-users" style={{ fontSize: 16, color: 'var(--accent)' }} />
            <span style={{ fontWeight: 700, fontSize: 14 }}>Global Recipients</span>
            <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginLeft: 4 }}>
              Receive reports for all projects
            </span>
          </div>

          <RecipientList
            recipients={globalRecs}
            onRemove={removeGlobalRec}
            newRec={newGlobal}
            setNewRec={setNewGlobal}
            onAdd={addGlobalRec}
            adding={addingG}
          />
        </div>

        {/* Project Recipients */}
        {project && (
          <div className="card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
              <i className="ti ti-folder-heart" style={{ fontSize: 16, color: 'var(--warn)' }} />
              <span style={{ fontWeight: 700, fontSize: 14 }}>Project Recipients — {project.name}</span>
              <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginLeft: 4 }}>
                Only for this project
              </span>
            </div>

            <RecipientList
              recipients={projectRecs}
              onRemove={removeProjectRec}
              newRec={newProject}
              setNewRec={setNewProject}
              onAdd={addProjectRec}
              adding={addingP}
            />
          </div>
        )}

        <div style={{ padding: '12px 16px', background: 'rgba(var(--accent-rgb, 73,204,61),0.06)', border: '1px solid rgba(73,204,61,0.2)', borderRadius: 8, fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
          <i className="ti ti-info-circle" style={{ marginRight: 6, color: 'var(--accent)' }} />
          After each test run completes, recipients will automatically receive:
          <ul style={{ margin: '6px 0 0 18px', paddingLeft: 0 }}>
            <li>Email body with test summary (pass/fail status, key metrics)</li>
            <li>Attachment: Full Analytics Report (PDF — all 7 sections)</li>
            <li>Attachment: JMeter HTML Report (ZIP)</li>
          </ul>
        </div>

      </div>
    </div>
  );
}

function RecipientList({ recipients, onRemove, newRec, setNewRec, onAdd, adding }) {
  return (
    <div>
      {recipients.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', padding: '8px 0', marginBottom: 10 }}>
          No recipients added yet.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
          {recipients.map(r => (
            <div key={r.id} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '7px 12px', background: 'var(--color-background-primary)',
              border: '1px solid var(--color-border-secondary)', borderRadius: 7,
            }}>
              <i className="ti ti-mail" style={{ fontSize: 13, color: 'var(--accent)', flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text-primary)' }}>{r.email}</div>
                {r.name && <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>{r.name}</div>}
              </div>
              <button className="btn-icon" onClick={() => onRemove(r.id)} title="Remove" style={{ color: 'var(--danger)' }}>
                <i className="ti ti-trash" style={{ fontSize: 13 }} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <div className="form-group" style={{ marginBottom: 0, flex: 1 }}>
          <label className="form-label">Email</label>
          <input type="email" value={newRec.email} onChange={e => setNewRec(r => ({ ...r, email: e.target.value }))} placeholder="recipient@example.com"
            onKeyDown={e => e.key === 'Enter' && onAdd()} />
        </div>
        <div className="form-group" style={{ marginBottom: 0, flex: 1 }}>
          <label className="form-label">Name (optional)</label>
          <input type="text" value={newRec.name} onChange={e => setNewRec(r => ({ ...r, name: e.target.value }))} placeholder="John Smith"
            onKeyDown={e => e.key === 'Enter' && onAdd()} />
        </div>
        <button className="btn-primary btn-sm" onClick={onAdd} disabled={adding} style={{ marginBottom: 1 }}>
          {adding ? <span className="spinner" /> : <i className="ti ti-plus" />}
          Add
        </button>
      </div>
    </div>
  );
}
