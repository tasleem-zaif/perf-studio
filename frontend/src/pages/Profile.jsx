import { useState, useEffect } from 'react';
import api from '../api';

/* ── Registry Token card — org's npm token for @peako packages ────────────── */
function CopyCommandBlock({ command, copyText }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(copyText ?? command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#0f172a', borderRadius: 8, padding: '12px 14px', marginBottom: 10 }}>
      <code style={{ flex: 1, fontFamily: 'monospace', fontSize: 12, color: '#4ade80', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
        {command}
      </code>
      <button className="btn-secondary btn-sm" onClick={copy} style={{ flexShrink: 0, background: 'rgba(255,255,255,0.1)', color: '#fff', border: 'none' }}>
        {copied ? 'Copied!' : 'Copy'}
      </button>
    </div>
  );
}

function RegistryTokenCard() {
  const [data, setData] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.get('/auth/me/registry-token').then(r => setData(r.data)).catch(() => setData(null));
  }, []);

  if (data === null) return null; // still loading / request failed

  const host = data.token ? data.registryUrl.replace(/^https?:\/\//, '') : '';

  function copyToken() {
    navigator.clipboard.writeText(data.token);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="card">
      <div style={{ fontWeight: 600, fontSize: 15, display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <i className="ti ti-key" style={{ color: 'var(--accent)' }} /> Registry Token
      </div>
      <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 18 }}>
        Use this token to install private <code>@peako</code> packages from the registry on your local machine.
      </div>

      {!data.token ? (
        <div style={{ padding: '12px 14px', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: 8, fontSize: 12, color: 'var(--color-text-secondary)' }}>
          <i className="ti ti-info-circle" style={{ marginRight: 6, color: '#f59e0b' }} />
          No registry token has been generated for your organization yet. Contact your Super Admin.
        </div>
      ) : (
        <>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Your token</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
        <input readOnly value={'•'.repeat(40)} disabled
          style={{ flex: 1, padding: '8px 10px', fontSize: 13, background: 'var(--color-background-secondary)', border: '1px solid var(--color-border-secondary)', borderRadius: 6, letterSpacing: 2, color: 'var(--color-text-tertiary)' }} />
        <button className="btn-primary btn-sm" onClick={copyToken} style={{ flexShrink: 0 }}>
          {copied ? 'Copied!' : 'Copy Token'}
        </button>
      </div>
      <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginBottom: 18 }}>
        Token is never displayed — click Copy to use it.
      </div>

      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 10 }}>
        Setup commands <span style={{ fontWeight: 400, color: 'var(--color-text-tertiary)' }}>(run once per machine)</span>
      </div>
      <CopyCommandBlock command={`npm config set @peako:registry ${data.registryUrl}`} />
      <CopyCommandBlock
        command={`npm config set ${host}:_authToken ${'•'.repeat(20)}`}
        copyText={`npm config set ${host}:_authToken ${data.token}`}
      />
        </>
      )}
    </div>
  );
}

export default function Profile({ user, onUserUpdated, onBack }) {
  const [editMode, setEditMode] = useState(false);
  const [editForm, setEditForm] = useState({ name: user?.name || '', email: user?.email || '' });
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');
  const [editSuccess, setEditSuccess] = useState('');

  const [pwMode, setPwMode] = useState(false);
  const [pwForm, setPwForm] = useState({ current_password: '', new_password: '', confirm_password: '' });
  const [pwSaving, setPwSaving] = useState(false);
  const [pwError, setPwError] = useState('');
  const [pwSuccess, setPwSuccess] = useState('');

  function openEdit() {
    setEditForm({ name: user.name, email: user.email });
    setEditError(''); setEditSuccess('');
    setEditMode(true);
  }

  async function saveProfile() {
    setEditError(''); setEditSuccess('');
    setEditSaving(true);
    try {
      const { data } = await api.put('/auth/me', editForm);
      onUserUpdated(data.user);
      setEditSuccess('Profile updated successfully.');
      setEditMode(false);
    } catch (e) {
      setEditError(e.response?.data?.error || 'Update failed');
    } finally { setEditSaving(false); }
  }

  async function changePassword() {
    setPwError(''); setPwSuccess('');
    if (pwForm.new_password !== pwForm.confirm_password) return setPwError('New passwords do not match');
    setPwSaving(true);
    try {
      await api.put('/auth/me/password', { current_password: pwForm.current_password, new_password: pwForm.new_password });
      setPwSuccess('Password changed successfully.');
      setPwForm({ current_password: '', new_password: '', confirm_password: '' });
      setPwMode(false);
    } catch (e) {
      setPwError(e.response?.data?.error || 'Password change failed');
    } finally { setPwSaving(false); }
  }

  const initials = user?.name ? user.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) : '?';

  return (
    <div className="page fade-in">
      {/* Back button */}
      {onBack && (
        <div style={{ marginBottom: 20 }}>
          <button onClick={onBack}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              background: 'none', border: 'none', cursor: 'pointer',
              fontSize: 13, fontWeight: 600, color: 'var(--accent)',
              padding: '4px 0', fontFamily: 'inherit',
            }}>
            <i className="ti ti-arrow-left" style={{ fontSize: 14 }} />
            Back to Dashboard
          </button>
        </div>
      )}

      {/* Two-column layout */}
      <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 24, alignItems: 'start' }}>

        {/* LEFT — avatar, name, email */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '36px 24px', gap: 16, textAlign: 'center' }}>
          <div style={{
            width: 90, height: 90, borderRadius: '50%',
            background: 'var(--accent)', color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 32, fontWeight: 700, letterSpacing: 1,
            boxShadow: '0 4px 20px rgba(34,197,94,0.3)',
          }}>
            {initials}
          </div>
          <div>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-text-primary)' }}>{user?.name}</div>
            <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginTop: 4 }}>{user?.email}</div>
            {user?.role && (
              <div style={{ marginTop: 10 }}>
                <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, background: '#dcfce7', color: '#16a34a', padding: '3px 10px', borderRadius: 20 }}>
                  {user.role.replace('_', ' ')}
                </span>
              </div>
            )}
            {user?.created_at && (
              <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 12 }}>
                <i className="ti ti-calendar" style={{ marginRight: 5 }} />
                Member since {user.created_at.slice(0, 10)}
              </div>
            )}
          </div>
        </div>

        {/* RIGHT — Profile Details + Change Password */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Profile Details */}
          <div className="card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '18px' }}>
              <div style={{ fontWeight: 600, fontSize: 15, display: 'flex', alignItems: 'center', gap: 8 }}>
                <i className="ti ti-user" style={{ color: 'var(--accent)' }} /> Profile Details
              </div>
              {!editMode && (
                <button className="btn-secondary btn-sm" onClick={openEdit}>
                  <i className="ti ti-edit" /> Edit Profile
                </button>
              )}
            </div>

            {editSuccess && !editMode && (
              <div style={{ padding: '8px 12px', background: 'rgba(0,200,150,0.1)', borderRadius: 8, color: '#00c896', fontSize: 13, marginBottom: 12 }}>
                <i className="ti ti-check" style={{ marginRight: 6 }} />{editSuccess}
              </div>
            )}

            {!editMode ? (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--color-text-tertiary)', marginBottom: 4 }}>Full Name</div>
                  <div style={{ fontSize: 14, color: 'var(--color-text-primary)' }}>{user?.name}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--color-text-tertiary)', marginBottom: 4 }}>Email Address</div>
                  <div style={{ fontSize: 14, color: 'var(--color-text-primary)' }}>{user?.email}</div>
                </div>
              </div>
            ) : (
              <>
                {editError && <div className="auth-error" style={{ marginBottom: 12 }}>{editError}</div>}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div className="form-group">
                    <label className="form-label">Full Name</label>
                    <input type="text" value={editForm.name} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))} autoFocus />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Email Address</label>
                    <input type="email" value={editForm.email} onChange={e => setEditForm(f => ({ ...f, email: e.target.value }))} />
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
                  <button className="btn-secondary" onClick={() => setEditMode(false)}>Cancel</button>
                  <button className="btn-primary" onClick={saveProfile} disabled={editSaving}>
                    {editSaving && <span className="spinner" />}
                    <i className="ti ti-device-floppy" /> Save Changes
                  </button>
                </div>
              </>
            )}
          </div>

          {/* Change Password */}
          <div className="card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: pwMode ? 18 : 0 }}>
              <div style={{ fontWeight: 600, fontSize: 15, display: 'flex', alignItems: 'center', gap: 8 }}>
                <i className="ti ti-lock" style={{ color: 'var(--accent)' }} /> Change Password
              </div>
              {!pwMode && (
                <button className="btn-secondary btn-sm" onClick={() => { setPwForm({ current_password: '', new_password: '', confirm_password: '' }); setPwError(''); setPwSuccess(''); setPwMode(true); }}>
                  <i className="ti ti-key" /> Change Password
                </button>
              )}
            </div>

            {pwSuccess && !pwMode && (
              <div style={{ padding: '8px 12px', background: 'rgba(0,200,150,0.1)', borderRadius: 8, color: '#00c896', fontSize: 13, marginTop: 12 }}>
                <i className="ti ti-check" style={{ marginRight: 6 }} />{pwSuccess}
              </div>
            )}

            {pwMode && (
              <>
                {pwError && <div className="auth-error" style={{ marginBottom: 12 }}>{pwError}</div>}
                <div className="form-group">
                  <label className="form-label">Current Password</label>
                  <input type="password" value={pwForm.current_password} onChange={e => setPwForm(f => ({ ...f, current_password: e.target.value }))} autoFocus />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div className="form-group">
                    <label className="form-label">New Password</label>
                    <input type="password" value={pwForm.new_password} onChange={e => setPwForm(f => ({ ...f, new_password: e.target.value }))} placeholder="Min. 6 characters" />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Confirm New Password</label>
                    <input type="password" value={pwForm.confirm_password} onChange={e => setPwForm(f => ({ ...f, confirm_password: e.target.value }))} />
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
                  <button className="btn-secondary" onClick={() => setPwMode(false)}>Cancel</button>
                  <button className="btn-primary" onClick={changePassword} disabled={pwSaving}>
                    {pwSaving && <span className="spinner" />}
                    <i className="ti ti-lock-check" /> Update Password
                  </button>
                </div>
              </>
            )}
          </div>

          <RegistryTokenCard />

        </div>
      </div>
    </div>
  );
}
