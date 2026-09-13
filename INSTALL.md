# Installing READIT

READIT is a wellbeing layer for your feed. It scores posts on X, Reddit, LinkedIn and
Instagram before you read them and blurs, collapses or hides the ones you asked it to.

> **Read this first.** READIT is a *client* — it does not score anything by itself. It
> sends post text and images to a backend running the models, and without one it does
> nothing at all. The popup will say **"Backend offline — feed passes through
> unfiltered"**. That is the extension working correctly, not a bug.
>
> Pick a backend in [step 2](#2-point-it-at-a-backend).

---

## 1. Install the extension

### Firefox

Firefox will not permanently install an unsigned extension, so use the signed `.xpi` from
the [Releases page](https://github.com/OutsideIron123/cyhi-SC/releases).

1. Download `readit-<version>.xpi`
2. Open it in Firefox (`Ctrl+O`, or drag it onto a Firefox window)
3. Accept the permission prompt

**Then grant site access — this is easy to miss and looks like a broken add-on.**
Firefox MV3 treats site permissions as optional and does *not* grant them at install:

`about:addons` → **READIT** → **Permissions** → enable the site toggles.

Until you do, the content script never injects and nothing happens, with no error.

<details>
<summary>Running from source instead (temporary, vanishes on restart)</summary>

```bash
cd extension && npm install && npm run build:firefox
```

`about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → select
`extension/dist-firefox/manifest.json` (the *file*, not the folder).
</details>

### Chrome / Edge / Brave

1. Download `readit-chrome-<version>.zip` from Releases and unzip it
2. Go to `chrome://extensions`
3. Turn on **Developer mode** (top right)
4. **Load unpacked** → select the unzipped folder

Chrome grants site permissions automatically, so there is no extra step.

<details>
<summary>Running from source</summary>

```bash
cd extension && npm install && npm run build
```

Then **Load unpacked** → `extension/dist`.
</details>

---

## 2. Point it at a backend

Click the READIT icon, put a URL in the **Backend** field, press **Test**. A green dot
means it is talking to real models.

### Option A — use the hosted backend

If the project publishes one, its URL is on the
[Releases page](https://github.com/OutsideIron123/cyhi-SC/releases). Paste it in and press
**Test**. Nothing else to do.

Be aware of what this means: **the text and images of posts in your feed are sent to that
server** so the models can score them. If you would rather that not happen, use option B.

### Option B — run it yourself (private; nothing leaves your machine)

With Docker:

```bash
docker build -t readit-backend . && docker run --rm -p 8000:8000 readit-backend
```

Without Docker — needs Python 3.10–3.12, because `torch` publishes no wheel for 3.13+:

```bash
pip install -r requirements.txt && python app.py
```

Either way the backend lands on `http://localhost:8000`, which is the extension's default.
First start downloads roughly 700 MB of model weights; the Docker image bakes them in, so
only the build is slow.

---

## 3. Check it is working

Open X or Reddit and scroll, then open the popup. The page report is the thing to read:

```
N posts matched · N sent · N filtered
```

**`matched` is the number that matters** — it means READIT found posts and read them.
`filtered` depends entirely on what is in your feed.

> **A normal feed contains almost nothing toxic**, so at default settings you can scroll
> for a minute and see nothing filtered. That is correct behaviour. To see it work, set
> **Toxicity** and **Clickbait** to **High** in the popup.

---

## Settings

Each category — Toxicity, NSFW, Clickbait, Boasting — has a **Low / Mid / High** control
and an action (Blur / Collapse / Hide).

**More filtering means a lower score threshold**, so High catches the most. Mid is the
calibrated default in every category; it is the value each filter was measured at, not a
midpoint picked for looks.

| Category | What it catches | Notes |
|---|---|---|
| Toxicity | Hate, harassment, abuse | All platforms |
| NSFW | Explicit or graphic images | Needs "Send images for scanning" on |
| Clickbait | Curiosity gaps, outrage hooks, engagement farming | All platforms |
| Boasting | Humblebrags, promotion announcements, hustle posts | **LinkedIn only** |
| Your topics | Anything you describe in plain language | Matched by meaning, not keywords |

**Your topics** is the interesting one: type *"arguments about politics"* and it catches
posts that never use the word, because it matches on meaning rather than keywords.

### A known limitation, stated plainly

**Clickbait on High will flag some genuine questions.** The model was trained on news
headlines, where a question is itself a bait marker. A real technical question scores
0.590; actual quiz-bait scores 0.598 — eight thousandths apart. No threshold separates
them cleanly, so High is an explicit trade you opt into, not a strictly better setting.
Mid is tuned to have no false positives.

---

## Troubleshooting

| What you see | Why | Fix |
|---|---|---|
| Nothing happens, no console line | Firefox site permissions not granted | `about:addons` → READIT → Permissions |
| "Backend offline" | No backend, or wrong URL | Step 2, then **Test** |
| "Mock backend" warning | Something fake is answering | Stop it; run the real `app.py` |
| `matched: 0` after 5 seconds | Site changed its markup | Console prints the live markup — open an issue and paste it |
| `matched` > 0 but `filtered: 0` | Working as intended | Set categories to High |
| Blurs vanish on scroll then return | Feed re-rendered over the veil | Expected; the cache repaints |
| `Extension context invalidated` | You reloaded the extension with tabs open | Refresh the tab. Harmless |

Open the console with **F12** on the feed tab. READIT logs
`[READIT] content script active on <platform>` when it starts — if that line is missing,
it is a permissions problem, not a filtering one.

---

## Privacy

- Post text and images go to **whichever backend URL you configure**, and nowhere else.
- Point it at `localhost` and nothing leaves your machine.
- Settings and the event log live in your browser's local storage.
- No analytics, no telemetry, no accounts.
