import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import '@tabler/icons-webfont/dist/tabler-icons.min.css';
import './index.css';

// Force favicon to reload on every app start (bypasses browser cache)
const favicon = document.querySelector("link[rel='icon']") || document.createElement('link');
favicon.rel   = 'icon';
favicon.type  = 'image/svg+xml';
favicon.href  = '/favicon.svg?v=' + Date.now();
document.head.appendChild(favicon);

// Attach the session-cleanup handler at module load time — before React mounts —
// so there is no race condition between restore-session completing and the handler
// being registered. The handler fires on EVERY beforeunload (refresh + close); the
// sessionStorage flag distinguishes them on the next load.
window.addEventListener('beforeunload', () => {
  const token = localStorage.getItem('ps_token');
  if (!token) return; // not logged in — nothing to do
  sessionStorage.setItem('ps_refreshing', '1');
  navigator.sendBeacon(
    '/api/auth/logout',
    new Blob([JSON.stringify({ token })], { type: 'application/json' })
  );
});

ReactDOM.createRoot(document.getElementById('root')).render(
  <App />
);
