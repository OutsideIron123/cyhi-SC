import { defineConfig } from 'vite';
import { resolve } from 'node:path';

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
