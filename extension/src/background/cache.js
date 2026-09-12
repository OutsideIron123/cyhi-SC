const KEY = 'verdictCache';
const MAX = 2500;

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
      });
  }
  return hydrated;
}

function scheduleFlush() {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    if (!dirty) return;
    dirty = false;
    try {
      await chrome.storage.session.set({ [KEY]: [...mem.entries()] });
    } catch {
    }
  }, 1500);
}

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
    mem.delete(v.id);
    mem.set(v.id, v);
  }
  while (mem.size > MAX) mem.delete(mem.keys().next().value);
  scheduleFlush();
}

export async function clear() {
  mem = new Map();
  dirty = false;
  try {
    await chrome.storage.session.remove(KEY);
  } catch {
  }
}

export async function size() {
  await hydrate();
  return mem.size;
}
