import { MSG } from '../lib/protocol.js';
import { getSettings, saveSettings, resetSettings, DEFAULT_SETTINGS } from '../lib/settings.js';
import { getEvents, clearEvents, markRevealed } from '../lib/events.js';
import { classifyItems } from './batcher.js';
import * as backend from './backend.js';
import * as cache from './cache.js';

const HEALTH_ALARM = 'cf:health';

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS, events: [] });
  } else {
    await saveSettings({});
  }
  chrome.alarms.create(HEALTH_ALARM, { periodInMinutes: 1 });
  void refreshHealth();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(HEALTH_ALARM, { periodInMinutes: 1 });
  void refreshHealth();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HEALTH_ALARM) void refreshHealth();
});

async function refreshHealth() {
  const settings = await getSettings();
  if (!settings.enabled) return;
  await backend.health(settings.backendUrl);
}

let lastPolicy = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const sig = policySignature(changes.settings.newValue);
  if (sig !== lastPolicy) {
    lastPolicy = sig;
    void cache.clear();
    backend.invalidateTriggerSync();
  }
});

function policySignature(s) {
  if (!s) return '';
  return JSON.stringify([
    s.backendUrl,
    s.toxicity,
    s.nsfw,
    (s.triggers || []).map((t) => [t.id, t.phrase, t.threshold, t.action, t.enabled]),
  ]);
}

const handlers = {
  async [MSG.CLASSIFY](payload, sender) {
    const settings = await getSettings();
    if (!settings.enabled) return { results: {}, degraded: false, disabled: true };

    const platform = payload?.items?.[0]?.platform;
    if (platform && settings.sites[platform] === false) {
      return { results: {}, degraded: false, disabled: true };
    }
    void sender;
    return classifyItems(payload?.items || [], settings);
  },

  async [MSG.GET_SETTINGS]() {
    return getSettings();
  },

  async [MSG.SAVE_SETTINGS](payload) {
    return saveSettings(payload?.patch || {});
  },

  async [MSG.RESET_SETTINGS]() {
    await cache.clear();
    return resetSettings();
  },

  async [MSG.GET_EVENTS](payload) {
    return { events: await getEvents(payload?.since || 0) };
  },

  async [MSG.CLEAR_EVENTS]() {
    await clearEvents();
    return { ok: true };
  },

  async [MSG.LOG_REVEAL](payload) {
    const ok = await markRevealed(payload?.id);
    return { ok };
  },

  async [MSG.GET_STATUS]() {
    const settings = await getSettings();
    return {
      ...backend.status,
      backendUrl: settings.backendUrl,
      enabled: settings.enabled,
      cached: await cache.size(),
    };
  },

  async [MSG.PING_BACKEND](payload) {
    const settings = await getSettings();
    const url = payload?.backendUrl ?? settings.backendUrl;
    const status = await backend.health(url);
    return { ...status, backendUrl: url };
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;

  handler(message, sender)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));

  return true;
});
