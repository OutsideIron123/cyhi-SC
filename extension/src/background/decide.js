import { ACTION, REASON } from '../lib/protocol.js';

/** Severity order — when several rules fire, the strictest one wins. */
const RANK = { [ACTION.ALLOW]: 0, [ACTION.BLUR]: 1, [ACTION.COLLAPSE]: 2, [ACTION.HIDE]: 3 };

/**
 * Turn raw model scores into an action.
 *
 * This is the one piece of policy in the whole system and it lives on the client
 * on purpose: the backend never sees a threshold it has to agree with, so moving
 * a slider in the popup changes behaviour on the next scroll with no redeploy and
 * no model reload. It is also a pure function, which makes it the only part of
 * the pipeline you can reason about at 4am.
 *
 * @param {{id: string, toxicity?: number, nsfw?: number, triggers?: {id: string, phrase: string, score: number}[]}} row
 * @param {import('../lib/settings.js').DEFAULT_SETTINGS} settings
 * @returns {import('../lib/protocol.js').Verdict}
 */
export function decide(row, settings) {
  const toxicity = clamp01(row?.toxicity);
  const nsfw = clamp01(row?.nsfw);

  let action = ACTION.ALLOW;
  const reasons = [];

  if (settings.toxicity.enabled && toxicity >= settings.toxicity.threshold) {
    reasons.push(REASON.TOXICITY);
    action = strictest(action, settings.toxicity.action);
  }
  if (settings.nsfw.enabled && nsfw >= settings.nsfw.threshold) {
    reasons.push(REASON.NSFW);
    action = strictest(action, settings.nsfw.action);
  }

  // Semantic triggers: the backend scores the post against every enabled trigger
  // vector; we keep the strongest one that clears its own per-trigger threshold.
  let trigger = null;
  let similarity = 0;
  const byId = new Map(settings.triggers.map((t) => [t.id, t]));
  for (const hit of row?.triggers || []) {
    const cfg = byId.get(hit.id);
    if (!cfg || !cfg.enabled) continue;
    const score = clamp01(hit.score);
    if (score < cfg.threshold) continue;
    if (score > similarity) {
      similarity = score;
      trigger = cfg.phrase;
    }
    action = strictest(action, cfg.action);
  }
  if (trigger) reasons.push(REASON.TRIGGER);

  return { id: row.id, action, reasons, toxicity, nsfw, trigger, similarity, degraded: false };
}

function strictest(a, b) {
  return (RANK[b] ?? 0) > (RANK[a] ?? 0) ? b : a;
}

function clamp01(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}
