import { ACTION, REASON, MSG } from '../lib/protocol.js';
import { rpc } from '../lib/rpc.js';

const STYLE_ID = 'cf-styles';
const VEIL_CLASS = 'cf-veil';

const LABELS = {
  [REASON.TOXICITY]: 'toxic language',
  [REASON.NSFW]: 'sensitive imagery',
  [REASON.TRIGGER]: 'a topic you muted',
  [REASON.BOAST]: 'self-promotion',
  [REASON.RAGEBAIT]: 'clickbait',
};

export function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    [data-cf-action="${ACTION.BLUR}"] {
      position: relative !important;
      /* The blurred children are scaled up below and would otherwise spill
         over neighbouring posts. */
      overflow: hidden !important;
    }
    [data-cf-action="${ACTION.BLUR}"] > *:not(.${VEIL_CLASS}) {
      /* blur() alone leaves large text perfectly legible - headlines survive
         it because their strokes are wider than the radius. Desaturating and
         darkening removes the contrast the eye reconstructs letterforms from,
         and the scale pushes the edges (which blur leaves sharp against the
         card boundary) out of view.

         Together these make the post genuinely unreadable rather than merely
         soft-focused, which is the point: a veil you can squint past is not a
         filter, it is a suggestion. */
      filter:
        blur(var(--cf-blur, 24px))
        saturate(0.25)
        brightness(0.55)
        contrast(0.75) !important;
      transform: scale(1.06) !important;
      pointer-events: none !important;
      user-select: none !important;
    }
    [data-cf-action="${ACTION.COLLAPSE}"] { position: relative !important; }
    [data-cf-action="${ACTION.COLLAPSE}"] > *:not(.${VEIL_CLASS}) {
      display: none !important;
    }
    [data-cf-action="${ACTION.HIDE}"] { display: none !important; }

    .${VEIL_CLASS} {
      position: absolute !important;
      inset: 0 !important;
      z-index: 2147483000 !important;
      display: flex !important;
      flex-direction: column !important;
      align-items: center !important;
      justify-content: center !important;
      gap: 8px !important;
      padding: 16px !important;
      box-sizing: border-box !important;
      /* Deliberately not opaque. At 88% the veil hid the post completely and
         the card became a flat grey panel - obscured, but with no indication
         anything was ever there. Letting the darkened smear show through reads
         as "a post you are choosing not to look at" rather than a loading
         error, and the backdrop-filter is a second independent pass so what
         does come through is still unreadable. */
      background: color-mix(in srgb, canvas 58%, canvastext 6%) !important;
      backdrop-filter: blur(10px) brightness(0.6) saturate(0.25) !important;
      -webkit-backdrop-filter: blur(10px) brightness(0.6) saturate(0.25) !important;
      /* The label needs to stay readable against whatever is behind it. */
      text-shadow: 0 1px 3px color-mix(in srgb, canvas 80%, transparent) !important;
      border-radius: 12px !important;
      font: 500 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif !important;
      color: canvastext !important;
      text-align: center !important;
      cursor: default !important;
    }
    [data-cf-action="${ACTION.COLLAPSE}"] .${VEIL_CLASS} {
      position: static !important;
      inset: auto !important;
      min-height: 96px !important;
      background: color-mix(in srgb, canvas 90%, canvastext 10%) !important;
      backdrop-filter: none !important;
    }
    .${VEIL_CLASS}-reason { opacity: 0.75 !important; }
    .${VEIL_CLASS}-btn {
      all: unset !important;
      cursor: pointer !important;
      padding: 6px 14px !important;
      border-radius: 999px !important;
      font: 600 12px system-ui, sans-serif !important;
      color: canvastext !important;
      border: 1px solid color-mix(in srgb, canvastext 30%, transparent) !important;
    }
    .${VEIL_CLASS}-btn:hover {
      background: color-mix(in srgb, canvastext 8%, transparent) !important;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

export function paint(el, verdict, settings) {
  if (verdict.action === ACTION.ALLOW) return;
  el.setAttribute('data-cf-action', verdict.action);
  el.style.setProperty('--cf-blur', `${settings?.blurAmount ?? 24}px`);

  if (el.querySelector(`:scope > .${VEIL_CLASS}`)) return;

  const veil = document.createElement('div');
  veil.className = VEIL_CLASS;

  const title = document.createElement('div');
  title.textContent = verdict.action === ACTION.COLLAPSE ? 'Post collapsed' : 'Post hidden';
  veil.appendChild(title);

  if (settings?.showReason !== false) {
    const reason = document.createElement('div');
    reason.className = `${VEIL_CLASS}-reason`;
    reason.textContent = describe(verdict);
    veil.appendChild(reason);
  }

  const btn = document.createElement('button');
  btn.className = `${VEIL_CLASS}-btn`;
  btn.textContent = 'Show anyway';
  btn.addEventListener(
    'click',
    (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      unpaint(el);
      void rpc(MSG.LOG_REVEAL, { id: verdict.id }).catch(() => {});
    },
    true
  );
  veil.appendChild(btn);

  el.appendChild(veil);
}

export function unpaint(el) {
  el.removeAttribute('data-cf-action');
  el.style.removeProperty('--cf-blur');
  el.querySelector(`:scope > .${VEIL_CLASS}`)?.remove();
}

function describe(verdict) {
  const parts = (verdict.reasons || []).map((r) => LABELS[r] || r);
  if (verdict.trigger) {
    const i = parts.indexOf(LABELS[REASON.TRIGGER]);
    if (i >= 0) parts[i] = `“${verdict.trigger}”`;
  }
  if (!parts.length) return 'Filtered';
  if (parts.length === 1) return `Contains ${parts[0]}`;
  return `Contains ${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
