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

ReactDOM.createRoot(document.getElementById('root')).render(
  <App />
);
