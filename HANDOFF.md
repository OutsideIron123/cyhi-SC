# Handoff - Stardust Crusaders

> Updated 2026-09-12T18:24:02+05:30 by rishikandiraju (session 0912-1656, track 3)
> Read this first. The full log is cyhi-logs/session.md.

## Current state
Role 3 slice is BUILT AND VERIFIED IN CHROME. Loaded unpacked from extension/dist, harness at
http://127.0.0.1:5000/ blurs 4 of 8 posts, backend log shows one /classify with 8 items.
Still zero git commits and no remote. Never talked to a real Flask backend.

## Works
- Full bridge proven live: extraction -> 80ms coalesce -> 120ms/16 batch -> HTTP -> decide()
  -> blur paint. One request for eight posts.
- MV3 SW: router, batcher, circuit breaker, alarms health poll, session verdict cache
- Client-side policy engine; thresholds + triggers in chrome.storage.local; 12/12 tests
- Mood Dashboard pipeline + summarize(); renders live from storage.onChanged
- npm run preview: index/popup/dashboard all render standalone in a normal browser tab
  (no chrome.*, sample data) so UI work needs no extension load
- npm run mock-backend: fake /classify + DOM harness on :5000

## Broken
- Unverified: Show anyway reveal logging, semantic trigger path end to end, dashboard
  filling from real events, service-worker-teardown recovery. Checklist steps 4-7.
- ADAPTERS selectors still first-guess; not tested against live X or Reddit markup.

## Next 3 things
1. Finish checklist steps 4-7 in extension/README.md (reveal, trigger, dashboard, SW idle).
2. Commit + push. Nothing is shared; Role 2 cannot start.
3. Point it at Role 1's real Flask when it exists - only the popup URL field changes.

## Decisions (and why)
- Backend returns SCORES, extension decides ACTION. Slider changes take effect next scroll,
  no redeploy, no model reload.
- Fail open everywhere; failed verdicts are not cached so they re-score on recovery.
- Built a local DOM harness rather than debugging on live X. Paid for itself immediately:
  isolated two real bugs without Role 2's code existing.
- No "tabs" permission; contexts subscribe to chrome.storage.onChanged.

## Don't retry
- Chrome match patterns CANNOT contain a port. "http://127.0.0.1:5000/*" in
  content_scripts.matches silently injects nothing. Use "http://127.0.0.1/*".
- Changing manifest.json needs Remove + Load unpacked. The reload arrow is not enough.
- Do not detect the platform only at document_start; inline page scripts have not run yet.
  Retry on DOMContentLoaded.
- Do not build fake post ids with arithmetic past Number.MAX_SAFE_INTEGER (~9e15). Real
  tweet ids are ~19 digits; build them as strings or every fixture post shares one id.
- Do not put durable state in the service worker; it dies ~30s idle.
- Do not register chrome listeners inside an async function.
- Do not use setInterval in the SW; use chrome.alarms.
- Do not demo against scripts/mock-backend.mjs. No models. Test fixture only.
