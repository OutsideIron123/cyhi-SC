import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HARNESS = join(dirname(fileURLToPath(import.meta.url)), '..', 'test-harness', 'index.html');
// 8001, NOT 8000. app.py owns 8000, and on Windows both processes can bind
// it - the one that started last answers, so a stray mock silently shadows the
// real backend and every score on screen becomes fake. Staying off its port is
// the only version of this that cannot happen by accident.
const PORT = Number(process.env.PORT || 8001);
const NASTY = ['idiot', 'stupid', 'hate', 'trash', 'kill', 'worthless', 'scum', 'shut up'];
const SPICY = ['nsfw', 'nude', 'gore', 'blood', 'graphic'];
const BAITY = ["won't believe", 'stop scrolling', 'nobody is talking', 'changes everything',
  'shocking truth', 'wait until you see', 'link in bio', 'save this'];

let triggerVault = [];

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();

  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
    const html = await readFile(HARNESS);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  if (req.url === '/health') {
    return json(res, {
      status: 'ok',
      service: 'MOCK-no-models',
      device: 'none',
      models: { toxicity: { name: 'MOCK' }, embedder: { name: 'MOCK' }, nsfw: { name: 'MOCK' } },
      triggers: { count: triggerVault.length, phrases: triggerVault },
    });
  }

  if (req.url === '/update-triggers' && req.method === 'POST') {
    const body = await readJson(req);
    triggerVault = (Array.isArray(body) ? body : body?.triggers || [])
      .map((t) => String(t).trim())
      .filter(Boolean);
    console.log(`/update-triggers  ${triggerVault.length} phrases`);
    return json(res, { status: 'ok', count: triggerVault.length, triggers: triggerVault });
  }

  if (req.url === '/classify' && req.method === 'POST') {
    const body = await readJson(req);
    const posts = body?.posts || [];
    const toxThreshold = num(body?.toxicity_threshold, 0.7);
    const simThreshold = num(body?.similarity_threshold, 0.45);
    const rageThreshold = num(body?.ragebait_threshold, 0.6);

    await new Promise((r) => setTimeout(r, 60 + posts.length * 8));

    let images = 0;
    const results = posts.map((post) => {
      const text = String(post.text || '').toLowerCase();
      const toxScore = score(text, NASTY);
      const isToxic = toxScore >= toxThreshold;

      const similarities = {};
      for (const phrase of triggerVault) similarities[phrase] = overlap(text, phrase);
      const matches = Object.entries(similarities)
        .map(([trigger, similarity]) => ({ trigger, similarity }))
        .filter((m) => m.similarity >= simThreshold)
        .sort((a, b) => b.similarity - a.similarity);
      const maxSim = Object.values(similarities).reduce((a, b) => Math.max(a, b), 0);

      let nsfw = null;
      if (post.image_base64) images += 1;
      const spicy = score(text, SPICY);
      if (post.image_base64 || spicy > 0) {
        const s = Math.max(spicy, post.image_base64 ? 0.2 : 0);
        nsfw = {
          flagged: s >= 0.6,
          score: s,
          label: s >= 0.6 ? 'nsfw' : 'normal',
          tags: [],
          scores: {},
        };
      }

      // Crude stand-in for the trained clickbait model: app.py returns this
      // block on every text post, so the harness has to as well or the
      // clickbait path goes untested until it meets the real backend.
      const rageScore = score(text, BAITY);
      const isRagebait = rageScore >= rageThreshold;

      const flags = {
        toxicity: isToxic,
        semantic_trigger: matches.length > 0,
        nsfw: !!nsfw?.flagged,
      };
      flags.ragebait = isRagebait;
      const flagged = Object.values(flags).some(Boolean);
      const reasons = [];
      if (flags.toxicity) reasons.push('toxicity:toxic');
      if (flags.semantic_trigger) reasons.push(`trigger:${matches[0].trigger}`);
      if (flags.nsfw) reasons.push('nsfw:nsfw');

      return {
        id: post.id,
        flagged,
        action: flagged ? 'blur' : 'allow',
        reasons,
        flags,
        toxicity: {
          flagged: isToxic,
          score: toxScore,
          threshold: toxThreshold,
          top_label: isToxic ? 'toxic' : 'neutral',
          scores: {},
        },
        semantic: {
          flagged: matches.length > 0,
          max_similarity: maxSim,
          threshold: simThreshold,
          matched_trigger: matches[0]?.trigger ?? null,
          matches,
          similarities,
        },
        nsfw,
        ragebait: {
          flagged: isRagebait,
          score: rageScore,
          threshold: rageThreshold,
          clickbait_model_score: rageScore,
          heuristic_score: 0,
        },
        errors: [],
      };
    });

    const flaggedCount = results.filter((r) => r.flagged).length;
    console.log(`/classify  ${posts.length} posts (${images} images) -> ${flaggedCount} flagged`);
    return json(res, {
      status: 'ok',
      results,
      summary: { posts: posts.length, images_scored: images, flagged: flaggedCount },
      thresholds: { toxicity: toxThreshold, similarity: simThreshold },
    });
  }

  res.writeHead(404).end();
});

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function score(text, words) {
  const hits = words.filter((w) => text.includes(w)).length;
  return Math.min(1, hits * 0.42 + (hits ? 0.3 : 0));
}

function overlap(text, phrase) {
  const words = String(phrase).toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  if (!words.length) return 0;
  const hits = words.filter((w) => text.includes(w)).length;
  return Math.min(1, (hits / words.length) * 0.7 + (hits ? 0.3 : 0));
}

function json(res, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(null);
      }
    });
  });
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Refusing to start a second`);
    console.error('server on it - a shadowed backend is worse than no backend.');
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`MOCK backend on http://127.0.0.1:${PORT} - NO MODELS, FAKE SCORES.`);
  console.log('Never demo this. The real backend is `python app.py` on :8000.');
  console.log(`Point the popup at http://127.0.0.1:${PORT} to use it.`);
});
