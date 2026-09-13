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
  [PLATFORM.INSTAGRAM]: {
    hosts: ['instagram.com', 'www.instagram.com'],
    // Instagram hashes every class the same way LinkedIn's new build does, so
    // the only durable handles are the element type, ARIA, and the permalink
    // href. `article` is the feed card and has been for years; the extra arms
    // cover the reel viewer and the profile/explore grid, where there is no
    // article element at all.
    selector: [
      'main article',
      'article[role="presentation"]',
      'section main article',
      'main div[data-media-id]',
      'a[href*="/p/"][role="link"][tabindex]',
    ].join(', '),
    extract(el) {
      const own = ownText(el);
      const media = instagramMedia(el);
      // The feed is padded with story trays, "suggested for you" rails and
      // empty virtualiser sentinels. A real post has media; a text-only card
      // has to be long enough to be worth a round trip.
      if (!media.length && own.length < 40) return {};

      const shortcode = instagramShortcode(el);
      const author = instagramAuthorOf(el);
      // No caption element survives the class hashing, so the caption is
      // recovered from the card's own innerText. That matters beyond tidiness:
      // innerText also carries the comment previews, and scoring a stranger's
      // comment as if the poster wrote it is how a clean post gets veiled.
      let text = stripInstagramChrome(own, author);
      // Image-only posts are the norm here, not the exception. Instagram's own
      // generated alt text ("May be an image of text that says ...") is the
      // only text such a post has, and on a meme it is the words in the image.
      if (text.length < 12) text = clean([text, instagramAltText(el)].filter(Boolean).join(' '));

      return {
        id: shortcode ? `ig_${shortcode}` : `ig_${fallbackId(el, text)}`,
        text: text.slice(0, 1500),
        images: media,
      };
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
    // The audience chip on the timestamp row. Written out in full since the
    // rewrite; "visibility:" only ever matched the older build.
    'visible to (anyone|connections).*|anyone on or off linkedin|' +
    '[•·]|(1st|2nd|3rd\\+?)|\\d+(st|nd|rd|th)\\+?|' +
    '[\\d,.]+\\s*(k|m)?\\s*(followers?|connections?|reactions?|comments?|reposts?|impressions?)|' +
    '\\d+\\s*[smhdwy]o?(\\s*(ago|[•·]|edited))*' +
    ')$',
  'i'
);

// Where the post ends and the feed furniture begins. Matched against a whole
// line, and it BREAKS rather than skipping: everything below is reactions,
// counts and other people's comments, none of which the poster wrote.
//
// Deliberately conservative - it must not fire inside a post body. "Load more
// comments" and a bare reaction count are unambiguous; a line merely containing
// the word "comment" is not, so only whole-line matches count.
const LI_TAIL = new RegExp(
  '^(' +
    'load more comments|see more comments|most relevant|all comments|' +
    'add a comment|write a comment|be the first to comment|' +
    '[\\d,.]+\\s*(k|m)?\\s*(comments?|reposts?|reactions?|likes?)|' +
    '(like|comment|repost|send)(\\s+(like|comment|repost|send))+|' +
    'activate to view larger image.*|reaction button state.*' +
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
    // Everything from the social bar down is reactions, counts and other
    // people's comments. The Instagram adapter has always cut here; LinkedIn
    // did not, so a card with a comment thread carried all of it into the text
    // we embed. That is a correctness bug on its own - a stranger's reply
    // scored as the poster's - and it also dilutes the post: MiniLM averages
    // over the whole string, so a real boast measured 0.641 clean and 0.437
    // with the thread attached, which is close enough to the 0.42 bar that a
    // slightly longer thread pushes it under and the post silently passes.
    if (LI_TAIL.test(line)) break;
    if (!line || CHROME_LINE.test(line)) continue;
    // innerText glues the whole timestamp row into one line:
    // "2d • Edited • Visible to anyone on or off LinkedIn". No single arm of
    // CHROME_LINE matches that, so it survived as post text.
    //
    // Drop a line only when EVERY bullet-separated segment is chrome. A real
    // post body containing a bullet keeps at least one segment that is not, so
    // this can never eat something the poster wrote.
    if (line.includes('•') || line.includes('·')) {
      const segments = line.split(/[•·]/).map((s) => s.trim()).filter(Boolean);
      if (segments.length > 1 && segments.every((s) => CHROME_LINE.test(s))) continue;
    }
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

// --- Instagram ------------------------------------------------------------

// The permalink on the timestamp is the one stable identity a feed card has:
// /p/<shortcode>/ for posts, /reel/ and /tv/ for video. Everything else about
// the card - classes, wrapper depth, attribute names - rotates.
export function instagramShortcode(el) {
  const links = [
    el.getAttribute?.('href') ? el : null,
    ...(el.querySelectorAll?.('a[href*="/p/"], a[href*="/reel/"], a[href*="/tv/"]') || []),
  ].filter(Boolean);
  for (const a of links) {
    const m = (a.getAttribute('href') || '').match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
    if (m) return m[1];
  }
  return '';
}

// Avatars carry alt="<username>'s profile picture" - the one per-post handle on
// the author that survives class hashing, and the same trick the LinkedIn
// adapter plays with the control-menu aria-label.
export function instagramAuthorOf(el) {
  const alt =
    el.querySelector?.('img[alt$="profile picture"], img[alt*="profile picture"]')?.getAttribute('alt') ||
    '';
  return alt.replace(/['\u2019]s profile picture$/i, '').trim();
}

// Avatars are served at s150x150 and sprites come off /rsrc.php/. Neither is
// post imagery, and sending them to the NSFW model wastes a fetch per card.
//
// data: URIs are allowed through because images.js decodes them without a
// network round trip, and because it is the only way the test harness can
// exercise the NSFW path at all - the LinkedIn adapter's http-only filter is
// why harness images never reach the model there.
function isInstagramChrome(src) {
  return (
    !src ||
    !/^(https?:|data:)/.test(src) ||
    src.includes('/rsrc.php/') ||
    /\/s(32|64|150)x(32|64|150)\//.test(src)
  );
}

export function instagramMedia(el) {
  const out = [];
  for (const img of el.querySelectorAll?.('img') || []) {
    if (/profile picture/i.test(img.getAttribute?.('alt') || '')) continue;
    const src = img.currentSrc || img.src;
    if (!isInstagramChrome(src)) out.push(src);
  }
  // A reel renders as <video>, whose frames we cannot read - but its poster is
  // a still of the same content and is exactly what the NSFW model wants.
  for (const v of el.querySelectorAll?.('video') || []) {
    const poster = v.getAttribute?.('poster');
    if (!isInstagramChrome(poster)) out.push(poster);
  }
  return [...new Set(out)];
}

// Instagram generates alt text of the form
//   "Photo by Jane on June 08, 2024. May be an image of text that says 'GO AWAY'."
// The prefix is boilerplate; what follows is a scene description, and on a meme
// it is the words baked into the image - the only text the post has.
export function instagramAltText(el) {
  for (const img of el.querySelectorAll?.('img') || []) {
    const alt = (img.getAttribute?.('alt') || '').trim();
    if (!alt || /profile picture/i.test(alt)) continue;
    const body = alt
      .replace(/^(photo|video|image) (shared )?by .*? on [^.]*\.\s*/i, '')
      .replace(/^may be an? (image|illustration|graphic|meme|close-up|cartoon|drawing)( of)?\s*/i, '')
      .trim();
    if (body.length >= 8) return clean(body);
  }
  return '';
}

// Feed furniture on an Instagram card: the actor row, the like/comment bar, the
// audio credit, and the fold marker. innerText picks all of it up as lines.
const IG_CHROME_LINE = new RegExp(
  '^(' +
    'follow(ing|s| back)?|sponsored|paid partnership.*|verified|suggested for you|' +
    'original audio|.*[\u00b7\u2022]\\s*original audio|audio|' +
    'like|likes?|comment|comments?|share|save|reply|translate|see translation|' +
    'more|\u2026\\s*more|less|edited|turn on post notifications|' +
    'view profile|message|subscribe|contact|' +
    '[\u2022\u00b7]|' +
    'liked by .*|[\\d,.]+\\s*(k|m)?\\s*(likes?|views?|plays?|comments?|followers?)|' +
    '\\d+\\s*[smhdw]|\\d+\\s*(seconds?|minutes?|hours?|days?|weeks?)(\\s*ago)?' +
    ')$',
  'i'
);

// Everything from here down is other people's writing. Scoring it as the
// poster's is how a perfectly clean post ends up veiled for a toxic reply.
const IG_COMMENTS_START =
  /^(view (all )?([\d,.]+ )?comments?|view all comments|add a comment|[\d,.]+ replies|see more comments)/i;

export function stripInstagramChrome(text, author = '') {
  const lines = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim().replace(/^[\u2022\u00b7]\s*/, '').trim();
    if (!line) continue;
    if (IG_COMMENTS_START.test(line)) break;
    if (IG_CHROME_LINE.test(line)) continue;
    if (author && line.replace(/\s*[\u2022\u00b7].*$/, '').trim() === author) continue;
    lines.push(line);
  }

  // Avatars are lazy-loaded, so on a card that has only just scrolled in there
  // is no alt to read the author off. The username is still structurally
  // identifiable: it opens the header line, and the caption line underneath
  // opens with the very same token. innerText gives the header as one line
  // ("jane_doe · Follow · 2d"), so the candidate is what precedes the bullet.
  if (!author && lines.length >= 2) {
    const cand = lines[0].split(/[•·]/)[0].trim();
    if (
      cand &&
      cand.length <= 30 &&
      !/\s/.test(cand) &&
      lines.slice(1).some((l) => l.toLowerCase().startsWith(cand.toLowerCase() + ' '))
    ) {
      author = cand;
      lines.shift();
    }
  }

  let out = lines.join(' ');
  // The caption line repeats the username as its first token ("jane_doe look at
  // this"). Left in, it is a proper noun the embedder has to explain away.
  if (author) {
    out = out.replace(new RegExp('^' + escapeRe(author) + '\\s+(?=\\S)', 'i'), '');
  }
  return clean(out.replace(/\s*\u2026?\s*\bmore\b\s*$/i, ''));
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
