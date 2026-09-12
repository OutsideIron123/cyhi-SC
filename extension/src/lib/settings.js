import { ACTION } from './protocol.js';

const KEY = 'settings';

export const DEFAULT_SETTINGS = {
  version: 1,
  enabled: true,

  backendUrl: 'http://localhost:8000',

  toxicity: { enabled: true, threshold: 0.7, action: ACTION.BLUR },
  nsfw: { enabled: true, threshold: 0.6, action: ACTION.BLUR },

  triggers: [],
  defaultTriggerThreshold: 0.55,

  scanImages: true,
  blurAmount: 14,
  showReason: true,
  logEvents: true,

  sites: { x: true, reddit: true },
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
  s.blurAmount = Math.max(0, Math.min(40, num(s.blurAmount, 14)));
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

