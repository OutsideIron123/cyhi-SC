import { allowVerdict } from '../lib/protocol.js';
import { eventFromVerdict, appendEvents } from '../lib/events.js';
import { classify } from './backend.js';
import { decide } from './decide.js';
import * as cache from './cache.js';

/** Posts per HTTP request. Role 1 tunes this against their batching on the Flask side. */
const MAX_BATCH = 16;
/** How long we hold the first item waiting for its neighbours. */
const WINDOW_MS = 120;

/** @type {Map<string, {item: any, settle: ((v:any)=>void)[]}>} */
const queue = new Map();
let timer = null;

/**
 * Classify a set of posts. Cache hits return immediately; misses join the next
 * outbound batch.
 *
 * The batching window is short on purpose. Chrome resets the service worker's
 * idle timer on every message and keeps it alive while an onMessage response is
 * outstanding, so 120ms is free — but a long window would risk the 30s response
 * ceiling if the backend also stalls, and it would make the blur visibly late.
 *
 * @returns {Promise<{results: Object<string, any>, degraded: boolean}>}
 */
export async function classifyItems(items, settings) {
  const unique = dedupe(items);
  const { hits, misses } = await cache.partition(unique.map((i) => i.id));

  const results = { ...hits };
  if (!misses.length) return { results, degraded: false };

  const missSet = new Set(misses);
  const waits = unique
    .filter((i) => missSet.has(i.id))
    .map((item) => enqueue(item, settings));

  const settled = await Promise.all(waits);
  let degraded = false;
  for (const v of settled) {
    results[v.id] = v;
    if (v.degraded) degraded = true;
  }
  return { results, degraded };
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const i of items || []) {
    if (!i?.id || seen.has(i.id)) continue;
    seen.add(i.id);
    out.push(i);
  }
  return out;
}

function enqueue(item, settings) {
  return new Promise((resolve) => {
    const existing = queue.get(item.id);
    if (existing) {
      // Two tabs asked for the same post inside one window — one request, two answers.
      existing.settle.push(resolve);
    } else {
      queue.set(item.id, { item, settle: [resolve] });
    }

    if (queue.size >= MAX_BATCH) {
      flush(settings);
    } else if (!timer) {
      timer = setTimeout(() => flush(settings), WINDOW_MS);
    }
  });
}

async function flush(settings) {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!queue.size) return;

  const entries = [...queue.values()];
  queue.clear();

  // Split oversized bursts (a fast scroll can queue 60 posts at once) so no single
  // request blocks the whole backlog behind one slow inference pass.
  for (let i = 0; i < entries.length; i += MAX_BATCH) {
    void send(entries.slice(i, i + MAX_BATCH), settings);
  }
}

async function send(entries, settings) {
  const items = entries.map(({ item }) => ({
    id: item.id,
    text: (item.text || '').slice(0, 2000),
    images: (item.images || []).slice(0, 4),
    platform: item.platform,
  }));

  let verdicts;
  try {
    const rows = await classify(items, settings);
    const byId = new Map(rows.map((r) => [r.id, r]));
    verdicts = entries.map(({ item }) => {
      const row = byId.get(item.id);
      // A post the backend silently dropped is allowed, not blocked. Never let a
      // model bug turn into a blank feed on stage.
      return row ? decide(row, settings) : allowVerdict(item.id, true);
    });
    await cache.put(verdicts);
    if (settings.logEvents) {
      await appendEvents(
        verdicts.map((v, idx) => eventFromVerdict(v, entries[idx].item.platform))
      );
    }
  } catch {
    // Fail open. A dead backend means an unfiltered feed, never a broken page.
    // These verdicts are deliberately NOT cached, so the posts get a real score
    // as soon as the backend comes back.
    verdicts = entries.map(({ item }) => allowVerdict(item.id, true));
  }

  verdicts.forEach((v, idx) => entries[idx].settle.forEach((fn) => fn(v)));
}
