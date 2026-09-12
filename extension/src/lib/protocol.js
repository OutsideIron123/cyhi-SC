// The wire contract. Every message between content script, popup, dashboard and
// the service worker uses one of these types. If you are changing a payload shape,
// change it here first and tell the other two people.

export const MSG = {
  /** content -> SW. { items: PostItem[] } -> { results: { [id]: Verdict }, degraded: boolean } */
  CLASSIFY: 'cf:classify',
  /** any -> SW. {} -> Settings */
  GET_SETTINGS: 'cf:get-settings',
  /** popup -> SW. { patch: Partial<Settings> } -> Settings */
  SAVE_SETTINGS: 'cf:save-settings',
  /** popup -> SW. {} -> Settings */
  RESET_SETTINGS: 'cf:reset-settings',
  // NOTE: there is no settings-broadcast message. chrome.storage.onChanged fires
  // in content scripts, the popup and the dashboard alike, so every context
  // subscribes to storage directly (see lib/settings.js#onSettingsChanged).
  // That also keeps "tabs" off the permission list, which matters for a project
  // whose pitch is about privacy.
  /** dashboard -> SW. { since?: number } -> { events: MoodEvent[] } */
  GET_EVENTS: 'cf:get-events',
  /** dashboard -> SW. {} -> { ok: true } */
  CLEAR_EVENTS: 'cf:clear-events',
  /** content -> SW. { id, platform, reasons } -> { ok: true }  (user lifted a blur) */
  LOG_REVEAL: 'cf:log-reveal',
  /** popup -> SW. {} -> BackendStatus */
  GET_STATUS: 'cf:get-status',
  /** popup -> SW. { backendUrl? } -> BackendStatus  (forces a live health check) */
  PING_BACKEND: 'cf:ping-backend',
};

/** What the content script does to a post. */
export const ACTION = {
  ALLOW: 'allow',
  BLUR: 'blur',
  COLLAPSE: 'collapse',
  HIDE: 'hide',
};

/** Why it did it. A verdict can carry more than one. */
export const REASON = {
  TOXICITY: 'toxicity',
  NSFW: 'nsfw',
  TRIGGER: 'trigger',
};

export const PLATFORM = {
  X: 'x',
  REDDIT: 'reddit',
};

/**
 * PostItem — what the DOM layer sends up.
 * @typedef {Object} PostItem
 * @property {string}   id        Stable per-post id. Must survive re-render.
 * @property {string}   text      Visible post text, already stripped of markup.
 * @property {string[]} [images]  Absolute image URLs. Omit or [] if none.
 * @property {string}   platform  PLATFORM.X | PLATFORM.REDDIT
 */

/**
 * Verdict — what the content layer gets back. The SW decides the action; the
 * backend only ever returns scores. Thresholds live in chrome.storage so the
 * user can move a slider and have it take effect without a backend redeploy.
 * @typedef {Object} Verdict
 * @property {string}   id
 * @property {string}   action    one of ACTION
 * @property {string[]} reasons   subset of REASON
 * @property {number}   toxicity  0..1
 * @property {number}   nsfw      0..1
 * @property {?string}  trigger   phrase of the strongest matching trigger, else null
 * @property {number}   similarity 0..1 similarity of that trigger, else 0
 * @property {boolean}  degraded  true if the backend was unreachable (fail-open)
 */

/** A neutral verdict, used when we fail open. */
export function allowVerdict(id, degraded = false) {
  return {
    id,
    action: ACTION.ALLOW,
    reasons: [],
    toxicity: 0,
    nsfw: 0,
    trigger: null,
    similarity: 0,
    degraded,
  };
}
