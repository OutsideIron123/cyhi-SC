import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Build 1 of 2: the extension pages (popup, dashboard) and the MV3 service worker.
// The service worker is declared "type": "module" in the manifest, so plain ESM
// output works. The content script CANNOT be ESM — it gets its own IIFE build in
// vite.config.content.js, which runs second with emptyOutDir disabled.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Chrome DevTools can read these and it costs nothing at demo scale.
    sourcemap: true,
    target: 'chrome114',
    rollupOptions: {
      input: {
        popup: resolve(import.meta.dirname, 'popup.html'),
        dashboard: resolve(import.meta.dirname, 'dashboard.html'),
        background: resolve(import.meta.dirname, 'src/background/index.js'),
      },
      output: {
        // background.js must sit at a stable path because manifest.json names it.
        entryFileNames: (chunk) =>
          chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
