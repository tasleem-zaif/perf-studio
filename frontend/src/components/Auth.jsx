import { useState } from 'react';
import api from '../api';
import Logo from './Logo';

/* ── Feature highlights shown on the left branding panel ── */
const FEATURES = [
  {
    title: 'AI Script Generation',
    desc: 'Generate Load Test scripts using AI.',
  },
  {
    title: 'Auto-Healing Tests',
    desc: 'AI detects script failures, fixes the script and re-runs.',
  },
  {
    title: 'Real-time Analytics',
    desc: 'Live dashboards for application performance.',
  },
  {
    title: 'Multi-Environment Support',
    desc: 'Work seamlessly with multiple environments.',
  },
  {
    title: 'Team Collaboration',
    desc: 'Organization based user invitations and role-based project access.',
  },
];

export default function Auth({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [sessionActive, setSessionActive] = useState(false);

  async function doLogin(force = false) {
    setError(''); setLoading(true); setSessionActive(false);
    try {
      const { data } = await api.post('/auth/login', { email, password, ...(force && { force: true }) });
      localStorage.setItem('ps_token', data.token);
      onLogin(data.user);
    } catch (err) {
      if (err.response?.data?.code === 'SESSION_ACTIVE') {
        setSessionActive(true);
        setError(err.response.data.error);
      } else {
        setError(err.response?.data?.error || 'Login failed — the server may be unreachable. Check your network connection and try again.');
      }
    } finally { setLoading(false); }
  }

  function submit(e) { e.preventDefault(); doLogin(false); }

  return (
    <div id="auth-screen" style={{ alignItems: 'stretch', padding: 0 }}>
      <div className="auth-split">

        {/* ── LEFT — Branding & Features ── */}
        <div className="auth-left">
          {/* Logo */}
          <div style={{ marginBottom: 28 }}>
            <Logo size="lg" theme="dark" />
          </div>

          {/* Headline */}
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: '#fff', lineHeight: 1.25, letterSpacing: '-0.3px' }}>
              Next Gen<br />
              <span style={{ color: '#22c55e' }}>Performance Testing</span><br />
              Platform
            </div>
          </div>
          <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)', marginBottom: 24, lineHeight: 1.6, maxWidth: 380 }}>
            Generate, execute, and auto-heal load tests for any API — powered by AI.
            From script creation to analytics, all in one place.
          </div>

          {/* Feature list — compact */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: 1 }}>
            {FEATURES.map(f => (
              <div key={f.title} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                <div style={{
                  width: 22, height: 22, borderRadius: '50%',
                  background: 'rgba(34,197,94,0.15)', flexShrink: 0, marginTop: 1,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <i className="ti ti-check" style={{ fontSize: 13, color: '#22c55e', fontWeight: 700 }} />
                </div>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#fff', marginBottom: 1 }}>{f.title}</div>
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', lineHeight: 1.5 }}>{f.desc}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Bottom tagline */}
          <div style={{
            paddingTop: 20,
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.1)' }} />
            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', whiteSpace: 'nowrap' }}>
              Trusted by QA &amp; Performance Engineers
            </span>
            <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.1)' }} />
          </div>
        </div>

        {/* ── RIGHT — Login Form ── */}
        <div className="auth-right">
          <div className="auth-card" style={{ border: 'none', boxShadow: 'none', background: 'transparent', width: '100%', maxWidth: 400, padding: '36px 36px 0 36px' }}>

            {/* Form header */}
            <div style={{ marginBottom: 32 }}>
              <div className="auth-title" style={{ fontSize: 24, marginBottom: 6 }}>Sign in</div>
              <div className="auth-sub" style={{ fontSize: 13 }}>Sign in to manage your performance tests</div>
            </div>

            {error && (
              <div style={{
                marginBottom: 16,
                padding: '12px 14px',
                background: sessionActive ? 'rgba(245,158,11,0.08)' : 'rgba(247,84,100,0.08)',
                border: `1px solid ${sessionActive ? 'rgba(245,158,11,0.35)' : 'rgba(247,84,100,0.3)'}`,
                borderRadius: 10,
                fontSize: 13,
                color: sessionActive ? '#b45309' : '#dc2626',
                lineHeight: 1.5,
              }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  <i className={`ti ${sessionActive ? 'ti-alert-triangle' : 'ti-circle-x'}`}
                    style={{ fontSize: 15, flexShrink: 0, marginTop: 1 }} />
                  <span>{error}</span>
                </div>
                {sessionActive && (
                  <button
                    onClick={() => doLogin(true)}
                    disabled={loading}
                    style={{
                      marginTop: 10, width: '100%', padding: '8px 0',
                      background: '#f59e0b', color: '#fff', border: 'none',
                      borderRadius: 8, fontSize: 13, fontWeight: 600,
                      cursor: 'pointer', display: 'flex', alignItems: 'center',
                      justifyContent: 'center', gap: 6,
                    }}>
                    {loading ? <span className="spinner" /> : <i className="ti ti-logout" />}
                    Logout from other devices and Sign In
                  </button>
                )}
              </div>
            )}

            <form onSubmit={submit}>
              <div className="form-group">
                <label className="form-label">Email</label>
                <input type="email" placeholder="you@company.com" value={email}
                  onChange={e => setEmail(e.target.value)} required autoFocus />
              </div>
              <div className="form-group" style={{ marginBottom: 4 }}>
                <label className="form-label">Password</label>
                <input type="password" placeholder="Password" value={password}
                  onChange={e => setPassword(e.target.value)} required />
              </div>

              {/* Forgot password link */}
              <div style={{ textAlign: 'right', marginBottom: 16 }}>
                <a href="/forgot-password"
                  style={{ fontSize: 12, color: '#22c55e', textDecoration: 'none', fontWeight: 500 }}>
                  Forgot password?
                </a>
              </div>

              <button className="btn-primary"
                style={{ width: '100%', justifyContent: 'center', marginTop: 0, height: 44, fontSize: 15, borderRadius: 10 }}
                disabled={loading}>
                {loading && <span className="spinner" />}
                Sign in
              </button>
            </form>

            {/* Invite notice instead of register link */}
            <div style={{
              marginTop: 24, padding: '12px 16px',
              background: 'rgba(34,197,94,0.06)',
              border: '1px solid rgba(34,197,94,0.18)',
              borderRadius: 10, textAlign: 'center',
            }}>
              <i className="ti ti-mail" style={{ color: '#22c55e', marginRight: 6, fontSize: 14 }} />
              <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
                Don't have an account?{' '}
                <span style={{ color: 'var(--color-text-primary)', fontWeight: 600 }}>
                  Get an invite from your administrator
                </span>{' '}
                to access the application.
              </span>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
