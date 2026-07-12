import { useToast } from '../hooks/useToast';

const CONFIG = {
  success: { icon: 'ti-circle-check',  bg: '#16a34a', border: '#15803d', fg: '#ffffff' },
  error:   { icon: 'ti-circle-x',      bg: '#dc2626', border: '#b91c1c', fg: '#ffffff' },
  warn:    { icon: 'ti-alert-triangle',bg: '#d97706', border: '#b45309', fg: '#ffffff' },
  info:    { icon: 'ti-info-circle',   bg: '#2563eb', border: '#1d4ed8', fg: '#ffffff' },
};

// Inject keyframes once
if (typeof document !== 'undefined' && !document.getElementById('toast-kf')) {
  const style = document.createElement('style');
  style.id = 'toast-kf';
  style.textContent = `
    @keyframes toast-slide-in {
      from { opacity: 0; transform: translateX(48px); }
      to   { opacity: 1; transform: translateX(0); }
    }
    @keyframes toast-progress {
      from { width: 100%; }
      to   { width: 0%; }
    }
  `;
  document.head.appendChild(style);
}

function ToastItem({ t, onDismiss }) {
  const cfg = CONFIG[t.type] || CONFIG.info;
  const secs = Math.round((t.duration || 5000) / 1000);

  return (
    <div
      style={{
        position: 'relative', overflow: 'hidden',
        minWidth: '300px', maxWidth: '420px',
        padding: '12px 14px',
        background: cfg.bg,
        border: `1px solid ${cfg.border}`,
        borderRadius: '10px',
        boxShadow: '0 4px 20px rgba(0,0,0,0.25)',
        display: 'flex', alignItems: 'flex-start', gap: '10px',
        animation: 'toast-slide-in 0.22s ease',
        fontFamily: 'var(--font)',
      }}
    >
      {/* Icon */}
      <i
        className={`ti ${cfg.icon}`}
        style={{ fontSize: '17px', color: cfg.fg, marginTop: '1px', flexShrink: 0 }}
      />

      {/* Message */}
      <span style={{ flex: 1, fontSize: '13px', color: cfg.fg, lineHeight: 1.5, wordBreak: 'break-word' }}>
        {t.message}
      </span>

      {/* Close button */}
      <button
        onClick={() => onDismiss(t.id)}
        title="Dismiss"
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          color: cfg.fg, opacity: 0.8, fontSize: '16px',
          padding: '0', lineHeight: 1, flexShrink: 0, marginTop: '1px',
          transition: 'opacity .15s',
        }}
        onMouseEnter={e => e.currentTarget.style.opacity = '1'}
        onMouseLeave={e => e.currentTarget.style.opacity = '0.8'}
      >
        <i className="ti ti-x" style={{ fontSize: '13px' }} />
      </button>

      {/* Progress bar — runs for exactly `duration` ms then disappears */}
      <div
        style={{
          position: 'absolute', bottom: 0, left: 0, height: '3px',
          background: cfg.fg, opacity: 0.5,
          animation: `toast-progress ${secs}s linear forwards`,
        }}
      />
    </div>
  );
}

export default function Toast() {
  const { toasts, dismiss } = useToast();
  if (!toasts.length) return null;

  return (
    <div
      style={{
        position: 'fixed', bottom: '24px', right: '24px',
        display: 'flex', flexDirection: 'column-reverse', // newest at bottom-right (top of stack visually)
        gap: '8px', zIndex: 9999,
        alignItems: 'flex-end',
        maxHeight: 'calc(100vh - 48px)',
        overflowY: 'auto',
        pointerEvents: 'none',
      }}
    >
      {toasts.map(t => (
        <div key={t.id} style={{ pointerEvents: 'all' }}>
          <ToastItem t={t} onDismiss={dismiss} />
        </div>
      ))}
    </div>
  );
}
