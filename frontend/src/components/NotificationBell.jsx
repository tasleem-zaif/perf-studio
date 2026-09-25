import { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import api from '../api';

const POLL_MS = 30000;

// The app renders at `html { zoom: 0.9 }` (see index.css) — see CustomSelect.jsx for why
// a portaled position:fixed element needs its rect divided by the zoom factor.
function getZoom() {
  const z = parseFloat(getComputedStyle(document.documentElement).zoom);
  return z && !isNaN(z) ? z : 1;
}

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [dropPos, setDropPos] = useState({ top: 0, right: 0 });
  const wrapRef = useRef(null);
  const pollRef = useRef(null);

  function load() {
    api.get('/notifications').then(({ data }) => {
      setNotifications(data.notifications || []);
      setUnreadCount(data.unread_count || 0);
    }).catch(() => {});
  }

  useEffect(() => {
    load();
    pollRef.current = setInterval(load, POLL_MS);
    return () => clearInterval(pollRef.current);
  }, []);

  // Position the portaled dropdown against the bell button's own rect (no overflow hacks —
  // .app-banner clips absolutely-positioned children, so this can't live in its DOM subtree).
  useLayoutEffect(() => {
    if (!open || !wrapRef.current) return;
    function update() {
      const r = wrapRef.current.getBoundingClientRect();
      const zoom = getZoom();
      setDropPos({ top: (r.bottom + 8) / zoom, right: (window.innerWidth - r.right) / zoom });
    }
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDown(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        const portal = document.getElementById('notification-bell-portal');
        if (portal && portal.contains(e.target)) return;
        setOpen(false);
      }
    }
    function onEsc(e) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  async function toggleOpen() {
    const next = !open;
    setOpen(next);
    if (next && unreadCount > 0) {
      await api.put('/notifications/mark-read').catch(() => {});
      setUnreadCount(0);
    }
  }

  const dropdown = open && createPortal(
    <div
      id="notification-bell-portal"
      style={{
        position: 'fixed',
        top: dropPos.top,
        right: dropPos.right,
        width: 360,
        maxHeight: 440,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--color-background-primary)',
        border: '1px solid var(--color-border-secondary)',
        borderTop: '3px solid var(--accent)',
        borderRadius: 10,
        zIndex: 99999,
        boxShadow: '0 12px 32px rgba(0,0,0,0.28)',
        overflow: 'hidden',
      }}
    >
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 14px', borderBottom: '1px solid var(--color-border-secondary)', flexShrink: 0,
      }}>
        <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--color-text-primary)' }}>Notifications</span>
        <button className="btn-icon" onClick={() => setOpen(false)} aria-label="Close">
          <i className="ti ti-x" style={{ fontSize: 13 }} />
        </button>
      </div>
      <div style={{ overflowY: 'auto' }}>
        {notifications.length === 0 ? (
          <div style={{ padding: '28px 20px', textAlign: 'center', color: 'var(--color-text-tertiary)' }}>
            <i className="ti ti-bell-off" style={{ fontSize: 22, display: 'block', marginBottom: 8 }} />
            <span style={{ fontSize: 12 }}>No notifications yet.</span>
          </div>
        ) : notifications.map(n => (
          <div key={n.id} style={{
            display: 'flex', gap: 8, padding: '10px 14px',
            borderBottom: '1px solid var(--color-border-secondary)',
            transition: 'background .12s',
          }}
          onMouseEnter={e => e.currentTarget.style.background = 'var(--color-background-secondary)'}
          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            <span style={{
              width: 7, height: 7, borderRadius: '50%', marginTop: 5, flexShrink: 0,
              background: n.read_at ? 'transparent' : 'var(--accent)',
            }} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 12, color: 'var(--color-text-primary)' }}>{n.subject}</div>
              <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 2, whiteSpace: 'pre-wrap' }}>{n.details}</div>
              <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', marginTop: 4 }}>{new Date(n.created_at).toLocaleString()}</div>
            </div>
          </div>
        ))}
      </div>
    </div>,
    document.body
  );

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button className="banner-action-btn" onClick={toggleOpen} style={{ position: 'relative' }}>
        <i className="ti ti-bell" style={{ fontSize: 14 }} />
        {unreadCount > 0 && (
          <span style={{
            position: 'absolute', top: 2, right: 2, minWidth: 14, height: 14, padding: '0 3px',
            borderRadius: 7, background: '#ef4444', color: '#fff', fontSize: 9, fontWeight: 700,
            display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1,
          }}>
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>
      {dropdown}
    </div>
  );
}
