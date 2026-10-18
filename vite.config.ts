import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The app is served by the Node server (server/index.ts). In dev, the server
// mounts Vite in middleware mode; this config is shared by both modes.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
  server: {
    port: 5199,
  },
});
