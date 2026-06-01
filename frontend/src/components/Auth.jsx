import { useState, useEffect } from 'react';
import api from '../api';
import CustomSelect from './CustomSelect';

export default function Auth({ onLogin }) {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('');
  const [orgId, setOrgId] = useState('');
  const [orgName, setOrgName] = useState('');
  const [createNewOrg, setCreateNewOrg] = useState(false);
  const [orgs, setOrgs] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (mode === 'register') {
      api.get('/orgs').then(({ data }) => setOrgs(data.orgs)).catch(() => {});
    }
  }, [mode]);

  function switchMode(m) {
    setMode(m);
    setError('');
    setPending(false);
    setRole('');
    setOrgId('');
    setOrgName('');
    setCreateNewOrg(false);
  }

  function handleOrgSelect(value) {
    if (value === '__new__') {
      setOrgId('');
      setOrgName('');
      setCreateNewOrg(true);
    } else {
      setOrgId(value);
      setOrgName('');
      setCreateNewOrg(false);
    }
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (mode === 'login') {
        const { data } = await api.post('/auth/login', { email, password });
        localStorage.setItem('ps_token', data.token);
        onLogin(data.user);
      } else {
        await api.post('/auth/register', {
          email, name, password, role,
          org_id: orgId || undefined,
          org_name: orgName || undefined,
        });
        setPending(true);
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  if (pending) {
    return (
      <div id="auth-screen">
        <div className="auth-card">
          <div className="auth-logo">
            <div className="auth-logo-icon">P</div>
            <div>
              <div className="auth-logo-text">Performance Studio</div>
              <div className="auth-logo-sub">Performance Testing Platform</div>
            </div>
          </div>
          <div style={{ textAlign: 'center', padding: '24px 0 8px' }}>
            <i className="ti ti-clock" style={{ fontSize: '48px', color: 'var(--accent)', display: 'block', marginBottom: '16px' }} />
            <div className="auth-title" style={{ marginBottom: '10px' }}>Registration Submitted</div>
            <div className="auth-sub" style={{ marginBottom: '24px', lineHeight: '1.6' }}>
              Your account is pending approval.{' '}
              {role === 'org_admin'
                ? 'The super admin will review and approve your organization admin request.'
                : 'Your organization admin will review and approve your request.'}
            </div>
            <button className="btn-secondary" style={{ width: '100%', justifyContent: 'center' }} onClick={() => switchMode('login')}>
              Back to Sign In
            </button>
          </div>
        </div>
      </div>
    );
  }

  const orgSelectValue = createNewOrg ? '__new__' : (orgId || '');

  return (
    <div id="auth-screen">
      <div className="auth-card">
        <div className="auth-logo">
          <div className="auth-logo-icon">P</div>
          <div>
            <div className="auth-logo-text">Performance Studio</div>
            <div className="auth-logo-sub">Performance Testing Platform</div>
          </div>
        </div>
        <div className="auth-title">{mode === 'login' ? 'Welcome back' : 'Create account'}</div>
        <div className="auth-sub">
          {mode === 'login' ? 'Sign in to manage your performance tests' : 'Start your performance testing journey'}
        </div>
        {error && <div className="auth-error">{error}</div>}
        <form onSubmit={submit}>
          {mode === 'register' && (
            <div className="form-group">
              <label className="form-label">Full Name</label>
              <input type="text" placeholder="Your name" value={name} onChange={e => setName(e.target.value)} required />
            </div>
          )}
          <div className="form-group">
            <label className="form-label">Email</label>
            <input type="email" placeholder="you@company.com" value={email} onChange={e => setEmail(e.target.value)} required />
          </div>
          <div className="form-group">
            <label className="form-label">Password</label>
            <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} required />
          </div>

          {mode === 'register' && (
            <>
              <div className="form-group">
                <label className="form-label">Role</label>
                <CustomSelect value={role} onChange={e => { setRole(e.target.value); setOrgId(''); setOrgName(''); setCreateNewOrg(false); }}>
                  <option value="">Select a role...</option>
                  <option value="org_admin">Organization Admin</option>
                  <option value="user">Regular User</option>
                </CustomSelect>
              </div>

              {/* Organization picker — both roles */}
              {(role === 'org_admin' || role === 'user') && (
                <div className="form-group">
                  <label className="form-label">Organization</label>
                  <CustomSelect value={orgSelectValue} onChange={e => handleOrgSelect(e.target.value)}>
                    <option value="">Select an organization...</option>
                    {orgs.map(o => <option key={o.id} value={String(o.id)}>{o.name}</option>)}
                    {role === 'org_admin' && (
                      <option value="__new__">＋ Create new organization...</option>
                    )}
                  </CustomSelect>

                  {/* New org name input — only when "Create new" is chosen */}
                  {role === 'org_admin' && createNewOrg && (
                    <input
                      type="text"
                      style={{ marginTop: '8px' }}
                      placeholder="New organization name"
                      value={orgName}
                      onChange={e => setOrgName(e.target.value)}
                      required
                      autoFocus
                    />
                  )}

                  {orgs.length === 0 && role === 'user' && (
                    <div style={{ fontSize: '11px', color: 'var(--color-text-tertiary)', marginTop: '4px' }}>
                      No organizations available yet. Ask your admin to register first.
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          <button className="btn-primary" style={{ width: '100%', justifyContent: 'center', marginTop: '8px' }} disabled={loading}>
            {loading && <span className="spinner" />}
            {mode === 'login' ? 'Sign in' : 'Submit Registration'}
          </button>
        </form>
        <div className="auth-switch">
          {mode === 'login' ? (
            <>Don't have an account? <button onClick={() => switchMode('register')}>Register</button></>
          ) : (
            <>Already have an account? <button onClick={() => switchMode('login')}>Sign in</button></>
          )}
        </div>
      </div>
    </div>
  );
}
