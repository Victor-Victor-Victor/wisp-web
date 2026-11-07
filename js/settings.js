// Per-phone preferences (localStorage). Cue sounds: full (default) / minimal (only "listening") / off (visual
// only — spoken questions and wrap-ups still speak). Vibration: off by default.
const KEY = 'wisp.settings';
export const DEFAULTS = Object.freeze({ sounds: 'full', vibrate: false });
export const SOUND_LEVELS = ['full', 'minimal', 'off'];

function clean(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    sounds: SOUND_LEVELS.includes(s.sounds) ? s.sounds : DEFAULTS.sounds,
    vibrate: s.vibrate === true,
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
