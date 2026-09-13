/**
 * End-to-end check against the REAL app.py — not the mock.
 *
 * Runs the extension's own backend.classify() and decide() against a live
 * backend, so what this prints is what the service worker would decide. The
 * smoke suite proves the policy engine in isolation; this proves the wire.
 *
 *   python app.py            # terminal 1, from the repo root
 *   npm run e2e              # terminal 2
 *
 * Fails loudly if a mock is answering, because a green run against fake scores
 * is worse than no run at all.
 */
import { classify, health, status } from '../src/background/backend.js';
import { decide } from '../src/background/decide.js';
import { normalize, DEFAULT_SETTINGS } from '../src/lib/settings.js';
import { ACTION, PLATFORM } from '../src/lib/protocol.js';

const BACKEND = process.env.BACKEND_URL || 'http://127.0.0.1:8000';

const settings = normalize({
  ...DEFAULT_SETTINGS,
  backendUrl: BACKEND,
  // Images are fetched over the network; this check is about the text wire.
  scanImages: false,
  // Shipped default threshold on purpose. "my whole team got laid off this
  // morning" scores 0.360 against this phrase on the real MiniLM - a loose
  // paraphrase with no shared keyword, which is the whole point of semantic
  // triggers, but it means a 0.5 bar silently never fires.
  triggers: [
    {
      id: 't1',
      phrase: 'layoffs and job loss',
      threshold: DEFAULT_SETTINGS.defaultTriggerThreshold,
      action: ACTION.BLUR,
      enabled: true,
    },
  ],
});

// [platform, text, what we expect and why]
const CASES = [
  [PLATFORM.LINKEDIN, 'finally got the build working after six hours. the bug was a trailing slash.', 'allow'],
  [PLATFORM.LINKEDIN, "What's everyone using for CI these days?", 'allow — a real question, 0.590 ragebait'],
  [PLATFORM.X, 'honestly everyone in this thread is an idiot and I hate all of you', 'blur — toxicity'],
  [PLATFORM.LINKEDIN, "Thrilled to announce that I've been promoted to Senior Engineering Manager!", 'collapse — boast'],
  [PLATFORM.LINKEDIN, 'Huge congrats to Priya on being promoted to Director! So happy for you.', 'allow — congratulation veto'],
  [PLATFORM.X, "Stop scrolling!! This changes everything about how you network", 'collapse — clickbait'],
  [PLATFORM.INSTAGRAM, "You won't believe what happened when I quit my job at 3am", 'collapse — clickbait'],
  [PLATFORM.REDDIT, 'my whole team got laid off this morning, still processing it', 'blur — trigger'],
];

const online = await health(BACKEND);
if (!online.online) {
  console.error(`\nBackend at ${BACKEND} is not answering: ${status.error}`);
  console.error('Start it with `python app.py` from the repo root.\n');
  process.exit(1);
}

const service = String(status.service || '');
const toxicityModel = status.models?.toxicity?.name || '(unknown)';
if (/mock/i.test(service) || /^mock$/i.test(toxicityModel)) {
  console.error(`\n${BACKEND} is a MOCK backend (service="${service}"). Fake scores.`);
  console.error('This check only means anything against the real app.py.\n');
  process.exit(1);
}

console.log(`\nBackend : ${BACKEND}  (${service})`);
console.log(`Models  : ${toxicityModel}, ${status.models?.embedder?.name}`);
console.log(`Ragebait: ${status.models?.ragebait?.method || 'MISSING — app.py is too old'}`);
console.log(`Threshold: clickbait ${settings.ragebait.threshold}, boast ${settings.boast.threshold}\n`);

const items = CASES.map(([platform, text], i) => ({ id: `e2e_${i}`, text, images: [], platform }));

// classify() batches per platform in the worker; here one call is enough
// because decide() takes the platform explicitly.
const rows = await classify(items, settings);
const byId = new Map(rows.map((r) => [r.id, r]));

console.log(
  `${'platform'.padEnd(10)} ${'verdict'.padEnd(9)} ${'tox'.padStart(5)} ${'rage'.padStart(5)} ` +
    `${'model'.padStart(5)} ${'boast'.padStart(5)}  text`
);

let missing = 0;
for (const [i, [platform, text, expected]] of CASES.entries()) {
  const row = byId.get(`e2e_${i}`);
  if (!row) {
    missing += 1;
    console.log(`${platform.padEnd(10)} ${'NO ROW'.padEnd(9)}  ${text.slice(0, 40)}`);
    continue;
  }
  const v = decide(row, settings, platform, text);
  const reasons = v.reasons.length ? v.reasons.join(',') : '-';
  console.log(
    `${platform.padEnd(10)} ${v.action.padEnd(9)} ${v.toxicity.toFixed(2).padStart(5)} ` +
      `${v.ragebait.toFixed(2).padStart(5)} ${v.ragebaitModel.toFixed(2).padStart(5)} ` +
      `${v.boast.toFixed(2).padStart(5)}  ${text.slice(0, 46)}`
  );
  console.log(`${' '.repeat(10)} ${reasons.padEnd(9)} expected: ${expected}`);
}

if (missing) {
  console.error(`\n${missing} posts came back with no row — the backend dropped them.`);
  process.exit(1);
}
console.log('\nWire OK: every post scored, every field parsed.\n');
