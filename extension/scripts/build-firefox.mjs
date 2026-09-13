// Build the Firefox MV3 package into dist-firefox/.
//
// Runs the normal page build, then re-emits the background as a self-contained
// IIFE (Firefox has no background service worker), then rewrites the manifest.
// Everything else - content script, popup, dashboard, assets - is identical to
// the Chrome build; only the manifest and the background packaging differ.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'dist-firefox');

// Invoke vite's JS entry through node rather than the npx/.cmd shim: spawning
// a .cmd on Windows without a shell is an EINVAL, and enabling the shell just
// to work around that would mean quoting arguments by hand.
const VITE = resolve(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const run = (args) => execFileSync(process.execPath, [VITE, ...args], { cwd: ROOT, stdio: 'inherit' });

// 1. Chrome build first - popup, dashboard, content script and assets are
//    byte-identical between the two targets.
run(['build']);
run(['build', '--config', 'vite.config.content.js']);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(resolve(ROOT, 'dist'), OUT, { recursive: true });

// 2. Replace the module background with the inlined IIFE one.
rmSync(resolve(OUT, 'background.js'), { force: true });
rmSync(resolve(OUT, 'background.js.map'), { force: true });
run(['build', '--config', 'vite.config.firefox-bg.js']);

if (!existsSync(resolve(OUT, 'background.js'))) {
  throw new Error('firefox background build produced no background.js');
}
const bg = readFileSync(resolve(OUT, 'background.js'), 'utf8');
// An IIFE that still carries a bare import would fail silently at load time,
// which looks exactly like "the add-on does nothing".
if (/^\s*import\s|^\s*export\s/m.test(bg)) {
  throw new Error('firefox background.js still contains ES module syntax');
}

// 3. Rewrite the manifest for Gecko.
const manifest = JSON.parse(readFileSync(resolve(OUT, 'manifest.json'), 'utf8'));

// Firefox MV3 uses an event page, not a service worker. `type: module` goes
// with it - the IIFE bundle needs no module loader.
delete manifest.background.service_worker;
delete manifest.background.type;
manifest.background.scripts = ['background.js'];

// Gecko refuses to install an MV3 extension without an add-on id. 115 is the
// floor because storage.session (the verdict cache) landed there.
manifest.browser_specific_settings = {
  gecko: {
    id: 'readit@stardustcrusaders.hackathon',
    // 140 is the floor for data_collection_permissions on desktop; Android
    // only got it in 142. Both are pinned so `web-ext lint` stays clean -
    // storage.session (the verdict cache) needed 115 anyway, so nothing here
    // costs us reach we actually had.
    strict_min_version: '140.0',
    // Required by AMO. Declare it honestly: we read the text and images of
    // posts in the feed and send them to the backend the user configured, so
    // this is websiteContent. Nothing is collected by us - the backend is the
    // user's own machine by default - but the category still applies.
    data_collection_permissions: {
      required: ['websiteContent'],
    },
  },
  gecko_android: {
    strict_min_version: '142.0',
  },
};

writeFileSync(resolve(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

console.log(`\nFirefox package written to dist-firefox/`);
console.log(`  background : ${manifest.background.scripts.join(', ')} (iife, ${(bg.length / 1024).toFixed(1)} kB)`);
console.log(`  gecko id   : ${manifest.browser_specific_settings.gecko.id}`);
console.log(`  min version: desktop ${manifest.browser_specific_settings.gecko.strict_min_version}, android ${manifest.browser_specific_settings.gecko_android.strict_min_version}`);
console.log(`  host perms : ${manifest.host_permissions.length} (OPTIONAL in Firefox MV3 - must be granted in about:addons)`);
