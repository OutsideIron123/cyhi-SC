import { ACTION, REASON } from '../lib/protocol.js';
import {
  boastAppliesTo,
  boastScore,
  readsAsCongratulation,
  readsAsBoastAnnouncement,
} from '../lib/boast.js';

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
    if (hit) boast = hit.score;

    // Two independent routes to the same verdict. The embedding catches brags
    // that use no stock phrasing; the lexical opener catches the ones whose
    // score has been dragged down by the length of the story wrapped around
    // them. Either is sufficient - requiring both would lose exactly the long
    // posts this was added for.
    const clearsThreshold = hit && boast >= settings.boast.threshold;
    const announces = readsAsBoastAnnouncement(text);

    // The congratulation veto still governs both. "Thrilled to announce that
    // Priya has been promoted" matches the opener and is still not a brag.
    if ((clearsThreshold || announces) && !readsAsCongratulation(text)) {
      boastPhrase = hit?.phrase ?? null;
      reasons.push(REASON.BOAST);
      action = strictest(action, settings.boast.action);
    }
  }

  // Clickbait / engagement bait. app.py returns this block on every text post;
  // before this it was computed server-side and thrown away here, which meant
  // the only model the team actually trained never reached the feed.
  const ragebait = clamp01(row?.ragebait?.score);
  const ragebaitModel = clamp01(row?.ragebait?.clickbait_model_score);
  if (settings.ragebait?.enabled && ragebait >= settings.ragebait.threshold) {
    reasons.push(REASON.RAGEBAIT);
    action = strictest(action, settings.ragebait.action);
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
    ragebait,
    ragebaitModel,
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
