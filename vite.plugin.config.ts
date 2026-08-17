import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const packageId = 'spatial-trajectory';
const globalName = 'SpatialTrajectoryPlugin';

function moduleLoaderHandoff(): Plugin {
  return {
    name: 'spatial-module-loader-handoff',
    renderChunk(code) {
      return {
        code: `window.__ModuleLoader__.load({id:${JSON.stringify(packageId)},factory:(require)=>{const module={exports:{}};const exports=module.exports;${code}\nreturn module.exports;}});`,
        map: null,
      };
    },
  };
}

export default defineConfig({
  plugins: [react(), moduleLoaderHandoff()],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: 'dist/plugin/harness',
    // This directory is the browser-facing plugin surface. Keep it free of
    // transient TypeScript ESM output: Harness watches it and may otherwise
    // try to execute an intermediate `client.js` before Vite wraps it.
    emptyOutDir: true,
    lib: {
      entry: 'src/harness/client-bundle-entry.ts',
      name: globalName,
      formats: ['cjs'],
      fileName: () => 'client.js',
    },
    rollupOptions: {
      external: ['react', 'react/jsx-runtime'],
      output: { inlineDynamicImports: true },
    },
    // Keep the distributable compact; local development still has Vite's
    // original sources and source maps do not participate in module loading.
    sourcemap: false,
  },
});
