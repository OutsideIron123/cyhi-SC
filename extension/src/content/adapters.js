import { PLATFORM } from '../lib/protocol.js';

// The per-platform parsers, kept in their own module so they can be unit tested
// without booting the content script: importing index.js runs detectPlatform()
// against location, which does not exist outside a page.

export const ADAPTERS = {
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
    // LinkedIn ships several feed markups at once and renames classes often, so
    // cast a wide net: urn attributes anywhere (substring, not prefix - the urn
    // is frequently a suffix of a longer data-id), the older class names, and
    // the direct children of the infinite-scroll list, which has outlived every
    // rename so far. extract() below throws out what that width drags in.
    selector: [
      '[data-urn*="urn:li:activity"]',
      '[data-id*="urn:li:activity"]',
      'div.feed-shared-update-v2',
      'div.occludable-update',
      '.scaffold-finite-scroll__content > div',
    ].join(', '),
    extract(el) {
      // The wide selector also catches ad slots, the "add to your feed" rail and
      // empty scroll sentinels. A real post is either long enough to read or has
      // an image; nothing else is worth a round trip to the backend.
      const own = ownText(el);
      if (own.length < 40 && !el.querySelector('img')) return {};

      const urn =
        el.getAttribute('data-urn') ||
        el.getAttribute('data-id') ||
        el.querySelector('[data-urn*="urn:li:activity"]')?.getAttribute('data-urn') ||
        el.querySelector('[data-id*="urn:li:activity"]')?.getAttribute('data-id') ||
        '';
      const activity = urn.match(/urn:li:activity:(\d+)/)?.[1];

      const textEl = el.querySelector(
        '.update-components-text, .feed-shared-update-v2__description, ' +
          '.feed-shared-inline-show-more-text, .update-components-update-v2__commentary'
      );
      // Falling back to the element's own text beats silently skipping the post:
      // an unmatched commentary class used to leave text empty, and scan() drops
      // anything with no text and no image.
      const text = clean(textEl ? ownText(textEl) : own).slice(0, 1500);

      const images = [...el.querySelectorAll('img')]
        .map((img) => img.currentSrc || img.src)
        .filter(
          (src) =>
            src &&
            src.startsWith('http') &&
            // Author avatars and reaction pips are not post imagery.
            !src.includes('profile-displayphoto') &&
            !src.includes('profile-framedphoto') &&
            !src.includes('/aero-v1/sc/h/') &&
            !src.includes('company-logo')
        );

      return { id: activity ? `li_${activity}` : fallbackId(el, text), text, images };
    },
  },
};

// innerText minus anything this extension itself painted on, so a re-scan of an
// already-veiled post does not read "Post hidden / Show anyway" back as content.
function ownText(el) {
  const veil = el.querySelector(':scope > .cf-veil');
  if (!veil) return (el.innerText || '').trim();
  const hidden = veil.style.display;
  veil.style.display = 'none';
  const text = (el.innerText || '').trim();
  veil.style.display = hidden;
  return text;
}

// LinkedIn folds long posts and appends "…see more" - mid-string, after a
// newline, not at the end - and pads everything with vertical whitespace.
export function clean(s) {
  return (s || '')
    .replace(/\s*…?\s*see more\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fallbackId(el, text) {
  let h = 2166136261;
  const s = text || el.textContent || '';
  for (let i = 0; i < Math.min(s.length, 300); i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `h_${(h >>> 0).toString(36)}`;
}
