# READIT — extension shell

MV3 Chrome extension for CYHI Track 3. This folder is Role 3's deliverable: the
bridge between the DOM layer and the Flask backend, plus the state that both
ends read from.

```bash
npm install
npm run build        # -> dist/   (load unpacked points here)
npm test             # policy engine + dashboard aggregation, no browser needed
npm run mock-backend # fake scores on :5000 so you can work before the API exists
```

Load it: `chrome://extensions` → Developer mode → **Load unpacked** → pick
`extension/dist`. After every `npm run build`, hit the reload arrow on the
extension card. `npm run dev` rebuilds on save; you still press reload.

---

## Who owns what

| Area | Owner | Files |
|---|---|---|
| Flask API, models | ML & Backend | *(separate repo folder)* |
| Post extraction, selectors | DOM Extraction | `src/content/index.js` — the `ADAPTERS` block only |
| Everything else in here | Extension Core | `src/background/`, `src/lib/`, `src/content/overlay.js` |
| Popup + dashboard visuals | UI/UX | `src/popup/*`, `src/dashboard/*` |

Two seams are deliberate. Below `ADAPTERS` in the content script, nothing should
need editing to support a new site. In the popup and dashboard, all the CSS is
replaceable — the only rule is that state changes go through `update()` /
`rpc()`, never straight to `chrome.storage`.

---

## The two contracts

### 1. Content script → service worker

```js
import { rpc } from '../lib/rpc.js';
import { MSG } from '../lib/protocol.js';

const { results } = await rpc(MSG.CLASSIFY, {
  items: [{ id: 'x_1790...', text: 'the post text', images: ['https://…'], platform: 'x' }],
});
// results['x_1790...'] -> { action, reasons[], toxicity, nsfw, trigger, similarity }
```

`id` must be stable across re-renders — that is the whole basis of the cache.
Use the platform's own id where one exists; `fallbackId()` hashes the text
otherwise.

Always go through `rpc()`, never `chrome.runtime.sendMessage` directly. It
handles the two MV3-specific failures: a sleeping worker (retry, normal) and a
reloaded extension (give up, unrecoverable).

### 2. Service worker → Flask

```
POST {backendUrl}/classify
{
  "items":  [{ "id": "...", "text": "...", "images": ["..."], "platform": "x" }],
  "config": { "toxicity_threshold": 0.7, "nsfw_threshold": 0.6,
              "semantic_threshold": 0.55,
              "triggers": [{ "id": "t_ab12", "phrase": "layoffs", "threshold": 0.6 }] }
}

200
{ "results": [{ "id": "...", "toxicity": 0.0-1.0, "nsfw": 0.0-1.0,
                "triggers": [{ "id": "t_ab12", "phrase": "layoffs", "score": 0.0-1.0 }] }] }
```

```
GET {backendUrl}/health  ->  { "status": "ok", "models": { ... } }
```

**The backend returns scores, never decisions.** Thresholds live in
`chrome.storage.local` and are applied in `src/background/decide.js`. That is
why a slider moves and the next scroll behaves differently with no redeploy and
no model reload. `config` is sent anyway so the backend can skip trigger
embeddings it knows will not clear the bar.

Backend notes for Role 1:
- `flask-cors` on, or the worker's fetch is blocked.
- Batches arrive up to 16 items. Return one row per input id, same order not required.
- A missing id is treated as *allow*, not *block*. A model crash must never blank the feed.
- ngrok's free tier serves an HTML interstitial to browser-ish clients; the worker
  sends `ngrok-skip-browser-warning: true` on every request, so don't strip it.

---

## How this survives MV3

The service worker is killed after ~30s idle, routinely mid-scroll. Everything
in `src/background/` is written around that:

- **No durable state in the worker.** Settings → `chrome.storage.local`. Verdict
  cache → in-memory `Map` mirrored to `chrome.storage.session`, rehydrated
  lazily on first touch after a restart. Event log → `chrome.storage.local`.
- **Listeners register synchronously at the top level** of `background/index.js`.
  A listener added inside an `await` is a listener the revived worker does not have.
- **`chrome.alarms`, not `setInterval`,** for the health poll — timers die with
  the worker.
- **`return true` from `onMessage`** keeps the port open for the async reply, and
  keeps the worker alive while it is outstanding. That is what makes the 120ms
  batching window safe.

## Request path

```
MutationObserver  →  80ms coalesce  →  rpc(CLASSIFY)
                                          ↓
                     session-cache hit ───┴─→ returned immediately
                                          ↓ miss
                     120ms batch window, max 16 per request
                                          ↓
                     POST /classify  →  decide()  →  cache + event log
                                          ↓
                     verdict  →  paint()  →  blur / collapse / hide
```

Three layers stop duplicate work: the content script's `seen` Set (per page
load), the worker's verdict cache (per browser session), and request-level
dedupe inside the batcher when two tabs ask for the same post at once.

**Failure is always open.** Backend down, timeout, malformed row, tripped
circuit breaker — the post is allowed through and the verdict is *not* cached,
so it gets scored properly the moment the backend returns. An unfiltered feed is
a bad demo; a blank feed is a dead one.

---

## Storage layout

| Area | Key | Contents |
|---|---|---|
| `local` | `settings` | thresholds, triggers, backend URL, appearance |
| `local` | `events` | Mood Dashboard log, ring buffer capped at 4000 |
| `session` | `verdictCache` | id → verdict, capped at 2500, never hits disk |

Nothing leaves the machine except post text and image URLs, sent to the backend
you point it at. There is no `tabs` permission and no analytics — every context
subscribes to `chrome.storage.onChanged` instead of receiving broadcasts.

## Testing without a backend or a real timeline

`npm run mock-backend` serves both a fake `/classify` and a **test harness** at
<http://127.0.0.1:5000/> — fake posts in real X and Reddit DOM shapes.

```bash
npm run mock-backend      # API + harness on :5000
# then open http://127.0.0.1:5000/  with the extension loaded
```

This is how you prove the bridge works independently of the other two roles. A
failure on the harness is a bridge bug; a failure on real X with a working
harness is a selector bug. Buttons on the page append posts (MutationObserver)
and burst 40 at once (batching). `?platform=reddit` switches DOM shape.

The harness declares its shape via `data-cf-platform` on `<html>`, which
`detectPlatform()` honours. That branch and the `127.0.0.1:5000` content-script
match in the manifest are dev-only — strip both before submission if you want
the permission list as small as it can be.

What to check, in order:
1. `chrome://extensions` → the card shows no errors, and **service worker** is a live link.
2. Popup shows a green dot after **Test** against `http://127.0.0.1:5000`.
3. Harness posts containing "idiot"/"hate"/"trash" blur; clean ones don't.
4. **Show anyway** lifts one blur and does not re-blur.
5. Add a trigger "layoffs and job loss", reload the harness — the layoffs posts blur too.
6. Mood Dashboard tiles are non-zero and tick up live while the harness is open.
7. Click the service worker link, wait 30s for it to go idle, scroll again — it
   revives and still answers. That is the MV3 failure mode that bites on stage.

---

## Demo-day checklist

1. Role 1 starts Flask, then `ngrok http 5000`.
2. Paste the `https://….ngrok-free.app` URL into the popup, press **Test**, wait
   for the green dot. No rebuild needed — the URL is just settings.
3. Add two semantic triggers in plain language. They take effect on the next scroll.
4. Scroll a real timeline. Blurs appear; **Show anyway** lifts one and the
   dashboard's "you un-hid" tile ticks up live.
5. Open the Mood Dashboard from the popup.

If the wifi dies, the extension keeps working and fails open — say so on stage,
it is a design decision, not an excuse.
