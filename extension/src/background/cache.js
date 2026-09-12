/**
 * Verdict cache, second tier.
 *
 * The content script keeps its own Set of seen post ids so it never re-sends
 * while a page is open. This layer survives navigation and tab close: scroll
 * a timeline, open a post, hit back, and the same posts come back scored
 * without touching the GPU.
 *
 * Backed by chrome.storage.session, which is cleared when the browser closes
 * and never written to disk — right trade-off for something this disposable.
 * The in-memory Map is the fast path; session storage is the rehydrate path
 * for when the MV3 worker gets torn down mid-scroll.
 */

const KEY = 'verdictCache';
const MAX = 2500;

/** @type {Map<string, any>} insertion-ordered, so the first key is the oldest. */
let mem = new Map();
let hydrated = null;
let flushTimer = null;
let dirty = false;

async function hydrate() {
  if (!hydrated) {
    hydrated = chrome.storage.session
      .get(KEY)
      .then((bag) => {
        const entries = bag?.[KEY];
        if (Array.isArray(entries)) mem = new Map(entries);
      })
      .catch(() => {
        /* session storage unavailable — memory-only is fine */
      });
  }
  return hydrated;
}

function scheduleFlush() {
  dirty = true;
  if (flushTimer) return;
  // Debounced: one write per burst of scrolling, not one per post.
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    if (!dirty) return;
    dirty = false;
    try {
      await chrome.storage.session.set({ [KEY]: [...mem.entries()] });
    } catch {
      /* over quota or worker dying — the memory map is still correct */
    }
  }, 1500);
}

/** @returns {Promise<{hits: Object<string, any>, misses: string[]}>} */
export async function partition(ids) {
  await hydrate();
  const hits = {};
  const misses = [];
  for (const id of ids) {
    const v = mem.get(id);
    if (v) hits[id] = v;
    else misses.push(id);
  }
  return { hits, misses };
}

export async function put(verdicts) {
  await hydrate();
  for (const v of verdicts) {
    if (!v?.id) continue;
    mem.delete(v.id); // re-insert so recently seen entries move to the back
    mem.set(v.id, v);
  }
  while (mem.size > MAX) mem.delete(mem.keys().next().value);
  scheduleFlush();
}

/** Thresholds moved — every cached action is now potentially wrong. */
export async function clear() {
  mem = new Map();
  dirty = false;
  try {
    await chrome.storage.session.remove(KEY);
  } catch {
    /* ignore */
  }
}

export async function size() {
  await hydrate();
  return mem.size;
}
