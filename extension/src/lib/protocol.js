export const MSG = {
  CLASSIFY: 'cf:classify',
  GET_SETTINGS: 'cf:get-settings',
  SAVE_SETTINGS: 'cf:save-settings',
  RESET_SETTINGS: 'cf:reset-settings',
  GET_EVENTS: 'cf:get-events',
  CLEAR_EVENTS: 'cf:clear-events',
  LOG_REVEAL: 'cf:log-reveal',
  GET_STATUS: 'cf:get-status',
  PING_BACKEND: 'cf:ping-backend',
};

export const ACTION = {
  ALLOW: 'allow',
  BLUR: 'blur',
  COLLAPSE: 'collapse',
  HIDE: 'hide',
};

export const REASON = {
  TOXICITY: 'toxicity',
  NSFW: 'nsfw',
  TRIGGER: 'trigger',
  BOAST: 'boast',
  // Keyed to match app.py's response field name exactly. The score behind it
  // blends our own clickbait model (ML_part/: TF-IDF + LogisticRegression over
  // 16k labelled headlines) with an outrage-phrasing heuristic, 0.6/0.4.
  RAGEBAIT: 'ragebait',
};

export const PLATFORM = {
  X: 'x',
  REDDIT: 'reddit',
  LINKEDIN: 'linkedin',
  INSTAGRAM: 'instagram',
};

export const PLATFORM_LABELS = {
  [PLATFORM.X]: 'X',
  [PLATFORM.REDDIT]: 'Reddit',
  [PLATFORM.LINKEDIN]: 'LinkedIn',
  [PLATFORM.INSTAGRAM]: 'Instagram',
};

export function allowVerdict(id, degraded = false) {
  return {
    id,
    action: ACTION.ALLOW,
    reasons: [],
    toxicity: 0,
    nsfw: 0,
    trigger: null,
    similarity: 0,
    boast: 0,
    ragebait: 0,
    ragebaitModel: 0,
    degraded,
  };
}
