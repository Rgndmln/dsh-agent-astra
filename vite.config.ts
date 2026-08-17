import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 4173, strictPort: true },
  // The standalone build is shipped with the plugin package. Source maps add
  // several megabytes there without helping the embedded runtime.
  build: { target: 'es2022', sourcemap: false },
});
