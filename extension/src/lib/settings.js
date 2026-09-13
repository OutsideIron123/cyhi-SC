import { ACTION } from './protocol.js';
import { BOAST_PLATFORMS } from './boast.js';

const KEY = 'settings';

export const DEFAULT_SETTINGS = {
  version: 1,
  enabled: true,

  backendUrl: 'http://localhost:8000',

  toxicity: { enabled: true, threshold: 0.7, action: ACTION.BLUR },
  nsfw: { enabled: true, threshold: 0.6, action: ACTION.BLUR },
  // Scored against BOAST_PHRASES by max cosine similarity. The bar sits higher
  // than defaultTriggerThreshold because taking the max over 16 phrases is a
  // far easier test to pass than clearing one phrase.
  boast: {
    enabled: true,
    threshold: 0.42,
    action: ACTION.COLLAPSE,
    platforms: [...BOAST_PLATFORMS],
  },

  // Clickbait / engagement bait, scored by the one model in this stack we
  // trained ourselves. Not platform-scoped the way boast is - curiosity-gap
  // hooks are native to all four feeds.
  //
  // 0.60, NOT app.py's DEFAULT_RAGEBAIT_THRESHOLD of 0.55. Measured against
  // the live backend over a 28-post corpus: at 0.55 two ordinary technical
  // questions flag ("What's everyone using for CI these days?" 0.590). The
  // model was trained on headlines, where a question IS a bait marker, so real
  // quiz-bait (0.598) sits only 0.008 above a genuine question. There is no
  // wide safe plateau here the way there was for boast - 0.60 is the lowest
  // threshold that clears every false positive with any margin at all.
  ragebait: { enabled: true, threshold: 0.6, action: ACTION.COLLAPSE },

  triggers: [],
  defaultTriggerThreshold: 0.32,

  scanImages: true,
  // 14px left headlines legible - large text survives a blur whose radius is
  // narrower than its strokes. Paired with the darkening in overlay.js.
  blurAmount: 24,
  showReason: true,
  logEvents: true,

  sites: { x: true, reddit: true, linkedin: true, instagram: true },
};

export function newTriggerId() {
  return 't_' + Math.random().toString(36).slice(2, 9);
}

export function makeTrigger(phrase, threshold = DEFAULT_SETTINGS.defaultTriggerThreshold) {
  return {
    id: newTriggerId(),
    phrase: String(phrase).trim(),
    threshold,
    action: ACTION.BLUR,
    enabled: true,
  };
}

export function normalize(stored) {
  const s = { ...DEFAULT_SETTINGS, ...(stored || {}) };
  s.toxicity = { ...DEFAULT_SETTINGS.toxicity, ...(stored?.toxicity || {}) };
  s.nsfw = { ...DEFAULT_SETTINGS.nsfw, ...(stored?.nsfw || {}) };
  s.boast = { ...DEFAULT_SETTINGS.boast, ...(stored?.boast || {}) };
  s.ragebait = { ...DEFAULT_SETTINGS.ragebait, ...(stored?.ragebait || {}) };
  s.sites = { ...DEFAULT_SETTINGS.sites, ...(stored?.sites || {}) };
  s.triggers = Array.isArray(stored?.triggers)
    ? stored.triggers
        .filter((t) => t && typeof t.phrase === 'string' && t.phrase.trim())
        .map((t) => ({
          id: t.id || newTriggerId(),
          phrase: t.phrase.trim(),
          threshold: clamp01(num(t.threshold, DEFAULT_SETTINGS.defaultTriggerThreshold)),
          action: t.action || ACTION.BLUR,
          enabled: t.enabled !== false,
        }))
    : [];
  s.toxicity.threshold = clamp01(num(s.toxicity.threshold, 0.7));
  s.nsfw.threshold = clamp01(num(s.nsfw.threshold, 0.6));
  s.boast.threshold = clamp01(num(s.boast.threshold, DEFAULT_SETTINGS.boast.threshold));
  s.ragebait.threshold = clamp01(num(s.ragebait.threshold, DEFAULT_SETTINGS.ragebait.threshold));
  s.ragebait.action = s.ragebait.action || DEFAULT_SETTINGS.ragebait.action;
  s.boast.action = s.boast.action || DEFAULT_SETTINGS.boast.action;
  s.boast.platforms = Array.isArray(s.boast.platforms) && s.boast.platforms.length
    ? s.boast.platforms.filter((p) => typeof p === 'string' && p)
    : [...BOAST_PLATFORMS];
  s.blurAmount = Math.max(0, Math.min(60, num(s.blurAmount, 24)));
  s.backendUrl = String(s.backendUrl || '').trim().replace(/\/+$/, '');
  return s;
}

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp01 = (v) => Math.max(0, Math.min(1, v));

export async function getSettings() {
  const bag = await chrome.storage.local.get(KEY);
  return normalize(bag[KEY]);
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = normalize({ ...current, ...patch });
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

export async function resetSettings() {
  await chrome.storage.local.set({ [KEY]: DEFAULT_SETTINGS });
  return normalize(DEFAULT_SETTINGS);
}

export function onSettingsChanged(cb) {
  const handler = (changes, area) => {
    if (area !== 'local' || !changes[KEY]) return;
    cb(normalize(changes[KEY].newValue));
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}

