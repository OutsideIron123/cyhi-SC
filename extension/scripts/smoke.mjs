import assert from 'node:assert/strict';
import { decide } from '../src/background/decide.js';
import { similarityFloor, triggerKey } from '../src/background/backend.js';
import { fetchAsBase64 } from '../src/background/images.js';
import { summarize } from '../src/lib/events.js';
import { mockEvents } from '../src/lib/mock.js';
import { normalize, DEFAULT_SETTINGS } from '../src/lib/settings.js';
import { ACTION, REASON, PLATFORM, PLATFORM_LABELS } from '../src/lib/protocol.js';

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
  assert.equal(similarityFloor(base), 0.6);
  const withLoose = normalize({
    ...base,
    triggers: [...base.triggers, { id: 't3', phrase: 'x', threshold: 0.3, enabled: true }],
  });
  assert.equal(similarityFloor(withLoose), 0.3);
});

test('similarity floor falls back to the default when no triggers are enabled', () => {
  const off = normalize({ ...base, triggers: base.triggers.map((t) => ({ ...t, enabled: false })) });
  assert.equal(similarityFloor(off), DEFAULT_SETTINGS.defaultTriggerThreshold);
});

test('trigger sync key ignores disabled triggers', () => {
  const off = normalize({
    ...base,
    triggers: [{ ...base.triggers[0] }, { ...base.triggers[1], enabled: false }],
  });
  assert.equal(triggerKey(off), JSON.stringify(['layoffs and job loss']));
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
