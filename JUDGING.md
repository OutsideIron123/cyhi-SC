# Judging prep — READIT (Stardust Crusaders, Track 3)

Ordered by danger, not by likelihood. Q1 is the one that can actually cost us the track.

---

## Q1. "The hard constraint says the majority of features must run on models you trained yourself. Do they?"

**This is the question. Answer it before they ask it.**

Honest position: **one of our five categories uses a model we trained from raw data.**

| Category | Model | Ours? |
|---|---|---|
| Clickbait | TF-IDF + LogisticRegression, 16k labelled headlines | **Trained by us, end to end** |
| Boasting | MiniLM embeddings + our phrase set, threshold and veto | System ours, embedder pretrained |
| Semantic triggers | MiniLM embeddings | Pretrained |
| Toxicity | `unitary/toxic-bert` | Pretrained |
| NSFW | `Falconsai/nsfw_image_detection` | Pretrained |

What to say:

> "One model is ours end to end — the clickbait classifier, trained from raw data with a
> four-stage pipeline and a held-out test set. Three are pretrained and self-hosted.
> What we can say without qualification is that **no commercial LLM API does any of the
> work** — there is not a single API call to OpenAI or Anthropic anywhere in this project.
> Everything runs on a backend we host. If your reading of the constraint is stricter than
> that, we would rather you tell us now than mark us down quietly."

**Do not oversell.** Inviting the correction is stronger than being caught.

Then pivot to what we *did* build, because the engineering is real:

- `ML_part/` is a genuine pipeline: `01_clean` → `02_preprocess` → `03_train` → `04_evaluate`
- The cleaning step found real data problems: `clickbait_data.txt` had every line duplicated
  (32k lines, 16k unique); `non_clickbait_data.txt` had ~10k blank lines
- Stratified 70/15/15 split, test set untouched until final evaluation
- The *system* around the models is ours: thresholds, calibration, vetoes, blending

---

## Q2. "Why not just use GPT-4? It would be more accurate."

> "Three reasons, and only one is the rules.
>
> **Latency.** We score a batch of 16 posts as you scroll. An LLM round trip per post is
> hundreds of milliseconds — the post is already read by then. Filtering has to happen
> *before* you see it, which is the whole premise.
>
> **Cost.** Every post in an infinite feed, per user. There is no version of that which
> is affordable.
>
> **Privacy.** Point it at localhost and your feed never leaves your machine. That is
> impossible with a hosted API."

A small classifier isn't the compromise here — it's the correct tool for per-post inference at scroll speed.

---

## Q3. "Show me it working." / It breaks during the demo

**Set every category to High before demoing.** A normal feed contains almost nothing
toxic, so at defaults you can scroll a minute and filter nothing — which looks broken but
is correct.

If a live feed matches nothing:

> "That is the failure we designed for. Give it five seconds — the extension dumps the
> live markup to the console, because these sites rebuild their feeds and we would rather
> read the real DOM than guess."

Then show the harness, which is deterministic. **Have it open in a second tab already.**

Honest disclosure if pressed: we have verified end to end against the real backend with
all four models, and every parser against captured markup, but we have not run against a
live logged-in feed on every platform.

---

## Q4. "How accurate is it?" / "It's not 100% accurate"

**You have a real number. Lead with it.** Held-out test set, never touched until final
evaluation — `ML_part/EVALUATION.txt`:

| | |
|---|---|
| **Accuracy** | **96%** (4,629 of 4,800) |
| **ROC-AUC** | **0.9951** |
| Precision / recall (clickbait) | 0.97 / 0.96 |
| Confusion matrix | 75 false positives, 96 false negatives |

> "96% accuracy, ROC-AUC 0.995, on a test set the model never saw during training or
> tuning. We can show you the confusion matrix."

**100% is not the bar — and a team claiming it would be telling you their test set leaked.**
The honest framing: we know our error rate, we know which direction the errors go, and we
made the operating point a user choice.

### The errors are genuinely hard, not sloppy

Read two of them out. They do the work for you:

- *"Politicians Disappear More Often Than You Think"* — labelled real news, scores 0.65.
  Reasonable people disagree.
- *"Pop starlet Kylie Minogue has early-stage breast cancer"* — real news written in
  tabloid register. The model is reading style, and the style genuinely is baity.

That's label ambiguity at the boundary, not a broken classifier.

### Precision/recall is a dial, not a fixed number

Also from the test set — worth quoting, because it shows we understand the trade:

| Threshold | Precision | Recall |
|---|---|---|
| 0.50 | 0.968 | 0.960 |
| 0.60 | 0.983 | 0.930 |
| 0.70 | 0.990 | 0.887 |
| 0.90 | 0.998 | 0.670 |

> "Filtering someone's feed wrongly is worse than missing one, so we run on the
> high-precision side. That's what the Low/Mid/High control is — it moves your operating
> point on this curve."

### Now the honest part: 96% is on *headlines*

> "That 96% is on news headlines, which is what the model was trained on. Our feed posts
> are social captions — a different distribution. That's where the 0.590 vs 0.598 collision
> comes from: on headlines a question **is** a bait marker, and on social feeds genuine
> questions are normal.
>
> So we don't claim 96% in deployment. We claim 96% on the distribution we measured, and
> we calibrated the deployed threshold separately against a hand-built social corpus."

**That distinction — in-distribution accuracy vs deployment accuracy — is the most
sophisticated thing you can say in this conversation.** Most teams can't tell you their
test-set number at all, let alone why it doesn't transfer.

Boasting has a clean plateau by contrast: 0.40–0.44 gives 14/14 with zero false positives,
so we ship 0.42, its midpoint.

**Caveat to volunteer:** the *social* corpora for boast and clickbait are hand-written by
one person. They prove separation, not accuracy. The 96% is the rigorous number; those are
calibration aids.

---

## Q5. "Your brief lists a pre-post toxicity check on the compose box. Where is it?"

**Not built.** Don't bluff — it's one grep away.

> "We didn't build it. We had four platforms' worth of DOM extraction to get right, and
> LinkedIn shipped a feed rewrite mid-project that cost us an adapter. We chose to make
> the read path work on four platforms rather than half-build a fifth feature.
>
> The pieces are there — the classifier and the pipeline both exist. It is a compose-box
> listener and a debounce away, not new modelling."

That trade — depth over feature count — is exactly what the brief says judges reward.

---

## Q6. "What happens to my data?"

> "Post text and images go to whichever backend URL you configure and nowhere else. Point
> it at localhost and nothing leaves your machine. No analytics, no telemetry, no accounts.
> Settings and the event log live in browser local storage."

If a hosted backend is live, be straight: using it means post text transits our server, and
self-hosting is the private option. Don't blur this.

---

## Q7. "How do you get around anti-scraping / bot detection?"

> "We don't, because we aren't scraping. The extension makes **zero requests to any
> platform** — there are exactly three fetch calls in the codebase and two go to our own
> backend. You load your own feed in your own browser, and we read the DOM that's already
> rendered. Architecturally we're an ad blocker or a screen reader."

So rate limiting, CAPTCHA, IP blocking, TLS fingerprinting never engage — there's no traffic.

What *does* break us is ordinary frontend engineering: hashed class names, virtualised
feeds, A/B'd rebuilds. We match on ARIA and `data-testid` because those can't be rotated
without breaking screen readers and their own test suites.

**One honest exception:** image scanning fetches image URLs from platform CDNs. Capped at 6
per batch, 3 MB, unauthenticated, and it fails open — blocked fetch means the post is
scored on text alone.

---

## Q8. "What was the hardest part?"

Best story, because it's a real failure we recovered from:

> "LinkedIn rebuilt their feed mid-project. Every class became a rotating hash, `data-urn`
> disappeared entirely, and the feed became virtualised — only about seven posts mounted
> at a time. Our adapter stopped matching anything.
>
> We captured the live DOM rather than guessing, and rewrote it to match on ARIA roles and
> the control-menu `aria-label`, because those can't change without breaking screen readers.
>
> The subtle part: with no caption element left, the post body had to come from `innerText`
> — which includes the poster's LinkedIn headline. Things like *'Helping founders scale.'*
> That reads as self-promotion on **every post they make**, and would have inflated the
> boasting score of an entire feed."

---

## Q9. "What would you do next, with a week?"

1. Run it against live feeds on all four platforms — the one thing we never did
2. Retrain clickbait on social captions, not news headlines; that fixes the 0.590/0.598 collision at the root
3. Build the compose-box check
4. Label a real corpus with more than one person

---

## Q10. "Why does this matter? Who is it for?"

> "Every platform has a report button, which acts *after* you've read the thing. This acts
> before. And it hands the decision to the reader — you describe what you don't want to see
> in plain language, and you choose how aggressive it is, per category.
>
> The dashboard exists for the same reason: you can see what an hour of scrolling actually
> contained, instead of just feeling worse and not knowing why."

---

## Numbers worth memorising

| | |
|---|---|
| Platforms | 4 — X, Reddit, LinkedIn, Instagram |
| Filter categories | 5 |
| Smoke tests | 110 |
| Clickbait training set | 16k unique labelled headlines |
| Clickbait: genuine question vs quiz-bait | **0.590 vs 0.598** |
| Boast zero-FP plateau | 0.40–0.44, ship 0.42 |
| Commercial LLM API calls | **zero** |
| Requests to platform servers | **zero** (except CDN images) |

---

## Three things to say before you're asked

Volunteering a weakness reads as rigour. Being caught on it reads as spin.

1. Only one of the models is ours end to end
2. The compose-box feature isn't built, and why we made that trade
3. Clickbait High flags genuine questions, with the 0.590/0.598 number to prove we measured it
