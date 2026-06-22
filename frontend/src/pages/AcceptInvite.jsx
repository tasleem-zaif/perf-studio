import { useState, useEffect } from 'react';
import api from '../api';

/* Same feature list as login page */
const FEATURES = [
  { title: 'AI Script Generation',      desc: 'Generate Load Test scripts using AI.' },
  { title: 'Auto-Healing Tests',         desc: 'AI detects script failures, fixes the script and re-runs.' },
  { title: 'Real-time Analytics',        desc: 'Live dashboards for application performance.' },
  { title: 'Multi-Environment Support',  desc: 'Work seamlessly with multiple environments.' },
  { title: 'Team Collaboration',         desc: 'Organization based user invitations and role-based project access.' },
];

/* ── Shared left branding panel ── */
function LeftPanel() {
  return (
    <div className="auth-left">
      {/* Logo */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 28 }}>
        <img
          src="https://www.qtsolv.com/wp-content/themes/qtsolvtheme/assets/images/svg/logo.svg"
          alt="Quarks"
          style={{ height: 36, width: 'auto' }}
        />
        <div style={{ width: 1, height: 30, background: 'rgba(255,255,255,0.15)' }} />
        <div>
          <div style={{ fontSize: 16, fontWeight: 800, color: '#fff', letterSpacing: '-0.5px' }}>Peako</div>
          <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', marginTop: 1 }}>by Quarks Technosoft</div>
        </div>
      </div>

      {/* Headline */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 22, fontWeight: 800, color: '#fff', lineHeight: 1.25, letterSpacing: '-0.3px' }}>
          AI-Powered<br />
          <span style={{ color: '#22c55e' }}>Performance Testing</span><br />
          Platform
        </div>
      </div>
      <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)', marginBottom: 24, lineHeight: 1.6, maxWidth: 380 }}>
        Generate, execute, and auto-heal load tests for any API — powered by AI.
        From script creation to analytics, all in one place.
      </div>

      {/* Features */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: 1 }}>
        {FEATURES.map(f => (
          <div key={f.title} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <div style={{
              width: 22, height: 22, borderRadius: '50%',
              background: 'rgba(34,197,94,0.15)', flexShrink: 0, marginTop: 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <i className="ti ti-check" style={{ fontSize: 13, color: '#22c55e' }} />
            </div>
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#fff', marginBottom: 1 }}>{f.title}</div>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', lineHeight: 1.5 }}>{f.desc}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Bottom tagline */}
      <div style={{ paddingTop: 20, display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.1)' }} />
        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', whiteSpace: 'nowrap' }}>
          Trusted by QA &amp; Performance Engineers
        </span>
        <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.1)' }} />
      </div>
    </div>
  );
}

/* ── Right panel wrapper (same style as login) ── */
function RightPanel({ children }) {
  return (
    <div className="auth-right">
      <div className="auth-card" style={{
        border: 'none', boxShadow: 'none', background: 'transparent',
        width: '100%', maxWidth: 400, padding: '36px 36px 0 36px',
      }}>
        {children}
      </div>
    </div>
  );
}

/* ── Full split layout wrapper ── */
function SplitLayout({ children }) {
  return (
    <div id="auth-screen" style={{ alignItems: 'stretch', padding: 0 }}>
      <div className="auth-split">
        <LeftPanel />
        <RightPanel>{children}</RightPanel>
      </div>
    </div>
  );
}

/* ── Main component ── */
export default function AcceptInvite({ token }) {
  const [invite, setInvite]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [form, setForm]       = useState({ name: '', password: '', confirmPassword: '' });
  const [saving, setSaving]   = useState(false);
  const [done, setDone]       = useState(false);

  useEffect(() => {
    api.get(`/invites/validate/${token}`)
      .then(({ data }) => {
        setInvite(data);
        setForm(f => ({ ...f, name: data.name || '' }));
      })
      .catch(e => {
        const status  = e.response?.status;
        const errCode = e.response?.data?.error;
        const errMsg  = e.response?.data?.message || e.response?.data?.error || 'Invalid or expired invite link.';
        if (status === 409 || errCode === 'already_accepted') {
          window.location.href = '/';
        } else if (status === 410 || errCode === 'expired') {
          setError('__expired__');
        } else {
          setError(errMsg);
        }
      })
      .finally(() => setLoading(false));
  }, [token]);

  async function accept(e) {
    e.preventDefault();
    if (form.password !== form.confirmPassword) return setError('Passwords do not match');
    if (form.password.length < 8) return setError('Password must be at least 8 characters');
    setSaving(true); setError('');
    try {
      const { data } = await api.post(`/invites/accept/${token}`, {
        name: form.name,
        password: form.password,
      });
      localStorage.setItem('ps_token', data.token);
      setDone(true);
      setTimeout(() => { window.location.href = '/'; }, 1200);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to accept invite');
    } finally { setSaving(false); }
  }

  /* Loading */
  if (loading) return (
    <SplitLayout>
      <div style={{ textAlign: 'center', padding: '40px 0' }}>
        <span className="spinner" style={{ width: 32, height: 32, display: 'inline-block' }} />
        <div style={{ marginTop: 16, color: 'var(--color-text-secondary)', fontSize: 14 }}>Validating invite…</div>
      </div>
    </SplitLayout>
  );

  /* Done */
  if (done) return (
    <SplitLayout>
      <div style={{ textAlign: 'center', padding: '40px 0' }}>
        <i className="ti ti-circle-check" style={{ fontSize: 52, color: '#22c55e', display: 'block', marginBottom: 16 }} />
        <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-text-primary)' }}>Account Created!</div>
        <div style={{ color: 'var(--color-text-secondary)', marginTop: 8 }}>Logging you in…</div>
        <span className="spinner" style={{ width: 24, height: 24, marginTop: 16, display: 'inline-block' }} />
      </div>
    </SplitLayout>
  );

  /* Expired */
  if (error === '__expired__') return (
    <SplitLayout>
      <div style={{ textAlign: 'center', padding: '40px 0' }}>
        <i className="ti ti-clock-off" style={{ fontSize: 52, color: '#f59e0b', display: 'block', marginBottom: 16 }} />
        <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-text-primary)' }}>Invite Expired</div>
        <div style={{ color: 'var(--color-text-secondary)', marginTop: 8, lineHeight: 1.6 }}>
          This invitation link has expired (72-hour limit).
        </div>
        <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 8 }}>
          Please ask your administrator to send a new invite.
        </div>
      </div>
    </SplitLayout>
  );

  /* Not found */
  if (error && !invite) return (
    <SplitLayout>
      <div style={{ textAlign: 'center', padding: '40px 0' }}>
        <i className="ti ti-link-off" style={{ fontSize: 52, color: 'var(--danger)', display: 'block', marginBottom: 16 }} />
        <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-text-primary)' }}>Invite Not Found</div>
        <div style={{ color: 'var(--color-text-secondary)', marginTop: 8 }}>{error}</div>
        <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 16 }}>
          Contact your administrator for a valid invite link.
        </div>
      </div>
    </SplitLayout>
  );

  const roleLabel = invite?.role === 'org_admin' ? 'Organization Admin' : 'Team Member';

  /* Main invite form */
  return (
    <SplitLayout>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <div className="auth-title" style={{ fontSize: 22, marginBottom: 6 }}>
          You're invited! 🎉
        </div>
        <div className="auth-sub" style={{ fontSize: 13 }}>
          Set up your account to get started
        </div>
      </div>

      {/* Invite context banner */}
      <div style={{
        marginBottom: 20, padding: '10px 14px',
        background: 'rgba(34,197,94,0.07)',
        border: '1px solid rgba(34,197,94,0.22)',
        borderRadius: 10,
      }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#22c55e', marginBottom: 3, display: 'flex', alignItems: 'center', gap: 6 }}>
          <i className="ti ti-mail" />
          Invitation from {invite?.inviter_name}
        </div>
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
          You've been invited as a <strong style={{ color: 'var(--color-text-primary)' }}>{roleLabel}</strong>
          {invite?.org_name && <> for <strong style={{ color: 'var(--color-text-primary)' }}>{invite.org_name}</strong></>}.
        </div>
        <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 3 }}>
          {invite?.email}
        </div>
      </div>

      {error && <div className="auth-error" style={{ marginBottom: 16 }}>{error}</div>}

      <form onSubmit={accept}>
        <div className="form-group">
          <label className="form-label">Full Name</label>
          <input type="text" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder="Your full name" required autoComplete="off" autoFocus />
        </div>

        <div className="form-group">
          <label className="form-label">Password</label>
          <input type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
            placeholder="Min 8 characters" required />
        </div>

        <div className="form-group">
          <label className="form-label">Confirm Password</label>
          <input type="password" value={form.confirmPassword} onChange={e => setForm(f => ({ ...f, confirmPassword: e.target.value }))}
            placeholder="Repeat password" required />
        </div>

        <button className="btn-primary"
          style={{ width: '100%', justifyContent: 'center', marginTop: 8, height: 44, fontSize: 15, borderRadius: 10 }}
          disabled={saving}>
          {saving && <span className="spinner" />}
          Set Up Account
        </button>
      </form>

      {/* Footer note */}
      <div style={{
        marginTop: 20, padding: '10px 14px',
        background: 'rgba(34,197,94,0.04)',
        border: '1px solid rgba(34,197,94,0.12)',
        borderRadius: 10, textAlign: 'center',
      }}>
        <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
          Already have an account?{' '}
          <a href="/" style={{ color: '#22c55e', fontWeight: 600, textDecoration: 'none' }}>Sign in</a>
        </span>
      </div>
    </SplitLayout>
  );
}
