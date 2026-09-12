/**
 * The one function every context uses to talk to the service worker.
 *
 * Two failure modes are specific to MV3 and both look like generic errors:
 *
 *  1. "Could not establish connection / Receiving end does not exist" — the
 *     worker was asleep and lost the race. Chrome is already spinning it back
 *     up, so a short retry succeeds. This is normal, not a bug.
 *  2. "Extension context invalidated" — the extension was reloaded while this
 *     page stayed open. Nothing will ever work again in this frame; retrying
 *     just burns CPU. We flag it so callers can shut themselves down.
 */
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
