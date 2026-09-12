# Handoff - Stardust Crusaders

> Updated 2026-09-12T21:30:48+05:30 by rishikandiraju (session e1356988-0f1, track 3)
> Read this first. The full log is cyhi-logs/session.md.

## Current state
READIT extension now speaks app.py's real contract and is pushed to main. Builds clean,
22/22 tests pass. Verified against the rewritten mock over HTTP; NOT yet verified against
the real Flask app or re-loaded in Chrome since the rewrite.

## Works
- POST /classify with {posts:[{id,text,image_base64}], toxicity_threshold, similarity_threshold}
- Server-side trigger vault synced via POST /update-triggers before classify whenever the
  enabled phrase list changes
- decide.js reads results[].toxicity.score, .semantic.similarities (keyed by PHRASE),
  .nsfw.score - scores not the backend's flagged booleans, so sliders still work live
- Per-trigger thresholds applied client-side; batch-wide similarity_threshold is set to the
  loosest enabled trigger so the backend pre-filters nothing
- Images: worker fetches first image per post and base64s it, 6/batch, 3MB cap, URL-cached.
  Image CDN host permissions added. "Send images for scanning" toggle in the popup.
- Mock backend rewritten to the identical wire format, now on :8000. Harness emits a
  data: URL image on every 4th post.
- Popup shows the loaded toxicity model name, which is how you tell real from mock.

## Broken
- Never run against app.py itself. Only the mock.
- Not reloaded in Chrome since the rewrite - manifest changed (image hosts), so it needs
  Remove + Load unpacked, not the reload arrow.
- ZenLayer's background.js at repo root is DEAD CODE against this backend: it reads
  data.toxic / data.nsfw, which app.py never returns. It can never blur anything.
- Repo still ships two extensions and two manifests.

## Next 3 things
1. Start app.py on :8000, Remove + Load unpacked from extension/dist, open the harness,
   confirm blurs with real models. Popup status line should show "toxic-bert", not "MOCK".
2. Team decision: delete root background.js + manifest.json + adapters, or fold the adapters
   into ADAPTERS in extension/src/content/index.js. Two extensions cannot both ship.
3. Ask the organisers how strictly "models you trained yourself" is read. toxic-bert,
   MiniLM and Falconsai/nsfw are all off-the-shelf; Calibrate.py tunes thresholds, not weights.

## Decisions (and why)
- Read scores, not the backend's flagged booleans. One decision point in decide.js, and the
  sliders keep working with no redeploy.
- Match triggers on phrase text because that is how the backend keys similarities. Renaming
  a trigger in the popup makes it a different trigger - accepted.
- Send the loosest enabled threshold as similarity_threshold so per-trigger sensitivity is
  still possible client-side despite the backend having only one global threshold.
- Images fetched in the worker, not the content script: page CORS would block most CDNs.

## Don't retry
- Chrome match patterns CANNOT contain a port. Use http://localhost/* - it matches any port.
- Manifest changes need Remove + Load unpacked. The reload arrow is not enough.
- Do not detect the platform only at document_start; inline page scripts have not run yet.
- Do not build fake post ids with arithmetic past Number.MAX_SAFE_INTEGER (~9e15).
- Do not read `flagged` from the backend and call it done - it bakes in the thresholds that
  were sent, so the popup sliders would appear to do nothing.
- Do not send image URLs to app.py. It wants base64 and will just record an error.
- Do not put durable state in the service worker; it dies ~30s idle.
- Do not demo against scripts/mock-backend.mjs. No models.
