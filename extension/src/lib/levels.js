// Low / Mid / High filtering strength.
//
// The popup used to expose a raw 0..1 threshold slider per category. Nobody
// tuning a feed thinks in cosine similarity, and the sliders invited people to
// wander off the calibrated values by a hundredth and then report the filter as
// broken. These are three named stops instead.
//
// Two things to hold onto:
//
// 1. MORE filtering means a LOWER threshold. "High" catches more, so it is the
//    smallest number in every row. Read the tables right-to-left.
// 2. `mid` is the calibrated default in every row - the value the category
//    actually shipped with. Low and High are deliberate moves away from a
//    measured point, not three arbitrary numbers.
//
// Thresholds are still stored as plain numbers in settings, exactly as before.
// Nothing downstream of the popup knows levels exist: decide(), the backend
// payload and every stored setting are untouched, and a threshold set by the
// old slider (or by a calibration script) still loads and renders as whichever
// level sits nearest.

export const LEVELS = ['low', 'mid', 'high'];

export const LEVEL_LABELS = { low: 'Low', mid: 'Mid', high: 'High' };

export const LEVEL_THRESHOLDS = {
  // toxic-bert is confident and well separated; 0.70 is its shipped default.
  // High at 0.50 starts catching heated-but-not-abusive argument.
  toxicity: { low: 0.85, mid: 0.7, high: 0.5 },

  // Falconsai scores are bimodal, so the exact bar matters less here than
  // elsewhere. Low leaves only the unambiguous cases.
  nsfw: { low: 0.8, mid: 0.6, high: 0.4 },

  // Measured plateau is 0.40-0.44 (14/14 boasts, 0 false positives); 0.42 is
  // its midpoint. High steps just below the plateau, where ordinary LinkedIn
  // posts begin to score. The congratulation veto is lexical, so it holds at
  // every level rather than eroding as the bar drops.
  boast: { low: 0.52, mid: 0.42, high: 0.36 },

  // Measured against the live backend: 0.60 is the LOWEST bar with zero false
  // positives (7/12 baits). High at 0.52 buys 10/12 but knowingly flags
  // ordinary technical questions - the clickbait model was trained on news
  // headlines, where an interrogative is itself a bait marker.
  ragebait: { low: 0.7, mid: 0.6, high: 0.52 },

  // Per-phrase semantic triggers. Mid is defaultTriggerThreshold (0.32).
  // These match the wording the popup used to print next to the slider:
  // high = "catch a lot", mid = "balanced", low = "near-exact only".
  trigger: { low: 0.45, mid: 0.32, high: 0.24 },
};

// What a category's slider used to say, now attached to the level instead.
export const LEVEL_HINTS = {
  low: 'Only the obvious cases',
  mid: 'Calibrated default',
  high: 'Catches more, expect some false positives',
};

export function thresholdFor(kind, level) {
  const row = LEVEL_THRESHOLDS[kind];
  if (!row) throw new Error(`no level table for "${kind}"`);
  return row[level] ?? row.mid;
}

// The nearest named stop to a stored number. A threshold that predates this UI
// - or one a calibration script wrote - has to render as something, and the
// closest level is the honest answer. Ties fall to the stricter (higher) level
// because under-filtering is the failure people notice.
export function levelFor(kind, threshold) {
  const row = LEVEL_THRESHOLDS[kind];
  if (!row) throw new Error(`no level table for "${kind}"`);
  const n = Number(threshold);
  if (!Number.isFinite(n)) return 'mid';

  let best = 'mid';
  let bestDistance = Infinity;
  for (const level of LEVELS) {
    const distance = Math.abs(row[level] - n);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = level;
    }
  }
  return best;
}

// True when the stored number is one of the three stops rather than something
// a slider left behind. The popup uses this to admit that it is rounding.
export function isExactLevel(kind, threshold) {
  const row = LEVEL_THRESHOLDS[kind];
  if (!row) return false;
  return LEVELS.some((level) => Math.abs(row[level] - Number(threshold)) < 1e-9);
}
