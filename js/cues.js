// Non-speech cues so WISP's state is clear without looking (ADR-009). Each is under 300 ms and distinct:
//   listening — rising two notes        tick    — one soft high click (item saved)
//   later     — two quick low notes     problem — one low tone
//   stop      — falling two notes (mic closed)
// Vibration patterns mirror them. Which ones play depends on the settings (cuePlan is pure and tested).

export const CUES = {
  listening: { tones: [[660, 0, 0.09], [990, 0.08, 0.13]], vibrate: [40] },
  tick: { tones: [[1568, 0, 0.05]], vibrate: [15] },
  later: { tones: [[392, 0, 0.07], [392, 0.12, 0.07]], vibrate: [20, 60, 20] },
  problem: { tones: [[196, 0, 0.26]], vibrate: [220] },
  stop: { tones: [[880, 0, 0.08], [523, 0.07, 0.13]], vibrate: [30, 50, 30] },
};

/** What to play for a cue under the given settings: {tones, vibrate}. */
export function cuePlan(kind, settings) {
  const cue = CUES[kind];
  if (!cue) return { tones: [], vibrate: null };
  const sound = settings.sounds === 'full' || (settings.sounds === 'minimal' && kind === 'listening');
  return { tones: sound ? cue.tones : [], vibrate: settings.vibrate ? cue.vibrate : null };
}

/** Plays cues with WebAudio + navigator.vibrate. play() resolves when the tones have finished. */
export function createCuePlayer({ win = window, getSettings, log = () => {} }) {
  let ctx = null;
  return {
    play(kind) {
      const plan = cuePlan(kind, getSettings());
      if (plan.vibrate && win.navigator?.vibrate) {
        try { win.navigator.vibrate(plan.vibrate); } catch { /* not allowed */ }
      }
      if (!plan.tones.length) return Promise.resolve();
      try {
        ctx ??= new win.AudioContext();
        if (ctx.state !== 'running') ctx.resume().catch(() => {});
        if (ctx.state !== 'running') return Promise.resolve();
        const t = ctx.currentTime + 0.01;
        let end = 0;
        for (const [freq, at, dur] of plan.tones) {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0.0001, t + at);
          gain.gain.exponentialRampToValueAtTime(0.22, t + at + 0.012);
          gain.gain.exponentialRampToValueAtTime(0.0001, t + at + dur);
          osc.connect(gain).connect(ctx.destination);
          osc.start(t + at);
          osc.stop(t + at + dur + 0.02);
          end = Math.max(end, at + dur);
        }
        return new Promise((r) => setTimeout(r, Math.round(end * 1000) + 40));
      } catch (e) {
        log(`cue error: ${e.name}`);
        return Promise.resolve();
      }
    },
  };
}
