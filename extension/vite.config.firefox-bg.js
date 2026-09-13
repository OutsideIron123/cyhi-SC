import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Firefox MV3 has no background service worker - it uses an event page loaded
// via `background.scripts`. The Chrome build emits background.js as an ES
// module that imports from ./assets/*.js chunks, which is not something a
// Firefox background script can be relied on to load.
//
// So Firefox gets its own background build: one self-contained IIFE with every
// dependency inlined and no import statements at all. Same source, different
// packaging.
export default defineConfig({
  build: {
    outDir: 'dist-firefox',
    emptyOutDir: false,
    sourcemap: true,
    target: 'firefox115',
    lib: {
      entry: resolve(import.meta.dirname, 'src/background/index.js'),
      formats: ['iife'],
      name: 'READITBackground',
      fileName: () => 'background.js',
    },
  },
});
