import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HARNESS = join(dirname(fileURLToPath(import.meta.url)), '..', 'test-harness', 'index.html');
const PORT = Number(process.env.PORT || 5000);
const NASTY = ['idiot', 'stupid', 'hate', 'trash', 'kill', 'worthless', 'scum', 'shut up'];
const SPICY = ['nsfw', 'nude', 'gore', 'blood', 'graphic'];

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
    return json(res, { status: 'ok', models: { toxicity: 'MOCK', nsfw: 'MOCK', embed: 'MOCK' } });
  }

  if (req.url === '/classify' && req.method === 'POST') {
    const body = await readJson(req);
    const items = body?.items || [];
    const triggers = body?.config?.triggers || [];

    await new Promise((r) => setTimeout(r, 60 + items.length * 8));

    const results = items.map((item) => {
      const text = String(item.text || '').toLowerCase();
      return {
        id: item.id,
        toxicity: score(text, NASTY),
        nsfw: Math.max(score(text, SPICY), item.images?.length ? 0.2 : 0),
        triggers: triggers.map((t) => ({
          id: t.id,
          phrase: t.phrase,
          score: overlap(text, t.phrase),
        })),
      };
    });

    console.log(`/classify  ${items.length} items`);
    return json(res, { results });
  }

  res.writeHead(404).end();
});

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

server.listen(PORT, '127.0.0.1', () => {
  console.log(`MOCK backend (no models) on http://127.0.0.1:${PORT}`);
});
