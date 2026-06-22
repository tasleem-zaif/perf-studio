import { useState } from 'react';
import api from '../api';

export default function ResetPassword({ token }) {
  const [password, setPassword]         = useState('');
  const [confirmPassword, setConfirm]   = useState('');
  const [loading, setLoading]           = useState(false);
  const [done, setDone]                 = useState(false);
  const [error, setError]               = useState('');

  async function submit(e) {
    e.preventDefault();
    if (password !== confirmPassword) return setError('Passwords do not match');
    if (password.length < 8) return setError('Password must be at least 8 characters');
    setLoading(true); setError('');
    try {
      await api.post('/auth/reset-password', { token, password });
      setDone(true);
    } catch (err) {
      setError(err.response?.data?.error || 'Reset failed — the link may have expired');
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
            <i className="ti ti-circle-check" style={{ fontSize: 48, color: '#22c55e', display: 'block', marginBottom: 14 }} />
            <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 8 }}>Password Reset!</div>
            <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginBottom: 24, lineHeight: 1.6 }}>
              Your password has been updated successfully.
            </div>
            <a href="/"
              style={{ display: 'inline-block', padding: '11px 28px', borderRadius: 8,
                       background: '#22c55e', color: '#fff', fontWeight: 700, fontSize: 14, textDecoration: 'none' }}>
              Sign In
            </a>
          </div>
        ) : (
          <>
            <div style={{ marginBottom: 22 }}>
              <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 6 }}>Set New Password</div>
              <div style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
                Choose a strong password (min 8 characters).
              </div>
            </div>

            {error && <div className="auth-error" style={{ marginBottom: 14 }}>{error}</div>}

            <form onSubmit={submit}>
              <div className="form-group">
                <label className="form-label">New Password</label>
                <input type="password" placeholder="Min 8 characters" value={password}
                  onChange={e => setPassword(e.target.value)} required autoFocus />
              </div>
              <div className="form-group">
                <label className="form-label">Confirm Password</label>
                <input type="password" placeholder="Repeat password" value={confirmPassword}
                  onChange={e => setConfirm(e.target.value)} required />
              </div>
              <button className="btn-primary"
                style={{ width: '100%', justifyContent: 'center', height: 44, fontSize: 15, borderRadius: 10, marginTop: 4 }}
                disabled={loading}>
                {loading && <span className="spinner" />}
                Reset Password
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
