import { allowVerdict } from '../lib/protocol.js';
import { eventFromVerdict, appendEvents } from '../lib/events.js';
import { classify } from './backend.js';
import { decide } from './decide.js';
import * as cache from './cache.js';

const MAX_BATCH = 16;
const WINDOW_MS = 120;

const queue = new Map();
let timer = null;

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
      return row ? decide(row, settings, item.platform, item.text) : allowVerdict(item.id, true);
    });
    await cache.put(verdicts);
    if (settings.logEvents) {
      await appendEvents(
        verdicts.map((v, idx) => eventFromVerdict(v, entries[idx].item.platform))
      );
    }
  } catch {
    verdicts = entries.map(({ item }) => allowVerdict(item.id, true));
  }

  verdicts.forEach((v, idx) => entries[idx].settle.forEach((fn) => fn(v)));
}
