import { toBackendConfig } from '../lib/settings.js';

const REQUEST_TIMEOUT_MS = 8000;
const HEALTH_TIMEOUT_MS = 3000;
const TRIP_AFTER = 3;
const OPEN_FOR_MS = 10000;

const breaker = { failures: 0, openedAt: 0 };

export const status = {
  online: false,
  checkedAt: 0,
  latencyMs: 0,
  models: null,
  error: null,
};

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

async function post(url, body, timeoutMs) {
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
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function classify(items, settings) {
  if (circuitOpen()) throw new Error('backend circuit open');
  const t0 = performance.now();
  try {
    const json = await post(
      `${settings.backendUrl}/classify`,
      { items, config: toBackendConfig(settings) },
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
  } catch (err) {
    recordFailure(err);
  } finally {
    clearTimeout(timer);
  }
  return { ...status };
}
