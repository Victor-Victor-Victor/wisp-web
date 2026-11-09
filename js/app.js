// WISP phone app: wires the dialog state machine (dialog.js) to the browser — speech, cues, backend, offline
// queue and the screen. All conversation rules live in dialog.js; this file only carries out its effects.
import { APP_VERSION, BACKEND_URL, TIMING } from './config.js';
import { step, initialState } from './dialog.js';
import { createVoice } from './voice.js';
import { createNativeVoice } from './voice-native.js';
import { createMicLab } from './miclab.js';
import { createCuePlayer, CUE_GUIDE, describeCue, CLIP_FILES } from './cues.js';
import { createSettings, timingFor } from './settings.js';
import { createBackend, FRESH } from './backend.js';
import { createLocalBackend, idbStore } from './local.js';
import { createQueue, indexedDbStore, describeDrained } from './queue.js';
import { consumeSetupHash, createTokenStore, isPlausibleToken } from './setup.js';
import {
  routeOf, tabOf, search, createViewStore, relativeTime, placeContents, itemDetail, changeAction, editAction, unitChoices,
  categoriesOf, predictView, applyTapDeltas, countAt,
} from './browse.js';
import { renderPlaces, renderPlace, renderItem, renderSearchResults, renderRecent, openForm } from './screens.js';

const $ = (id) => document.getElementById(id);
const ui = {
  ver: $('ver'), mic: $('mic'), status: $('status'), banner: $('banner'), transcript: $('transcript'), reply: $('reply'),
  undo: $('undo'), items: $('items'), results: $('results'), notices: $('notices'), attention: $('attention'),
  attentionList: $('attention-list'), setup: $('setup'), setupMsg: $('setup-msg'), tokenInput: $('token-input'),
  tokenSave: $('token-save'), gear: $('gear'), settings: $('settings'), vibrate: $('set-vibrate'),
  log: $('log'), copy: $('copy'), copyStatus: $('copy-status'),
  talk: $('talk'), browse: $('browse'), browseTitle: $('browse-title'), browseStatus: $('browse-status'),
  browseBody: $('browse-body'), searchBox: $('search-box'), refresh: $('refresh'), fab: $('fab-mic'), toast: $('toast'),
  tabs: [...document.querySelectorAll('.tabs a')],
  phoneData: $('phone-data'), phoneDataStatus: $('phone-data-status'), backupSave: $('backup-save'),
  backupRestore: $('backup-restore'), backupFile: $('backup-file'), phoneErase: $('phone-erase'),
  guide: $('guide'), vibrateRow: $('vibrate-row'), pauseS: $('set-pause'), finishS: $('set-finish'), graceS: $('set-grace'), word: $('set-word'), wordRow: $('word-row'),
};

// ---------- diagnostics log (never contains the token) ----------
// The last session's lines are kept, so closing and reopening WISP doesn't lose the report (0.7.1).
const LOG_KEY = 'wisp.log';
const logLines = (() => {
  try {
    const before = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
    return before.length ? [...before.slice(-200), `----- reopened ${new Date().toLocaleString()} -----`] : [];
  } catch {
    return [];
  }
})();
let logSave = null;
function log(msg) {
  logLines.push(`${String(Math.round(performance.now())).padStart(7)}ms  ${msg}`);
  if (logLines.length > 400) logLines.shift();
  ui.log.textContent = logLines.join('\n');
  clearTimeout(logSave);
  logSave = setTimeout(() => {
    try { localStorage.setItem(LOG_KEY, JSON.stringify(logLines.slice(-300))); } catch { /* ignore */ }
  }, 400);
}

// ---------- services ----------
const tokenStore = createTokenStore(window.localStorage);
const setupResult = consumeSetupHash(window.location, window.history, tokenStore);
const settings = createSettings(window.localStorage);
// Inside the Android app (Capacitor, ADR-015): native speech, no service worker, data on the phone by default.
const CAP = window.Capacitor;
const NATIVE = Boolean(CAP?.isNativePlatform?.());
if (NATIVE) {
  try {
    const saved = JSON.parse(localStorage.getItem('wisp.settings') || '{}');
    if (!('data' in saved)) settings.set({ data: 'phone' });
  } catch { settings.set({ data: 'phone' }); }
}
const sheetBackend = createBackend({
  url: BACKEND_URL, getToken: tokenStore.get, fetchFn: (...a) => fetch(...a), timeoutMs: TIMING.requestTimeoutMs,
});
const phoneBackend = createLocalBackend({ store: idbStore(window.indexedDB) });
/** ⚙ Data (ADR-014): the inventory lives in the Google Sheet or only on this phone. */
const onPhone = () => settings.get().data === 'phone';
const active = () => (onPhone() ? phoneBackend : sheetBackend);
const backend = Object.fromEntries(['command', 'list', 'answer', 'undo', 'actions', 'view', 'check']
  .map((m) => [m, (...args) => active()[m](...args)]));
/** Ready to talk: on the phone always; the Sheet needs the setup token. */
const ready = () => onPhone() || Boolean(tokenStore.get());
const queue = createQueue(indexedDbStore(window.indexedDB));
const onInterim = (t) => { ui.transcript.textContent = t; };
const nativePlugin = (name) => CAP?.Plugins?.[name] ?? CAP?.registerPlugin?.(name);
const voice = NATIVE
  ? createNativeVoice({
    // no bundler: the native bridge exposes each plugin as Capacitor.Plugins.<name>
    plugins: { SpeechRecognition: nativePlugin('SpeechRecognition'), TextToSpeech: nativePlugin('TextToSpeech') },
    log, onInterim,
  })
  : createVoice({ log, onInterim });
const cues = createCuePlayer({ getSettings: settings.get, log, speak: (t) => voice.speak(t), tailMs: TIMING.echoTailMs, clips: CLIP_FILES });
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`);

// ---------- dialog loop ----------
let state = initialState();
let reloadWhenIdle = false;
let cueDone = Promise.resolve();

function dispatch(ev) {
  const out = step(state, ev, timingFor(TIMING, settings.get()));
  if (out.state.mode !== state.mode) log(`${ev.type}: ${state.mode} → ${out.state.mode}`);
  state = out.state;
  render();
  for (const fx of out.effects) run(fx);
}

function send(req) {
  if (req.kind === 'list') return backend.list(req.transcript, req.location, req.requestId);
  if (req.kind === 'answer') return backend.answer(req.transcript, req.pending, req.clarify, req.requestId);
  if (req.kind === 'undo') return backend.undo(req.requestId, req.txnIds);
  return backend.command(req.transcript, req.requestId);
}

async function run(fx) {
  switch (fx.type) {
    case 'cue':
      log(`cue ${fx.kind}${fx.quiet ? ' (quiet)' : ''}`);
      // every cue still playing counts: an "Okay" followed by an (empty) listening cue must still hold the mic back
      cueDone = Promise.all([cueDone, cues.play(fx.kind, { quiet: fx.quiet })]);
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
        if (r.speech) log('speech but no words');
        dispatch({ type: 'silence', id: fx.id, elapsedMs: Math.round(performance.now() - t0), speech: Boolean(r.speech) });
      }
      break;
    }
    case 'stopListening': voice.stop(); break;
    case 'abortListening': voice.abort(); break;
    case 'speak':
      await cueDone; // let an "Okay" or a tone finish first
      ui.reply.textContent = fx.text;
      await voice.speak(fx.text);
      dispatch({ type: 'spoken', id: fx.id });
      break;
    case 'cancelSpeech': voice.cancelSpeech(); break;
    case 'send': {
      const req = fx.request;
      const t0 = performance.now();
      const result = await send(req);
      log(`${req.kind} → ${result.kind}${result.data?.status ? `/${result.data.status}` : ''} in ${Math.round(performance.now() - t0)} ms${serverTiming(result)}`);
      if (result.kind === 'network' && req.kind === 'list') {
        await queue.enqueue({ transcript: req.transcript, requestId: req.requestId, location: req.location });
        log('queued for retry');
      }
      if (result.kind === 'ok') viewStale = true; // the browse screens refetch next time
      dispatch({ type: 'response', requestId: req.requestId, result });
      break;
    }
    case 'showItem': showItem(fx.status, fx.text, fx.txn); break;
    case 'clearItems':
      ui.items.replaceChildren();
      ui.results.replaceChildren();
      ui.results.hidden = true;
      ui.reply.textContent = '';
      break;
    case 'undoCountdown': startUndoCountdown(fx.epoch); break;
    case 'pauseTimer': setTimeout(() => dispatch({ type: 'pauseExpired', id: fx.id }), fx.ms); break;
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
    if (state.listenKind === 'grace') return 'Anything else? (or say "that\'s it")';
    if (sess?.continuing) return 'Go on… (say "that\'s it" when done)';
    return 'Listening…';
  }
  if (state.mode === 'paused') return 'List paused — tap the mic to go on';
  if (state.mode === 'working') return 'Working…';
  if (state.mode === 'speaking') return '';
  return 'Tap the mic to talk';
}

function render() {
  ui.status.textContent = statusText();
  const busy = Boolean(state.session?.inFlight || state.session?.queue?.length || state.mode === 'working');
  ui.mic.className = `mic ${state.mode}${busy ? ' busy' : ''}`;
  ui.mic.setAttribute('aria-label', state.mode === 'listening' ? 'Done talking' : 'Talk to WISP');
  ui.fab.className = `fab ${state.mode}`;
  const sess = state.session;
  const saved = sess?.applied?.filter((a) => a.kind === 'saved').length ?? 0;
  const toCheck = sess?.held?.length ?? 0;
  if (sess && (sess.chunks > 1 || sess.continuing || state.mode === 'paused')) {
    ui.banner.hidden = false;
    ui.banner.textContent = `Listing${sess.location?.name ? `: ${sess.location.name}` : ''} · ${saved} saved${toCheck ? ` · ${toCheck} to check` : ''}`;
  } else {
    ui.banner.hidden = true;
  }
  renderUndo();
  if (state.mode === 'idle' && reloadWhenIdle) {
    try { sessionStorage.setItem('wisp.updated', '1'); } catch { /* still reloads */ }
    window.location.reload(); // a new version: the reload must not open the mic by itself (0.6.3)
  }
}

// Undo (ADR-010): one tap = the newest item of *this* list, by txn_id. Busy while it's on its way.
function renderUndo() {
  const u = state.undo;
  const busy = Boolean(u.waiting || u.inFlight);
  const top = u.stack[u.stack.length - 1];
  ui.undo.hidden = !busy && !top;
  ui.undo.disabled = busy;
  ui.undo.textContent = busy ? 'Undoing…' : top ? `Undo: ${top.label}` : 'Undo';
}

const ICONS = { saved: '✓', held: '?', error: '!', undo: '↶', queued: '⏳' };
function showItem(status, text, txn) {
  if (status === 'pending') return; // the live transcript line already shows what was heard
  if (status === 'undo' && txn) {
    const row = ui.items.querySelector(`li[data-txn="${CSS.escape(txn)}"]`);
    if (row) { // strike through the saved row instead of adding another line
      row.className = 'item undone';
      row.querySelector('.icon').textContent = ICONS.undo;
      return;
    }
  }
  const li = document.createElement('li');
  if (txn && status === 'saved') li.dataset.txn = txn;
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

// Undo stays visible while a list is going, and for 10 s after the read-back (ADR-009/010).
let undoTimer = null;
function startUndoCountdown(epoch) {
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => dispatch({ type: 'undoExpired', epoch }), TIMING.undoVisibleMs);
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
      const a = document.createElement('a'); // each answer row opens the item (ADR-011)
      a.href = `#item/${encodeURIComponent(r.item_id)}`;
      a.append(what, where);
      li.append(a);
      ui.results.append(li);
    }
    if (block?.scope === 'location' && block.rows?.[0]?.location_id) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.className = 'open-link';
      a.href = `#place/${encodeURIComponent(block.rows[0].location_id)}`;
      a.textContent = `Open ${block.rows[0].location} →`;
      li.append(a);
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
  if (!tokenStore.get() || onPhone()) return; // the queue is for the Sheet only
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
  for (const input of document.querySelectorAll('input[name="style"]')) input.checked = input.value === s.style;
  ui.vibrate.checked = s.vibrate;
  ui.vibrateRow.hidden = s.style === 'vibrate' || s.style === 'silent';
  ui.word.value = s.word;
  ui.wordRow.hidden = s.style !== 'voice';
  ui.graceS.value = String(s.graceS);
  ui.pauseS.value = String(s.pauseS);
  ui.finishS.value = String(s.finishS);
  ui.guide.replaceChildren(...CUE_GUIDE.map((g) => {
    const li = document.createElement('li');
    const play = document.createElement('button');
    play.className = 'btn small';
    play.textContent = '▶';
    play.setAttribute('aria-label', `Play: ${g.meaning}`);
    play.addEventListener('click', () => cues.play(g.kind));
    const text = document.createElement('span');
    const how = document.createElement('strong');
    how.textContent = describeCue(g.kind, s);
    text.append(how, document.createTextNode(` means ${g.meaning}.`));
    li.append(play, text);
    return li;
  }));
}
ui.gear.addEventListener('click', () => {
  ui.settings.hidden = !ui.settings.hidden;
  renderSettings();
  renderData();
});
for (const input of document.querySelectorAll('input[name="style"]')) {
  input.addEventListener('change', () => {
    settings.set({ style: input.value });
    renderSettings();
    cues.play('heard'); // preview
  });
}
for (const [el, key] of [[ui.pauseS, 'pauseS'], [ui.finishS, 'finishS'], [ui.graceS, 'graceS']]) {
  el.addEventListener('change', () => { settings.set({ [key]: Number(el.value) }); renderSettings(); });
}
// ---------- ⚙ Data (ADR-014) ----------
const BACKUP_KEY = 'wisp.lastBackup';
async function renderData() {
  const phone = onPhone();
  for (const input of document.querySelectorAll('input[name="data"]')) input.checked = input.value === settings.get().data;
  ui.phoneData.hidden = !phone;
  if (!phone) return;
  const c = await phoneBackend.counts();
  let last = null;
  try { last = localStorage.getItem(BACKUP_KEY); } catch { /* ignore */ }
  const days = last ? (Date.now() - new Date(last).getTime()) / 86400000 : Infinity;
  ui.phoneDataStatus.textContent = `${c.items} item${c.items === 1 ? '' : 's'} in ${c.places} place${c.places === 1 ? '' : 's'} on this phone. `
    + (last ? `Last backup file: ${relativeTime(last)}.` : 'No backup file saved yet.')
    + (c.changes && days > 7 ? ' Save one now — it only lives on this phone.' : '');
}
for (const input of document.querySelectorAll('input[name="data"]')) {
  input.addEventListener('change', async () => {
    settings.set({ data: input.value });
    viewEntry = null; // the two inventories are different
    try { localStorage.removeItem('wisp.view'); } catch { /* ignore */ }
    viewStale = true;
    log(`data → ${input.value}`);
    ui.setup.hidden = true;
    if (!ready()) showSetup();
    notice(input.value === 'phone' ? 'WISP now keeps the inventory on this phone. The Google Sheet is left as it was.' : 'WISP now uses the Google Sheet again. The phone\'s inventory is kept for when you switch back.');
    await renderData();
    renderBrowse(); // show the other inventory right away (0.7.1)
    await refreshView({ force: true });
  });
}
ui.backupSave.addEventListener('click', async () => {
  const text = await phoneBackend.exportData();
  const name = `wisp-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([text], name, { type: 'application/json' });
  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  };
  let saved = true;
  try {
    if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: name }); // Drive, email…
    else download();
  } catch (e) {
    if (e?.name === 'AbortError') saved = false; // the person closed the share sheet
    else download(); // sharing refused: save it to Downloads instead
  }
  if (saved) {
    try { localStorage.setItem(BACKUP_KEY, new Date().toISOString()); } catch { /* ignore */ }
    notice(`Backup saved: ${name}.`);
  }
  renderData();
});
ui.backupRestore.addEventListener('click', () => ui.backupFile.click());
ui.backupFile.addEventListener('change', async () => {
  const f = ui.backupFile.files?.[0];
  ui.backupFile.value = '';
  if (!f) return;
  if (!window.confirm(`Restore "${f.name}"? This replaces everything on this phone.`)) return;
  try {
    const r = await phoneBackend.importData(await f.text());
    notice(`Restored ${r.items} item${r.items === 1 ? '' : 's'} in ${r.places} place${r.places === 1 ? '' : 's'}.`);
    viewStale = true;
  } catch (e) {
    notice(e.message);
  }
  renderData();
});
ui.phoneErase.addEventListener('click', async () => {
  const typed = window.prompt('This deletes the whole inventory on this phone (the Google Sheet is not touched). Type ERASE to confirm.');
  if (String(typed ?? '').trim() !== 'ERASE') {
    notice('Nothing was erased.');
    return;
  }
  await phoneBackend.erase();
  viewStale = true;
  notice('Everything on this phone was erased.');
  renderData();
});

ui.word.addEventListener('change', () => {
  settings.set({ word: ui.word.value });
  renderSettings();
  cues.play('heard'); // preview
});
ui.vibrate.addEventListener('change', () => {
  settings.set({ vibrate: ui.vibrate.checked });
  renderSettings();
  cues.play('heard');
});

// ---------- events ----------
ui.mic.addEventListener('click', () => {
  if (!ready()) {
    showSetup();
    return;
  }
  dispatch({ type: 'start' });
});
ui.undo.addEventListener('click', () => dispatch({ type: 'undo', requestId: newId() }));

function wake(reason) {
  log(`wake: ${reason}`);
  drainQueue();
  if (ready() && route.screen === 'talk') dispatch({ type: 'start' }); // browsing: don't open the mic
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
    `app: ${NATIVE ? 'android' : 'web'} | speech: ${NATIVE ? 'native' : 'web'} | display: ${matchMedia('(display-mode: standalone)').matches ? 'standalone' : 'browser'} | data: ${s.data} | set up: ${tokenStore.get() ? 'yes' : 'no'} | queued: ${await queue.size()} | cues: ${s.style}${s.style === 'voice' ? ` (${s.word})` : ''}${s.vibrate ? ' + vibrate' : ''} | wait ${s.graceS} s, pause ${s.pauseS} s, finish ${s.finishS} s`,
    `UA: ${navigator.userAgent}`, '', ...logLines,
  ].join('\n');
  try {
    await navigator.clipboard.writeText(report);
    ui.copyStatus.textContent = 'Report copied.';
  } catch {
    ui.copyStatus.textContent = 'Copy blocked — long-press the log to copy it.';
  }
});

if ('serviceWorker' in navigator && !NATIVE) { // the app's files are already on the phone
  navigator.serviceWorker.register('./sw.js').catch((e) => log(`service worker failed: ${e.message}`));
  let hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) { hadController = true; return; } // first install, not an update
    log('new version installed');
    reloadWhenIdle = true;
    render();
  });
}

// ---------- browse screens (ADR-011) ----------
const viewStore = createViewStore(window.localStorage);
let viewEntry = viewStore.load();
let viewProblem = ''; // '' | 'offline' | 'error'
let viewStale = true;
let refreshing = false;
let route = routeOf(window.location.hash);
const TITLES = { places: 'Places', search: 'Search', recent: 'Recent changes' };
const STALE_MS = 30000;

async function refreshView({ force = false } = {}) {
  if (!ready() || refreshing) return;
  const age = viewEntry ? Date.now() - new Date(viewEntry.fetched_at).getTime() : Infinity;
  if (!force && !viewStale && age < STALE_MS) return;
  refreshing = true;
  renderBrowseStatus();
  const t0 = performance.now();
  const r = await backend.view();
  refreshing = false;
  log(`view → ${r.kind} in ${Math.round(performance.now() - t0)} ms`);
  if (r.kind === 'ok') {
    viewEntry = viewStore.save(r.data.view, r.data.fetched_at);
    viewProblem = '';
    viewStale = false;
  } else {
    viewProblem = r.kind === 'network' ? 'offline' : 'error';
    if (r.kind === 'unauthorized') showSetup();
  }
  renderBrowse();
}

function renderBrowseStatus() {
  const s = ui.browseStatus;
  if (refreshing && !viewEntry) s.textContent = 'Loading…';
  else if (refreshing) s.textContent = `Updated ${relativeTime(viewEntry.fetched_at)} · refreshing…`;
  else if (viewProblem === 'offline') s.textContent = viewEntry ? 'Offline — showing the last copy' : "Offline — can't load the inventory";
  else if (viewProblem === 'error') s.textContent = viewEntry ? "Couldn't refresh — showing the last copy" : "Couldn't load the inventory";
  else s.textContent = viewEntry ? `Updated ${relativeTime(viewEntry.fetched_at)}` : '';
}

function renderBrowse() {
  if (route.screen === 'talk') return;
  renderBrowseStatus();
  ui.searchBox.hidden = route.screen !== 'search';
  const view = shownView();
  const now = new Date();
  let title = TITLES[route.screen] ?? '';
  if (view && route.screen === 'place') title = placeContents(view, route.id)?.place.name ?? 'Place';
  if (view && route.screen === 'item') title = itemDetail(view, route.id)?.item.name ?? 'Item';
  ui.browseTitle.textContent = title;
  if (!view) {
    ui.browseBody.replaceChildren();
    return;
  }
  const body = {
    places: () => renderPlaces(view),
    place: () => renderPlace(view, route.id, now, act),
    item: () => renderItem(view, route.id, now, act),
    search: () => renderSearchResults(search(view, ui.searchBox.value), ui.searchBox.value),
    recent: () => renderRecent(view, now, undoFromRecent),
  }[route.screen];
  ui.browseBody.replaceChildren(body());
}

function showRoute() {
  const before = route;
  route = routeOf(window.location.hash);
  const talk = route.screen === 'talk';
  ui.talk.hidden = !talk;
  ui.browse.hidden = talk;
  ui.fab.hidden = talk;
  const tab = tabOf(route.screen);
  for (const a of ui.tabs) a.classList.toggle('on', a.dataset.tab === tab);
  if (talk) return;
  renderBrowse();
  if (before.screen !== route.screen || before.id !== route.id) window.scrollTo(0, 0);
  refreshView();
}

let toastTimer = null;
/** A short message over the screens; with a txn_id it carries an Undo button for that change. */
function toast(text, undoTxn = null) {
  const msg = document.createElement('span');
  msg.textContent = text;
  ui.toast.replaceChildren(msg);
  if (undoTxn) {
    const b = document.createElement('button');
    b.className = 'btn small';
    b.textContent = 'Undo';
    b.addEventListener('click', () => undoFromRecent(undoTxn, b));
    ui.toast.append(b);
  }
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { ui.toast.hidden = true; }, undoTxn ? 8000 : 5000);
}

async function undoFromRecent(txnId, button) {
  button.disabled = true;
  button.textContent = 'Undoing…';
  const t0 = performance.now();
  const r = await backend.undo(newId(), [txnId], FRESH);
  log(`undo → ${r.kind}${r.data?.status ? `/${r.data.status}` : ''} in ${Math.round(performance.now() - t0)} ms${serverTiming(r)}`);
  let text = r.data?.reply || 'Something went wrong. Nothing was undone.';
  if (r.kind === 'network') text = "I couldn't reach the inventory, so nothing was undone.";
  toast(text);
  await adoptView(r);
}

/** "(server 1900: load 120, engine 4, write 1650)" from a timed response. */
function serverTiming(r) {
  const t = r.data?.timing;
  if (!t) return '';
  const parts = ['load', 'rules', 'llm', 'engine', 'write'].filter((k) => t[k] != null).map((k) => `${k} ${Math.round(t[k])}`);
  return ` (server ${Math.round(t.total ?? 0)}: ${parts.join(', ')}${t.cache ? `, cache ${t.cache}` : ''})`;
}

/** A change's response carries the fresh view: show it at once; otherwise fetch it. */
async function adoptView(r) {
  if (r.kind === 'ok' && r.data.view) {
    viewEntry = viewStore.save(r.data.view, r.data.fetched_at);
    viewProblem = '';
    viewStale = false;
    renderBrowse();
    return;
  }
  viewStale = true;
  await refreshView({ force: true });
}

// ---------- manual corrections (ADR-011 step B) ----------
/** Send one change; never queued (a stale tap must not land later). Shows the result with an Undo. */
let pendingView = null; // what the screen shows while a change is saving (counted items only)

async function runChange(actions) {
  ui.browseBody.classList.add('busy');
  pendingView = predictView(viewEntry.view, actions[0]);
  if (pendingView) renderBrowse();
  toast('Saving…');
  const t0 = performance.now();
  const r = await backend.actions(actions, newId());
  ui.browseBody.classList.remove('busy');
  pendingView = null;
  if (r.kind !== 'ok' || r.data.status !== 'ok') renderBrowse(); // back to what's really there
  log(`change ${actions[0].intent} → ${r.kind}${r.data?.status ? `/${r.data.status}` : ''} in ${Math.round(performance.now() - t0)} ms${serverTiming(r)}`);
  if (r.kind === 'ok' && r.data.status === 'ok') {
    toast(r.data.reply, r.data.txn_id);
    await adoptView(r);
  } else if (r.kind === 'ok' && r.data.status === 'clarify') {
    toast(`Nothing was changed. ${r.data.reply}`);
  } else if (r.kind === 'network') {
    toast("I couldn't reach the inventory. Nothing was changed.");
  } else {
    toast(r.data?.reply || 'Something went wrong. Nothing was changed.');
    if (r.kind === 'unauthorized') showSetup();
  }
}

const unitOptions = (item) => unitChoices(item).map((u) => ({ value: u, label: u }));
const placeName = (id) => viewEntry?.view.places.find((p) => p.id === id)?.name ?? 'there';

// ---------- quick − / + taps (0.6.4): count up on screen at once, save together after a pause ----------
const TAP_SETTLE_MS = 900;
const taps = new Map(); // `${itemId}|${placeId}` → {itemId, item, placeId, delta, timer}: not sent yet
const sentTaps = []; // [{itemId, placeId, delta}] sent, not answered yet

/** The view as the screen should show it: a predicted Set…, plus taps not yet saved. */
function shownView() {
  const base = pendingView ?? viewEntry?.view;
  const deltas = [...sentTaps, ...taps.values()];
  return base && deltas.length ? applyTapDeltas(base, deltas) : base;
}

function tap(item, placeId, step) {
  if (step < 0 && countAt(shownView(), item.id, placeId) <= 0) return; // nothing left to take out
  const key = `${item.id}|${placeId}`;
  const t = taps.get(key) ?? { itemId: item.id, item, placeId, delta: 0, timer: null };
  t.delta += step;
  clearTimeout(t.timer);
  t.timer = setTimeout(() => saveTaps(key), TAP_SETTLE_MS);
  taps.set(key, t);
  renderBrowse();
}

async function saveTaps(key) {
  const t = taps.get(key);
  taps.delete(key);
  if (!t?.delta || !viewEntry) {
    renderBrowse();
    return;
  }
  const sent = { itemId: t.itemId, placeId: t.placeId, delta: t.delta };
  sentTaps.push(sent);
  const action = { ...changeAction(viewEntry.view, t.delta > 0 ? 'plusOne' : 'minusOne', { item: t.item, placeId: t.placeId }), quantity: Math.abs(t.delta) };
  toast('Saving…');
  const t0 = performance.now();
  const r = await backend.actions([action], newId());
  sentTaps.splice(sentTaps.indexOf(sent), 1);
  log(`taps ${t.delta > 0 ? '+' : ''}${t.delta} → ${r.kind}${r.data?.status ? `/${r.data.status}` : ''} in ${Math.round(performance.now() - t0)} ms${serverTiming(r)}`);
  if (r.kind === 'ok' && r.data.status === 'ok') {
    toast(r.data.reply, r.data.txn_id);
    await adoptView(r);
  } else {
    if (r.kind === 'ok' && r.data.status === 'clarify') toast(`Nothing was changed. ${r.data.reply}`);
    else toast(r.kind === 'network' ? "I couldn't reach the inventory. Nothing was changed." : (r.data?.reply || 'Something went wrong. Nothing was changed.'));
    renderBrowse(); // back to what's really there
  }
}

const act = {
  async change(kind, args) {
    const view = viewEntry?.view;
    if (!view) return;
    const { item, placeId } = args;
    if (kind === 'plusOne' || kind === 'minusOne') {
      tap(item, placeId, kind === 'plusOne' ? 1 : -1);
      return;
    }
    const what = item.name.toLowerCase();
    let values = {};
    if (kind === 'set') {
      values = await openForm({
        title: `How many ${what} in ${placeName(placeId)}?`, submit: 'Set',
        fields: [{ name: 'qty', label: 'Count', type: 'number', value: String(parseFloat(args.current) || 0) }],
      });
    } else if (kind === 'useSome') {
      values = await openForm({
        title: `How much ${what} did you use?`, submit: 'Take out',
        fields: [{ name: 'qty', label: 'Amount', type: 'number' }, { name: 'unit', label: 'Unit', type: 'select', options: unitOptions(item) }],
      });
    } else if (kind === 'addPackage') {
      values = await openForm({
        title: `Add a package of ${what}`, submit: 'Add',
        fields: [{ name: 'qty', label: 'Size', type: 'number', value: item.pkg_amount ? String(item.pkg_amount) : '' },
          { name: 'unit', label: 'Unit', type: 'select', options: unitOptions(item) }],
      });
    } else if (kind === 'move') {
      const others = view.places.filter((p) => p.id !== placeId).map((p) => ({ value: p.id, label: p.name }));
      const v = await openForm({
        title: `Move all the ${what} from ${placeName(placeId)} to…`, submit: 'Move',
        fields: [{ name: 'to', label: 'Place', type: 'select', options: [...others, { value: '__new', label: 'A new place…' }] },
          { name: 'name', label: 'New place name', type: 'text', placeholder: 'e.g. Basement Fridge', showWhen: { field: 'to', value: '__new' } }],
      });
      values = v && { to: v.to === '__new' ? { name: v.name } : { id: v.to } };
    }
    if (!values) return; // cancelled
    const action = changeAction(view, kind, { ...args, ...values });
    if (!action) {
      toast("That doesn't look right. Nothing was changed.");
      return;
    }
    await runChange([action]);
  },

  async edit(kind, target) {
    const view = viewEntry?.view;
    if (!view) return;
    const common = [
      { name: 'name', label: 'Name', type: 'text', value: target.name },
      { name: 'aliases', label: 'Other names', type: 'text', value: target.aliases.join(', '), hint: 'Separate with commas. WISP understands these too.' },
    ];
    const fields = kind === 'item'
      ? [...common,
        { name: 'category', label: 'Category', type: 'text', value: target.category, list: categoriesOf(view) },
        { name: 'subcategory', label: 'Subcategory', type: 'text', value: target.subcategory },
        ...(target.tracking === 'measure' ? [
          { name: 'needs_amount', label: 'Always ask how much', type: 'checkbox', value: target.needs_amount },
          { name: 'pkg_amount', label: `Usual package size (${target.unit})`, type: 'number', value: target.pkg_amount === '' || target.pkg_amount == null ? '' : String(target.pkg_amount) },
        ] : []),
        // how it's measured: only while none is on hand (the engine enforces it too) — ADR-014
        ...(target.stock.length ? [] : [
          { name: 'tracking', label: 'How it\'s kept', type: 'select', value: target.tracking, options: [{ value: 'count', label: 'Counted (packages, boxes…)' }, { value: 'measure', label: 'Weighed or measured (lb, oz, gal…)' }] },
          { name: 'unit', label: 'Unit', type: 'text', value: target.unit, hint: 'Counted: package, box, bag, can… Weighed: lb, oz, kg, gal, qt…' },
        ]),
        { name: 'notes', label: 'Notes', type: 'textarea', value: target.notes }]
      : [...common,
        { name: 'area', label: 'Area', type: 'text', value: target.area, hint: 'e.g. Garage, Kitchen', list: [...new Set(view.places.map((p) => p.area).filter(Boolean))] },
        { name: 'type', label: 'Type', type: 'text', value: target.type, hint: 'e.g. freezer, shelf, drawer' }];
    const values = await openForm({ title: kind === 'item' ? `Edit ${target.name}` : `Edit ${target.name}`, fields });
    if (!values) return;
    if ('pkg_amount' in values) {
      const n = Number(String(values.pkg_amount).replace(',', '.'));
      values.pkg_amount = values.pkg_amount === '' ? '' : n > 0 ? n : (target.pkg_amount ?? '');
    }
    const action = editAction(kind, target, values);
    if (!action) {
      toast('Nothing to change.');
      return;
    }
    await runChange([action]);
  },
};

window.addEventListener('hashchange', showRoute);
ui.searchBox.addEventListener('input', () => renderBrowse());
ui.refresh.addEventListener('click', () => refreshView({ force: true }));
ui.fab.addEventListener('click', () => {
  window.location.hash = '';
  ui.mic.click();
});

// ---------- mic lab (Android app only, ADR-016) ----------
if (NATIVE && CAP?.Plugins?.WispSpeech) {
  const root = $('miclab');
  root.hidden = false;
  createMicLab({
    plugin: CAP.Plugins.WispSpeech, log, root,
    sayOkay: () => voice.speak('Okay.'),
    playOkay: () => cues.play('heard', { settings: { style: 'voice', word: 'okay' } }),
    playListening: () => cues.play('needsYou', { settings: { style: 'tones' } }), // lab stand-in for a start sound
  });
}

// ---------- boot ----------
ui.ver.textContent = APP_VERSION;
if (route.screen !== 'talk') history.replaceState(null, '', window.location.pathname); // a launch always opens on Talk
route = routeOf(window.location.hash);
showRoute();
renderAttention();
renderSettings();
log(`boot ${APP_VERSION}`);
if (setupResult === 'stored') {
  confirmSetup();
} else if (setupResult === 'invalid') {
  showSetup("That setup link wasn't valid. Scan the code again.");
} else if (!ready()) {
  showSetup();
} else if (document.visibilityState === 'visible') {
  let updated = false;
  try { updated = sessionStorage.getItem('wisp.updated') === '1'; sessionStorage.removeItem('wisp.updated'); } catch { /* ignore */ }
  if (updated) {
    log(`updated to ${APP_VERSION}: not opening the mic`);
    notice(`WISP updated to ${APP_VERSION}.`);
  } else {
    wake('launch');
  }
}
render();
