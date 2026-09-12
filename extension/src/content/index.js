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
  [PLATFORM.LINKEDIN]: {
    hosts: ['linkedin.com', 'www.linkedin.com'],
    selector: 'div.feed-shared-update-v2, div[data-urn^="urn:li:activity"], div[data-id^="urn:li:activity"]',
    extract(el) {
      const urn =
        el.getAttribute('data-urn') ||
        el.getAttribute('data-id') ||
        el.querySelector('[data-urn^="urn:li:activity"]')?.getAttribute('data-urn') ||
        '';
      const activity = urn.match(/urn:li:activity:(\d+)/)?.[1];

      const textEl = el.querySelector(
        '.update-components-text, .feed-shared-update-v2__description, .feed-shared-inline-show-more-text'
      );
      const text = (textEl?.innerText || '').replace(/\s*…see more\s*$/i, '').trim();

      const images = [...el.querySelectorAll('.update-components-image img, img.ivm-view-attr__img--centered')]
        .map((img) => img.currentSrc || img.src)
        .filter((src) => src && src.startsWith('http') && !src.includes('/profile-'));

      return { id: activity ? `li_${activity}` : fallbackId(el, text), text, images };
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
    // If the feed has had time to render and we still matched nothing, the
    // selectors are wrong for this build of the site. Say so loudly, with the
    // markup that is actually on the page, instead of failing silently.
    reportPageStatus();
    setTimeout(() => {
      if (dead) return;
      if (seen.size === 0) reportNoMatches();
      reportPageStatus({ diag: pageDiagnostics() });
    }, 5000);
  };
  if (document.body) attach();
  else document.addEventListener('DOMContentLoaded', attach, { once: true });
}

function pageDiagnostics() {
  const adapter = ADAPTERS[platform];
  const sample = (els, fn) => [...new Set([...els].map(fn).filter(Boolean))].slice(0, 8);
  return {
    host: location.host,
    selector: adapter.selector,
    matched: document.querySelectorAll(adapter.selector).length,
    articles: document.querySelectorAll('article').length,
    dataUrn: sample(document.querySelectorAll('[data-urn]'), (e) => e.getAttribute('data-urn')),
    dataId: sample(document.querySelectorAll('[data-id]'), (e) => e.getAttribute('data-id')),
    feedishClasses: sample(
      document.querySelectorAll('div[class*="feed"],div[class*="update"],div[class*="post"]'),
      (e) => String(e.className).split(' ')[0]
    ),
  };
}

function reportNoMatches() {
  const adapter = ADAPTERS[platform];
  const sample = (els, fn) => [...new Set([...els].map(fn).filter(Boolean))].slice(0, 8);

  console.warn(
    `[READIT] no posts matched on ${platform}. The content script is running, so this is a selector problem, not a permissions one.`
  );
  console.log('[READIT] selector tried:', adapter.selector);
  console.log('[READIT] page diagnostics:', {
    host: location.host,
    matched: document.querySelectorAll(adapter.selector).length,
    articles: document.querySelectorAll('article').length,
    dataUrn: sample(document.querySelectorAll('[data-urn]'), (e) => e.getAttribute('data-urn')),
    dataId: sample(document.querySelectorAll('[data-id]'), (e) => e.getAttribute('data-id')),
    feedishClasses: sample(
      document.querySelectorAll('div[class*="feed"],div[class*="update"],div[class*="post"]'),
      (e) => String(e.className).split(' ')[0]
    ),
    textCandidates: sample(
      document.querySelectorAll('[class*="text"],[class*="description"],[class*="break-words"]'),
      (e) => String(e.className).slice(0, 60)
    ),
  });
  console.log('[READIT] copy the object above and send it to whoever owns the adapters.');
}

function reportPageStatus(extra = {}) {
  // The popup reads this. A content script that never runs never writes it,
  // which is itself the answer to "is it even injected on this site".
  try {
    chrome.storage.local.set({
      pageStatus: {
        ts: Date.now(),
        host: location.host,
        platform,
        matched: document.querySelectorAll(ADAPTERS[platform].selector).length,
        seen: seen.size,
        painted: painted.size,
        ...extra,
      },
    });
  } catch {
    /* storage unavailable in a dying context */
  }
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
    if (el.parentElement?.closest(adapter.selector)) continue;
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
    reportPageStatus();
  } catch (err) {
    if (err instanceof ContextInvalidated) {
      dead = true;
      return;
    }
    for (const b of batch) seen.delete(b.item.id);
  }
}

export { REASON };
