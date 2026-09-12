import { PLATFORM, ACTION, REASON } from '../lib/protocol.js';
import { getSettings, onSettingsChanged } from '../lib/settings.js';
import { rpc, ContextInvalidated } from '../lib/rpc.js';
import { MSG } from '../lib/protocol.js';
import { injectStyles, paint, unpaint } from './overlay.js';

const ADAPTERS = {
  [PLATFORM.X]: {
    hosts: ['x.com', 'twitter.com'],
    selector: 'article[data-testid="tweet"]',
    extract(el) {
      const link = el.querySelector('a[href*="/status/"]');
      const m = link?.getAttribute('href')?.match(/\/status\/(\d+)/);
      const text = el.querySelector('[data-testid="tweetText"]')?.innerText || '';
      const images = [...el.querySelectorAll('[data-testid="tweetPhoto"] img')]
        .map((img) => img.src)
        .filter(Boolean);
      return { id: m ? `x_${m[1]}` : fallbackId(el, text), text, images };
    },
  },
  [PLATFORM.REDDIT]: {
    hosts: ['reddit.com', 'www.reddit.com', 'old.reddit.com'],
    selector: 'shreddit-post, div.thing[data-fullname]',
    extract(el) {
      const id =
        el.getAttribute('id') ||
        el.getAttribute('data-fullname') ||
        el.getAttribute('data-post-id');
      const title =
        el.getAttribute('post-title') ||
        el.querySelector('[slot="title"], a.title')?.innerText ||
        '';
      const body = el.querySelector('[slot="text-body"], div.usertext-body')?.innerText || '';
      const images = [...el.querySelectorAll('img[src^="http"]')]
        .map((img) => img.src)
        .filter((src) => !src.includes('/avatar') && !src.includes('styles.redditmedia'));
      const text = [title, body].filter(Boolean).join('\n\n');
      return { id: id ? `r_${id}` : fallbackId(el, text), text, images };
    },
  },
};

function fallbackId(el, text) {
  let h = 2166136261;
  const s = text || el.textContent || '';
  for (let i = 0; i < Math.min(s.length, 300); i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `h_${(h >>> 0).toString(36)}`;
}

let platform = detectPlatform();
if (platform) {
  void start();
} else {
  document.addEventListener(
    'DOMContentLoaded',
    () => {
      platform = detectPlatform();
      if (platform) void start();
    },
    { once: true }
  );
}

function detectPlatform() {
  const declared = document.documentElement?.dataset?.cfPlatform;
  if (declared && ADAPTERS[declared]) return declared;

  const host = location.hostname.replace(/^www\./, '');
  for (const [name, cfg] of Object.entries(ADAPTERS)) {
    if (cfg.hosts.some((h) => host === h.replace(/^www\./, '') || host.endsWith(`.${h}`))) {
      return name;
    }
  }
  return null;
}

const seen = new Set();
const painted = new Map();
let settings = null;
let dead = false;
let pending = [];
let flushTimer = null;

async function start() {
  console.info('[READIT] content script active on', platform, location.host);
  injectStyles();
  settings = await getSettings();

  onSettingsChanged((next) => {
    const before = settings;
    settings = next;
    if (policyChanged(before, next)) {
      seen.clear();
      for (const [, el] of painted) unpaint(el);
      painted.clear();
      if (next.enabled) scan(document);
    } else if (!next.enabled) {
      for (const [, el] of painted) unpaint(el);
      painted.clear();
    }
  });

  const observer = new MutationObserver((records) => {
    if (dead || !settings?.enabled) return;
    for (const rec of records) {
      for (const node of rec.addedNodes) {
        if (node.nodeType === 1) scan(node);
      }
    }
  });

  const attach = () => {
    observer.observe(document.body, { childList: true, subtree: true });
    scan(document);
  };
  if (document.body) attach();
  else document.addEventListener('DOMContentLoaded', attach, { once: true });
}

function policyChanged(a, b) {
  if (!a) return true;
  return (
    JSON.stringify([a.toxicity, a.nsfw, a.triggers, a.backendUrl]) !==
    JSON.stringify([b.toxicity, b.nsfw, b.triggers, b.backendUrl])
  );
}

function scan(root) {
  const adapter = ADAPTERS[platform];
  const nodes =
    root.nodeType === 1 && root.matches?.(adapter.selector)
      ? [root]
      : root.querySelectorAll?.(adapter.selector) || [];

  for (const el of nodes) {
    let item;
    try {
      item = adapter.extract(el);
    } catch {
      continue;
    }
    if (!item?.id) continue;
    if (!item.text && !item.images?.length) continue;

    if (seen.has(item.id)) {
      const known = painted.get(item.id);
      if (known && known !== el && known.verdict) paint(el, known.verdict, settings);
      continue;
    }
    seen.add(item.id);
    pending.push({ item: { ...item, platform }, el });
    schedule();
  }
}

function schedule() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, 80);
}

async function flush() {
  flushTimer = null;
  if (dead || !pending.length) return;

  const batch = pending;
  pending = [];
  const byId = new Map(batch.map((b) => [b.item.id, b.el]));

  try {
    const res = await rpc(MSG.CLASSIFY, { items: batch.map((b) => b.item) });
    if (res?.disabled) return;
    for (const [id, verdict] of Object.entries(res?.results || {})) {
      const el = byId.get(id);
      if (!el || !el.isConnected) continue;
      if (verdict.action !== ACTION.ALLOW) {
        el.verdict = verdict;
        painted.set(id, el);
        paint(el, verdict, settings);
      }
    }
  } catch (err) {
    if (err instanceof ContextInvalidated) {
      dead = true;
      return;
    }
    for (const b of batch) seen.delete(b.item.id);
  }
}

export { REASON };
