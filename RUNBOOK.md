# Runbook — READIT

Everything needed to get the whole stack running, in order. Copy-paste from top.

---

## 0. One time, per machine

```bash
git clone <TEAM REMOTE>
cd cyhi-hackathon/extension
npm install
```

Python 3.8+ and Node 18+ must be on PATH. Check: `node -v` and `py -3 -V`.

---

## 1. Run it (three terminals)

### Terminal 1 — backend

Real backend, once Role 1 has it:

```bash
cd backend && python app.py
```

Stand-in, until then — **no models, never demo this**:

```bash
cd extension && npm run mock-backend
```

Serves fake `/classify` + `/health` on `:5000`, and a DOM test harness at
<http://127.0.0.1:5000/>.

### Terminal 2 — build the extension

```bash
cd extension && npm run build
```

Rebuild on every save instead:

```bash
cd extension && npm run dev
```

`npm run dev` rebuilds automatically but does **not** reload the extension — you
still press the reload arrow on the `chrome://extensions` card.

### Terminal 3 — dashboard preview (optional)

```bash
cd extension && npm run preview
```

Opens the Mood Dashboard standalone at <http://localhost:5173/dashboard.html>
with sample data. No extension or backend needed. This is the one to put on a
screen.

---

## 2. Load the extension

1. `chrome://extensions`
2. Toggle **Developer mode** (top right)
3. **Load unpacked** → select `cyhi-hackathon/extension/dist`
4. Pin it so the popup is one click away

After every `npm run build`, press the **reload arrow** on the card. If you
changed `manifest.json`, remove the extension and load unpacked again.

---

## 3. Verify it works — 7 steps, ~5 minutes

With the mock backend running, open <http://127.0.0.1:5000/>.

| # | Do this | Expect |
|---|---|---|
| 1 | Look at the `chrome://extensions` card | No red **Errors** button; **service worker** is a blue link |
| 2 | Open the popup, set URL to `http://127.0.0.1:5000`, click **Test** | Green dot, "Backend online · NNms" |
| 3 | Look at the harness page | Posts with "idiot"/"hate"/"trash" are blurred; clean ones are not |
| 4 | Click **Show anyway** on a blurred post | Blur lifts and does not come back |
| 5 | Popup → add topic `layoffs and job loss` → reload harness | Layoffs posts now blur too |
| 6 | Popup → **Mood dashboard** | Tiles are non-zero and tick up while the harness is open |
| 7 | Click **service worker**, wait 30s for it to stop, click **Burst 40** | Worker revives, posts still get scored |

Step 7 is the MV3 teardown that bites on stage. Do not skip it.

Also run, any time:

```bash
cd extension && npm test
```

12 tests over the policy engine and dashboard aggregation. No browser, ~2s.

---

## 4. Demo day

```bash
cd backend && python app.py          # terminal 1
ngrok http 5000                      # terminal 2
```

1. Copy the `https://xxxx.ngrok-free.app` URL.
2. Popup → paste into the backend field → **Test** → wait for green.
   **No rebuild needed.** The URL is just settings.
3. Add two semantic triggers in plain language, live, in front of the judges.
4. Scroll a real timeline. Blurs appear. Lift one with **Show anyway**.
5. Open the Mood Dashboard — the un-hide you just did is already counted.

Before submitting, if you want the permission list minimal, strip the two
dev-only bits: the `data-cf-platform` branch in `detectPlatform()` and the
`127.0.0.1:5000` entries in `content_scripts.matches`.

---

## 5. When it breaks

| Symptom | Cause | Fix |
|---|---|---|
| Card shows **Errors** after load | Stale `dist` | `npm run build`, then reload the card |
| Nothing blurs, popup dot is red | Backend not running, or wrong URL | Check terminal 1; `curl http://127.0.0.1:5000/health` |
| Nothing blurs, popup dot is green | Selectors don't match the live DOM | Role 2's `ADAPTERS`. Confirm on the harness first — if the harness blurs, it's a selector bug, not a bridge bug |
| Blurs flicker or vanish on scroll | SPA re-rendered over the veil | Expected; the verdict cache repaints. If it persists, the post id isn't stable |
| `Extension context invalidated` in console | You reloaded the extension with a tab open | Refresh the tab. Harmless |
| Works, then stops after ~30s idle | MV3 worker died and something held state in memory | It should self-revive. If not, that's a real bug — check `background/index.js` listener registration |
| ngrok returns HTML not JSON | Free-tier interstitial | The worker already sends `ngrok-skip-browser-warning`. Don't strip it server-side |
| CORS error in the worker console | Flask missing CORS | `pip install flask-cors`, `CORS(app)` |
| Sliders move, nothing changes | Verdict cache still holding old decisions | It clears on any policy change. If not, reload the tab |

---

## 6. Handing work to teammates

Paste these as-is.

**Role 1 — ML & Backend**

> Build the Flask API for our Track 3 extension. The exact request/response
> contract is in `extension/README.md` under "Service worker → Flask" — match it
> exactly. Three rules: `flask-cors` must be on or the extension's fetch is
> blocked; return **scores only, never actions** (the extension applies the
> user's thresholds client-side); and if you can't score an item, omit it — a
> missing id is treated as *allow*, because a model crash must never blank the
> feed. Batches arrive up to 16 items. Test against the extension with
> `cd extension && npm run mock-backend` replaced by your server on the same port.

**Role 2 — DOM Extraction**

> Work only inside the `ADAPTERS` block at the top of
> `extension/src/content/index.js`. Everything below it — batching, caching,
> blur painting, settings reactivity — is done and should not need changes. For
> each platform, `extract(el)` returns `{ id, text, images }`. The `id` must be
> stable across re-renders; it is the cache key for the whole pipeline. Verify
> against `http://127.0.0.1:5000/` (`npm run mock-backend`) first — if the
> harness blurs but real X doesn't, the bug is your selectors.

**Role 4 — UI/UX**

> The popup is `extension/src/popup/` and the dashboard is
> `extension/src/dashboard/`. Both CSS files are structural placeholders meant to
> be replaced wholesale. The only rule: state changes go through `update()` or
> `rpc()`, never straight to `chrome.storage`. Run `npm run preview` to design
> the dashboard in a normal browser tab — it falls back to `mockEvents()`, which
> has the identical shape to real data, so you need no backend and no extension.
