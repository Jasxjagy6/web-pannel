import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    // Vite dev-server port +3 (5173 -> 5176). The two proxy targets
    // point at the backend, which also moved +3 (3000 -> 3003).
    port: 5176,
    proxy: {
      '/api': {
        target: 'http://localhost:3003',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://localhost:3003',
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
