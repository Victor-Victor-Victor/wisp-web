// Cues (ADR-010): what WISP signals between spoken sentences, named by meaning. The chosen style decides how each
// one sounds — a spoken word, a speech-shaped tone, a plain beep, a buzz, or nothing. Android plays its own beep
// whenever the mic opens (a web app can't silence it), so WISP adds no "listening" sound of its own.
//   heard    — got that phrase, go on            done   — list finished, read-back follows
//   needsYou — a question is coming              problem — something went wrong (see screen)
//   undo     — the last item was undone          paused — list paused: tap the mic to go on
//   listening — the mic just opened (buzz only, for the vibration style)
// cuePlan() is pure and tested; createCuePlayer() plays a plan with WebAudio, navigator.vibrate and speech.

// A tone is [startHz, endHz, atSeconds, durationSeconds]; a glide when startHz ≠ endHz. Every cue is < 0.3 s.
const GLIDES = {
  heard: [[440, 440, 0, 0.08], [494, 600, 0.11, 0.13]], // "mm-HM"
  done: [[784, 523, 0, 0.24]], // falling, like the end of a sentence
  needsYou: [[523, 784, 0, 0.22]], // rising, like a question
  problem: [[587, 587, 0, 0.1], [440, 440, 0.14, 0.14]], // "uh-oh"
  undo: [[784, 392, 0, 0.1], [784, 392, 0.14, 0.1]], // quick rewind
  paused: [[392, 392, 0, 0.1], [330, 330, 0.14, 0.13]], // soft, low
};
const HIGH = [[1046, 1046, 0, 0.08]];
const LOW = [[262, 262, 0, 0.16]];
const BEEPS = { heard: HIGH, done: HIGH, needsYou: LOW, problem: LOW, undo: LOW, paused: LOW };
const BUZZ = {
  listening: [30], heard: [40], done: [30, 60, 30], needsYou: [40, 80, 40], problem: [300], undo: [30, 50, 30, 50, 30], paused: [300],
};
const SAY = { heard: 'Okay.', undo: 'Undone.', paused: 'Paused. Tap the mic to go on.' };
// Recorded words (web/audio, made by scripts/make-voice-clips.mjs): they start at once, where Android's speech engine
// takes ~0.5 s to start. If a clip isn't loaded (or audio isn't allowed yet), the words are spoken instead.
const CLIP = { heard: 'okay', undo: 'undone' };
export const CLIP_FILES = { okay: 'audio/okay.wav', kay: 'audio/kay.wav', undone: 'audio/undone.wav' };

export const CUE_KINDS = ['heard', 'done', 'needsYou', 'problem', 'undo', 'paused'];

/**
 * What to play for a cue under the given settings: {say, tones, vibrate}.
 * quiet: the mic is open and hears any sound — even the vibration motor — and then restarts with an Android beep, so
 * nothing plays at all (the screen shows it).
 */
export function cuePlan(kind, settings, { quiet = false } = {}) {
  const style = settings?.style ?? 'voice';
  const plan = { say: null, clip: null, tones: [], vibrate: null };
  if (style === 'silent' || quiet) return plan;
  if (style === 'vibrate') return { ...plan, vibrate: BUZZ[kind] ?? null };
  if (style === 'voice') {
    const kay = kind === 'heard' && settings?.word === 'kay'; // ⚙ Voice word: the quicker one
    if (SAY[kind]) {
      plan.say = kay ? 'Kay.' : SAY[kind];
      plan.clip = kay ? 'kay' : (CLIP[kind] ?? null);
    }
    else if (kind === 'problem') plan.tones = GLIDES[kind]; // done/needsYou: the spoken words that follow say it
  } else if (style === 'tones') {
    plan.tones = GLIDES[kind] ?? [];
  } else if (style === 'beeps') {
    plan.tones = BEEPS[kind] ?? [];
  }
  if (settings?.vibrate && kind !== 'listening') plan.vibrate = BUZZ[kind] ?? null;
  return plan;
}

/** For the ⚙ cue guide: what each cue means, in the order a list goes. */
export const CUE_GUIDE = [
  { kind: 'heard', meaning: 'got that phrase; go on, or say “that’s it”' },
  { kind: 'paused', meaning: 'the list paused after a long silence; tap the mic to go on' },
  { kind: 'done', meaning: 'the list is finished; WISP reads it back' },
  { kind: 'needsYou', meaning: 'a question is coming' },
  { kind: 'problem', meaning: 'something went wrong; see the screen' },
  { kind: 'undo', meaning: 'the newest item was undone' },
];

/** Describe a cue in words for the guide ("says “Okay.”", "rising tone", "two short buzzes"…). */
export function describeCue(kind, settings) {
  const p = cuePlan(kind, settings);
  const parts = [];
  if (p.say) parts.push(`says “${p.say}”`);
  if (p.tones.length) parts.push(settings.style === 'beeps' ? (p.tones[0][0] > 600 ? 'high beep' : 'low beep') : 'tone');
  if (p.vibrate) parts.push(p.vibrate.length === 1 ? (p.vibrate[0] >= 200 ? 'long buzz' : 'short buzz') : `${Math.ceil(p.vibrate.length / 2)} short buzzes`);
  return parts.join(' + ') || (settings.style === 'voice' ? 'the next spoken words' : 'nothing (screen only)');
}

/**
 * Plays cues. play() resolves when the tones and any spoken word have finished (plus a short tail after speech),
 * so the mic never hears them.
 * @param speak  (text) => Promise — WISP's speech (voice.speak)
 * @param clips  {name: url} recorded words to preload (CLIP_FILES)
 */
export function createCuePlayer({ win = window, getSettings, log = () => {}, speak = () => Promise.resolve(), tailMs = 200, clips = {} }) {
  let ctx = null;
  const buffers = {};
  function audio() {
    ctx ??= new win.AudioContext();
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    return ctx;
  }
  // decode the clips once (decoding works even before the first tap allows sound)
  if (win.AudioContext && win.fetch) {
    for (const [name, url] of Object.entries(clips)) {
      win.fetch(url)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((data) => audio().decodeAudioData(data))
        .then((buf) => { buffers[name] = buf; })
        .catch((e) => log(`clip ${name} not loaded: ${e.message ?? e}`));
    }
  }
  /** Play a recorded word; false if it can't play right now (then it's spoken instead). */
  function clip(name) {
    const buf = buffers[name];
    if (!buf) return null;
    try {
      const c = audio();
      if (c.state !== 'running') return null;
      const src = c.createBufferSource();
      src.buffer = buf;
      src.connect(c.destination);
      src.start();
      return new Promise((r) => setTimeout(r, Math.round(buf.duration * 1000) + tailMs));
    } catch (e) {
      log(`clip error: ${e.name}`);
      return null;
    }
  }
  function tones(list) {
    if (!list.length) return Promise.resolve();
    try {
      audio();
      if (ctx.state !== 'running') return Promise.resolve();
      const t = ctx.currentTime + 0.01;
      let end = 0;
      for (const [f0, f1, at, dur] of list) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(f0, t + at);
        if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(f1, t + at + dur);
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
  }
  return {
    play(kind, { settings: override, quiet = false } = {}) {
      const plan = cuePlan(kind, override ?? getSettings(), { quiet });
      if (plan.vibrate && win.navigator?.vibrate) {
        try { win.navigator.vibrate(plan.vibrate); } catch { /* not allowed */ }
      }
      const fromClip = plan.clip ? clip(plan.clip) : null;
      const said = fromClip ?? (plan.say ? speak(plan.say).then(() => new Promise((r) => setTimeout(r, tailMs))) : Promise.resolve());
      return Promise.all([tones(plan.tones), said]).then(() => {});
    },
  };
}
