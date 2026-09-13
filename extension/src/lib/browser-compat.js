// Namespace shim, imported for its side effect before anything touches an
// extension API.
//
// Chrome exposes `chrome.*` returning promises under MV3. Firefox's canonical
// namespace is `browser.*`, which is promise-based and a superset of the
// callback style. Rather than rewrite ~26 call sites to a neutral name, alias
// `chrome` onto `browser` where `browser` exists.
//
// In Chrome `globalThis.browser` is undefined, so this is a no-op and the
// Chrome build is unaffected.
//
// Import this FIRST in every entry point. ES modules evaluate all imports
// before the importing module's body, which matters because
// background/index.js registers chrome.runtime listeners at top level - those
// run at module evaluation, before any function call could set things up.

const api = globalThis.browser ?? globalThis.chrome;

try {
  // Not writable in every context (some content-script sandboxes lock it
  // down). Falling back is fine: if we cannot reassign, `chrome` was already
  // the working namespace there.
  if (api && globalThis.chrome !== api) globalThis.chrome = api;
} catch {
  /* leave the existing binding alone */
}

export default api;
