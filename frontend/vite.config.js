import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes, req, res) => {
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              // Disable Nagle's algorithm so SSE chunks flush immediately
              proxyRes.socket?.setNoDelay(true);
              res.socket?.setNoDelay(true);
            }
          });
        },
      },
      '/projects-files': { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
});
