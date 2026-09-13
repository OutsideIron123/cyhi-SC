# Handoff - Stardust Crusaders

> Updated 2026-09-13T05:42:14+05:30 by rishikandiraju (session 083bf0b5-4f3, track 3)
> Read this first. The full log is cyhi-logs/session.md.

## Current state
LinkedIn parsing is fixed and a first-class boasting filter ships alongside toxicity and
NSFW. 56/56 smoke tests pass (was 22). Verified end-to-end against the real app.py with
toxic-bert + MiniLM + Falconsai loaded - NOT just the mock. Repo now ships ONE extension.

## Works
- LinkedIn adapter rewritten in extension/src/content/adapters.js (new module, extracted
  from content/index.js so the parsers can be unit tested without a page).
  Wide-net selector: [data-urn*=], [data-id*=], feed-shared-update-v2, occludable-update,
  .scaffold-finite-scroll__content > div. Substring, not prefix - ^= missed aggregate
  data-ids and descendant urns. extract() falls back to the element's own innerText when
  no commentary class matches, which is what used to make posts vanish: empty text +
  no image means scan() drops the post.
- Boast filter: settings.boast {enabled, threshold 0.42, action collapse, platforms:['linkedin']}.
  16 seed phrases in src/lib/boast.js pushed into app.py's trigger vault via the existing
  /update-triggers path; score = max cosine similarity over them. REASON.BOAST, its own
  popup slider (range 0.2-0.75), veil reads "self-promotion".
- Congratulation veto: "huge congrats to Priya on being promoted" measured 0.589 against
  the promotion phrases - higher than several genuine brags. Lexical veto in
  readsAsCongratulation(), applied in decide() over the first 220 chars.
- Calibrated against the real MiniLM, 28-post hand-built corpus: at 0.42, 14/14 boasts
  caught, 0 false positives. Perfect plateau runs 0.40-0.44; 0.42 is its midpoint.
- e2e against app.py: 4 boasts collapsed (0.462-0.832), congratulation allowed, 2 normal
  posts allowed, toxic post blurred at 0.979, same boast post allowed on X and Reddit.
- Root adapters/, manifest.json, background.js DELETED. They read data.toxic/data.nsfw,
  which app.py never returns, so they could never blur anything.

## Broken
- Not yet loaded in Chrome against a live linkedin.com feed. dist/ is freshly built;
  needs Remove + Load unpacked from extension/dist.
- The wide-net selector is calibrated against LinkedIn markup as described, not against a
  live DOM capture. If posts are missed, the 5s reportNoMatches() diagnostic dumps the
  real markup to the console - use it rather than guessing.
- Instagram support is gone with the root extension. It was only ever in the dead tree.
- The boast corpus is hand-written by one person. It proves separation, not accuracy.

## Next 3 things
1. Load extension/dist in Chrome, open a real LinkedIn feed, confirm boast posts collapse
   and the console shows a non-zero matched count.
2. Sanity-check the boast threshold against real feed posts; the slider is in the popup.
3. Ask the organisers how strictly "models you trained yourself" is read - toxic-bert,
   MiniLM and Falconsai are all off-the-shelf.

## Decisions (and why)
- Boasting as a first-class category, not seeded user triggers: it needed platform scoping
  (LinkedIn only) and its own slider, and seeding the trigger list would have polluted it
  and broken the moment a user cleared their triggers.
- Action defaults to COLLAPSE, not BLUR: a brag is not harmful, just tiresome, and a
  blurred card still occupies the same space in the feed.
- Parsers moved to their own module purely for testability - importing index.js runs
  detectPlatform() against location and throws outside a page.
- Veto is lexical, not semantic, because the embedder cannot represent who the subject of
  a sentence is. No phrase tuning separates "I got promoted" from "you got promoted".
- Boast phrases go through the existing trigger vault rather than a new endpoint: no
  backend change needed, so app.py is untouched.

## Don't retry
- Do not use ^= for LinkedIn urn attributes. Aggregate data-ids embed the urn mid-string.
- Do not let extract() return empty text when the commentary class does not match; scan()
  silently drops those posts and it looks exactly like a selector failure.
- Do not try to fix the congratulation false positive by editing BOAST_PHRASES. It was
  tried; the confusion is structural in MiniLM.
- Do not resurrect root background.js. Its wire format never matched app.py.
- Do not anchor the "see more" strip to end-of-string; innerText puts it mid-string.
