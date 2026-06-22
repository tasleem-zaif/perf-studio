import { useState } from 'react';
import api from '../api';

export default function ForgotPassword() {
  const [email, setEmail]     = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone]       = useState(false);
  const [error, setError]     = useState('');

  async function submit(e) {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      await api.post('/auth/forgot-password', { email });
      setDone(true);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to send reset link — the server may be unreachable. Check your network connection and try again.');
    } finally { setLoading(false); }
  }

  return (
    <div id="auth-screen" style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div className="auth-card" style={{ width: 400, maxWidth: '90vw' }}>

        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 28 }}>
          <img src="https://www.qtsolv.com/wp-content/themes/qtsolvtheme/assets/images/svg/logo.svg"
            alt="Quarks" style={{ height: 32, width: 'auto' }} />
          <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--color-text-primary)' }}>
            Peako
          </span>
        </div>

        {done ? (
          <div style={{ textAlign: 'center', padding: '12px 0' }}>
            <i className="ti ti-mail-check" style={{ fontSize: 48, color: '#22c55e', display: 'block', marginBottom: 14 }} />
            <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 8 }}>Check your email</div>
            <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.6, marginBottom: 24 }}>
              If <strong>{email}</strong> has an account, a password reset link has been sent.<br />
              The link expires in <strong>30 minutes</strong>.
            </div>
            <a href="/" style={{ color: '#22c55e', fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>
              ← Back to Sign In
            </a>
          </div>
        ) : (
          <>
            <div style={{ marginBottom: 22 }}>
              <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 6 }}>Forgot Password?</div>
              <div style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
                Enter your email and we'll send you a reset link.
              </div>
            </div>

            {error && <div className="auth-error" style={{ marginBottom: 14 }}>{error}</div>}

            <form onSubmit={submit}>
              <div className="form-group">
                <label className="form-label">Email Address</label>
                <input type="email" placeholder="you@company.com" value={email}
                  onChange={e => setEmail(e.target.value)} required autoFocus />
              </div>
              <button className="btn-primary"
                style={{ width: '100%', justifyContent: 'center', height: 44, fontSize: 15, borderRadius: 10, marginTop: 4 }}
                disabled={loading}>
                {loading && <span className="spinner" />}
                Send Reset Link
              </button>
            </form>

            <div style={{ marginTop: 18, textAlign: 'center' }}>
              <a href="/" style={{ fontSize: 12, color: 'var(--color-text-secondary)', textDecoration: 'none' }}>
                ← Back to Sign In
              </a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
