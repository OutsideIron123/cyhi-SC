import assert from 'node:assert/strict';
import { decide } from '../src/background/decide.js';
import { similarityFloor, triggerKey } from '../src/background/backend.js';
import { fetchAsBase64 } from '../src/background/images.js';
import { summarize } from '../src/lib/events.js';
import { mockEvents } from '../src/lib/mock.js';
import { normalize, DEFAULT_SETTINGS } from '../src/lib/settings.js';
import { ACTION, REASON, PLATFORM, PLATFORM_LABELS } from '../src/lib/protocol.js';
import { BOAST_PHRASES, readsAsCongratulation } from '../src/lib/boast.js';
import { ADAPTERS, clean, stripLinkedInChrome, authorOf } from '../src/content/adapters.js';

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

await new Promise((r) => setTimeout(r, 50));
test('every platform has a display label', () => {
  for (const p of Object.values(PLATFORM)) {
    assert.ok(PLATFORM_LABELS[p], `no label for platform "${p}"`);
  }
});

test('linkedin is on by default and normalize keeps site toggles', () => {
  const s = normalize({});
  assert.equal(s.sites.linkedin, true);
  const off = normalize({ sites: { linkedin: false } });
  assert.equal(off.sites.linkedin, false);
  assert.equal(off.sites.x, true, 'untouched sites keep their default');
});

test('summarize splits by all three platforms', () => {
  const s = summarize(mockEvents({ count: 300, minutes: 60 }));
  const seen = Object.keys(s.byPlatform).sort();
  assert.deepEqual(seen, ['linkedin', 'reddit', 'x'], `got ${seen}`);
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
