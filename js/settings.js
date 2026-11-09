// Per-phone preferences (localStorage). Cue style (ADR-010): voice (default — a spoken "Okay" per phrase), tones
// (speech-shaped glides), beeps (high/low), vibrate (buzzes only), silent (visual only). Spoken questions and the
// end-of-list read-back always speak. "Also vibrate" adds buzzes to voice, tones or beeps.
// Timing: how long a silence after "and" pauses the list, and how long a paused list waits before it's finished.
const KEY = 'wisp.settings';
export const CUE_STYLES = ['voice', 'tones', 'beeps', 'vibrate', 'silent'];
export const PAUSE_CHOICES = [10, 15, 20, 30]; // seconds
export const FINISH_CHOICES = [15, 30, 60]; // seconds
export const DATA_CHOICES = ['sheet', 'phone']; // ADR-014: where the inventory lives
export const GRACE_CHOICES = [1.5, 2, 3, 4]; // seconds WISP keeps listening after a phrase with no "and" (0.6.7)
export const WORD_CHOICES = ['okay', 'kay']; // the Voice style's word: "Okay." or a quicker one-syllable "Kay."
// After each phrase (ADR-017): a light buzz, a soft tick, the cue style's own sound ("Okay", tone…), or nothing.
// The app defaults to the buzz (a spoken "Okay" lands while people are still talking); the web keeps the cue style.
export const ACK_CHOICES = ['buzz', 'soft', 'cue', 'none'];
export const DEFAULTS = Object.freeze({ style: 'voice', vibrate: false, pauseS: 15, finishS: 30, word: 'okay', graceS: 3, data: 'sheet', ack: 'cue' });
const FROM_OLD_SOUNDS = { full: 'voice', minimal: 'beeps', off: 'silent' }; // 0.4.x settings

function clean(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  let style = CUE_STYLES.includes(s.style) ? s.style : null;
  if (!style && s.sounds in FROM_OLD_SOUNDS) style = s.sounds === 'off' && s.vibrate === true ? 'vibrate' : FROM_OLD_SOUNDS[s.sounds];
  const pick = (v, choices, d) => (choices.includes(Number(v)) ? Number(v) : d);
  return {
    style: style ?? DEFAULTS.style,
    vibrate: s.vibrate === true,
    pauseS: pick(s.pauseS, PAUSE_CHOICES, DEFAULTS.pauseS),
    finishS: pick(s.finishS, FINISH_CHOICES, DEFAULTS.finishS),
    word: WORD_CHOICES.includes(s.word) ? s.word : DEFAULTS.word,
    graceS: pick(s.graceS, GRACE_CHOICES, DEFAULTS.graceS),
    data: DATA_CHOICES.includes(s.data) ? s.data : DEFAULTS.data,
    ack: ACK_CHOICES.includes(s.ack) ? s.ack : DEFAULTS.ack,
  };
}

/** The dialog's timings with this phone's choices applied. */
export function timingFor(base, settings) {
  return {
    ...base,
    listPauseMs: settings.pauseS * 1000,
    pausedFinishMs: settings.finishS * 1000,
    graceListenMs: (settings.graceS ?? DEFAULTS.graceS) * 1000,
  };
}

export function createSettings(storage) {
  let cached = null;
  return {
    get() {
      if (cached) return cached;
      try { cached = clean(JSON.parse(storage?.getItem(KEY) ?? 'null')); } catch { cached = { ...DEFAULTS }; }
      return cached;
    },
    set(patch) {
      cached = clean({ ...this.get(), ...patch });
      try { storage?.setItem(KEY, JSON.stringify(cached)); } catch { /* still applies for this session */ }
      return cached;
    },
  };
}
