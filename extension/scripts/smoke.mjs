// Node smoke test for the parts that have no chrome.* dependency:
// the policy engine and the dashboard aggregation.
//   node scripts/smoke.mjs
import assert from 'node:assert/strict';
import { decide } from '../src/background/decide.js';
import { summarize } from '../src/lib/events.js';
import { mockEvents } from '../src/lib/mock.js';
import { normalize, DEFAULT_SETTINGS } from '../src/lib/settings.js';
import { ACTION, REASON } from '../src/lib/protocol.js';

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed++;
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
};

const base = normalize({
  ...DEFAULT_SETTINGS,
  triggers: [
    { id: 't1', phrase: 'layoffs', threshold: 0.6, action: ACTION.BLUR, enabled: true },
    { id: 't2', phrase: 'dieting', threshold: 0.8, action: ACTION.HIDE, enabled: true },
  ],
});

test('clean post is allowed', () => {
  const v = decide({ id: 'a', toxicity: 0.1, nsfw: 0.02 }, base);
  assert.equal(v.action, ACTION.ALLOW);
  assert.deepEqual(v.reasons, []);
});

test('toxicity at the threshold fires (>=, not >)', () => {
  const v = decide({ id: 'a', toxicity: 0.7, nsfw: 0 }, base);
  assert.equal(v.action, ACTION.BLUR);
  assert.deepEqual(v.reasons, [REASON.TOXICITY]);
});

test('disabled classifier is ignored', () => {
  const s = normalize({ ...base, toxicity: { ...base.toxicity, enabled: false } });
  assert.equal(decide({ id: 'a', toxicity: 0.99 }, s).action, ACTION.ALLOW);
});

test('strictest action wins across rules', () => {
  const v = decide(
    { id: 'a', toxicity: 0.9, triggers: [{ id: 't2', phrase: 'dieting', score: 0.85 }] },
    base
  );
  assert.equal(v.action, ACTION.HIDE, 'HIDE from trigger beats BLUR from toxicity');
});

test('trigger below its own threshold does not fire', () => {
  const v = decide({ id: 'a', triggers: [{ id: 't1', phrase: 'layoffs', score: 0.5 }] }, base);
  assert.equal(v.action, ACTION.ALLOW);
  assert.equal(v.trigger, null);
});

test('strongest matching trigger is the one reported', () => {
  const v = decide(
    {
      id: 'a',
      triggers: [
        { id: 't1', phrase: 'layoffs', score: 0.65 },
        { id: 't2', phrase: 'dieting', score: 0.92 },
      ],
    },
    base
  );
  assert.equal(v.trigger, 'dieting');
  assert.equal(v.similarity, 0.92);
});

test('a trigger the user deleted is ignored even if the backend still scores it', () => {
  const v = decide({ id: 'a', triggers: [{ id: 'ghost', phrase: 'gone', score: 0.99 }] }, base);
  assert.equal(v.action, ACTION.ALLOW);
});

test('garbage scores do not throw', () => {
  const v = decide({ id: 'a', toxicity: null, nsfw: 'NaN', triggers: null }, base);
  assert.equal(v.toxicity, 0);
  assert.equal(v.action, ACTION.ALLOW);
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
  assert.ok(s.timeline.length >= 10, 'an hour should bucket into ~12 five-minute windows');
  assert.equal(
    s.timeline.reduce((n, b) => n + b.total, 0),
    s.total,
    'every event lands in exactly one bucket'
  );
  assert.ok(s.calmScore >= 0 && s.calmScore <= 100);
  assert.ok(s.avgToxicity >= 0 && s.avgToxicity <= 1);
});

test('normalize backfills fields missing from an older stored blob', () => {
  const s = normalize({ enabled: false, toxicity: { threshold: 0.5 } });
  assert.equal(s.enabled, false);
  assert.equal(s.toxicity.threshold, 0.5);
  assert.equal(s.toxicity.action, ACTION.BLUR, 'action came from defaults');
  assert.equal(s.nsfw.threshold, 0.6);
  assert.deepEqual(s.triggers, []);
});

test('normalize clamps and strips junk', () => {
  const s = normalize({
    backendUrl: '  http://127.0.0.1:5000///  ',
    toxicity: { threshold: 4 },
    triggers: [{ phrase: '  ok  ', threshold: -3 }, { phrase: '   ' }, null],
  });
  assert.equal(s.backendUrl, 'http://127.0.0.1:5000');
  assert.equal(s.toxicity.threshold, 1);
  assert.equal(s.triggers.length, 1);
  assert.equal(s.triggers[0].phrase, 'ok');
  assert.equal(s.triggers[0].threshold, 0);
  assert.ok(s.triggers[0].id, 'a trigger added without an id gets one');
});

console.log(process.exitCode ? `\n${passed} passed, some failed` : `${passed} passed`);
