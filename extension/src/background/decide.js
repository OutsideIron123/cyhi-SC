import { ACTION, REASON } from '../lib/protocol.js';
import { boastAppliesTo, boastScore, readsAsCongratulation } from '../lib/boast.js';

const RANK = { [ACTION.ALLOW]: 0, [ACTION.BLUR]: 1, [ACTION.COLLAPSE]: 2, [ACTION.HIDE]: 3 };

export function decide(row, settings, platform, text) {
  const toxicity = clamp01(row?.toxicity?.score);
  const nsfw = clamp01(row?.nsfw?.score);
  const similarities = row?.semantic?.similarities || {};

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

  let trigger = null;
  let similarity = 0;
  for (const cfg of settings.triggers) {
    if (!cfg.enabled) continue;
    const score = clamp01(similarities[cfg.phrase]);
    if (score < cfg.threshold) continue;
    if (score > similarity) {
      similarity = score;
      trigger = cfg.phrase;
    }
    action = strictest(action, cfg.action);
  }
  if (trigger) reasons.push(REASON.TRIGGER);

  // Boasting is scored the same way a trigger is - cosine similarity from the
  // same embedder - but it is a named category with its own slider, and it only
  // applies on the platforms it is scoped to (LinkedIn by default).
  let boast = 0;
  let boastPhrase = null;
  if (boastAppliesTo(platform, settings.boast)) {
    const hit = boastScore(similarities);
    if (hit) {
      boast = hit.score;
      if (boast >= settings.boast.threshold && !readsAsCongratulation(text)) {
        boastPhrase = hit.phrase;
        reasons.push(REASON.BOAST);
        action = strictest(action, settings.boast.action);
      }
    }
  }

  return {
    id: row.id,
    action,
    reasons,
    toxicity,
    nsfw,
    trigger,
    similarity,
    boast,
    boastPhrase,
    degraded: false,
  };
}

function strictest(a, b) {
  return (RANK[b] ?? 0) > (RANK[a] ?? 0) ? b : a;
}

function clamp01(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}
