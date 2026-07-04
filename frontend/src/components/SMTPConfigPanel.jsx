import { useState, useEffect } from 'react';
import api from '../api';
import { useToast } from '../hooks/useToast';

const BLANK_SMTP = { smtp_host: '', smtp_port: '587', smtp_secure: false, smtp_user: '', smtp_pass: '', from_name: 'Peako', from_email: '' };

/** Detect SMTP host/port from email domain */
function detectSmtpFromEmail(email) {
  if (!email || !email.includes('@')) return {};
  const domain = email.split('@')[1].toLowerCase();
  const providers = {
    'gmail.com':                { smtp_host: 'smtp.gmail.com',          smtp_port: '587' },
    'googlemail.com':           { smtp_host: 'smtp.gmail.com',          smtp_port: '587' },
    'outlook.com':              { smtp_host: 'smtp-mail.outlook.com',   smtp_port: '587' },
    'hotmail.com':              { smtp_host: 'smtp-mail.outlook.com',   smtp_port: '587' },
    'live.com':                 { smtp_host: 'smtp-mail.outlook.com',   smtp_port: '587' },
    'msn.com':                  { smtp_host: 'smtp-mail.outlook.com',   smtp_port: '587' },
    'yahoo.com':                { smtp_host: 'smtp.mail.yahoo.com',     smtp_port: '587' },
    'yahoo.co.uk':              { smtp_host: 'smtp.mail.yahoo.com',     smtp_port: '587' },
    'icloud.com':               { smtp_host: 'smtp.mail.me.com',        smtp_port: '587' },
    'me.com':                   { smtp_host: 'smtp.mail.me.com',        smtp_port: '587' },
    'protonmail.com':           { smtp_host: 'smtp.protonmail.com',     smtp_port: '587' },
    'proton.me':                { smtp_host: 'smtp.protonmail.com',     smtp_port: '587' },
    'zoho.com':                 { smtp_host: 'smtp.zoho.com',           smtp_port: '587' },
  };
  return providers[domain] || { smtp_host: `smtp.${domain}`, smtp_port: '587' };
}

export default function SMTPConfigPanel({ currentUser, showHelp = true, standalone = true }) {
  const { toast } = useToast();
  const [cfg, setCfg]           = useState({ ...BLANK_SMTP });
  const [saving, setSaving]     = useState(false);
  const [testing, setTesting]   = useState(false);
  const [testEmail, setTestEmail] = useState('');
  const [autoDetected, setAutoDetected] = useState(false);

  useEffect(() => {
    api.get('/alerts/config').then(({ data }) => {
      if (data.config) {
        const c = data.config;
        setCfg({ ...BLANK_SMTP, ...c, smtp_pass: c.smtp_pass || '' });
        if (c.inherited_from_super_admin) setAutoDetected('super_admin');
      } else if (currentUser?.email) {
        // No config at all — auto-detect from user's own email
        const detected = detectSmtpFromEmail(currentUser.email);
        setCfg(prev => ({
          ...prev, ...detected,
          smtp_user: currentUser.email,
          from_email: currentUser.email,
          from_name: currentUser.name || 'Peako',
        }));
        setAutoDetected('email');
      }
    }).catch(() => {});
  }, [currentUser?.email]);

  async function save() {
    setSaving(true);
    try {
      await api.put('/alerts/config', cfg);
      toast('SMTP configuration saved', 'success');
    } catch (e) {
      toast(e.response?.data?.error || 'Failed to save SMTP configuration — check the host, port and credentials are correct.', 'error');
    } finally { setSaving(false); }
  }

  async function testConnection() {
    setTesting(true);
    try {
      const { data } = await api.post('/alerts/test-smtp');
      toast(data.message, 'success');
    } catch (e) {
      toast(e.response?.data?.error || 'Connection failed', 'error');
    } finally { setTesting(false); }
  }

  async function sendTest() {
    if (!testEmail) return toast('Enter a recipient email first', 'warn');
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(testEmail)) return toast(`"${testEmail}" is not a valid email`, 'error');
    setTesting(true);
    try {
      const { data } = await api.post('/alerts/send-test', { to: testEmail });
      toast(data.message, 'success');
    } catch (e) {
      toast(e.response?.data?.error || 'Send failed', 'error');
    } finally { setTesting(false); }
  }

  function set(k, v) { setCfg(c => ({ ...c, [k]: v })); }

  return (
    <div className={standalone ? 'page fade-in' : ''} style={{ maxWidth: 600 }}>
      <div style={{ fontSize: '13px', color: 'var(--color-text-secondary)', marginBottom: '16px' }}>
        Configure SMTP to send invite emails and post-test alert emails to users.
      </div>

      {autoDetected === 'super_admin' && (
        <div style={{ padding: '10px 14px', background: 'rgba(73,204,61,0.08)', border: '1px solid rgba(73,204,61,0.25)', borderRadius: '8px', marginBottom: '16px', fontSize: '12px', color: 'var(--color-text-secondary)', display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
          <i className="ti ti-shield-check" style={{ color: 'var(--accent)', fontSize: '14px', flexShrink: 0, marginTop: '1px' }} />
          <div>
            <strong style={{ color: 'var(--accent)' }}>Pre-filled from Super Admin's SMTP configuration.</strong>{' '}
            The SMTP server settings have been copied from the Super Admin's configuration.
            Just enter your <strong>SMTP Password</strong> and update <strong>From Name / From Email</strong> if needed, then save.
          </div>
        </div>
      )}
      {autoDetected === 'email' && (
        <div style={{ padding: '10px 14px', background: 'rgba(73,204,61,0.08)', border: '1px solid rgba(73,204,61,0.25)', borderRadius: '8px', marginBottom: '16px', fontSize: '12px', color: 'var(--color-text-secondary)', display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
          <i className="ti ti-sparkles" style={{ color: 'var(--accent)', fontSize: '14px', flexShrink: 0, marginTop: '1px' }} />
          <div>
            <strong style={{ color: 'var(--accent)' }}>Auto-detected from your email ({currentUser?.email}).</strong>{' '}
            Just enter your <strong>SMTP Password</strong> and <strong>From Name</strong> to complete setup.
          </div>
        </div>
      )}

      {/* SMTP fields */}
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
            <span style={{ fontSize: 12 }}>Secure</span>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">SMTP Username</label>
          <input type="text" value={cfg.smtp_user} onChange={e => set('smtp_user', e.target.value)} placeholder="user@gmail.com" autoComplete="new-password" />
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">SMTP Password</label>
          <input type="password" value={cfg.smtp_pass} onChange={e => set('smtp_pass', e.target.value)} placeholder="App password" autoComplete="new-password" />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 20 }}>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">From Name</label>
          <input type="text" value={cfg.from_name} onChange={e => set('from_name', e.target.value)} placeholder="Peako" />
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">From Email</label>
          <input type="email" value={cfg.from_email} onChange={e => set('from_email', e.target.value)} placeholder="alerts@yourcompany.com" />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 20 }}>
        <button className="btn-primary btn-sm" onClick={save} disabled={saving}>
          {saving ? <><span className="spinner" />Saving…</> : <><i className="ti ti-device-floppy" />Save Config</>}
        </button>
        <button className="btn-secondary btn-sm" onClick={testConnection} disabled={testing}>
          {testing ? <><span className="spinner" />Testing…</> : <><i className="ti ti-plug" />Test Connection</>}
        </button>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 'auto' }}>
          <input type="email" value={testEmail} onChange={e => setTestEmail(e.target.value)} placeholder="recipient@example.com"
            style={{ fontSize: 12, padding: '5px 10px', width: 200 }} data-form-type="other" />
          <button className="btn-secondary btn-sm" onClick={sendTest} disabled={testing}>
            <i className="ti ti-send" />Send Test
          </button>
        </div>
      </div>

      {/* Provider help */}
      {showHelp && (
        <div style={{ padding: '12px 14px', background: 'var(--color-background-secondary)', border: '1px solid var(--color-border-secondary)', borderRadius: '8px', fontSize: '12px', color: 'var(--color-text-secondary)' }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}><i className="ti ti-bulb" style={{ marginRight: 6, color: 'var(--accent)' }} />Recommended: Gmail</div>
          <div>Host: <code>smtp.gmail.com</code> · Port: <code>587</code> · Secure: OFF</div>
          <div style={{ marginTop: 4 }}>Use an <strong>App Password</strong> (not your Gmail password) — generate at <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>myaccount.google.com/apppasswords</a></div>
        </div>
      )}
    </div>
  );
}
