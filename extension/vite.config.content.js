import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Build 2 of 2: the content script.
// Content scripts are injected as classic scripts — no import/export at runtime —
// so this is a separate IIFE lib build that appends into the same dist/ folder.
// emptyOutDir:false is load-bearing: it must not wipe build 1's output.
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: true,
    target: 'chrome114',
    lib: {
      entry: resolve(import.meta.dirname, 'src/content/index.js'),
      formats: ['iife'],
      name: 'READITContent',
      fileName: () => 'content.js',
    },
  },
});
