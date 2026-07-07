import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: Vite serves the app on :5173 and proxies API + WebSocket to the Node
// server on :5174. Prod: the Node server serves the built app itself.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:5174',
      '/ws': { target: 'ws://localhost:5174', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
