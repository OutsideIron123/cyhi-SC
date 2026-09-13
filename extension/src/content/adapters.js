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
    // LinkedIn runs several feed builds at once. The current one is a rewrite:
    // every class is a rotating hash (_1470c439), data-urn is gone entirely,
    // and the feed is virtualised - only ~7 posts are mounted at a time, each
    // inside a div[data-lazy-mount-id] whose style is `display: contents`.
    //
    // So match on attributes and ARIA, which survive class hashing, and match
    // the role="listitem" card rather than its mount wrapper: a display:contents
    // element generates no box, so painting it can never render a veil.
    //
    // The legacy arms stay because the old build is still served to some
    // accounts. extract() throws out whatever the width drags in.
    selector: [
      '[data-lazy-mount-id] [role="listitem"]',
      'main [role="listitem"]',
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
      // The new build has no commentary element to target, so the body has to be
      // recovered from the card's own innerText with the chrome stripped off.
      // That matters beyond tidiness: the actor block carries the poster's
      // LinkedIn headline ("Helping founders scale...") which reads as
      // self-promotion and would inflate the boast score of every post in the
      // feed, including ordinary ones.
      const text = (textEl ? clean(ownText(textEl)) : stripLinkedInChrome(own, authorOf(el))).slice(
        0,
        1500
      );

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

      // No urn survives in the new build, so identity falls back to a content
      // hash. That is also what makes virtualisation survivable: a post that
      // unmounts and remounts hashes to the same id and hits the verdict cache.
      return { id: activity ? `li_${activity}` : `li_${fallbackId(el, text)}`, text, images };
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

// Every post card carries a control-menu button labelled "Open control menu for
// post by <name>". It is the one per-post, per-author handle that survives the
// class hashing, so it is how we know whose header to strip.
export function authorOf(el) {
  const label =
    el.querySelector('[aria-label^="Open control menu for post by"]')?.getAttribute('aria-label') ||
    '';
  return label.replace(/^Open control menu for post by\s*/i, '').trim();
}

// Lines that are feed furniture rather than anything the poster wrote: actor
// chrome, the social action bar, and button labels that innerText picks up.
const CHROME_LINE = new RegExp(
  '^(' +
    'feed post|promoted|sponsored|follow(ing)?|connect|message|subscribe|' +
    'like|likes?|comment|comments?|repost|reposts?|send|share|save|' +
    'register|apply( now)?|learn more|sign up|download|view\\b.*|' +
    'reaction button state.*|visibility:.*|see more|…\\s*see more|edited|' +
    '[•·]|(1st|2nd|3rd\\+?)|\\d+(st|nd|rd|th)\\+?|' +
    '[\\d,.]+\\s*(k|m)?\\s*(followers?|connections?|reactions?|comments?|reposts?|impressions?)|' +
    '\\d+\\s*[smhdwy]o?(\\s*(ago|[•·]|edited))*' +
    ')$',
  'i'
);

// innerText gives real line breaks, so the header can be peeled off line by line
// rather than guessed at from a blob.
export function stripLinkedInChrome(text, author = '') {
  const lines = [];
  let headlineAt = -1;

  for (const raw of String(text || '').split('\n')) {
    // Bullets are glued onto chrome ("• Follow", "• 3rd+") as separators.
    const line = raw.trim().replace(/^[•·]\s*/, '').trim();
    if (!line || CHROME_LINE.test(line)) continue;
    if (author && line.replace(/\s*[•·].*$/, '').trim() === author) {
      headlineAt = lines.length;
      continue;
    }
    lines.push(line);
  }

  // The poster's headline sits directly after their name and would read as
  // self-promotion on every post they make. Only drop it when something longer
  // follows: a company post has no headline, and there that line IS the post -
  // dropping it blindly threw away the whole body.
  if (headlineAt >= 0 && headlineAt < lines.length) {
    const candidate = lines[headlineAt];
    const longerFollows = lines.slice(headlineAt + 1).some((l) => l.length > candidate.length);
    if (longerFollows && candidate.length < 160) lines.splice(headlineAt, 1);
  }

  return clean(lines.join(' '));
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
