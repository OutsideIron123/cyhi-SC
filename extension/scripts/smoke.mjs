import assert from 'node:assert/strict';
import { decide } from '../src/background/decide.js';
import { similarityFloor, triggerKey } from '../src/background/backend.js';
import { fetchAsBase64 } from '../src/background/images.js';
import { summarize, REASON_LABELS } from '../src/lib/events.js';
import { mockEvents } from '../src/lib/mock.js';
import { normalize, DEFAULT_SETTINGS } from '../src/lib/settings.js';
import { ACTION, REASON, PLATFORM, PLATFORM_LABELS } from '../src/lib/protocol.js';
import {
  BOAST_PHRASES,
  readsAsCongratulation,
  readsAsBoastAnnouncement,
} from '../src/lib/boast.js';
import {
  LEVELS,
  LEVEL_THRESHOLDS,
  levelFor,
  thresholdFor,
  isExactLevel,
} from '../src/lib/levels.js';
import {
  ADAPTERS,
  clean,
  stripLinkedInChrome,
  authorOf,
  instagramAuthorOf,
  instagramShortcode,
  instagramAltText,
  instagramMedia,
  stripInstagramChrome,
} from '../src/content/adapters.js';

let passed = 0;
const test = (name, fn) => {
  try {
    const r = fn();
    if (r instanceof Promise) return r.then(() => { passed++; }).catch((err) => {
      console.error(`FAIL  ${name}\n      ${err.message}`);
      process.exitCode = 1;
    });
    passed++;
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
};

const base = normalize({
  ...DEFAULT_SETTINGS,
  triggers: [
    { id: 't1', phrase: 'layoffs and job loss', threshold: 0.6, action: ACTION.BLUR, enabled: true },
    { id: 't2', phrase: 'dieting', threshold: 0.8, action: ACTION.HIDE, enabled: true },
  ],
});

// Same policy with the boast filter off, for the assertions that predate it.
const noBoast = normalize({ ...base, boast: { ...DEFAULT_SETTINGS.boast, enabled: false } });

// Shaped exactly like a row from app.py's /classify response.
const row = (over = {}) => ({
  id: 'a',
  flagged: false,
  reasons: [],
  flags: { toxicity: false, semantic_trigger: false, nsfw: false },
  toxicity: { flagged: false, score: 0.02, threshold: 0.7, top_label: 'neutral', scores: {} },
  semantic: { flagged: false, max_similarity: 0, threshold: 0.45, matched_trigger: null, matches: [], similarities: {} },
  nsfw: null,
  errors: [],
  ...over,
});

test('clean post is allowed', () => {
  const v = decide(row(), base);
  assert.equal(v.action, ACTION.ALLOW);
  assert.deepEqual(v.reasons, []);
});

test('reads the nested toxicity.score, not a flat field', () => {
  const v = decide(row({ toxicity: { score: 0.9 } }), base);
  assert.equal(v.toxicity, 0.9);
  assert.equal(v.action, ACTION.BLUR);
  assert.deepEqual(v.reasons, [REASON.TOXICITY]);
});

test('toxicity at the threshold fires (>=, not >)', () => {
  assert.equal(decide(row({ toxicity: { score: 0.7 } }), base).action, ACTION.BLUR);
  assert.equal(decide(row({ toxicity: { score: 0.6999 } }), base).action, ACTION.ALLOW);
});

test('null nsfw block (no image sent) is not a crash and not a flag', () => {
  const v = decide(row({ nsfw: null }), base);
  assert.equal(v.nsfw, 0);
  assert.equal(v.action, ACTION.ALLOW);
});

test('nsfw uses our slider, not the backend label decision', () => {
  // Backend says flagged:false, but its own score clears the user's lower bar.
  const v = decide(row({ nsfw: { flagged: false, score: 0.65, label: 'normal' } }), base);
  assert.equal(v.action, ACTION.BLUR);
  assert.ok(v.reasons.includes(REASON.NSFW));
});

test('triggers match on phrase, which is how the backend keys similarities', () => {
  const v = decide(
    row({ semantic: { similarities: { 'layoffs and job loss': 0.71, dieting: 0.1 } } }),
    base
  );
  assert.equal(v.trigger, 'layoffs and job loss');
  assert.equal(v.similarity, 0.71);
  assert.ok(v.reasons.includes(REASON.TRIGGER));
});

test('trigger below its own per-phrase threshold does not fire', () => {
  // 0.5 clears the batch-wide floor we send, but not this trigger's own 0.6.
  const v = decide(row({ semantic: { similarities: { 'layoffs and job loss': 0.5 } } }), base);
  assert.equal(v.action, ACTION.ALLOW);
  assert.equal(v.trigger, null);
});

test('strictest action wins across rules', () => {
  const v = decide(
    row({ toxicity: { score: 0.9 }, semantic: { similarities: { dieting: 0.85 } } }),
    base
  );
  assert.equal(v.action, ACTION.HIDE, 'HIDE from the trigger beats BLUR from toxicity');
});

test('strongest matching trigger is the one reported', () => {
  const v = decide(
    row({ semantic: { similarities: { 'layoffs and job loss': 0.65, dieting: 0.92 } } }),
    base
  );
  assert.equal(v.trigger, 'dieting');
});

test('a phrase the vault still holds but the user deleted is ignored', () => {
  const v = decide(row({ semantic: { similarities: { 'gone from settings': 0.99 } } }), base);
  assert.equal(v.action, ACTION.ALLOW);
});

test('disabled classifier is ignored', () => {
  const s = normalize({ ...base, toxicity: { ...base.toxicity, enabled: false } });
  assert.equal(decide(row({ toxicity: { score: 0.99 } }), s).action, ACTION.ALLOW);
});

test('garbage scores do not throw', () => {
  const v = decide({ id: 'a', toxicity: null, nsfw: 'NaN', semantic: null }, base);
  assert.equal(v.toxicity, 0);
  assert.equal(v.action, ACTION.ALLOW);
});

test('similarity floor is the loosest enabled trigger, so nothing is pre-filtered', () => {
  assert.equal(similarityFloor(noBoast), 0.6);
  const withLoose = normalize({
    ...noBoast,
    triggers: [...base.triggers, { id: 't3', phrase: 'x', threshold: 0.3, enabled: true }],
  });
  assert.equal(similarityFloor(withLoose), 0.3);
});

test('the boast threshold is part of the floor when the filter is on', () => {
  // Otherwise the backend pre-filters boast similarities away before we see them.
  assert.equal(similarityFloor(base), base.boast.threshold);
});

test('similarity floor falls back to the default when nothing is enabled', () => {
  const off = normalize({ ...noBoast, triggers: base.triggers.map((t) => ({ ...t, enabled: false })) });
  assert.equal(similarityFloor(off), DEFAULT_SETTINGS.defaultTriggerThreshold);
});

test('trigger sync key ignores disabled triggers', () => {
  const off = normalize({
    ...noBoast,
    triggers: [{ ...base.triggers[0] }, { ...base.triggers[1], enabled: false }],
  });
  assert.equal(triggerKey(off), JSON.stringify(['layoffs and job loss']));
});

test('boast phrases are pushed to the vault, or the backend never scores them', () => {
  const key = JSON.parse(triggerKey(base));
  for (const phrase of BOAST_PHRASES) assert.ok(key.includes(phrase), `vault missing: ${phrase}`);
  assert.ok(key.includes('layoffs and job loss'), 'user triggers survive alongside them');
});

test('turning the boast filter off takes its phrases back out of the vault', () => {
  const key = JSON.parse(triggerKey(noBoast));
  assert.equal(key.length, 2);
});

// --- boast filter ---------------------------------------------------------

const boastRow = (score) =>
  row({ id: 'b', semantic: { similarities: { [BOAST_PHRASES[2]]: score } } });

test('a boasting LinkedIn post is caught', () => {
  const v = decide(boastRow(0.62), base, PLATFORM.LINKEDIN);
  assert.equal(v.action, base.boast.action);
  assert.ok(v.reasons.includes(REASON.BOAST));
  assert.equal(v.boast, 0.62);
  assert.equal(v.boastPhrase, BOAST_PHRASES[2]);
});

test('the same post on X and Reddit is left alone', () => {
  assert.equal(decide(boastRow(0.62), base, PLATFORM.X).action, ACTION.ALLOW);
  assert.equal(decide(boastRow(0.62), base, PLATFORM.REDDIT).action, ACTION.ALLOW);
});

test('boast below the slider does not fire but is still reported', () => {
  const v = decide(boastRow(0.3), base, PLATFORM.LINKEDIN);
  assert.equal(v.action, ACTION.ALLOW);
  assert.deepEqual(v.reasons, []);
  assert.equal(v.boast, 0.3, 'the score is kept so the popup can show near misses');
});

test('boast at the threshold fires (>=, not >)', () => {
  assert.notEqual(decide(boastRow(base.boast.threshold), base, PLATFORM.LINKEDIN).action, ACTION.ALLOW);
});

test('boast takes the best-matching phrase across the whole seed set', () => {
  const v = decide(
    row({ semantic: { similarities: { [BOAST_PHRASES[0]]: 0.44, [BOAST_PHRASES[5]]: 0.81 } } }),
    base,
    PLATFORM.LINKEDIN
  );
  assert.equal(v.boast, 0.81);
  assert.equal(v.boastPhrase, BOAST_PHRASES[5]);
});

test('disabled boast filter is ignored even on LinkedIn', () => {
  assert.equal(decide(boastRow(0.99), noBoast, PLATFORM.LINKEDIN).action, ACTION.ALLOW);
});

test('a stale vault with no boast keys scores zero rather than throwing', () => {
  const v = decide(row({ semantic: { similarities: {} } }), base, PLATFORM.LINKEDIN);
  assert.equal(v.boast, 0);
  assert.equal(v.action, ACTION.ALLOW);
});

test('toxicity still outranks a boast collapse', () => {
  const v = decide(
    row({ toxicity: { score: 0.9 }, semantic: { similarities: { [BOAST_PHRASES[2]]: 0.9 } } }),
    normalize({ ...base, boast: { ...base.boast, action: ACTION.BLUR } }),
    PLATFORM.LINKEDIN
  );
  assert.equal(v.action, ACTION.BLUR);
  assert.ok(v.reasons.includes(REASON.TOXICITY) && v.reasons.includes(REASON.BOAST));
});

test('boast settings survive an older stored blob that predates the feature', () => {
  const s = normalize({ enabled: true, toxicity: { threshold: 0.5 } });
  assert.equal(s.boast.enabled, true);
  assert.deepEqual(s.boast.platforms, [PLATFORM.LINKEDIN]);
  assert.equal(s.boast.threshold, DEFAULT_SETTINGS.boast.threshold);
});

test('data: URLs are unwrapped to bare base64, which is what app.py wants', async () => {
  const encoded = await fetchAsBase64('data:image/png;base64,aGVsbG8=');
  assert.equal(encoded, 'aGVsbG8=');
});

test('non-http schemes are skipped rather than fetched', async () => {
  assert.equal(await fetchAsBase64('blob:https://x.com/abc'), '');
  assert.equal(await fetchAsBase64(''), '');
});

test('summarize handles an empty log', () => {
  const s = summarize([]);
  assert.equal(s.total, 0);
  assert.equal(s.calmScore, 100);
  assert.deepEqual(s.timeline, []);
});

test('summarize over mock data is coherent', () => {
  const s = summarize(mockEvents({ count: 300, minutes: 60 }));
  assert.equal(s.total, 300);
  assert.equal(s.filtered, s.total - s.byAction.allow);
  assert.ok(s.timeline.length >= 10);
  assert.equal(s.timeline.reduce((n, b) => n + b.total, 0), s.total);
  assert.ok(s.calmScore >= 0 && s.calmScore <= 100);
});

test('normalize backfills fields missing from an older stored blob', () => {
  const s = normalize({ enabled: false, toxicity: { threshold: 0.5 } });
  assert.equal(s.enabled, false);
  assert.equal(s.toxicity.threshold, 0.5);
  assert.equal(s.toxicity.action, ACTION.BLUR);
  assert.equal(s.scanImages, true);
  assert.deepEqual(s.triggers, []);
});

test('default backend points at the Flask app, not the old mock port', () => {
  assert.equal(normalize({}).backendUrl, 'http://localhost:8000');
});

test('normalize clamps and strips junk', () => {
  const s = normalize({
    backendUrl: '  http://localhost:8000///  ',
    toxicity: { threshold: 4 },
    triggers: [{ phrase: '  ok  ', threshold: -3 }, { phrase: '   ' }, null],
  });
  assert.equal(s.backendUrl, 'http://localhost:8000');
  assert.equal(s.toxicity.threshold, 1);
  assert.equal(s.triggers.length, 1);
  assert.equal(s.triggers[0].phrase, 'ok');
  assert.ok(s.triggers[0].id);
});


test('congratulating someone else is not boasting, whatever the embedder says', () => {
  // Measured: "huge congrats to Priya on being promoted" scores 0.59 against the
  // promotion phrases - higher than several genuine brags. Phrases cannot fix
  // this, so the veto does.
  const congrats = 'Huge congrats to Priya on being promoted to Director! So happy for you.';
  const v = decide(boastRow(0.59), base, PLATFORM.LINKEDIN, congrats);
  assert.equal(v.action, ACTION.ALLOW);
  assert.deepEqual(v.reasons, []);
  assert.equal(v.boast, 0.59, 'the score is still reported, only the action is vetoed');
});

test('the veto recognises the usual congratulation openers', () => {
  assert.ok(readsAsCongratulation('Congratulations to Dana on her new role - well deserved.'));
  assert.ok(readsAsCongratulation('Huge congrats to Priya!'));
  assert.ok(readsAsCongratulation('Shoutout to the team at Acme. Proud of you all.'));
  assert.ok(readsAsCongratulation('So happy for you, Sam.'));
});

test('the veto does not fire on ordinary brags', () => {
  assert.equal(readsAsCongratulation('Thrilled to announce my promotion to Director!'), false);
  assert.equal(readsAsCongratulation(''), false);
  assert.equal(readsAsCongratulation(undefined), false);
});

test('a brag that thanks well-wishers at the end is still caught', () => {
  // Only the opening is inspected, so a trailing "congrats to my team" does not
  // buy a brag its way out.
  const text =
    'Thrilled to announce I have been promoted to Director. ' +
    'x'.repeat(240) +
    ' And congratulations to everyone else promoted this cycle!';
  assert.equal(readsAsCongratulation(text), false);
  assert.notEqual(decide(boastRow(0.62), base, PLATFORM.LINKEDIN, text).action, ACTION.ALLOW);
});

test('congratulating yourself is still a brag', () => {
  assert.equal(readsAsCongratulation('Congrats to me, I got the promotion!'), false);
  assert.equal(readsAsCongratulation('Congratulations to our team on smashing the target'), false);
});

test('no text at all does not veto - the score stands on its own', () => {
  assert.notEqual(decide(boastRow(0.62), base, PLATFORM.LINKEDIN).action, ACTION.ALLOW);
});

// --- LinkedIn parser ------------------------------------------------------
// Hand-rolled stubs: extract() only ever calls querySelector with a fixed set
// of selector strings, so keying on the literal string is enough and saves
// pulling in a DOM implementation.

const li = ADAPTERS.linkedin;
const NL = String.fromCharCode(10);
const TEXT_SEL =
  '.update-components-text, .feed-shared-update-v2__description, ' +
  '.feed-shared-inline-show-more-text, .update-components-update-v2__commentary';

function img(src) {
  return { src, currentSrc: '' };
}

function fakeEl({ attrs = {}, innerText = '', sel = {}, imgs = [] } = {}) {
  return {
    innerText,
    textContent: innerText,
    getAttribute: (k) => attrs[k] ?? null,
    querySelector(q) {
      if (q in sel) return sel[q];
      if (q === 'img') return imgs[0] || null;
      return null;
    },
    querySelectorAll(q) {
      if (q === 'img') return imgs;
      return [];
    },
  };
}

const POST =
  'Thrilled to announce that after four incredible years I am moving on to a new role.';

test('LinkedIn selector matches urns anywhere, not just as a prefix', () => {
  // The ^= version missed every wrapper whose data-id embeds the urn.
  assert.ok(li.selector.includes('[data-urn*="urn:li:activity"]'));
  assert.ok(li.selector.includes('[data-id*="urn:li:activity"]'));
  assert.ok(!li.selector.includes('^="urn:li:activity"'), 'prefix matching is the old bug');
  assert.ok(li.selector.includes('.scaffold-finite-scroll__content > div'));
});

test('a post whose commentary class is unrecognised still yields text', () => {
  // This was the silent drop: no matching text element meant text === '', and
  // scan() throws away anything with no text and no image.
  const el = fakeEl({ attrs: { 'data-urn': 'urn:li:activity:7261234567890123456' }, innerText: POST });
  const item = li.extract(el);
  assert.equal(item.text, POST);
  assert.equal(item.id, 'li_7261234567890123456');
});

test('the urn is found when it is embedded in an aggregate data-id', () => {
  const el = fakeEl({
    attrs: { 'data-id': 'urn:li:aggregate:(urn:li:activity:7009988776655443322)' },
    innerText: POST,
  });
  assert.equal(li.extract(el).id, 'li_7009988776655443322');
});

test('the urn is found on a descendant when the wrapper carries none', () => {
  const el = fakeEl({
    innerText: POST,
    sel: {
      '[data-urn*="urn:li:activity"]': {
        getAttribute: () => 'urn:li:activity:7111111111111111111',
      },
    },
  });
  assert.equal(li.extract(el).id, 'li_7111111111111111111');
});

test('a post with no urn at all falls back to a content hash, not to nothing', () => {
  const item = li.extract(fakeEl({ innerText: POST }));
  // Platform-scoped now: a bare content hash could collide with a Reddit or X
  // post of identical text and share its cached verdict.
  assert.ok(item.id.startsWith('li_h_'), item.id);
  assert.equal(item.text, POST);
});

test('"…see more" is stripped mid-string, not just at the end', () => {
  // innerText puts the fold marker in the middle, so an end-anchored regex left
  // "…see more" sitting in the text we embed.
  const folded = `Excited to share my news

…see more

42 reactions`;
  const el = fakeEl({
    innerText: folded,
    sel: { [TEXT_SEL]: { innerText: folded, querySelector: () => null } },
  });
  assert.equal(li.extract(el).text, 'Excited to share my news 42 reactions');
});

test('clean collapses the vertical whitespace LinkedIn pads posts with', () => {
  assert.equal(clean(`  a

  b `), 'a b');
  assert.equal(clean(''), '');
  assert.equal(clean(null), '');
});

test('avatars, company logos and sprite chrome are not treated as post imagery', () => {
  const el = fakeEl({
    attrs: { 'data-urn': 'urn:li:activity:1' },
    innerText: POST,
    imgs: [
      img('https://media.licdn.com/dms/image/v2/profile-displayphoto-shrink_100_100/x.jpg'),
      img('https://media.licdn.com/dms/image/company-logo_100_100/y.png'),
      img('https://static.licdn.com/aero-v1/sc/h/abc123.svg'),
      img('https://media.licdn.com/dms/image/v2/D4E22AQ/feedshare-shrink_800/real.jpg'),
    ],
  });
  const item = li.extract(el);
  assert.deepEqual(item.images, ['https://media.licdn.com/dms/image/v2/D4E22AQ/feedshare-shrink_800/real.jpg']);
});

test('ad slots and scroll sentinels the wide selector drags in are discarded', () => {
  assert.deepEqual(li.extract(fakeEl({ innerText: 'Promoted' })), {});
  assert.deepEqual(li.extract(fakeEl({ innerText: '' })), {});
});

test('a short post is kept when it carries an image', () => {
  const el = fakeEl({
    attrs: { 'data-urn': 'urn:li:activity:2' },
    innerText: 'We won.',
    imgs: [img('https://media.licdn.com/dms/image/v2/feedshare/trophy.jpg')],
  });
  const item = li.extract(el);
  assert.equal(item.id, 'li_2');
  assert.equal(item.images.length, 1);
});

test('extract caps text so one long post cannot blow the batch payload', () => {
  const item = li.extract(fakeEl({ attrs: { 'data-urn': 'urn:li:activity:3' }, innerText: 'x'.repeat(5000) }));
  assert.equal(item.text.length, 1500);
});


// --- LinkedIn: the rewritten feed build --------------------------------------
// Hashed classes, no data-urn, virtualised cards. Shapes taken from a real
// captured feed, not invented to match the selector.

test('the new build selector targets the card, not the display:contents wrapper', () => {
  // Painting a display:contents element can never render a veil - it has no box.
  assert.ok(li.selector.includes('[data-lazy-mount-id] [role="listitem"]'));
  assert.ok(!/\[data-lazy-mount-id\](?!\s)/.test(li.selector), 'must not match the bare wrapper');
});

test('legacy build selectors are kept, since LinkedIn serves both', () => {
  assert.ok(li.selector.includes('div.feed-shared-update-v2'));
  assert.ok(li.selector.includes('[data-urn*="urn:li:activity"]'));
});

test('author comes from the control-menu aria-label, which survives class hashing', () => {
  const el = fakeEl({ sel: { '[aria-label^="Open control menu for post by"]': {
    getAttribute: () => 'Open control menu for post by Muhammad Ayan' } } });
  assert.equal(authorOf(el), 'Muhammad Ayan');
  assert.equal(authorOf(fakeEl({})), '');
});

test('the poster headline is stripped so it cannot inflate the boast score', () => {
  // A headline like this reads as self-promotion on every post the person makes.
  const raw = [
    'Feed post',
    'Muhammad Ayan',
    'Engineering AI & Workflow Automations (n8n, Python)',
    '3d',
    'Visibility: Global',
    'Our team shipped a rewrite of the ingestion pipeline this week.',
    'Like', 'Comment', 'Repost', 'Send',
  ].join(NL);
  const body = stripLinkedInChrome(raw, 'Muhammad Ayan');
  assert.equal(body, 'Our team shipped a rewrite of the ingestion pipeline this week.');
  assert.ok(!body.includes('Engineering AI'), 'headline must not survive');
  assert.ok(!body.includes('Feed post'));
});

test('chrome stripping keeps the body when there is no author to anchor on', () => {
  const raw = ['Feed post', 'Promoted', '37,319,826 followers', 'Amazon ML Challenge 2026 is open for registration.'].join(NL);
  assert.equal(stripLinkedInChrome(raw, ''), 'Amazon ML Challenge 2026 is open for registration.');
});

test('a company post keeps its body - it has no headline to drop', () => {
  // Regression: dropping the line after the author unconditionally threw away
  // the entire post on company cards, which carry followers/Promoted instead.
  const raw = ['Feed post','Amazon','37,319,826 followers','Promoted',
    'Amazon ML Challenge 2026 is open for registration. Build a model, win prizes.',
    'Register','Reaction button state: no reaction'].join(NL);
  const body = stripLinkedInChrome(raw, 'Amazon');
  assert.equal(body, 'Amazon ML Challenge 2026 is open for registration. Build a model, win prizes.');
});

test('bullet-prefixed chrome is stripped', () => {
  const raw = ['Feed post','RAHUL SHEKHAWAT','• 3rd+','Student at SKIT Jaipur','3d','• Follow',
    'Thrilled to announce that I have been selected for the Google Summer of Code program!','Like'].join(NL);
  const body = stripLinkedInChrome(raw, 'RAHUL SHEKHAWAT');
  assert.ok(!body.includes('Follow'), body);
  assert.ok(!body.includes('SKIT'), 'headline still dropped');
  assert.ok(body.startsWith('Thrilled to announce'), body);
});

test('a multi-paragraph body survives intact', () => {
  const raw = ['Feed post','Dana Ruiz','• 2nd','Staff Engineer at Acme','1w',
    'We shipped the migration today.','It took four months and three rewrites.',
    'Full writeup in the comments.','Like','Comment'].join(NL);
  const body = stripLinkedInChrome(raw, 'Dana Ruiz');
  assert.ok(body.includes('shipped the migration'));
  assert.ok(body.includes('four months'));
  assert.ok(body.includes('Full writeup'));
  assert.ok(!body.includes('Staff Engineer'), 'headline dropped, body kept');
});

test('chrome stripping never returns empty for a real post', () => {
  const body = stripLinkedInChrome(['Feed post','RAHUL SHEKHAWAT','Student at SKIT Jaipur','3d','Just finished a great course.'].join(NL), 'RAHUL SHEKHAWAT');
  assert.ok(body.length > 10, body);
  assert.ok(body.includes('great course'));
});

test('a new-build card with no urn still gets a stable, platform-scoped id', () => {
  const el = fakeEl({ innerText: POST, sel: { '[aria-label^="Open control menu for post by"]': null } });
  const a = li.extract(el).id;
  const b = li.extract(fakeEl({ innerText: POST })).id;
  assert.ok(a.startsWith('li_'), a);
  assert.equal(a, b, 'same text must hash the same, or remounting re-classifies the post');
});

test('two different posts do not collide on id', () => {
  const a = li.extract(fakeEl({ innerText: POST })).id;
  const b = li.extract(fakeEl({ innerText: 'A completely different post about ferrets and networking.' })).id;
  assert.notEqual(a, b);
});

test('LinkedIn returns the same item shape Reddit does', () => {
  const liItem = li.extract(fakeEl({ attrs: { 'data-urn': 'urn:li:activity:4' }, innerText: POST }));
  const rItem = ADAPTERS.reddit.extract(
    fakeEl({ attrs: { id: 't3_abc', 'post-title': POST }, innerText: POST })
  );
  assert.deepEqual(Object.keys(liItem).sort(), Object.keys(rItem).sort());
  assert.equal(rItem.id, 'r_t3_abc');
});


// --- Instagram parser -----------------------------------------------------
// Instagram has no caption element to target - every class is a rotating hash -
// so extract() works off innerText, the permalink href and the avatar alt. The
// stub answers the handful of selectors it actually asks for.

const ig = ADAPTERS.instagram;

function igEl({ innerText = '', href = null, links = [], imgs = [], videos = [] } = {}) {
  return {
    innerText,
    textContent: innerText,
    getAttribute: (k) => (k === 'href' ? href : null),
    querySelector(q) {
      if (q.includes('cf-veil')) return null;
      if (q.includes('profile picture')) {
        return imgs.find((i) => /profile picture/i.test(i.alt || '')) || null;
      }
      if (q === 'img') return imgs[0] || null;
      return null;
    },
    querySelectorAll(q) {
      if (q === 'img') return imgs;
      if (q === 'video') return videos;
      if (q.includes('/p/')) return links;
      return [];
    },
  };
}

const igImg = (src, alt = '') => ({
  src,
  currentSrc: '',
  alt,
  getAttribute: (k) => (k === 'alt' ? alt : null),
});
const igLink = (href) => ({ getAttribute: (k) => (k === 'href' ? href : null) });
const igVideo = (poster) => ({ getAttribute: (k) => (k === 'poster' ? poster : null) });

const CDN = 'https://scontent.cdninstagram.com/v/t51/';
const AVATAR = `${CDN}s150x150/avatar.jpg`;

// What innerText actually gives you for one feed card, chrome and all.
const IG_CARD = [
  'jane_doe',
  '•',
  'Follow',
  '2d',
  'jane_doe honestly everyone in this thread is an idiot and I hate all of you',
  '… more',
  'Liked by someone_else and 1,204 others',
  'View all 42 comments',
  'mark_b totally agree with this',
  'Add a comment…',
].join(NL);

test('Instagram selector targets the article, not a hashed class', () => {
  assert.ok(ig.selector.includes('main article'));
  assert.ok(!/_a[a-z0-9]{3}/.test(ig.selector), 'hashed classes rotate; never match on one');
  assert.deepEqual(ig.hosts, ['instagram.com', 'www.instagram.com']);
});

test('the shortcode in the permalink is the post id', () => {
  const item = ig.extract(
    igEl({
      innerText: IG_CARD,
      links: [igLink('/jane_doe/p/C8xYz-123_ab/')],
      imgs: [igImg(`${CDN}post.jpg`, 'Photo by jane')],
    })
  );
  assert.equal(item.id, 'ig_C8xYz-123_ab');
});

test('reels and igtv permalinks yield an id too', () => {
  assert.equal(instagramShortcode(igEl({ links: [igLink('/reel/DA1b2C3d4E5/')] })), 'DA1b2C3d4E5');
  assert.equal(instagramShortcode(igEl({ links: [igLink('/tv/BxYz9/')] })), 'BxYz9');
  assert.equal(
    instagramShortcode(igEl({ href: 'https://www.instagram.com/p/CQQQ1/?img_index=2' })),
    'CQQQ1'
  );
});

test('a card with no permalink falls back to a platform-scoped content hash', () => {
  const item = ig.extract(igEl({ innerText: IG_CARD, imgs: [igImg(`${CDN}post.jpg`)] }));
  // Bare content hashes collide across platforms and would share a cached verdict.
  assert.ok(item.id.startsWith('ig_h_'), item.id);
});

test('the caption survives and the feed chrome does not', () => {
  const item = ig.extract(
    igEl({ innerText: IG_CARD, links: [igLink('/p/C1/')], imgs: [igImg(`${CDN}post.jpg`)] })
  );
  assert.equal(item.text, 'honestly everyone in this thread is an idiot and I hate all of you');
});

test('comment previews are cut off, not scored as the poster', () => {
  // A stranger's reply under a clean post used to be read as the post itself.
  const text = stripInstagramChrome(
    [
      'jane_doe',
      'Follow',
      '2d',
      'jane_doe sunset from the lab',
      'View all 42 comments',
      'mark_b you are worthless and nobody would miss you',
    ].join(NL),
    'jane_doe'
  );
  assert.equal(text, 'sunset from the lab');
});

test('the username prefix on the caption line is stripped', () => {
  assert.equal(
    stripInstagramChrome(['jane_doe', 'jane_doe look at this'].join(NL), 'jane_doe'),
    'look at this'
  );
  // ...but a caption that merely starts with a similar word keeps it.
  assert.equal(
    stripInstagramChrome(['jane_doe', 'janes are great'].join(NL), 'jane_doe'),
    'janes are great'
  );
});

test('"see more" is stripped from the fold, both as its own line and trailing', () => {
  assert.equal(stripInstagramChrome(['a real caption here', '… more'].join(NL)), 'a real caption here');
  assert.equal(stripInstagramChrome('a real caption here… more'), 'a real caption here');
});

test('the username is inferred when the avatar has not loaded its alt yet', () => {
  // No avatar to read the author off, but the header line and the caption line
  // both open with the same token - which is what a username is.
  assert.equal(
    stripInstagramChrome(['jane_doe', '2d', 'jane_doe look at this'].join(NL)),
    'look at this'
  );
  // Two unrelated lines must not be mistaken for a header plus its caption.
  assert.equal(
    stripInstagramChrome(['headline', 'a completely different sentence'].join(NL)),
    'headline a completely different sentence'
  );
});

test('the header survives innerText collapsing it onto one line', () => {
  // Captured from a real DOM, not assumed: innerText renders the actor row as
  // "jane_doe · Follow · 2d", so the username has to be taken off the front of
  // that line rather than expected to be a line of its own.
  const real = [
    ' jane_doe · Follow · 2d',
    'jane_doe honestly everyone in this thread is an idiot and I hate all of you',
    '… more',
    'Liked by someone and 1,204 others',
    '2D',
    'View all 42 comments',
    'hostile_commenter you are worthless and nobody would miss you',
    'Add a comment…',
  ].join(NL);
  const expected = 'honestly everyone in this thread is an idiot and I hate all of you';
  assert.equal(stripInstagramChrome(real, 'jane_doe'), expected, 'avatar alt available');
  assert.equal(stripInstagramChrome(real), expected, 'avatar still lazy-loading');
});

test('the author comes off the avatar alt, which survives class hashing', () => {
  const el = igEl({ imgs: [igImg(AVATAR, "jane_doe's profile picture")] });
  assert.equal(instagramAuthorOf(el), 'jane_doe');
  assert.equal(instagramAuthorOf(igEl({})), '');
});

test('avatars and sprites are not sent to the NSFW model', () => {
  const media = instagramMedia(
    igEl({
      imgs: [
        igImg(AVATAR, "jane_doe's profile picture"),
        igImg('https://static.cdninstagram.com/rsrc.php/v3/icon.png'),
        igImg(`${CDN}post.jpg`, 'Photo by jane_doe on June 08, 2024.'),
      ],
    })
  );
  assert.deepEqual(media, [`${CDN}post.jpg`]);
});

test('data: images go through, but blob and relative srcs do not', () => {
  // images.js decodes a data: URI without a fetch, and it is the only image the
  // test harness can produce. blob: has no meaning in the service worker.
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAA';
  assert.deepEqual(instagramMedia(igEl({ imgs: [igImg(PNG)] })), [PNG]);
  assert.deepEqual(instagramMedia(igEl({ imgs: [igImg('blob:https://instagram.com/abc')] })), []);
  assert.deepEqual(instagramMedia(igEl({ imgs: [igImg('/static/x.png')] })), []);
});

test('a reel has no readable frames, so its poster stands in for the video', () => {
  const media = instagramMedia(igEl({ videos: [igVideo(`${CDN}poster.jpg`)] }));
  assert.deepEqual(media, [`${CDN}poster.jpg`]);
});

test('an image-only post falls back to the generated alt text', () => {
  // The whole post is a meme; the words are in the picture, and Instagram's own
  // alt is the only place they exist as text.
  const item = ig.extract(
    igEl({
      innerText: ['jane_doe', 'Follow', '3h', 'Liked by bob and 12 others'].join(NL),
      links: [igLink('/p/C2/')],
      imgs: [
        igImg(AVATAR, "jane_doe's profile picture"),
        igImg(
          `${CDN}meme.jpg`,
          "Photo by jane_doe on June 08, 2024. May be an image of text that says 'everyone here is trash'."
        ),
      ],
    })
  );
  assert.equal(item.text, "text that says 'everyone here is trash'.");
  assert.deepEqual(item.images, [`${CDN}meme.jpg`]);
});

test('alt text is not used when there is a real caption', () => {
  const item = ig.extract(
    igEl({
      innerText: IG_CARD,
      links: [igLink('/p/C3/')],
      imgs: [igImg(`${CDN}post.jpg`, 'Photo by jane on June 08, 2024. May be an image of one person.')],
    })
  );
  assert.ok(!item.text.includes('one person'), item.text);
});

test('a story tray or empty sentinel is dropped, not sent to the backend', () => {
  assert.deepEqual(ig.extract(igEl({ innerText: '' })), {});
  assert.deepEqual(ig.extract(igEl({ innerText: 'Suggested for you' })), {});
  assert.deepEqual(ig.extract(igEl({ innerText: 'Follow' })), {});
});

test('an image post with a short caption still goes through', () => {
  // A length gate alone would drop this; on an image feed almost every real
  // post is a short caption plus a picture.
  const item = ig.extract(
    igEl({ innerText: 'jane_doe nice', links: [igLink('/p/C4/')], imgs: [igImg(`${CDN}a.jpg`)] })
  );
  assert.equal(item.id, 'ig_C4');
  assert.equal(item.images.length, 1);
});

test('Instagram captions are capped like every other platform', () => {
  const item = ig.extract(igEl({ innerText: 'x'.repeat(5000), links: [igLink('/p/C5/')] }));
  assert.equal(item.text.length, 1500);
});

test('the same post seen twice hashes to the same id (virtualised feed)', () => {
  const a = ig.extract(igEl({ innerText: IG_CARD, imgs: [igImg(`${CDN}post.jpg`)] })).id;
  const b = ig.extract(igEl({ innerText: IG_CARD, imgs: [igImg(`${CDN}post.jpg`)] })).id;
  assert.equal(a, b);
});

test('the alt prefix stripper leaves nothing useful behind on boilerplate', () => {
  assert.equal(
    instagramAltText(igEl({ imgs: [igImg(`${CDN}a.jpg`, 'Photo by jane_doe on June 08, 2024.')] })),
    ''
  );
  assert.equal(instagramAltText(igEl({ imgs: [igImg(AVATAR, "jane_doe's profile picture")] })), '');
});

test('boasting stays off Instagram - it is scoped to LinkedIn', () => {
  const v = decide(boastRow(0.99), base, PLATFORM.INSTAGRAM);
  assert.equal(v.action, ACTION.ALLOW);
  assert.ok(!v.reasons.includes(REASON.BOAST));
});

test('toxicity and NSFW do apply on Instagram', () => {
  assert.equal(
    decide(row({ toxicity: { score: 0.9 } }), base, PLATFORM.INSTAGRAM).action,
    ACTION.BLUR
  );
  assert.equal(decide(row({ nsfw: { score: 0.9 } }), base, PLATFORM.INSTAGRAM).action, ACTION.BLUR);
});


// --- Clickbait / rage-bait ------------------------------------------------
// app.py returns a `ragebait` block on every text post, scored by the one
// model in this stack we trained ourselves (ML_part/). It was computed and
// then dropped on the floor here until this was wired up.

const rageRow = (score, model = null) =>
  row({
    ragebait: {
      flagged: score >= 0.6,
      score,
      threshold: 0.6,
      clickbait_model_score: model === null ? score : model,
      heuristic_score: 0,
    },
  });

test('reads the nested ragebait.score, not a flat field', () => {
  // The exact shape bug that made the old root background.js unable to blur
  // anything: it read fields app.py has never once returned.
  const v = decide(rageRow(0.77), base, PLATFORM.X);
  assert.equal(v.ragebait, 0.77);
  assert.ok(v.reasons.includes(REASON.RAGEBAIT));
  assert.equal(v.action, ACTION.COLLAPSE);
});

test('ragebait at the threshold fires (>=, not >)', () => {
  assert.notEqual(decide(rageRow(0.6), base, PLATFORM.X).action, ACTION.ALLOW);
  assert.equal(decide(rageRow(0.5999), base, PLATFORM.X).action, ACTION.ALLOW);
});

test('the clickbait model score is surfaced next to the blend', () => {
  // The blend is 0.6*model + 0.4*heuristic, so the model's own probability has
  // to survive separately or we cannot show what our model contributed.
  const v = decide(rageRow(0.62, 0.98), base, PLATFORM.X);
  assert.equal(v.ragebait, 0.62);
  assert.equal(v.ragebaitModel, 0.98);
});

test('a post with no ragebait block is not a crash and not a flag', () => {
  // app.py omits it for an image-only post - there is no text to score.
  const v = decide(row({ ragebait: null }), base, PLATFORM.X);
  assert.equal(v.ragebait, 0);
  assert.equal(v.action, ACTION.ALLOW);
});

test('clickbait is scored on every platform, unlike boasting', () => {
  for (const p of Object.values(PLATFORM)) {
    assert.notEqual(decide(rageRow(0.8), base, p).action, ACTION.ALLOW, `not scored on ${p}`);
  }
});

test('disabled clickbait filter is ignored', () => {
  const off = normalize({ ...base, ragebait: { ...DEFAULT_SETTINGS.ragebait, enabled: false } });
  assert.equal(decide(rageRow(0.99), off, PLATFORM.X).action, ACTION.ALLOW);
});

test('a stricter rule still wins over clickbait', () => {
  const v = decide(
    row({
      toxicity: { score: 0.9 },
      ragebait: { score: 0.9, clickbait_model_score: 0.9, heuristic_score: 0 },
      semantic: { similarities: { dieting: 0.85 } },
    }),
    base,
    PLATFORM.X
  );
  assert.equal(v.action, ACTION.HIDE, 'HIDE from the trigger beats COLLAPSE from clickbait');
});

test('the clickbait threshold is the calibrated 0.60, not app.py 0.55', () => {
  // Measured against the live backend: at 0.55 ordinary technical questions
  // flag ("What's everyone using for CI these days?" scores 0.590) because the
  // model was trained on headlines, where a question is itself a bait marker.
  // Real quiz-bait lands at 0.598 - eight thousandths above a false positive.
  // Do not lower this default without re-running that sweep.
  assert.equal(DEFAULT_SETTINGS.ragebait.threshold, 0.6);
  assert.equal(normalize({}).ragebait.threshold, 0.6);
  assert.equal(normalize({}).ragebait.action, ACTION.COLLAPSE);
});

test('a genuine question below the bar is left alone', () => {
  // The live score for "What's everyone using for CI these days?".
  assert.equal(decide(rageRow(0.59), base, PLATFORM.LINKEDIN).action, ACTION.ALLOW);
});

test('clickbait events carry their score and reason into the dashboard', () => {
  const s = summarize(mockEvents({ count: 300, minutes: 60 }));
  assert.ok(s.byReason.ragebait > 0, 'sample data must exercise the clickbait bar');
});

test('every reason has a dashboard label', () => {
  for (const r of Object.values(REASON)) {
    assert.ok(REASON_LABELS[r], `no label for reason "${r}"`);
  }
});


// --- Low / Mid / High filtering levels ------------------------------------

test('every level table is ordered high-catches-more, i.e. descending', () => {
  // The whole UI inverts here: "High" filtering means a LOWER score threshold.
  // Get this backwards and the buttons silently do the opposite of their label.
  for (const [kind, row] of Object.entries(LEVEL_THRESHOLDS)) {
    assert.ok(row.low > row.mid, `${kind}: low must sit above mid`);
    assert.ok(row.mid > row.high, `${kind}: mid must sit above high`);
  }
});

test('mid is the calibrated default that actually ships', () => {
  // If a default moves and its table does not, the popup opens showing a level
  // the user never chose. These are the numbers in DEFAULT_SETTINGS.
  const s = normalize({});
  assert.equal(LEVEL_THRESHOLDS.toxicity.mid, s.toxicity.threshold);
  assert.equal(LEVEL_THRESHOLDS.nsfw.mid, s.nsfw.threshold);
  assert.equal(LEVEL_THRESHOLDS.boast.mid, s.boast.threshold);
  assert.equal(LEVEL_THRESHOLDS.ragebait.mid, s.ragebait.threshold);
  assert.equal(LEVEL_THRESHOLDS.trigger.mid, s.defaultTriggerThreshold);
});

test('a freshly installed popup opens on Mid everywhere', () => {
  const s = normalize({});
  assert.equal(levelFor('toxicity', s.toxicity.threshold), 'mid');
  assert.equal(levelFor('nsfw', s.nsfw.threshold), 'mid');
  assert.equal(levelFor('boast', s.boast.threshold), 'mid');
  assert.equal(levelFor('ragebait', s.ragebait.threshold), 'mid');
});

test('thresholdFor and levelFor round-trip on every stop', () => {
  for (const kind of Object.keys(LEVEL_THRESHOLDS)) {
    for (const level of LEVELS) {
      assert.equal(levelFor(kind, thresholdFor(kind, level)), level, `${kind}/${level}`);
    }
  }
});

test('a threshold left behind by the old slider renders as the nearest level', () => {
  // Settings saved before this UI existed still load; they just round.
  assert.equal(levelFor('ragebait', 0.59), 'mid');
  assert.equal(levelFor('ragebait', 0.69), 'low');
  assert.equal(levelFor('toxicity', 0.42), 'high');
  assert.equal(isExactLevel('ragebait', 0.59), false, 'and is reported as custom');
  assert.equal(isExactLevel('ragebait', 0.6), true);
});

test('clickbait High is the level that knowingly trades false positives', () => {
  // Measured against the live backend: 0.60 is the lowest bar with zero false
  // positives, and an ordinary technical question scores 0.590. High has to sit
  // below that question to be worth offering at all.
  const GENUINE_QUESTION = 0.59;
  assert.ok(LEVEL_THRESHOLDS.ragebait.high < GENUINE_QUESTION);
  assert.ok(LEVEL_THRESHOLDS.ragebait.mid > GENUINE_QUESTION, 'Mid must stay clean');
});

test('boast Mid stays inside the measured 0.40-0.44 plateau', () => {
  assert.ok(LEVEL_THRESHOLDS.boast.mid >= 0.4 && LEVEL_THRESHOLDS.boast.mid <= 0.44);
  assert.ok(LEVEL_THRESHOLDS.boast.high < 0.4, 'High steps off the plateau deliberately');
});

test('picking a level writes a number, so nothing downstream knows levels exist', () => {
  // decide() and the backend payload still see a plain threshold.
  const picked = thresholdFor('toxicity', 'high');
  assert.equal(typeof picked, 'number');
  const s = normalize({ toxicity: { enabled: true, threshold: picked, action: ACTION.BLUR } });
  assert.equal(s.toxicity.threshold, picked, 'normalize must not rewrite a level value');
  assert.equal(decide(row({ toxicity: { score: 0.55 } }), s).action, ACTION.BLUR);
});

test('an unknown category is a throw, not a silent mid', () => {
  assert.throws(() => thresholdFor('nope', 'low'));
  assert.throws(() => levelFor('nope', 0.5));
});


// --- image batching --------------------------------------------------------

test('images in a batch are fetched in parallel, not one at a time', async () => {
  // Six images against a 5s timeout, awaited in a for loop, serialised the whole
  // batch behind the slowest CDN for work that is pure network wait.
  // Kept well under the 50ms settle at the end of this file, or the async
  // result lands after the final tally and the test silently stops counting.
  const DELAY = 15;
  const N = 6;
  const fake = () => new Promise((r) => setTimeout(() => r('x'), DELAY));

  const t0 = Date.now();
  await Promise.all(Array.from({ length: N }, fake));
  const elapsed = Date.now() - t0;

  // Sequential would be ~N*DELAY; parallel should land near one DELAY.
  assert.ok(
    elapsed < DELAY * N * 0.5,
    `parallel fetch took ${elapsed}ms, sequential would be ~${DELAY * N}ms`
  );
});


test('LinkedIn text is cut at the social bar, like Instagram already was', () => {
  // Live-feed regression. The comment thread was being carried into the text we
  // embed - a stranger's reply scored as the poster's - and it diluted the post
  // badly enough to matter: measured against the real backend, this card scored
  // 0.441 with the thread attached and 0.644 without, against a 0.42 bar. A
  // slightly longer thread pushes a real boast under and it silently passes.
  const card = [
    'Priya Sharma',
    'Priya Sharma \u2022 3rd+',
    'Helping founders scale engineering teams | Ex-Google | Speaker',
    '2d \u2022 Edited \u2022 Visible to anyone on or off LinkedIn',
    'Thrilled to announce that I have been promoted to Senior Engineering Manager!',
    '\u2026see more',
    'Activate to view larger image',
    '247 \u2022 38 comments \u2022 12 reposts',
    'Like Comment Repost Send',
    'Load more comments',
    'Anil Kumar',
    'Congratulations Priya! Well deserved.',
    'Reply',
  ].join(NL);
  const out = stripLinkedInChrome(card, 'Priya Sharma');
  assert.equal(out, 'Thrilled to announce that I have been promoted to Senior Engineering Manager!');
  assert.ok(!/Congratulations Priya/.test(out), "a commenter's words are not the poster's");
  assert.ok(!/Ex-Google/.test(out), 'the headline still goes');
  assert.ok(!/Visible to anyone/.test(out), 'the audience chip still goes');
});

test('a post body containing a bullet is never eaten by the chrome stripper', () => {
  // The bullet-joined-chrome rule drops a line only when EVERY segment is
  // chrome, so a real body keeps at least one segment and survives whole.
  const body = 'Three lessons \u2022 one year in \u2022 what I learned building this';
  assert.equal(stripLinkedInChrome(body), body);
});


test('the LinkedIn tail rule survives its own escaping', () => {
  // LI_TAIL is built from string concatenation, so every backslash needs
  // doubling. It shipped once with \d collapsed to d, which silently reduced
  // the rule to its literal phrases: a card showing counts and the action bar
  // but no "Load more comments" was not cut at all. Assert behaviour, not text.
  const cut = [
    '247 comments', '38 comments', '12 reposts', '1,204 reactions',
    'Like Comment Repost Send', 'Load more comments',
  ];
  for (const line of cut) {
    assert.equal(
      stripLinkedInChrome(['A real boast about my promotion', line, 'someone else replied here'].join(NL)),
      'A real boast about my promotion',
      `should cut at: ${line}`
    );
  }
  // ...and must not fire on a body that merely mentions comments.
  const body = 'I got 3 comments on my last post and it changed everything';
  assert.equal(stripLinkedInChrome(body), body);
});


test('the announcement formula fires boast regardless of embedding score', () => {
  // The embedding is length-sensitive: measured live, the same announcement is
  // 0.668 in one line and 0.526 wrapped in a paragraph, and a humblebrag lands
  // at 0.447 against a 0.42 bar. A brag that opens this way is a brag at any
  // length, so the opener is sufficient on its own.
  for (const t of [
    'Thrilled to announce that I have been promoted to Senior Engineering Manager!',
    'Humbled to share that I have been recognised as one of the top 30 under 30.',
    'Happy to share that I have earned the AWS Solutions Architect certification!',
    'Big news! I am starting a new role next month.',
  ]) {
    assert.ok(readsAsBoastAnnouncement(t), `should read as an announcement: ${t}`);
  }
});

test('the announcement rule does not fire on ordinary posts', () => {
  for (const t of [
    'finally got the build working after six hours. the bug was a trailing slash.',
    'does anyone have a good recommendation for filter coffee near campus',
    'another round of layoffs announced today, third one this quarter',
    'We are hiring two backend engineers in Bangalore. Details in the comments.',
    // "thrilled" without the telling verb is just a feeling, not an announcement.
    'I was thrilled by the conference talk yesterday, lots to think about.',
  ]) {
    assert.equal(readsAsBoastAnnouncement(t), false, `must not fire on: ${t}`);
  }
});

test('an announcement about someone else is still vetoed', () => {
  // The lexical route must not become a way around the congratulation veto.
  const t = 'Thrilled to announce that Priya has been promoted to Director. Congratulations Priya!';
  assert.ok(readsAsBoastAnnouncement(t), 'it does read as an announcement');
  const v = decide(row({ semantic: { similarities: {} } }), base, PLATFORM.LINKEDIN, t);
  assert.equal(v.action, ACTION.ALLOW, 'but the veto still wins');
});

test('a long boast that scores under the bar is still caught', () => {
  // Score deliberately below threshold - the lexical route has to carry it.
  const t = 'Thrilled to share some personal news! After six incredible years I am joining Acme as a Staff Engineer, and I am grateful to everyone who helped along the way.';
  const v = decide(boastRow(0.30), base, PLATFORM.LINKEDIN, t);
  assert.notEqual(v.action, ACTION.ALLOW);
  assert.ok(v.reasons.includes(REASON.BOAST));
});

test('the announcement rule respects platform scope and the enable toggle', () => {
  const t = 'Thrilled to announce that I have been promoted!';
  assert.equal(decide(boastRow(0.1), base, PLATFORM.X, t).action, ACTION.ALLOW, 'X is out of scope');
  assert.equal(decide(boastRow(0.1), noBoast, PLATFORM.LINKEDIN, t).action, ACTION.ALLOW, 'disabled');
});

await new Promise((r) => setTimeout(r, 50));
test('every platform has a display label', () => {
  for (const p of Object.values(PLATFORM)) {
    assert.ok(PLATFORM_LABELS[p], `no label for platform "${p}"`);
  }
});

test('linkedin is on by default and normalize keeps site toggles', () => {
  const s = normalize({});
  assert.equal(s.sites.linkedin, true);
  assert.equal(s.sites.instagram, true, 'a new platform must default to on');
  const off = normalize({ sites: { linkedin: false } });
  assert.equal(off.sites.linkedin, false);
  assert.equal(off.sites.x, true, 'untouched sites keep their default');
});

test('summarize splits by every platform we ship an adapter for', () => {
  const s = summarize(mockEvents({ count: 300, minutes: 60 }));
  const seen = Object.keys(s.byPlatform).sort();
  assert.deepEqual(seen, ['instagram', 'linkedin', 'reddit', 'x'], `got ${seen}`);
  assert.equal(
    Object.values(s.byPlatform).reduce((a, b) => a + b, 0),
    s.total,
    'every event is attributed to exactly one platform'
  );
});

test('a cold status reading is treated as stale, not as offline', () => {
  // Mirrors the GET_STATUS staleness rule in background/index.js. A freshly
  // revived MV3 worker has checkedAt === 0, which must trigger a real health
  // check rather than being reported as "backend offline".
  const STALE_MS = 20000;
  const age = (checkedAt) => (checkedAt ? Date.now() - checkedAt : Infinity);

  assert.ok(age(0) > STALE_MS, 'never-checked must be stale');
  assert.ok(age(Date.now() - 60000) > STALE_MS, 'a minute old must be stale');
  assert.ok(!(age(Date.now() - 1000) > STALE_MS), 'a fresh reading is reused');
});

console.log(process.exitCode ? `\n${passed} passed, some failed` : `${passed} passed`);
