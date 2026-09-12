import { MSG } from '../lib/protocol.js';
import { getSettings, saveSettings, resetSettings, DEFAULT_SETTINGS } from '../lib/settings.js';
import { getEvents, clearEvents, markRevealed } from '../lib/events.js';
import { classifyItems } from './batcher.js';
import * as backend from './backend.js';
import * as cache from './cache.js';

// ---------------------------------------------------------------------------
// MV3 service worker.
//
// The one rule that governs this file: THIS WORKER WILL BE KILLED, usually
// after ~30s idle, and often mid-scroll. So it holds no state that matters.
// Settings live in chrome.storage.local, the verdict cache mirrors to
// chrome.storage.session, the event log is in chrome.storage.local. Everything
// in memory here is a cache of something durable, and every listener is
// registered synchronously at the top level so the worker can be revived by an
// incoming event. Do not wrap addListener calls in an async function.
// ---------------------------------------------------------------------------

const HEALTH_ALARM = 'cf:health';

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS, events: [] });
  } else {
    // An update can add fields; normalize() backfills them on first read.
    await saveSettings({});
  }
  chrome.alarms.create(HEALTH_ALARM, { periodInMinutes: 1 });
  void refreshHealth();
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(HEALTH_ALARM, { periodInMinutes: 1 });
  void refreshHealth();
});

// Alarms are the only reliable way to get periodic work out of an MV3 worker;
// setInterval dies with the worker. One minute is the floor Chrome allows.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HEALTH_ALARM) void refreshHealth();
});

async function refreshHealth() {
  const settings = await getSettings();
  if (!settings.enabled) return;
  await backend.health(settings.backendUrl);
}

// Any change to a threshold, a trigger, or the backend invalidates cached
// verdicts — they encode a decision, not just a score.
let lastPolicy = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const sig = policySignature(changes.settings.newValue);
  if (sig !== lastPolicy) {
    lastPolicy = sig;
    void cache.clear();
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

// ---------------------------------------------------------------------------
// Message router
//
// Returning `true` keeps the port open for an async reply. Chrome holds the
// worker alive while a response is outstanding (up to 30s), which is what makes
// batch-then-fetch safe here. Every handler catches: an uncaught throw closes
// the port with no reply and the content script hangs until its own timeout.
// ---------------------------------------------------------------------------

const handlers = {
  async [MSG.CLASSIFY](payload, sender) {
    const settings = await getSettings();
    if (!settings.enabled) return { results: {}, degraded: false, disabled: true };

    const platform = payload?.items?.[0]?.platform;
    if (platform && settings.sites[platform] === false) {
      return { results: {}, degraded: false, disabled: true };
    }
    void sender; // sender.tab is available if you ever need per-tab state
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

  return true; // async reply
});
