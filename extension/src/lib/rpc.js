export class ContextInvalidated extends Error {}

export async function rpc(type, payload = {}, { retries = 2, backoffMs = 150 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await chrome.runtime.sendMessage({ type, ...payload });
      if (!res) throw new Error('no response from service worker');
      if (!res.ok) throw new Error(res.error || 'service worker error');
      return res.data;
    } catch (err) {
      const msg = String(err?.message || err);
      if (msg.includes('Extension context invalidated')) {
        throw new ContextInvalidated(msg);
      }
      lastErr = err;
      if (attempt < retries) {
        await sleep(backoffMs * (attempt + 1));
      }
    }
  }
  throw lastErr;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
