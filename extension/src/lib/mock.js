import { ACTION, REASON, PLATFORM } from './protocol.js';

export function mockEvents({ count = 240, minutes = 60, seed = 7 } = {}) {
  const rand = mulberry32(seed);
  const now = Date.now();
  const span = minutes * 60 * 1000;
  const phrases = ['layoffs and job loss', 'graphic animal cruelty', 'election arguments', 'diet and calories'];
  const out = [];

  for (let i = 0; i < count; i++) {
    const progress = i / count;
    const t = now - span + Math.floor(span * progress) + Math.floor(rand() * 4000);
    const heat = 0.25 + progress * 0.45;
    const tox = clamp01(betaish(rand, heat));
    const sim = clamp01(betaish(rand, 0.3));

    const platform = pickPlatform(rand());
    // Instagram is an image feed, so NSFW is the reason that actually fires
    // there; on a text feed it is mostly noise. Modelling one rate for all four
    // platforms made the dashboard's per-platform split meaningless.
    const nsf = clamp01(betaish(rand, platform === PLATFORM.INSTAGRAM ? 0.44 : 0.28));
    // Boasting only ever scores on LinkedIn, so the sample data has to model it
    // that way or the dashboard's Boasting bar sits at zero forever.
    const bst = platform === PLATFORM.LINKEDIN ? clamp01(betaish(rand, 0.36)) : 0;

    const reasons = [];
    if (tox > 0.7) reasons.push(REASON.TOXICITY);
    if (nsf > 0.6) reasons.push(REASON.NSFW);
    const tg = sim > 0.55 ? phrases[Math.floor(rand() * phrases.length)] : null;
    if (tg) reasons.push(REASON.TRIGGER);
    const boasted = bst >= 0.42;
    if (boasted) reasons.push(REASON.BOAST);

    out.push({
      t,
      p: platform,
      a: reasons.length
        ? nsf > 0.6
          ? ACTION.COLLAPSE
          : boasted && reasons.length === 1
            ? ACTION.COLLAPSE
            : ACTION.BLUR
        : ACTION.ALLOW,
      r: reasons,
      tox: round2(tox),
      nsf: round2(nsf),
      tg,
      sim: round2(sim),
      bst: round2(bst),
      rv: reasons.length > 0 && rand() > 0.82,
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

const pickPlatform = (r) =>
  r < 0.36 ? PLATFORM.X : r < 0.64 ? PLATFORM.REDDIT : r < 0.84 ? PLATFORM.LINKEDIN : PLATFORM.INSTAGRAM;

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const round2 = (n) => Math.round(n * 100) / 100;
const betaish = (rand, center) => center * (rand() + rand()) * 0.9 + rand() * rand() * 0.4;

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
