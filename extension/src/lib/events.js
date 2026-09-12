import { ACTION, REASON } from './protocol.js';

const KEY = 'events';
/** Ring buffer cap. ~4k events is well under the 10MB local-storage quota and covers a full demo session. */
export const MAX_EVENTS = 4000;

/**
 * MoodEvent — one scored post. Keys are short because we write thousands of these.
 * @typedef {Object} MoodEvent
 * @property {number}   t    epoch ms
 * @property {string}   p    platform
 * @property {string}   a    action taken
 * @property {string[]} r    reasons
 * @property {number}   tox  toxicity 0..1
 * @property {number}   nsf  nsfw 0..1
 * @property {?string}  tg   matched trigger phrase
 * @property {number}   sim  trigger similarity 0..1
 * @property {boolean}  [rv] user revealed it anyway
 */

export function eventFromVerdict(verdict, platform) {
  return {
    t: Date.now(),
    i: verdict.id,
    p: platform,
    a: verdict.action,
    r: verdict.reasons,
    tox: round2(verdict.toxicity),
    nsf: round2(verdict.nsfw),
    tg: verdict.trigger,
    sim: round2(verdict.similarity),
  };
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export async function getEvents(since = 0) {
  const bag = await chrome.storage.local.get(KEY);
  const all = Array.isArray(bag[KEY]) ? bag[KEY] : [];
  return since ? all.filter((e) => e.t >= since) : all;
}

/** Append and trim. One storage write per batch, not per post. */
export async function appendEvents(events) {
  if (!events?.length) return;
  const bag = await chrome.storage.local.get(KEY);
  const all = Array.isArray(bag[KEY]) ? bag[KEY] : [];
  all.push(...events);
  const trimmed = all.length > MAX_EVENTS ? all.slice(all.length - MAX_EVENTS) : all;
  await chrome.storage.local.set({ [KEY]: trimmed });
}

export async function clearEvents() {
  await chrome.storage.local.set({ [KEY]: [] });
}

/**
 * The reader lifted a blur. That is the single most interesting signal the
 * dashboard has — it is the difference between "we hid 40 posts" and "we hid 40
 * posts and you only wanted 3 of them back" — so it is worth the read-modify-write.
 * Scans from the end because the post was almost certainly just scored.
 */
export async function markRevealed(id) {
  const bag = await chrome.storage.local.get(KEY);
  const all = Array.isArray(bag[KEY]) ? bag[KEY] : [];
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].i === id) {
      if (all[i].rv) return false;
      all[i].rv = true;
      await chrome.storage.local.set({ [KEY]: all });
      return true;
    }
  }
  return false;
}

/**
 * Everything the Mood Dashboard renders, computed in one pass.
 * Pure function over an event array — the dashboard can feed it mock data
 * (see mock.js) and get an identically shaped result. That is deliberate: the
 * UI work does not block on the pipeline being live.
 */
export function summarize(events, { bucketMinutes = 5 } = {}) {
  const total = events.length;
  const empty = {
    total: 0,
    filtered: 0,
    revealed: 0,
    calmScore: 100,
    avgToxicity: 0,
    peakToxicity: 0,
    byAction: { allow: 0, blur: 0, collapse: 0, hide: 0 },
    byReason: { toxicity: 0, nsfw: 0, trigger: 0 },
    topTriggers: [],
    timeline: [],
    sessionMinutes: 0,
    byPlatform: {},
  };
  if (!total) return empty;

  const byAction = { allow: 0, blur: 0, collapse: 0, hide: 0 };
  const byReason = { toxicity: 0, nsfw: 0, trigger: 0 };
  const byPlatform = {};
  const triggerCounts = new Map();

  let toxSum = 0;
  let peak = 0;
  let revealed = 0;

  for (const e of events) {
    byAction[e.a] = (byAction[e.a] || 0) + 1;
    for (const r of e.r || []) byReason[r] = (byReason[r] || 0) + 1;
    byPlatform[e.p] = (byPlatform[e.p] || 0) + 1;
    toxSum += e.tox || 0;
    if ((e.tox || 0) > peak) peak = e.tox;
    if (e.rv) revealed += 1;
    if (e.tg) triggerCounts.set(e.tg, (triggerCounts.get(e.tg) || 0) + 1);
  }

  const filtered = total - byAction.allow;
  const first = events[0].t;
  const last = events[total - 1].t;

  // Timeline: fixed-width buckets between the first and last event.
  const bucketMs = bucketMinutes * 60 * 1000;
  const start = Math.floor(first / bucketMs) * bucketMs;
  const buckets = new Map();
  for (let t = start; t <= last; t += bucketMs) {
    buckets.set(t, { t, total: 0, filtered: 0, toxSum: 0 });
  }
  for (const e of events) {
    const k = Math.floor(e.t / bucketMs) * bucketMs;
    const b = buckets.get(k) || { t: k, total: 0, filtered: 0, toxSum: 0 };
    b.total += 1;
    if (e.a !== ACTION.ALLOW) b.filtered += 1;
    b.toxSum += e.tox || 0;
    buckets.set(k, b);
  }
  const timeline = [...buckets.values()]
    .sort((a, b) => a.t - b.t)
    .map((b) => ({
      t: b.t,
      total: b.total,
      filtered: b.filtered,
      avgToxicity: b.total ? round2(b.toxSum / b.total) : 0,
    }));

  const topTriggers = [...triggerCounts.entries()]
    .map(([phrase, count]) => ({ phrase, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);

  const avgToxicity = round2(toxSum / total);
  // Calm score: what fraction of the feed reached you clean, damped by how nasty
  // the average post was. Presentational, not a model output — say so on stage.
  const calmScore = Math.round(
    Math.max(0, Math.min(100, (1 - filtered / total) * 100 * (1 - avgToxicity * 0.5)))
  );

  return {
    total,
    filtered,
    revealed,
    calmScore,
    avgToxicity,
    peakToxicity: round2(peak),
    byAction,
    byReason,
    topTriggers,
    timeline,
    sessionMinutes: Math.max(1, Math.round((last - first) / 60000)),
    byPlatform,
  };
}

export const REASON_LABELS = {
  [REASON.TOXICITY]: 'Toxicity',
  [REASON.NSFW]: 'NSFW',
  [REASON.TRIGGER]: 'Your triggers',
};
