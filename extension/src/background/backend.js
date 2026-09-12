import { fetchAsBase64 } from './images.js';

const REQUEST_TIMEOUT_MS = 30000;
const HEALTH_TIMEOUT_MS = 4000;
const TRIGGER_TIMEOUT_MS = 8000;
const TRIP_AFTER = 3;
const OPEN_FOR_MS = 10000;

const MAX_IMAGES_PER_BATCH = 6;

const breaker = { failures: 0, openedAt: 0 };

export const status = {
  online: false,
  checkedAt: 0,
  latencyMs: 0,
  models: null,
  triggers: null,
  error: null,
};

let syncedTriggerKey = null;

function circuitOpen() {
  if (breaker.failures < TRIP_AFTER) return false;
  if (Date.now() - breaker.openedAt > OPEN_FOR_MS) {
    breaker.failures = 0;
    return false;
  }
  return true;
}

function recordFailure(err) {
  breaker.failures += 1;
  if (breaker.failures === TRIP_AFTER) breaker.openedAt = Date.now();
  status.online = false;
  status.error = String(err?.message || err);
  status.checkedAt = Date.now();
}

function recordSuccess(latencyMs) {
  breaker.failures = 0;
  status.online = true;
  status.error = null;
  status.latencyMs = latencyMs;
  status.checkedAt = Date.now();
}

async function postJson(url, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'ngrok-skip-browser-warning': 'true',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${detail ? `: ${detail.slice(0, 160)}` : ''}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function enabledPhrases(settings) {
  return settings.triggers.filter((t) => t.enabled).map((t) => t.phrase);
}

export function triggerKey(settings) {
  return JSON.stringify(enabledPhrases(settings));
}

export function invalidateTriggerSync() {
  syncedTriggerKey = null;
}

export async function syncTriggers(settings, { force = false } = {}) {
  const key = triggerKey(settings);
  if (!force && key === syncedTriggerKey) return false;
  const json = await postJson(
    `${settings.backendUrl}/update-triggers`,
    { triggers: enabledPhrases(settings) },
    TRIGGER_TIMEOUT_MS
  );
  syncedTriggerKey = key;
  status.triggers = json?.triggers ?? enabledPhrases(settings);
  return true;
}

export function similarityFloor(settings) {
  const active = settings.triggers.filter((t) => t.enabled);
  if (!active.length) return settings.defaultTriggerThreshold;
  return Math.min(...active.map((t) => t.threshold));
}

async function attachImages(items, settings) {
  if (!settings.scanImages) return items.map((i) => ({ ...i, image_base64: '' }));
  let budget = MAX_IMAGES_PER_BATCH;
  const out = [];
  for (const item of items) {
    const url = item.images?.[0];
    let image_base64 = '';
    if (url && budget > 0) {
      const encoded = await fetchAsBase64(url);
      if (encoded) {
        image_base64 = encoded;
        budget -= 1;
      }
    }
    out.push({ ...item, image_base64 });
  }
  return out;
}

export async function classify(items, settings) {
  if (circuitOpen()) throw new Error('backend circuit open');
  const t0 = performance.now();
  try {
    await syncTriggers(settings);
    const withImages = await attachImages(items, settings);
    const json = await postJson(
      `${settings.backendUrl}/classify`,
      {
        posts: withImages.map((i) => ({
          id: i.id,
          text: i.text || '',
          image_base64: i.image_base64 || '',
        })),
        toxicity_threshold: settings.toxicity.threshold,
        similarity_threshold: similarityFloor(settings),
      },
      REQUEST_TIMEOUT_MS
    );
    recordSuccess(Math.round(performance.now() - t0));
    return Array.isArray(json?.results) ? json.results : [];
  } catch (err) {
    recordFailure(err);
    throw err;
  }
}

export async function health(backendUrl) {
  const url = String(backendUrl || '').replace(/\/+$/, '');
  if (!url) {
    status.online = false;
    status.error = 'no backend URL set';
    status.checkedAt = Date.now();
    return { ...status };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
  const t0 = performance.now();
  try {
    const res = await fetch(`${url}/health`, {
      headers: { 'ngrok-skip-browser-warning': 'true' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json().catch(() => ({}));
    recordSuccess(Math.round(performance.now() - t0));
    status.models = json.models || null;
    syncedTriggerKey = null;
  } catch (err) {
    recordFailure(err);
  } finally {
    clearTimeout(timer);
  }
  return { ...status };
}
