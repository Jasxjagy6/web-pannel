import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  // The SPA is served behind a reverse proxy at the /panel path (the only
  // publicly reachable port on the host is 80, shared with another app), so
  // all emitted asset URLs are rooted at /panel/. The upstream Caddy strips
  // /panel before forwarding to the frontend container.
  base: process.env.VITE_BASE_PATH || '/panel/',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    // Vite dev-server port +3 (5173 -> 5176). The two proxy targets
    // point at the backend, which is now on 3005 (originally shifted +3
    // to 3003 and then bumped further to coexist with another local
    // service already holding 3003).
    port: 5176,
    proxy: {
      '/api': {
        target: 'http://localhost:3005',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://localhost:3005',
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
