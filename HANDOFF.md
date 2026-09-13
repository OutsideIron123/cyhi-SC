# Handoff - Stardust Crusaders

> Updated 2026-09-13T13:50:28+05:30 by rishikandiraju (session c359b897-39a, track 3)
> Read this first. The full log is cyhi-logs/session.md.

## Current state
Four platforms ship: X, Reddit, LinkedIn, Instagram. Five filter categories: toxicity,
NSFW, semantic triggers, boasting, clickbait. Everything is on main and pushed. 110 smoke
tests pass (was 56). Chrome build in extension/dist, Firefox build in extension/dist-firefox.
Verified end-to-end against the REAL app.py with all four models loaded - not the mock.
The one thing never done: opened against a live logged-in feed on any platform.

## Works
- Instagram adapter (content/adapters.js). Class-hashed like LinkedIn, so it matches on
  `main article` + ARIA and reads identity off the /p/<shortcode>/ permalink -> ig_.
  Author comes off the avatar alt "<user>'s profile picture". Caption recovered from
  innerText, CUT at "View all N comments" so a stranger's reply is never scored as the
  poster's. Image-only posts fall back to Instagram's generated alt text, which on a meme
  is the only place the words in the picture exist as text. Avatars (s150x150) and sprites
  (/rsrc.php/) are dropped; a reel's poster stands in for the video.
- Clickbait filter wired end to end. app.py was already returning a `ragebait` block from
  our own TF-IDF + LogisticRegression model (ML_part/) blended 0.6/0.4 with an outrage
  heuristic, and decide() was discarding it - the one model we trained ourselves never
  reached the feed. Now REASON.RAGEBAIT with its own control, veil label, event field and
  dashboard bar. Cross-platform, unlike boast.
- Popup filtering is Low/Mid/High per category, not sliders (src/lib/levels.js). Mid is
  the calibrated default in every row. Thresholds are still stored as plain numbers, so
  decide(), the backend payload and every stored setting are untouched.
- Firefox MV3 target: `npm run build:firefox` -> dist-firefox. Background rebuilt as a
  self-contained IIFE (Firefox has no background service worker), gecko id injected,
  chrome->browser namespace shim in src/lib/browser-compat.js. web-ext lint: 0 errors.
- Branches consolidated. Six worktrees on four commits collapsed to main. Turn log
  unioned across all six: committed copy had 115 lines, true union is 130 across 12
  sessions.

## Broken
- NEVER opened against a live logged-in feed on ANY platform. Every adapter is calibrated
  against captured markup and stub tests. This is the single biggest risk left.
- Firefox host permissions are OPTIONAL in MV3 and must be granted in about:addons after
  loading, or content scripts never inject. Fails silently, looks like a broken add-on.
- Firefox temporary add-ons vanish on browser restart. No AMO signing done.
- Clickbait catches 7/12 known baits at the shipped 0.60. High (0.52) gets 10/12 but
  knowingly flags ordinary technical questions - a genuine question scores 0.590, real
  quiz-bait 0.598. Eight thousandths apart. No threshold separates them.
- Boast and clickbait corpora are hand-written by one person. They prove separation, not
  accuracy.
- Four stale worktree directories remain on disk under .claude/worktrees/ - git has
  de-registered them but Windows would not delete the folders while other sessions held
  handles. Harmless; delete once those windows are closed.

## Next 3 things
1. Load extension/dist in Chrome, open a real X or Reddit feed, confirm a non-zero
   `matched` count in the popup page report. Drop the categories to High first or a normal
   feed will legitimately filter nothing and look broken.
2. If matched is 0, use the 5s reportNoMatches() console dump - it prints the live markup.
   Do not guess at selectors; that is what the diagnostic exists for.
3. Ask the organisers how strictly "models you trained yourself" is read. Clickbait is
   ours; toxicity, embeddings and NSFW are off-the-shelf.

## Decisions (and why)
- Clickbait default is 0.60, NOT app.py's 0.55. At 0.55 two ordinary technical questions
  flag. 0.60 is the lowest bar with zero false positives. There is no wide safe plateau
  the way there was for boast.
- Low/Mid/High replaced sliders because nobody tunes a feed in cosine similarity, and the
  sliders invited people a hundredth off a calibrated value and then a bug report.
- More filtering = LOWER threshold, so High is the smallest number in every row. A test
  asserts every row is ordered low > mid > high; get it backwards and the buttons do the
  opposite of their label with no other symptom.
- Firefox gets a separate dist rather than one universal package: background service
  worker vs event page is not reconcilable in a single manifest.
- Mock backend moved to :8001 and now exits on EADDRINUSE instead of double-binding.

## Don't retry
- Do not use ^= for LinkedIn urn attributes. Aggregate data-ids embed the urn mid-string.
- Do not let extract() return empty text when the commentary class does not match; scan()
  silently drops those posts and it looks exactly like a selector failure.
- Do not fix the congratulation false positive by editing BOAST_PHRASES. Structural in MiniLM.
- Do not resurrect root background.js. Its wire format never matched app.py.
- Do not anchor the "see more" strip to end-of-string; innerText puts it mid-string.
- Do not run the mock backend on :8000 alongside app.py. On Windows both bind and the
  later one answers, so every score on screen is fake with no visible symptom. This cost
  a full debugging session.
- Do not start a second app.py "just in case" - only one binds; the other burns 2-3GB of
  duplicate model weights.
- Do not assume a stale vite on :5173 is serving your worktree. It served the old popup UI
  for a whole turn and looked like a caching bug.
- Do not lower the clickbait bar to catch more baits without re-reading the 0.590/0.598
  measurement. It is not a tuning problem.
