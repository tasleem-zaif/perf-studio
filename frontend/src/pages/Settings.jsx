import { useState, useEffect } from 'react';
import api from '../api';
import CustomSelect from '../components/CustomSelect';

const PROVIDERS = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'claude', label: 'Anthropic (Claude)' },
];

const MODELS = {
  openai: [
    { value: 'gpt-4o',          label: 'GPT-4o',            desc: 'Most capable, best quality — recommended' },
    { value: 'gpt-4o-mini',     label: 'GPT-4o Mini',       desc: 'Fast & cheap — good for simple scripts' },
    { value: 'gpt-4-turbo',     label: 'GPT-4 Turbo',       desc: 'High quality, large context window' },
    { value: 'gpt-4',           label: 'GPT-4',             desc: 'Classic GPT-4 — reliable and accurate' },
    { value: 'gpt-3.5-turbo',   label: 'GPT-3.5 Turbo',    desc: 'Fastest & cheapest — basic use only' },
    { value: 'o1-mini',         label: 'o1 Mini',           desc: 'Reasoning model — slower but thorough' },
    { value: 'o3-mini',         label: 'o3 Mini',           desc: 'Latest reasoning model — best for complex fixes' },
  ],
  claude: [
    { value: 'claude-opus-4-5',   label: 'Claude Opus 4.5',   desc: 'Most powerful Claude — best quality' },
    { value: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', desc: 'Balanced quality & speed — recommended' },
    { value: 'claude-sonnet-4',   label: 'Claude Sonnet 4',   desc: 'Previous generation Sonnet' },
    { value: 'claude-haiku-4-5',  label: 'Claude Haiku 4.5',  desc: 'Fastest & cheapest Claude model' },
    { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet', desc: 'Stable production model' },
    { value: 'claude-3-opus-20240229',     label: 'Claude 3 Opus',     desc: 'Previous generation Opus' },
  ],
};

const DEFAULT_MODEL = { openai: 'gpt-4o', claude: 'claude-sonnet-4-5' };

const THEMES = [
  {
    value: 'intellij',
    label: 'IntelliJ Dark',
    desc: 'Professional dark IDE look',
    swatch: 'linear-gradient(135deg, #2b2d30 50%, #4e9eff 50%)',
  },
  {
    value: 'qtsolv',
    label: 'Quarks Dark',
    desc: 'Professional dark theme with green accent',
    swatch: 'linear-gradient(135deg, #383a3e 50%, #49CC3D 50%)',
  },
  {
    value: 'quarks',
    label: 'Quarks Light',
    desc: 'Light grey background with green accent',
    swatch: 'linear-gradient(135deg, #E7EAF1 50%, #2ea82a 50%)',
  },
];

const ROLE_LABELS = { super_admin: 'Super Admin', org_admin: 'Org Admin', user: 'User' };
const STATUS_LABELS = { active: 'Active', pending: 'Pending', rejected: 'Rejected' };

function StatusBadge({ status }) {
  const colors = {
    active: { bg: 'rgba(95,201,120,0.15)', color: '#5fc978' },
    pending: { bg: 'rgba(255,180,0,0.15)', color: '#ffb400' },
    rejected: { bg: 'rgba(255,90,90,0.15)', color: '#ff5a5a' },
  };
  const c = colors[status] || colors.pending;
  return (
    <span style={{ padding: '2px 8px', borderRadius: '10px', fontSize: '11px', fontWeight: 600, background: c.bg, color: c.color }}>
      {STATUS_LABELS[status] || status}
    </span>
  );
}

function UserManagementPanel({ user }) {
  const [tab, setTab] = useState('active');
  const [users, setUsers] = useState([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [actionLoading, setActionLoading] = useState({});

  useEffect(() => {
    setLoadingUsers(true);
    api.get('/admin/users').then(({ data }) => setUsers(data.users)).catch(() => {}).finally(() => setLoadingUsers(false));
  }, []);

  async function setStatus(userId, status) {
    setActionLoading(a => ({ ...a, [userId]: true }));
    try {
      await api.put(`/admin/users/${userId}/status`, { status });
      setUsers(u => u.map(x => x.id === userId ? { ...x, status } : x));
    } catch (e) {
      alert(e.response?.data?.error || 'Action failed');
    } finally {
      setActionLoading(a => ({ ...a, [userId]: false }));
    }
  }

  async function removeUser(userId) {
    if (!window.confirm('Remove this user permanently?')) return;
    setActionLoading(a => ({ ...a, [userId]: true }));
    try {
      await api.delete(`/admin/users/${userId}`);
      setUsers(u => u.filter(x => x.id !== userId));
    } catch (e) {
      alert(e.response?.data?.error || 'Delete failed');
    } finally {
      setActionLoading(a => ({ ...a, [userId]: false }));
    }
  }

  const filtered = tab === 'active'
    ? users.filter(u => u.status === 'active')
    : users.filter(u => u.status === 'pending' || u.status === 'rejected');

  return (
    <div className="page fade-in">
      <div style={{ marginBottom: '20px' }}>
        <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)' }}>
          {user?.role === 'super_admin'
            ? 'Manage organization admins and users across all organizations.'
            : 'Manage users within your organization.'}
        </div>
      </div>

      <div style={{ display: 'flex', gap: '4px', marginBottom: '16px', borderBottom: '1px solid var(--color-border-secondary)' }}>
        {['active', 'pending'].map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: '8px 14px',
              fontSize: '13px', fontWeight: tab === t ? 600 : 400,
              color: tab === t ? 'var(--accent)' : 'var(--color-text-secondary)',
              borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
              marginBottom: '-1px',
            }}
          >
            {t === 'active' ? 'Active Users' : 'Pending / Rejected'}
            <span style={{
              marginLeft: '6px',
              background: tab === t ? 'var(--accent)' : 'var(--color-background-secondary)',
              color: tab === t ? 'var(--color-body)' : 'var(--color-text-tertiary)',
              borderRadius: '10px', padding: '1px 7px', fontSize: '11px', fontWeight: 600,
            }}>
              {t === 'active' ? users.filter(u => u.status === 'active').length : users.filter(u => u.status === 'pending' || u.status === 'rejected').length}
            </span>
          </button>
        ))}
      </div>

      {loadingUsers ? (
        <div style={{ color: 'var(--color-text-tertiary)', fontSize: '13px', padding: '40px 0', textAlign: 'center' }}>
          <span className="spinner" style={{ marginRight: '8px' }} />Loading users...
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ color: 'var(--color-text-tertiary)', fontSize: '13px', padding: '40px 0', textAlign: 'center' }}>
          No {tab === 'active' ? 'active' : 'pending'} users.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {filtered.map(u => (
            <div key={u.id} style={{
              display: 'flex', alignItems: 'center', gap: '12px',
              padding: '12px 14px', background: 'var(--color-background-secondary)',
              borderRadius: 'var(--border-radius-md)', border: '1px solid var(--color-border-secondary)',
            }}>
              <div style={{
                width: '36px', height: '36px', borderRadius: '50%',
                background: 'var(--accent)', color: 'var(--color-body)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontWeight: 700, fontSize: '14px', flexShrink: 0,
              }}>
                {u.name?.[0]?.toUpperCase() || '?'}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: '13px', color: 'var(--color-text-primary)', marginBottom: '2px' }}>{u.name}</div>
                <div style={{ fontSize: '11px', color: 'var(--color-text-tertiary)' }}>{u.email}</div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px', flexShrink: 0 }}>
                <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                  <span style={{ fontSize: '11px', color: 'var(--color-text-tertiary)', padding: '2px 7px', borderRadius: '10px', background: 'var(--color-background)', border: '1px solid var(--color-border-secondary)' }}>
                    {ROLE_LABELS[u.role] || u.role}
                  </span>
                  {u.org_name && (
                    <span style={{ fontSize: '11px', color: 'var(--color-text-tertiary)' }}>{u.org_name}</span>
                  )}
                </div>
                <StatusBadge status={u.status} />
              </div>
              <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                {u.status === 'pending' && (
                  <>
                    <button className="btn-primary btn-sm" disabled={actionLoading[u.id]} onClick={() => setStatus(u.id, 'active')} style={{ fontSize: '12px', padding: '4px 10px' }}>
                      {actionLoading[u.id] ? <span className="spinner" /> : <i className="ti ti-check" />} Approve
                    </button>
                    <button className="btn-secondary btn-sm" disabled={actionLoading[u.id]} onClick={() => setStatus(u.id, 'rejected')} style={{ fontSize: '12px', padding: '4px 10px' }}>
                      <i className="ti ti-x" /> Reject
                    </button>
                  </>
                )}
                {u.status === 'rejected' && (
                  <button className="btn-secondary btn-sm" disabled={actionLoading[u.id]} onClick={() => setStatus(u.id, 'active')} style={{ fontSize: '12px', padding: '4px 10px' }}>
                    <i className="ti ti-refresh" /> Re-activate
                  </button>
                )}
                {u.status === 'active' && (
                  <button className="btn-secondary btn-sm" disabled={actionLoading[u.id]} onClick={() => setStatus(u.id, 'rejected')} style={{ fontSize: '12px', padding: '4px 10px', color: '#ff5a5a' }}>
                    <i className="ti ti-user-off" /> Deactivate
                  </button>
                )}
                <button className="btn-secondary btn-sm" disabled={actionLoading[u.id]} onClick={() => removeUser(u.id)} style={{ fontSize: '12px', padding: '4px 8px', color: '#ff5a5a' }}>
                  <i className="ti ti-trash" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AppearancePanel({ theme, onThemeChange }) {
  return (
    <div className="page fade-in">
      <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)', marginBottom: '20px' }}>
        Choose a UI theme. Your preference is saved in the browser.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px', maxWidth: '560px' }}>
        {THEMES.map(t => (
          <button
            key={t.value}
            className={`theme-btn${theme === t.value ? ' active' : ''}`}
            onClick={() => onThemeChange(t.value)}
          >
            <div className="theme-swatch" style={{ background: t.swatch, width: '32px', height: '32px', borderRadius: '6px', border: '1px solid var(--color-border-secondary)' }} />
            <div>
              <div style={{ fontWeight: 600, fontSize: '13px' }}>{t.label}</div>
              <div style={{ fontSize: '11px', color: 'var(--color-text-secondary)', marginTop: '1px' }}>{t.desc}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function ModelRow({ icon, title, subtitle, value, onChange, models, iconColor }) {
  const selected = models.find(m => m.value === value);
  return (
    <div style={{
      padding: '14px 16px', marginBottom: '10px',
      background: 'var(--color-background-secondary)',
      border: '1px solid var(--color-border-secondary)',
      borderRadius: 'var(--border-radius-md)',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', marginBottom: '10px' }}>
        <i className={`ti ${icon}`} style={{ fontSize: '16px', color: iconColor, marginTop: '1px', flexShrink: 0 }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: '13px', color: 'var(--color-text-primary)' }}>{title}</div>
          <div style={{ fontSize: '11px', color: 'var(--color-text-tertiary)', marginTop: '1px' }}>{subtitle}</div>
        </div>
      </div>
      <CustomSelect value={value} onChange={e => onChange(e.target.value)}>
        {models.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
      </CustomSelect>
      {selected && (
        <div style={{ marginTop: '7px', fontSize: '11px', color: 'var(--color-text-tertiary)', display: 'flex', alignItems: 'center', gap: '5px' }}>
          <i className="ti ti-info-circle" style={{ fontSize: '11px' }} />
          {selected.desc}
        </div>
      )}
    </div>
  );
}

function AIConfigPanel() {
  const [provider,   setProvider]   = useState('openai');
  const [model,      setModel]      = useState('');
  const [healModel,  setHealModel]  = useState('');
  const [apiKey,     setApiKey]     = useState('');
  const [keySet,     setKeySet]     = useState(false);
  const [saving,     setSaving]     = useState(false);
  const [saved,      setSaved]      = useState(false);
  const [error,      setError]      = useState('');

  useEffect(() => {
    api.get('/settings/ai').then(({ data }) => {
      setProvider(data.provider || 'openai');
      setModel(data.model || DEFAULT_MODEL[data.provider || 'openai'] || '');
      setHealModel(data.heal_model || '');
      setKeySet(data.api_key_set);
    }).catch(() => {});
  }, []);

  function handleProviderChange(val) {
    setProvider(val);
    setModel(DEFAULT_MODEL[val] || '');
    setHealModel('');
  }

  async function save() {
    if (!apiKey && !keySet) return setError('API key required');
    setSaving(true); setError(''); setSaved(false);
    try {
      const body = {
        provider,
        model:      model      || DEFAULT_MODEL[provider],
        heal_model: healModel  || DEFAULT_MODEL[provider],
      };
      if (apiKey) body.api_key = apiKey;
      await api.put('/settings/ai', body);
      setKeySet(true); setApiKey(''); setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setError(e.response?.data?.error || 'Save failed');
    } finally { setSaving(false); }
  }

  const providerModels  = MODELS[provider] || [];
  const effectiveModel  = model      || DEFAULT_MODEL[provider] || '';
  const effectiveHeal   = healModel  || DEFAULT_MODEL[provider] || '';

  return (
    <div className="page fade-in" style={{ maxWidth: '560px' }}>
      <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)', marginBottom: '20px' }}>
        Configure separate AI models for script generation and auto-healing. Both use the same provider and API key.
      </div>

      {error && <div className="auth-error" style={{ marginBottom: '16px' }}>{error}</div>}
      {saved && (
        <div style={{ marginBottom: '16px', padding: '10px 14px', background: 'rgba(95,201,120,0.12)', border: '1px solid rgba(95,201,120,0.3)', borderRadius: 'var(--border-radius-md)', fontSize: '13px', color: '#5fc978' }}>
          <i className="ti ti-circle-check" style={{ marginRight: '6px' }} />Settings saved successfully.
        </div>
      )}

      {/* Provider */}
      <div className="form-group">
        <label className="form-label">AI Provider</label>
        <CustomSelect value={provider} onChange={e => handleProviderChange(e.target.value)}>
          {PROVIDERS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
        </CustomSelect>
      </div>

      {/* Script generation model */}
      <ModelRow
        icon="ti-code"
        iconColor="var(--accent)"
        title="Script Generation Model"
        subtitle="Used when generating JMX / K6 scripts from your API collections"
        value={effectiveModel}
        onChange={setModel}
        models={providerModels}
      />

      {/* Auto healer model */}
      <ModelRow
        icon="ti-first-aid-kit"
        iconColor="#f59e0b"
        title="Auto Healer Model"
        subtitle="Used when diagnosing and fixing failed test runs (reasoning-heavy — use a smarter model)"
        value={effectiveHeal}
        onChange={setHealModel}
        models={providerModels}
      />

      {/* API Key */}
      <div className="form-group">
        <label className="form-label">
          API Key
          {provider === 'openai' && (
            <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer"
               style={{ marginLeft: '8px', fontSize: '10px', color: 'var(--accent)', fontWeight: 400 }}>
              Get OpenAI key ↗
            </a>
          )}
          {provider === 'claude' && (
            <a href="https://console.anthropic.com/account/keys" target="_blank" rel="noreferrer"
               style={{ marginLeft: '8px', fontSize: '10px', color: 'var(--accent)', fontWeight: 400 }}>
              Get Anthropic key ↗
            </a>
          )}
        </label>
        <input
          type="password"
          value={apiKey}
          onChange={e => setApiKey(e.target.value)}
          placeholder={keySet ? '••••••••••••  (key saved — enter new key to update)' : provider === 'openai' ? 'sk-...' : 'sk-ant-...'}
        />
      </div>

      <button className="btn-primary" onClick={save} disabled={saving} style={{ marginTop: '4px' }}>
        {saving && <span className="spinner" />}
        <i className="ti ti-device-floppy" />Save Settings
      </button>

      {/* Recommendation hint */}
      <div style={{
        marginTop: '18px', padding: '12px 14px',
        background: 'var(--color-background-secondary)',
        border: '1px solid var(--color-border-secondary)',
        borderRadius: 'var(--border-radius-md)', fontSize: '12px',
        color: 'var(--color-text-secondary)', lineHeight: 1.7,
      }}>
        <div style={{ fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <i className="ti ti-bulb" style={{ color: 'var(--accent)' }} /> Recommended combination
        </div>
        {provider === 'openai' ? <>
          <div><i className="ti ti-code" style={{ marginRight: '5px', color: 'var(--accent)' }} /><strong>Script:</strong> GPT-4o — accurate XML/JS generation, good context understanding</div>
          <div><i className="ti ti-first-aid-kit" style={{ marginRight: '5px', color: '#f59e0b' }} /><strong>Healer:</strong> o3 Mini — step-by-step reasoning to find root cause in complex failures</div>
        </> : <>
          <div><i className="ti ti-code" style={{ marginRight: '5px', color: 'var(--accent)' }} /><strong>Script:</strong> Claude Sonnet 4.5 — fast, accurate script generation</div>
          <div><i className="ti ti-first-aid-kit" style={{ marginRight: '5px', color: '#f59e0b' }} /><strong>Healer:</strong> Claude Opus 4.5 — deepest reasoning for diagnosing complex failures</div>
        </>}
      </div>
    </div>
  );
}

export default function Settings({ page, theme, onThemeChange, user }) {
  if (page === 'settings-users') return <UserManagementPanel user={user} />;
  if (page === 'settings-appearance') return <AppearancePanel theme={theme} onThemeChange={onThemeChange} />;
  if (page === 'settings-ai') return <AIConfigPanel />;
  return null;
}
