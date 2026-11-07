// Per-phone preferences (localStorage). Cue style (ADR-010): voice (default — a spoken "Okay" per phrase), tones
// (speech-shaped glides), beeps (high/low), vibrate (buzzes only), silent (visual only). Spoken questions and the
// end-of-list read-back always speak. "Also vibrate" adds buzzes to voice, tones or beeps.
const KEY = 'wisp.settings';
export const CUE_STYLES = ['voice', 'tones', 'beeps', 'vibrate', 'silent'];
export const DEFAULTS = Object.freeze({ style: 'voice', vibrate: false });
const FROM_OLD_SOUNDS = { full: 'voice', minimal: 'beeps', off: 'silent' }; // 0.4.x settings

function clean(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  let style = CUE_STYLES.includes(s.style) ? s.style : null;
  if (!style && s.sounds in FROM_OLD_SOUNDS) style = s.sounds === 'off' && s.vibrate === true ? 'vibrate' : FROM_OLD_SOUNDS[s.sounds];
  return { style: style ?? DEFAULTS.style, vibrate: s.vibrate === true };
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
