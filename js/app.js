// WISP Phase 0 spike: auto-listen on launch/resume, echo the transcript with TTS,
// and record exactly what worked so the PWA-vs-native gate decision is objective.
import { stripWakeWord } from './utterance.js';

const APP_VERSION = '0.0.1-spike.1';
const CHIME_TO_LISTEN_MS = 250;
const TTS_START_TIMEOUT_MS = 4000;

const $ = (id) => document.getElementById(id);
const ui = {
  mode: $('mode'), ver: $('ver'), mic: $('mic'), status: $('status'), transcript: $('transcript'),
  reply: $('reply'), fallback: $('fallback'), results: $('results'), history: $('history'),
  attemptLabel: $('attempt-label'), copy: $('copy'), clear: $('clear'), copyStatus: $('copy-status'),
  reportFallback: $('report-fallback'), log: $('log'),
};

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

let state = 'idle';          // idle | starting | listening | speaking
let current = null;          // the attempt in progress
let recognition = null;
let audioCtx = null;
let pendingFreshLoad = false;
let fallbackAction = null;
let micPermission = 'unknown';
const attempts = [];
const logLines = [];
const bootWallClock = new Date();

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ms = () => Math.round(performance.now());

function log(msg) {
  logLines.push(`${String(ms()).padStart(7)}ms  ${msg}`);
  ui.log.textContent = logLines.join('\n');
  ui.log.scrollTop = ui.log.scrollHeight;
}

function displayMode() {
  for (const m of ['standalone', 'fullscreen', 'minimal-ui', 'browser']) {
    if (matchMedia(`(display-mode: ${m})`).matches) return m;
  }
  return 'unknown';
}

function activation() {
  const ua = navigator.userActivation;
  return ua ? `isActive=${ua.isActive} hasBeenActive=${ua.hasBeenActive}` : 'n/a';
}

function navType() {
  return performance.getEntriesByType('navigation')[0]?.type ?? 'unknown';
}

const mark = (v) => (v === true ? '✅' : v === false ? '❌' : '⏳');

// ---------- UI ----------
function setUi(mode, status) {
  ui.mic.classList.toggle('listening', mode === 'listening');
  ui.mic.classList.toggle('speaking', mode === 'speaking');
  ui.mic.setAttribute('aria-label', mode === 'listening' ? 'Stop listening' : 'Start listening');
  ui.status.textContent = status ?? {
    starting: 'Starting…', listening: 'Listening…', speaking: 'Speaking…', idle: 'Idle — tap the mic to talk',
  }[mode];
}

function showFallback(what, action) {
  fallbackAction = action;
  ui.fallback.textContent = `Tap to continue (${what} was blocked)`;
  ui.fallback.hidden = false;
  log(`fallback shown: ${what} blocked without a tap`);
}

function hideFallback() {
  ui.fallback.hidden = true;
  fallbackAction = null;
}

function attemptSummary(a) {
  const parts = [
    `#${a.n} ${a.trigger}`,
    `display=${a.displayMode}`,
    `${a.auto ? 'auto-listen' : 'listen'} ${mark(a.listening)}${a.listenMs != null ? ` (${a.listenMs} ms)` : ''}`,
    `chime ${mark(a.chime)}${a.chimeState ? ` (${a.chimeState})` : ''}`,
    `TTS ${a.tts == null && !a.transcript ? '—' : mark(a.tts)}`,
  ];
  if (a.rescueListen != null) parts.push(`tap rescued listening ${mark(a.rescueListen)}`);
  if (a.rescueTts != null) parts.push(`tap rescued TTS ${mark(a.rescueTts)}`);
  if (a.transcript) parts.push(`heard "${a.transcript}" → "${a.stripped}"`);
  if (a.errors.length) parts.push(`errors: ${a.errors.join(', ')}`);
  return parts.join(' | ');
}

function render() {
  ui.mode.textContent = displayMode();
  const a = current;
  ui.attemptLabel.textContent = a ? `#${a.n}` : '';
  const rows = a ? [
    [a.auto ? 'Auto-listen' : 'Listening (tap)', `${mark(a.listening)}${a.listenMs != null ? ` ${a.listenMs} ms from ${a.auto ? 'launch' : 'tap'}` : ''}`],
    ['Chime played', `${mark(a.chime)}${a.chimeState ? ` AudioContext ${a.chimeState}` : ''}`],
    ['TTS spoke', a.tts == null && !a.transcript ? '— (needs a transcript)' : mark(a.tts)],
    ['Display mode', a.displayMode],
    ['Launch type', a.trigger],
    ['User activation', a.activation],
    ['Mic permission', micPermission],
  ] : [['Status', 'No attempt yet']];
  if (a?.rescueListen != null) rows.push(['Tap rescued listening', mark(a.rescueListen)]);
  if (a?.rescueTts != null) rows.push(['Tap rescued TTS', mark(a.rescueTts)]);
  if (a?.errors.length) rows.push(['Errors', a.errors.join(', ')]);

  ui.results.replaceChildren(...rows.flatMap(([k, v]) => {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    if (v.startsWith('✅')) dd.className = 'good';
    else if (v.startsWith('❌')) dd.className = 'bad';
    return [dt, dd];
  }));

  ui.history.replaceChildren(...attempts.slice(0, -1).map((x) => {
    const li = document.createElement('li');
    li.textContent = attemptSummary(x);
    return li;
  }));
}

// ---------- chime ----------
function playChime(a) {
  try {
    audioCtx ??= new AudioContext();
    if (audioCtx.state !== 'running') audioCtx.resume().catch(() => {});
  } catch (e) {
    a.chime = false;
    a.errors.push(`chime: ${e.name}`);
    log(`chime error: ${e.name} ${e.message}`);
    return Promise.resolve();
  }
  // resume() without user activation may stay pending forever, so check state shortly after.
  return sleep(60).then(() => {
    a.chimeState = audioCtx.state;
    a.chime = audioCtx.state === 'running';
    log(`chime: AudioContext ${audioCtx.state}`);
    if (!a.chime) return;
    const t = audioCtx.currentTime + 0.01;
    for (const [freq, at, dur] of [[880, 0, 0.12], [1320, 0.07, 0.14]]) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t + at);
      gain.gain.exponentialRampToValueAtTime(0.25, t + at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + at + dur);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t + at);
      osc.stop(t + at + dur + 0.02);
    }
  });
}

// ---------- attempts ----------
async function startAttempt(trigger, t0, rescueOf = null) {
  if (state !== 'idle') {
    log(`skip ${trigger}: state=${state}`);
    return;
  }
  if (document.visibilityState !== 'visible') {
    log(`skip ${trigger}: page hidden`);
    return;
  }
  state = 'starting';
  hideFallback();
  setUi('starting');
  ui.transcript.textContent = '';
  ui.reply.textContent = '';

  const a = {
    n: attempts.length + 1,
    trigger,
    auto: !trigger.startsWith('tap'),
    rescueOf,
    t0,
    displayMode: displayMode(),
    activation: activation(),
    listening: null, listenMs: null, chime: null, chimeState: null, tts: null,
    rescueListen: null, rescueTts: null,
    transcript: '', stripped: '', errors: [],
  };
  attempts.push(a);
  current = a;
  log(`attempt #${a.n} (${trigger}) display=${a.displayMode} activation: ${a.activation}`);
  render();

  const chimeStarted = performance.now();
  await playChime(a);
  await sleep(Math.max(0, CHIME_TO_LISTEN_MS - (performance.now() - chimeStarted)));
  if (state !== 'starting' || current !== a) return; // page hidden or superseded meanwhile
  startRecognition(a);
}

function listenFailed(a, why) {
  if (a.listening == null) a.listening = false;
  if (a.rescueOf) a.rescueOf.rescueListen = false;
  if (!a.errors.includes(why)) a.errors.push(why);
}

function startRecognition(a) {
  if (!SR) {
    listenFailed(a, 'SpeechRecognition unsupported');
    state = 'idle';
    setUi('idle', 'Speech recognition is not supported here');
    render();
    return;
  }
  const rec = new SR();
  rec.lang = 'en-US';
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;
  recognition = rec;
  let finalText = '';
  let blocked = false;

  rec.onstart = () => {
    if (recognition !== rec) return;
    state = 'listening';
    a.listening = true;
    a.listenMs = Math.round(performance.now() - a.t0);
    if (a.rescueOf) a.rescueOf.rescueListen = true;
    log(`recognition start (${a.listenMs} ms after ${a.auto ? 'launch' : 'tap'})`);
    setUi('listening');
    render();
  };
  for (const ev of ['audiostart', 'soundstart', 'speechstart', 'speechend', 'soundend', 'audioend']) {
    rec.addEventListener(ev, () => log(`recognition ${ev}`));
  }
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) {
        finalText += r[0].transcript;
        log(`final: "${r[0].transcript}" (confidence ${r[0].confidence.toFixed(2)})`);
      } else {
        interim += r[0].transcript;
      }
    }
    ui.transcript.textContent = finalText + interim;
  };
  rec.onnomatch = () => log('recognition nomatch');
  rec.onerror = (e) => {
    log(`recognition error: ${e.error}${e.message ? ` (${e.message})` : ''}`);
    a.errors.push(`recognition:${e.error}`);
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      blocked = true;
      listenFailed(a, `recognition:${e.error}`);
    }
  };
  rec.onend = () => {
    log('recognition end');
    if (recognition !== rec) return; // aborted by us (page hidden)
    recognition = null;
    if (a.listening == null) listenFailed(a, 'recognition ended before start');
    const heard = finalText.trim();
    if (heard) {
      a.transcript = heard;
      a.stripped = stripWakeWord(heard);
      render();
      respond(a);
      return;
    }
    state = 'idle';
    setUi('idle', a.listening ? "Didn't catch that — tap the mic" : undefined);
    if (blocked || !a.listening) {
      const target = a.rescueOf ?? a;
      if (a.auto) showFallback('listening', () => startAttempt('tap-fallback', performance.now(), target));
    }
    render();
  };

  try {
    rec.start();
    log('recognition.start() called');
  } catch (e) {
    recognition = null;
    log(`recognition.start() threw: ${e.name} ${e.message}`);
    listenFailed(a, `start threw ${e.name}`);
    state = 'idle';
    setUi('idle');
    if (a.auto) showFallback('listening', () => startAttempt('tap-fallback', performance.now(), a));
    render();
  }
}

// ---------- TTS ----------
function respond(a) {
  const text = a.stripped ? `You said: ${a.stripped}` : 'I only heard the wake word.';
  ui.reply.textContent = text;
  speak(a, text, false);
}

function speak(a, text, isRescue) {
  const record = (ok) => {
    if (isRescue) { if (a.rescueTts == null) a.rescueTts = ok; }
    else if (a.tts == null) a.tts = ok;
    render();
  };
  if (!('speechSynthesis' in window)) {
    a.errors.push('speechSynthesis unsupported');
    record(false);
    state = 'idle';
    setUi('idle');
    return;
  }
  state = 'speaking';
  setUi('speaking');
  if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();

  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US';
  let started = false;
  let finished = false;
  const fail = (why) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    a.errors.push(`tts:${why}`);
    record(false);
    state = 'idle';
    setUi('idle');
    if (!isRescue) showFallback('speech output', () => { state = 'speaking'; hideFallback(); speak(a, text, true); });
  };
  const timer = setTimeout(() => {
    if (!started) {
      log(`TTS: no onstart within ${TTS_START_TIMEOUT_MS} ms`);
      speechSynthesis.cancel();
      fail('no-start');
    }
  }, TTS_START_TIMEOUT_MS);

  u.onstart = () => {
    started = true;
    clearTimeout(timer);
    log(`TTS start${isRescue ? ' (after tap)' : ''}`);
    record(true);
  };
  u.onend = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    log('TTS end');
    if (!started) record(false);
    state = 'idle';
    setUi('idle');
  };
  u.onerror = (e) => {
    log(`TTS error: ${e.error}`);
    if (started && (e.error === 'interrupted' || e.error === 'canceled')) {
      finished = true;
      clearTimeout(timer);
      state = 'idle';
      setUi('idle');
      return;
    }
    fail(e.error);
  };
  speechSynthesis.speak(u);
  log(`TTS speak() called: "${text}"`);
}

// ---------- lifecycle ----------
function stopAll(reason) {
  if (recognition) {
    const rec = recognition;
    recognition = null;
    try { rec.abort(); } catch { /* already stopped */ }
  }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  if (state !== 'idle') {
    log(`stopped (${reason}) while ${state}`);
    if (current && current.listening == null) current.errors.push(`interrupted: ${reason}`);
  }
  state = 'idle';
  setUi('idle');
}

document.addEventListener('visibilitychange', () => {
  log(`visibility: ${document.visibilityState} activation: ${activation()}`);
  if (document.visibilityState === 'hidden') {
    stopAll('page hidden');
    return;
  }
  if (pendingFreshLoad) {
    pendingFreshLoad = false;
    startAttempt('fresh load (became visible)', 0);
  } else {
    startAttempt('resume', performance.now());
  }
});

window.addEventListener('pageshow', (e) => {
  if (e.persisted) {
    log('pageshow from back/forward cache');
    startAttempt('bfcache restore', performance.now());
  }
});

ui.mic.addEventListener('click', () => {
  if (state === 'listening' && recognition) {
    log('mic tapped: stop');
    recognition.stop();
    return;
  }
  if (state === 'speaking') stopAll('mic tapped');
  hideFallback();
  startAttempt('tap', performance.now());
});

ui.fallback.addEventListener('click', () => {
  const action = fallbackAction;
  hideFallback();
  log('fallback tapped');
  action?.();
});

// ---------- report ----------
function buildReport() {
  return [
    `WISP spike report — ${APP_VERSION}`,
    `Booted: ${bootWallClock.toString()}`,
    `URL: ${location.href}`,
    `Display mode: ${displayMode()} | navigation: ${navType()} | wasDiscarded: ${document.wasDiscarded ?? 'n/a'}`,
    `Mic permission: ${micPermission}`,
    `SpeechRecognition: ${SR ? 'yes' : 'no'} | speechSynthesis: ${'speechSynthesis' in window ? 'yes' : 'no'}`,
    `UA: ${navigator.userAgent}`,
    '',
    'Attempts:',
    ...(attempts.length ? attempts.map(attemptSummary) : ['(none)']),
    '',
    'Event log:',
    ...logLines,
  ].join('\n');
}

ui.copy.addEventListener('click', async () => {
  const report = buildReport();
  try {
    await navigator.clipboard.writeText(report);
    ui.copyStatus.textContent = 'Report copied. Paste it into Claude Code.';
    ui.reportFallback.hidden = true;
  } catch (e) {
    ui.reportFallback.hidden = false;
    ui.reportFallback.value = report;
    ui.reportFallback.select();
    const ok = document.execCommand?.('copy');
    ui.copyStatus.textContent = ok ? 'Report copied.' : 'Copy blocked — long-press the text below and copy it.';
  }
});

ui.clear.addEventListener('click', () => {
  attempts.length = 0;
  logLines.length = 0;
  current = null;
  ui.copyStatus.textContent = '';
  ui.reportFallback.hidden = true;
  log('cleared');
  render();
});

async function watchMicPermission() {
  try {
    const status = await navigator.permissions.query({ name: 'microphone' });
    micPermission = status.state;
    log(`mic permission: ${status.state}`);
    status.onchange = () => {
      micPermission = status.state;
      log(`mic permission changed: ${status.state}`);
      render();
    };
  } catch (e) {
    micPermission = `query failed (${e.name})`;
  }
  render();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    log('service worker: unsupported');
    return;
  }
  navigator.serviceWorker.register('./sw.js')
    .then((reg) => log(`service worker registered (scope ${new URL(reg.scope).pathname})`))
    .catch((e) => log(`service worker failed: ${e.message}`));
}

// ---------- boot ----------
ui.ver.textContent = APP_VERSION;
log(`boot ${APP_VERSION} url=${location.pathname}${location.search}`);
log(`display-mode=${displayMode()} navigation=${navType()} visibility=${document.visibilityState} activation: ${activation()}`);
watchMicPermission();
registerServiceWorker();
render();
if (document.visibilityState === 'visible') {
  startAttempt('fresh load', 0);
} else {
  pendingFreshLoad = true;
  log('loaded hidden; will listen when visible');
}
