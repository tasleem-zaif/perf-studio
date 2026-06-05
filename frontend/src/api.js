import axios from 'axios';

const api = axios.create({ baseURL: '/api' });

api.interceptors.request.use(cfg => {
  const token = localStorage.getItem('ps_token');
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  // Prevent browser from serving stale 304 cached responses
  cfg.headers['Cache-Control'] = 'no-cache';
  cfg.headers['Pragma'] = 'no-cache';
  return cfg;
});

api.interceptors.response.use(
  res => res,
  err => {
    if (err.response?.status === 401) {
      // Only force-reload when a session token already exists (i.e. it expired).
      // If there is no token the 401 is a failed login attempt — let the
      // calling code handle it and show an inline error message instead.
      if (localStorage.getItem('ps_token')) {
        localStorage.removeItem('ps_token');
        window.location.reload();
      }
    }
    return Promise.reject(err);
  }
);

export default api;
