import { PLATFORM, ACTION, REASON } from '../lib/protocol.js';
import { getSettings, onSettingsChanged } from '../lib/settings.js';
import { rpc, ContextInvalidated } from '../lib/rpc.js';
import { MSG } from '../lib/protocol.js';
import { injectStyles, paint, unpaint } from './overlay.js';

// ---------------------------------------------------------------------------
// OWNERSHIP NOTE
//
// The DOM Extraction Specialist owns this file. Everything below the ADAPTERS
// block is the bridge — batching, caching, settings reactivity, veil painting —
// and should not need to change. ADAPTERS is the seam: replace the selectors and
// the extract() bodies with the real X / Reddit mappings and the rest keeps working.
//
// The contract in both directions:
//   send    { id, text, images[], platform }   (see lib/protocol.js PostItem)
//   receive { id, action, reasons[], toxicity, nsfw, trigger, similarity }
// ---------------------------------------------------------------------------

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
  // Some posts have no stable id in the DOM. Hashing the text keeps the cache
  // working across re-renders, which is the only thing the id is actually for.
  let h = 2166136261;
  const s = text || el.textContent || '';
  for (let i = 0; i < Math.min(s.length, 300); i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `h_${(h >>> 0).toString(36)}`;
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

let platform = detectPlatform();
if (platform) {
  void start();
} else {
  // Nothing matched at document_start. That is expected for the dev harness,
  // which declares its shape from an inline script that has not run yet — and
  // it is cheap insurance for any page that decides what it is late. Real sites
  // match on hostname and take the branch above.
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
  // DEV ONLY. The test harness declares which DOM shape it is emitting so the
  // bridge can be exercised without a logged-in timeline. Real sites never set
  // this attribute. Drop this branch and the localhost match pattern in
  // manifest.json before submission if you want the permission list minimal.
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

/** Post ids already sent this page-load. Survives scroll-up; dies with the tab. */
const seen = new Set();
/** id -> element, so a settings change can repaint without another round trip. */
const painted = new Map();
let settings = null;
let dead = false;
let pending = [];
let flushTimer = null;

async function start() {
  // One line, on purpose: "is the content script even alive here" is the first
  // question every time something does not blur, and it is otherwise invisible.
  console.info('[READIT] content script active on', platform, location.host);
  injectStyles();
  settings = await getSettings();

  onSettingsChanged((next) => {
    const before = settings;
    settings = next;
    // Thresholds moved: the SW has already dropped its verdict cache, so the
    // honest thing is to clear ours and re-score what is on screen.
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
  // run_at is document_start, so body may not exist yet.
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

    // Re-render of a post we already decided on: repaint from the element map
    // rather than asking again.
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
  // Coalesce a burst of MutationObserver callbacks into one message. The SW
  // batches again on its side; this pass just keeps the message count sane
  // during a fast scroll.
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
      // The extension was reloaded under us. Stop cleanly instead of throwing
      // on every scroll event for the rest of the page's life.
      dead = true;
      return;
    }
    // Anything else: the posts stay visible. Let them be re-tried on the next
    // re-render rather than leaving the reader with a frozen feed.
    for (const b of batch) seen.delete(b.item.id);
  }
}

export { REASON };
