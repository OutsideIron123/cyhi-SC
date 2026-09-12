const FETCH_TIMEOUT_MS = 5000;
const MAX_BYTES = 3 * 1024 * 1024;
const CACHE_MAX = 200;

const cache = new Map();

function remember(url, value) {
  cache.delete(url);
  cache.set(url, value);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return value;
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export async function fetchAsBase64(url) {
  if (!url) return '';
  if (cache.has(url)) return cache.get(url);

  if (url.startsWith('data:')) {
    const payload = url.slice(url.indexOf(',') + 1);
    return remember(url, payload.length * 0.75 > MAX_BYTES ? '' : payload);
  }
  if (!/^https?:/i.test(url)) return remember(url, '');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, credentials: 'omit' });
    if (!res.ok) return remember(url, '');
    const type = res.headers.get('content-type') || '';
    if (type && !type.startsWith('image/')) return remember(url, '');
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > MAX_BYTES) return remember(url, '');
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) return remember(url, '');
    return remember(url, toBase64(buf));
  } catch {
    return remember(url, '');
  } finally {
    clearTimeout(timer);
  }
}

export function clearImageCache() {
  cache.clear();
}
