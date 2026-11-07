// WISP phone app: wires the dialog state machine (dialog.js) to the browser — speech, cues, backend, offline
// queue and the screen. All conversation rules live in dialog.js; this file only carries out its effects.
import { APP_VERSION, BACKEND_URL, TIMING } from './config.js';
import { step, initialState } from './dialog.js';
import { createVoice } from './voice.js';
import { createCuePlayer } from './cues.js';
import { createSettings } from './settings.js';
import { createBackend } from './backend.js';
import { createQueue, indexedDbStore, describeDrained } from './queue.js';
import { consumeSetupHash, createTokenStore, isPlausibleToken } from './setup.js';

const $ = (id) => document.getElementById(id);
const ui = {
  ver: $('ver'), mic: $('mic'), status: $('status'), banner: $('banner'), transcript: $('transcript'), reply: $('reply'),
  undo: $('undo'), items: $('items'), results: $('results'), notices: $('notices'), attention: $('attention'),
  attentionList: $('attention-list'), setup: $('setup'), setupMsg: $('setup-msg'), tokenInput: $('token-input'),
  tokenSave: $('token-save'), gear: $('gear'), settings: $('settings'), vibrate: $('set-vibrate'),
  log: $('log'), copy: $('copy'), copyStatus: $('copy-status'),
};

// ---------- diagnostics log (never contains the token) ----------
const logLines = [];
function log(msg) {
  logLines.push(`${String(Math.round(performance.now())).padStart(7)}ms  ${msg}`);
  if (logLines.length > 400) logLines.shift();
  ui.log.textContent = logLines.join('\n');
}

// ---------- services ----------
const tokenStore = createTokenStore(window.localStorage);
const setupResult = consumeSetupHash(window.location, window.history, tokenStore);
const settings = createSettings(window.localStorage);
const backend = createBackend({
  url: BACKEND_URL, getToken: tokenStore.get, fetchFn: (...a) => fetch(...a), timeoutMs: TIMING.requestTimeoutMs,
});
const queue = createQueue(indexedDbStore(window.indexedDB));
const voice = createVoice({ log, onInterim: (t) => { ui.transcript.textContent = t; } });
const cues = createCuePlayer({ getSettings: settings.get, log });
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`);

// ---------- dialog loop ----------
let state = initialState();
let reloadWhenIdle = false;
let cueDone = Promise.resolve();

function dispatch(ev) {
  const out = step(state, ev);
  if (out.state.mode !== state.mode) log(`${ev.type}: ${state.mode} → ${out.state.mode}`);
  state = out.state;
  render();
  for (const fx of out.effects) run(fx);
}

function send(req) {
  if (req.kind === 'list') return backend.list(req.transcript, req.location, req.requestId);
  if (req.kind === 'answer') return backend.answer(req.transcript, req.pending, req.clarify, req.requestId);
  if (req.kind === 'undo') return backend.undo(req.requestId);
  return backend.command(req.transcript, req.requestId);
}

async function run(fx) {
  switch (fx.type) {
    case 'cue':
      log(`cue ${fx.kind}`);
      cueDone = cues.play(fx.kind);
      break;
    case 'listen': {
      await cueDone; // never let the mic hear our own cue
      ui.transcript.textContent = '';
      const t0 = performance.now();
      const r = await voice.listen({ timeoutMs: fx.timeoutMs });
      if (r.type === 'heard') {
        log(`heard (${r.text.length} chars)`);
        dispatch({ type: 'heard', id: fx.id, text: r.text, requestId: newId() });
      } else {
        if (r.type === 'error') onListenError(r.error);
        dispatch({ type: 'silence', id: fx.id, elapsedMs: Math.round(performance.now() - t0) });
      }
      break;
    }
    case 'stopListening': voice.stop(); break;
    case 'abortListening': voice.abort(); break;
    case 'speak':
      ui.reply.textContent = fx.text;
      await voice.speak(fx.text);
      dispatch({ type: 'spoken', id: fx.id });
      break;
    case 'cancelSpeech': voice.cancelSpeech(); break;
    case 'send': {
      const req = fx.request;
      const t0 = performance.now();
      const result = await send(req);
      log(`${req.kind} → ${result.kind}${result.data?.status ? `/${result.data.status}` : ''} in ${Math.round(performance.now() - t0)} ms`);
      if (result.kind === 'network' && req.kind === 'list') {
        await queue.enqueue({ transcript: req.transcript, requestId: req.requestId, location: req.location });
        log('queued for retry');
      }
      dispatch({ type: 'response', requestId: req.requestId, result });
      break;
    }
    case 'showItem': showItem(fx.status, fx.text); break;
    case 'clearItems':
      ui.items.replaceChildren();
      ui.results.replaceChildren();
      ui.results.hidden = true;
      ui.reply.textContent = '';
      break;
    case 'showUndo': showUndo(); break;
    case 'undoCountdown': startUndoCountdown(); break;
    case 'hideUndo': hideUndo(); break;
    case 'showData': renderResults(fx.data); break;
    case 'showSetup': showSetup(); break;
    case 'attention':
      saveAttention([...fx.items.map((h) => ({ transcript: h.pending?.transcript ?? '', text: `WISP needs to ask: ${h.question}` })), ...loadAttention()]);
      break;
    default: break;
  }
}

function onListenError(error) {
  if (error === 'not-allowed' || error === 'service-not-allowed') {
    notice('Microphone is blocked. Tap the mic to talk, or allow the microphone for WISP in Settings.');
  } else if (error === 'unsupported') {
    notice('Speech recognition is not available in this browser.');
  }
}

// ---------- screen ----------
function statusText() {
  const sess = state.session;
  if (state.mode === 'listening') {
    if (state.listenKind === 'answer') return 'Listening for your answer…';
    if (sess?.followup) return 'Anything else?';
    if (sess?.continuing) return 'Go on… (say "that\'s it" when done)';
    return 'Listening…';
  }
  if (state.mode === 'working') return 'Working…';
  if (state.mode === 'speaking') return '';
  return 'Tap the mic to talk';
}

function render() {
  ui.status.textContent = statusText();
  const busy = Boolean(state.session?.inFlight || state.session?.queue?.length || state.mode === 'working');
  ui.mic.className = `mic ${state.mode}${busy ? ' busy' : ''}`;
  ui.mic.setAttribute('aria-label', state.mode === 'listening' ? 'Done talking' : 'Talk to WISP');
  const sess = state.session;
  const saved = sess?.applied?.filter((a) => a.kind === 'saved').length ?? 0;
  const toCheck = sess?.held?.length ?? 0;
  if (sess && (sess.chunks > 1 || sess.continuing) && !sess.followup) {
    ui.banner.hidden = false;
    ui.banner.textContent = `Listing${sess.location?.name ? `: ${sess.location.name}` : ''} · ${saved} saved${toCheck ? ` · ${toCheck} to check` : ''}`;
  } else {
    ui.banner.hidden = true;
  }
  if (state.mode === 'idle' && reloadWhenIdle) window.location.reload();
}

const ICONS = { saved: '✓', held: '?', error: '!', undo: '↶', queued: '⏳' };
function showItem(status, text) {
  if (status === 'pending') return; // the live transcript line already shows what was heard
  const li = document.createElement('li');
  li.className = `item ${status === 'undo' ? 'undone' : status}`;
  const icon = document.createElement('span');
  icon.className = 'icon';
  icon.textContent = ICONS[status] ?? '•';
  const body = document.createElement('span');
  body.textContent = text;
  li.append(icon, body);
  ui.items.append(li);
  li.scrollIntoView({ block: 'nearest' });
}

// Undo stays visible while a list is going, and for 10 s after the wrap-up (ADR-009).
let undoTimer = null;
function showUndo() {
  clearTimeout(undoTimer);
  ui.undo.hidden = false;
}
function startUndoCountdown() {
  clearTimeout(undoTimer);
  const txn = state.undoTxn;
  undoTimer = setTimeout(() => dispatch({ type: 'undoExpired', txn }), TIMING.undoVisibleMs);
}
function hideUndo() {
  clearTimeout(undoTimer);
  ui.undo.hidden = true;
}

function renderResults(data) {
  const blocks = Array.isArray(data) ? data : [data];
  ui.results.replaceChildren();
  for (const block of blocks) {
    for (const r of block?.rows ?? []) {
      const li = document.createElement('li');
      const what = document.createElement('span');
      what.textContent = `${r.qty} ${r.unit === 'each' ? '' : r.unit} ${r.item}`.replace(/\s+/g, ' ');
      const where = document.createElement('span');
      where.className = 'where';
      where.textContent = r.location;
      li.append(what, where);
      ui.results.append(li);
    }
  }
  ui.results.hidden = !ui.results.children.length;
}

function notice(text) {
  const p = document.createElement('p');
  p.textContent = text;
  ui.notices.prepend(p);
  while (ui.notices.children.length > 5) ui.notices.lastChild.remove();
}

// ---------- needs attention ----------
const ATTENTION_KEY = 'wisp.attention';
function loadAttention() {
  try { return JSON.parse(localStorage.getItem(ATTENTION_KEY) || '[]'); } catch { return []; }
}
function saveAttention(list) {
  try { localStorage.setItem(ATTENTION_KEY, JSON.stringify(list.slice(0, 30))); } catch { /* ignore */ }
  renderAttention(list);
}
function renderAttention(list = loadAttention()) {
  ui.attention.hidden = list.length === 0;
  ui.attentionList.replaceChildren(...list.map((a, i) => {
    const li = document.createElement('li');
    if (a.transcript) {
      const said = document.createElement('q');
      said.textContent = a.transcript;
      li.append(said);
    }
    const why = document.createElement('span');
    why.textContent = a.text;
    const dismiss = document.createElement('button');
    dismiss.className = 'btn small';
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', () => saveAttention(loadAttention().filter((_, j) => j !== i)));
    li.append(why, dismiss);
    return li;
  }));
}

async function drainQueue() {
  if (!tokenStore.get()) return;
  const done = await queue.drain((item) => backend.list(item.transcript, item.location, item.id));
  if (!done.length) return;
  log(`retried ${done.length} queued chunk(s)`);
  const attention = loadAttention();
  for (const d of done) {
    for (const desc of describeDrained(d)) {
      if (desc.kind === 'saved') notice(desc.text);
      else attention.unshift({ transcript: desc.transcript, text: desc.text });
    }
  }
  saveAttention(attention);
}

// ---------- setup ----------
function showSetup(message) {
  ui.setup.hidden = false;
  if (message) ui.setupMsg.textContent = message;
}

async function confirmSetup() {
  const res = await backend.check();
  if (res.kind === 'ok') {
    ui.setup.hidden = true;
    notice('This phone is set up. Say a command any time.');
    voice.speak('WISP is set up.');
    return true;
  }
  if (res.kind === 'unauthorized') {
    tokenStore.clear();
    showSetup("That setup code didn't work. Scan it again, or paste the token below.");
  } else {
    showSetup("Couldn't reach the inventory to check the setup. Check the connection and try again.");
  }
  return false;
}

ui.tokenSave.addEventListener('click', async () => {
  const t = ui.tokenInput.value.trim();
  ui.tokenInput.value = '';
  if (!isPlausibleToken(t)) {
    showSetup("That doesn't look like a WISP token.");
    return;
  }
  tokenStore.set(t);
  await confirmSetup();
});

// ---------- settings panel ----------
function renderSettings() {
  const s = settings.get();
  for (const input of document.querySelectorAll('input[name="sounds"]')) input.checked = input.value === s.sounds;
  ui.vibrate.checked = s.vibrate;
}
ui.gear.addEventListener('click', () => {
  ui.settings.hidden = !ui.settings.hidden;
  renderSettings();
});
for (const input of document.querySelectorAll('input[name="sounds"]')) {
  input.addEventListener('change', () => {
    settings.set({ sounds: input.value });
    cues.play('listening'); // preview
  });
}
ui.vibrate.addEventListener('change', () => {
  settings.set({ vibrate: ui.vibrate.checked });
  cues.play('tick');
});

// ---------- events ----------
ui.mic.addEventListener('click', () => {
  if (!tokenStore.get()) {
    showSetup();
    return;
  }
  dispatch({ type: 'start' });
});
ui.undo.addEventListener('click', () => dispatch({ type: 'undo', requestId: newId() }));

function wake(reason) {
  log(`wake: ${reason}`);
  drainQueue();
  if (tokenStore.get()) dispatch({ type: 'start' });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') dispatch({ type: 'cancel' });
  else wake('resume');
});
window.addEventListener('online', () => drainQueue());

ui.copy.addEventListener('click', async () => {
  const s = settings.get();
  const report = [
    `WISP ${APP_VERSION} — ${new Date().toString()}`,
    `display: ${matchMedia('(display-mode: standalone)').matches ? 'standalone' : 'browser'} | set up: ${tokenStore.get() ? 'yes' : 'no'} | queued: ${await queue.size()} | sounds: ${s.sounds} | vibrate: ${s.vibrate}`,
    `UA: ${navigator.userAgent}`, '', ...logLines,
  ].join('\n');
  try {
    await navigator.clipboard.writeText(report);
    ui.copyStatus.textContent = 'Report copied.';
  } catch {
    ui.copyStatus.textContent = 'Copy blocked — long-press the log to copy it.';
  }
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((e) => log(`service worker failed: ${e.message}`));
  let hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) { hadController = true; return; } // first install, not an update
    log('new version installed');
    reloadWhenIdle = true;
    render();
  });
}

// ---------- boot ----------
ui.ver.textContent = APP_VERSION;
renderAttention();
renderSettings();
log(`boot ${APP_VERSION}`);
if (setupResult === 'stored') {
  confirmSetup();
} else if (setupResult === 'invalid') {
  showSetup("That setup link wasn't valid. Scan the code again.");
} else if (!tokenStore.get()) {
  showSetup();
} else if (document.visibilityState === 'visible') {
  wake('launch');
}
render();
