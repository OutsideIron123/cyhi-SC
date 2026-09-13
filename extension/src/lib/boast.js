import { PLATFORM } from './protocol.js';

// The boast filter rides on the same embedder as the user's own triggers: these
// phrases go into app.py's trigger vault, and a post's boast score is the best
// cosine similarity it scores against any of them. They are written the way the
// posts themselves are written - first person, announcement voice - because
// MiniLM matches register as much as topic, and a terse label like "bragging"
// scores about as well against a layoff post as against a promotion post.
export const BOAST_PHRASES = [
  'thrilled to announce my new role at an amazing company',
  'humbled and honoured to receive this award',
  'excited to share that I have been promoted',
  'delighted to announce that I am joining as the new head of',
  'proud to share that our team smashed its targets this quarter',
  'happy to share that I have earned my certification',
  'grateful to be recognised as a top performer this year',
  'after countless rejections I finally landed my dream job',
  'blessed to receive an offer from my dream company',
  'just closed the biggest deal of my career',
  'honoured to be featured as a speaker at this conference',
  'we raised our funding round and I could not be prouder of the team',
  'here is what my success taught me about hustle and grinding',
  'I woke up at 5am every day and here is what the grind taught me about winning',
  'graduated at the top of my class against all odds',
  'small flex but I hit a personal milestone this week',
  'reflecting on how far I have come in my career journey',
];

// Boasting is a LinkedIn pathology. Scoring it on Reddit and X would mostly
// catch ordinary good news, so the filter is scoped by platform rather than
// applied to every feed.
export const BOAST_PLATFORMS = [PLATFORM.LINKEDIN];

export function boastAppliesTo(platform, cfg) {
  if (!cfg?.enabled) return false;
  if (!platform) return false;
  const scope = Array.isArray(cfg.platforms) && cfg.platforms.length ? cfg.platforms : BOAST_PLATFORMS;
  return scope.includes(platform);
}

// Congratulating someone else is the one thing the embedder reliably confuses
// with boasting: "huge congrats to Priya on being promoted" scores 0.59 against
// the promotion phrases, higher than several real brags. The topic is identical
// and MiniLM does not track who the subject is, so no amount of phrase tuning
// separates them - it takes a lexical veto.
const CONGRATULATION =
  /\b(congrats|congratulation|congratulations|well[- ]deserved|proud of you|happy for (you|her|him|them)|shout[- ]?out to)\b/i;
// ...unless the person being congratulated is the poster, which is just a brag
// wearing a different hat.
const CONGRATULATING_SELF = /\bcongrat\w*\s+(to\s+)?(me\b|myself|us\b|our team)/i;

// The LinkedIn announcement formula, which is lexical and almost invariant:
// an emotion word, then a telling verb, in the opening line. "Thrilled to
// announce", "humbled to share", "excited to share some personal news".
//
// This exists because the embedding score is length-sensitive - MiniLM averages
// over the whole post, so the longer the story around the brag the lower it
// scores. Measured against the live backend: the same announcement is 0.668 in
// one line and 0.526 wrapped in a paragraph of reflection, and a humblebrag
// lands at 0.447 against a 0.42 bar. All pass, but only just, and a longer post
// eventually slips under.
//
// A brag that opens this way is a brag at any length, so treat the opener as
// sufficient on its own rather than hoping the average holds up.
const BOAST_OPENER = new RegExp(
  '\\b(thrilled|excited|delighted|happy|proud|humbled|honou?red|grateful|blessed|pleased|stoked)\\b' +
    '[^.!?]{0,40}?\\bto\\s+(announce|share|say|reveal|report)\\b',
  'i'
);

// ...and the bare-superlative variant, which skips the emotion word entirely:
// "Beyond grateful", "Big news!", "Some personal news".
const BOAST_NEWS = /\b(big|exciting|personal|great)\s+news\b/i;

export function readsAsBoastAnnouncement(text) {
  // Only the opening matters. A post that mentions being thrilled in its last
  // paragraph is not announcing anything.
  const head = String(text || '').slice(0, 200);
  return BOAST_OPENER.test(head) || BOAST_NEWS.test(head);
}

export function readsAsCongratulation(text) {
  // Only the opening matters: a brag that thanks well-wishers in its last line
  // is still a brag.
  const head = String(text || '').slice(0, 220);
  if (!CONGRATULATION.test(head)) return false;
  return !CONGRATULATING_SELF.test(head);
}

// The best-matching boast phrase, given the phrase-keyed similarity map app.py
// returns. Returns null when nothing in the map is a boast phrase at all, which
// is what a stale trigger-vault sync looks like from here.
export function boastScore(similarities) {
  let best = 0;
  let phrase = null;
  let saw = false;
  for (const p of BOAST_PHRASES) {
    const raw = similarities?.[p];
    if (raw === undefined) continue;
    saw = true;
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    if (n > best) {
      best = n;
      phrase = p;
    }
  }
  return saw ? { score: Math.max(0, Math.min(1, best)), phrase } : null;
}
