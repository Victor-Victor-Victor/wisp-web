// The voice conversation as a pure state machine (spec §8; list protocol ADR-009, turn-taking ADR-010). No browser
// APIs: app.js feeds it events and carries out the effects it returns, so every rule here is unit-tested.
//
// A *session* is one spoken list; a single command is a one-chunk list.
//   start → listen ──"…, and"──→ ack ("Okay") · chunk sent in the background · listen again (long) ─┐
//                  ←─────────────────────────────────────────────────────────────────────────────────┘
//          ──a phrase with no "and"──→ ack · 3 s grace listen (more speech continues the list)
//          ──"that's it" / grace silence / tap──→ list closed ("done" cue)
//   long silence after "and" → list *paused* (mic off, no Android beeps) until a tap resumes it; 60 s → finished
//   closed → held questions asked one by one (even while the last chunk is still saving) → spoken read-back → idle
// Server results make no sound mid-list: they show on screen, and anything that needs you waits for the review.
// Undo (the button) reverses the newest *phrase* of this session — every item it saved, by txn_id — and is there as
// soon as the phrase is heard (a tap while it's still saving waits for it). It never reaches anything older.
// Spoken corrections (ADR-017): "no, I meant …" / "scratch that" mid-list takes back the newest phrase the same way;
// at the end, "No" to "I heard: … Right?" asks "What did you mean?", and "No, ‹phrase›" replaces the item at once.
// Every listen/speak/request has an id; events from a stale one are ignored.
import { TIMING } from './config.js';
import { classifyUtterance, isSkip, parseNo, isYes } from './utterance.js';

export const TEXT = {
  offline: "I couldn't reach the inventory. I saved this and will retry.",
  offlineNoQueue: "I couldn't reach the inventory. That one wasn't saved.",
  notSetUp: "This phone isn't set up yet. Scan the setup code on your computer.",
  serverError: 'Something went wrong with that one.',
  undoOffline: "I couldn't reach the inventory, so nothing was undone.",
  undoQueued: "That one was saved for later because I couldn't reach the inventory, so it couldn't be undone.",
  okay: 'Okay.',
  restate: 'Okay. What did you mean?',
};
const READ_BACK_MAX = 6;
const MAX_ASKS = 3; // times one held item may be asked before it's left out

const freshUndo = (epoch = 0) => ({ stack: [], waiting: null, inFlight: null, epoch });

export function initialState() {
  return { mode: 'idle', listenId: 0, listenKind: null, speakId: 0, after: null, session: null, review: null, lastLocation: null, undo: freshUndo() };
}

function newSession(location) {
  return {
    location, open: true, continuing: false, chunks: 0, silentMs: 0, graceRetried: false, queue: [], inFlight: null,
    applied: [], held: [], errors: [], replies: [], skipped: 0, undone: 0, cancelled: false, closeRequested: false, wasContinuing: false,
    lastKey: null, lastLabel: null, // the newest phrase (a spoken correction takes it back)
  };
}

// ---------- small builders ----------
function listen(s, kind, timeoutMs) {
  const listenId = s.listenId + 1;
  return { state: { ...s, mode: 'listening', listenKind: kind, listenId }, effects: [{ type: 'cue', kind: 'listening' }, { type: 'listen', id: listenId, kind, timeoutMs }] };
}

function speak(s, text, after) {
  const speakId = s.speakId + 1;
  return { state: { ...s, mode: 'speaking', listenKind: null, after, speakId }, effects: [{ type: 'speak', id: speakId, text }] };
}

const withSession = (s, patch) => ({ ...s, session: { ...s.session, ...patch } });
const withUndo = (s, patch) => ({ ...s, undo: { ...s.undo, ...patch } });
const lower = (t) => String(t ?? '').toLowerCase();
const stripNothing = (t) => String(t ?? '').replace(/\s*Nothing was (changed|saved)\.\s*$/, '').trim();
const capitalize = (t) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);
const pendingChunks = (sess) => Boolean(sess && (sess.inFlight || sess.queue.length));
/** Chunks still saving, or an Undo still on its way: the read-back waits for both. */
const settling = (s) => pendingChunks(s.session) || Boolean(s.undo.waiting || s.undo.inFlight);

function chain(...steps) {
  return (s0) => {
    let s = s0;
    const effects = [];
    for (const fn of steps) {
      const out = fn(s);
      s = out.state;
      effects.push(...out.effects);
    }
    return { state: s, effects };
  };
}

/** Send the next queued chunk if nothing is in flight (chunks go strictly in order: the place carries over). */
function pump(s) {
  const sess = s.session;
  if (!sess || sess.inFlight || !sess.queue.length) return { state: s, effects: [] };
  const [next, ...rest] = sess.queue;
  const request = { kind: 'list', transcript: next.transcript, location: sess.location, requestId: next.requestId };
  return { state: withSession(s, { inFlight: next, queue: rest }), effects: [{ type: 'send', request }] };
}

// ---------- read-back ----------
/** "added 2 bags of peas to the garage freezer" → {what: "2 bags of peas", place: "garage freezer"} */
function addParts(summary) {
  const m = /^added (.+) to (?:the )?(.+)$/i.exec(String(summary ?? '').trim());
  return m ? { what: m[1], place: lower(m[2]) } : null;
}

function joinList(parts) {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** "Okay, I have chicken breast, 2 bags of peas and fish sticks in the garage freezer." */
export function readBack(saved) {
  const summaries = saved.map((a) => String(a.summary ?? '').replace(/\.$/, ''));
  const more = summaries.length > READ_BACK_MAX ? summaries.length - (READ_BACK_MAX - 1) : 0;
  const adds = summaries.map(addParts);
  const onePlace = adds.every(Boolean) && new Set(adds.map((p) => p.place)).size === 1;
  if (onePlace) {
    const whats = adds.map((p) => p.what);
    const shown = more ? [...whats.slice(0, READ_BACK_MAX - 1), `${more} more — on screen`] : whats;
    // no "Okay," here: the per-phrase "Okay" already said it, and two so close together clash (0.6.7)
    return `I have ${joinList(shown)} in the ${adds[0].place}.`;
  }
  const shown = more ? [...summaries.slice(0, READ_BACK_MAX - 1), `${more} more — on screen`] : summaries;
  return `${capitalize(joinList(shown))}.`;
}

/** One spoken wrap-up for the whole session. */
export function wrapUpText(sess) {
  const parts = [...sess.replies];
  for (const e of sess.errors) parts.push(stripNothing(e.reply));
  const saved = sess.applied.filter((a) => a.kind === 'saved' && !a.undone);
  if (saved.length) {
    parts.push(readBack(saved));
    const fresh = [...new Set(saved.map((a) => a.new_location).filter(Boolean))];
    if (fresh.length) parts.push(`New place${fresh.length > 1 ? 's' : ''}: ${fresh.join(', ')}.`);
  }
  if (sess.undone) parts.push(`Undid ${sess.undone === 1 ? 'one' : sess.undone}.`);
  if (sess.skipped) parts.push(`Skipped ${sess.skipped === 1 ? 'one' : sess.skipped}.`);
  if (!parts.length && sess.cancelled) parts.push(TEXT.okay);
  return parts.filter(Boolean).join(' ');
}

// ---------- closing, review, wrap-up ----------
function closeList(s, extra = {}) {
  if (!s.session?.open) return { state: withSession(s, extra), effects: [] };
  return {
    state: { ...withSession(s, { open: false, continuing: false, ...extra }), mode: 'working', listenKind: null },
    effects: [{ type: 'cue', kind: 'done' }],
  };
}

/**
 * How long to wait for more after a phrase without "and" (0.6.8): the ⚙ choice after a first phrase (a single
 * command wants a quick read-back), but at least listGraceMinMs once a list is underway (people pause between items).
 */
function graceMs(s, t) {
  const listing = (s.session?.chunks ?? 0) > 1 || s.session?.wasContinuing;
  return listing ? Math.max(t.graceListenMs, t.listGraceMinMs ?? 0) : t.graceListenMs;
}

/** After the list closes: ask held items (without waiting for chunks still saving), then wrap up. */
function maybeFinish(s) {
  const sess = s.session;
  if (!sess || sess.open || s.review || s.mode === 'listening' || s.mode === 'speaking') return { state: s, effects: [] };
  if (sess.held.length && !sess.cancelled) return askHeld({ ...s, review: { index: 0, current: null, waiting: false } });
  if (settling(s)) return { state: { ...s, mode: 'working' }, effects: [] };
  return wrapUp(s);
}

function askHeld(s) {
  const item = s.session.held[s.review.index];
  if (item) {
    const sp = speak({ ...s, review: { ...s.review, waiting: false } }, item.question, 'answer');
    return { state: sp.state, effects: [{ type: 'cue', kind: 'needsYou' }, ...sp.effects] };
  }
  if (settling(s)) return { state: { ...s, mode: 'working', review: { ...s.review, waiting: true } }, effects: [] };
  return wrapUp({ ...s, review: null });
}

function nextHeld(s, patch = {}) {
  return askHeld({ ...withSession(s, patch), review: { index: s.review.index + 1, current: null, waiting: false } });
}

function wrapUp(s) {
  const sess = s.session;
  const text = wrapUpText(sess);
  const epoch = s.undo.epoch + 1;
  const effects = s.undo.stack.length ? [{ type: 'undoCountdown', epoch }] : [];
  if (sess.cancelled && sess.held.length) effects.push({ type: 'attention', items: sess.held });
  const next = { ...withUndo(s, { epoch }), review: null, lastLocation: sess.location ?? s.lastLocation };
  if (!text) return { state: { ...next, mode: 'idle', session: null }, effects };
  const sp = speak(next, text, 'idle');
  return { state: sp.state, effects: [...effects, ...sp.effects] };
}

// ---------- undo ----------
// The stack holds one entry per phrase: {key (its requestId), label, txns, pending, cancelled, dropped}.
const undoTop = (s) => s.undo.stack[s.undo.stack.length - 1];
const withEntry = (s, key, patch) => withUndo(s, { stack: s.undo.stack.map((e) => (e.key === key ? { ...e, ...patch } : e)) });
const withoutEntry = (s, key) => withUndo(s, { stack: s.undo.stack.filter((e) => e.key !== key) });

function sendUndo(s, entry, requestId) {
  const inFlight = { requestId, key: entry.key, txns: entry.txns, label: entry.label, dropped: entry.dropped ?? 0, replaced: Boolean(entry.replaced) };
  return {
    state: withUndo(s, { waiting: null, inFlight }),
    effects: [{ type: 'send', request: { kind: 'undo', txnIds: entry.txns, requestId } }],
  };
}

function countUndone(s, n) {
  return s.session && n ? withSession(s, { undone: s.session.undone + n }) : s;
}

/** A tapped phrase has finished saving: undo what it saved (or, if it saved nothing, just let it go). */
function settleCancelled(s, key) {
  const entry = s.undo.stack.find((e) => e.key === key);
  if (!entry?.cancelled) return { state: s, effects: [] };
  if (entry.txns.length) return sendUndo(s, entry, s.undo.waiting);
  const st = countUndone(withUndo(withoutEntry(s, key), { waiting: null }), entry.replaced ? 0 : entry.dropped ?? 0);
  const shown = entry.dropped || entry.replaced;
  return { state: st, effects: shown ? [{ type: 'showItem', status: 'undo', text: `${entry.replaced ? 'Replaced' : 'Undid'}: ${entry.label}` }] : [] };
}

function applyUndoResult(s, r) {
  const { key, txns, label, dropped, replaced } = s.undo.inFlight;
  let st = withUndo(s, { inFlight: null });
  const effects = [];
  const done = r.kind === 'ok' && (r.data.status === 'ok' || r.data.reply === "That's already undone.");
  if (done) {
    // a correction's take-back isn't an "Undid one" in the read-back: the item is simply replaced
    st = countUndone(withoutEntry(st, key), replaced ? 0 : txns.length + dropped);
    if (st.session) st = withSession(st, { applied: st.session.applied.map((a) => (txns.includes(a.txn_id) ? { ...a, undone: true } : a)) });
    for (const txn of txns) effects.push({ type: 'showItem', status: 'undo', text: `${replaced ? 'Replaced' : 'Undid'}: ${label}`, txn });
  } else {
    st = withEntry(st, key, { cancelled: false });
    const text = r.kind === 'network' ? TEXT.undoOffline : r.kind === 'ok' ? r.data.reply : TEXT.serverError;
    effects.push({ type: 'cue', kind: 'problem' }, { type: 'showItem', status: 'error', text });
  }
  return { state: st, effects };
}

/**
 * A spoken correction ("no, I meant …", "scratch that"): take back the session's newest phrase — its saves (by
 * txn_id, like the Undo button; a phrase still saving is undone when it lands) and its held questions.
 */
function correctLast(s, requestId) {
  const sess = s.session;
  const key = sess?.lastKey;
  if (!key) return { state: s, effects: [] };
  const label = sess.lastLabel;
  const keptHeld = sess.held.filter((h) => h.from !== key);
  const droppedHeld = sess.held.length - keptHeld.length;
  let st = withSession(s, { lastKey: null, lastLabel: null, held: keptHeld });
  const entry = st.undo.stack.find((e) => e.key === key);
  if (entry && !st.undo.waiting && !st.undo.inFlight) {
    st = withEntry(st, key, { replaced: true });
    if (entry.pending) return { state: withUndo(withEntry(st, key, { cancelled: true }), { waiting: requestId }), effects: [] };
    if (entry.txns.length) return sendUndo(st, { ...entry, replaced: true }, requestId);
  }
  return { state: st, effects: droppedHeld ? [{ type: 'showItem', status: 'undo', text: `Replaced: ${label}` }] : [] };
}

/** Where a held item was going (a correction at the end goes to the same place). */
function heldPlace(s, item) {
  const a = item?.pending?.actions?.[item?.clarify?.action_index ?? 0] ?? item?.pending?.actions?.[0];
  const ref = a?.intent === 'move' ? a.to_location : a?.location;
  return ref?.name ? ref : s.session.location ?? null;
}

// ---------- server results ----------
function applyListResult(s, chunk, r) {
  let sess = { ...s.session, inFlight: null };
  let { undo } = s;
  const effects = [];
  const entry = undo.stack.find((e) => e.key === chunk.requestId);
  if (r.kind !== 'ok') {
    // nothing of this phrase was saved (or it's queued for later): nothing to undo
    undo = { ...undo, stack: undo.stack.filter((e) => e.key !== chunk.requestId) };
    if (entry?.cancelled) {
      undo = { ...undo, waiting: null };
      if (r.kind === 'network') effects.push({ type: 'showItem', status: 'error', text: TEXT.undoQueued });
    }
  }
  if (r.kind === 'network') {
    if (!sess.errors.some((e) => e.reply === TEXT.offline)) sess.errors = [...sess.errors, { reply: TEXT.offline }];
    effects.push({ type: 'showItem', status: 'queued', text: chunk.transcript });
  } else if (r.kind === 'unauthorized') {
    sess = { ...sess, errors: [...sess.errors, { reply: TEXT.notSetUp }], open: false, queue: [] };
    effects.push({ type: 'cue', kind: 'problem' }, { type: 'showSetup' });
    if (s.mode === 'listening') {
      s = { ...s, mode: 'working', listenKind: null }; // close the mic: nothing more can be saved
      effects.push({ type: 'abortListening' });
    }
  } else if (r.kind !== 'ok') {
    sess.errors = [...sess.errors, { reply: r.data?.reply || TEXT.serverError }];
    effects.push({ type: 'showItem', status: 'error', text: r.data?.reply || TEXT.serverError });
  } else {
    const d = r.data;
    const place = d.location?.name ?? sess.location?.name ?? null;
    sess.location = d.location ?? sess.location;
    const txns = [];
    const whats = [];
    for (const a of d.applied ?? []) {
      if (a.kind === 'undo') {
        // a spoken "undo": the server reversed this person's newest save — the newest txn on our stack
        sess.undone += 1;
        const i = undo.stack.findLastIndex((e) => e.key !== chunk.requestId && e.txns.length);
        const txn = i >= 0 ? undo.stack[i].txns[undo.stack[i].txns.length - 1] : null;
        if (txn) {
          const left = undo.stack[i].txns.slice(0, -1);
          undo = { ...undo, stack: left.length ? undo.stack.map((e, j) => (j === i ? { ...e, txns: left } : e)) : undo.stack.filter((_, j) => j !== i) };
          sess.applied = sess.applied.map((x) => (x.txn_id === txn ? { ...x, undone: true } : x));
        }
        effects.push({ type: 'showItem', status: 'undo', text: a.reply, txn });
        continue;
      }
      sess.applied = [...sess.applied, { ...a, place }];
      if (a.txn_id) txns.push(a.txn_id);
      whats.push(addParts(a.summary)?.what ?? a.summary);
      effects.push({ type: 'showItem', status: 'saved', text: capitalize(a.summary), txn: a.txn_id });
    }
    // a phrase Undo was tapped for: its questions are dropped, its saves undone (settleCancelled)
    const held = entry?.cancelled ? [] : (d.held ?? []).map((h) => ({ ...h, from: chunk.requestId }));
    if (entry) {
      const dropped = entry.cancelled ? (d.held ?? []).length : 0;
      const patch = { txns, pending: false, dropped, label: whats.length ? joinList(whats) : entry.label };
      undo = txns.length || entry.cancelled
        ? { ...undo, stack: undo.stack.map((e) => (e.key === entry.key ? { ...e, ...patch } : e)) }
        : { ...undo, stack: undo.stack.filter((e) => e.key !== entry.key) }; // only questions: each gets its own Undo once answered
    }
    for (const h of held) effects.push({ type: 'showItem', status: 'held', text: h.question });
    for (const e of d.errors ?? []) effects.push({ type: 'showItem', status: 'error', text: stripNothing(e.reply) });
    sess.held = [...sess.held, ...held];
    sess.errors = [...sess.errors, ...(d.errors ?? [])];
    if (d.reply) sess.replies = [...sess.replies, d.reply];
    if (d.data) effects.push({ type: 'showData', data: d.data });
  }
  return { state: { ...s, session: sess, undo }, effects };
}

function applyAnswerResult(s, r) {
  const effects = [];
  if (r.kind === 'ok' && r.data.status === 'clarify') {
    // the engine needs one more thing about the same item: ask it next
    const item = s.session.held[s.review.index];
    const asks = (item.asks ?? 1) + 1;
    // never loop on one item (phone test 0.5.3: "How much rice?" forever): after MAX_ASKS, leave it out
    if (asks > MAX_ASKS) return nextHeld(s, { skipped: s.session.skipped + 1 });
    const held = s.session.held.map((h, i) => (i === s.review.index ? { ...h, question: r.data.reply, pending: r.data.pending, clarify: r.data.clarify, asks } : h));
    return askHeld({ ...withSession(s, { held }), review: { ...s.review, current: null } });
  }
  let patch = {};
  if (r.kind === 'ok' && r.data.status === 'ok') {
    const summary = r.data.summary ?? r.data.reply;
    const saved = { kind: 'saved', txn_id: r.data.txn_id, summary, place: s.session.location?.name ?? null };
    patch = { applied: [...s.session.applied, saved] };
    effects.push({ type: 'showItem', status: 'saved', text: capitalize(summary), txn: r.data.txn_id });
    if (r.data.txn_id) {
      const entry = { key: s.review.current.requestId, label: addParts(summary)?.what ?? summary, txns: [r.data.txn_id], pending: false, cancelled: false };
      s = withUndo(s, { stack: [...s.undo.stack, entry] });
    }
  } else if (r.kind === 'ok' && r.data.status === 'cancelled') {
    patch = { skipped: s.session.skipped + 1 };
  } else {
    const reply = r.kind === 'network' ? TEXT.offlineNoQueue : r.kind === 'unauthorized' ? TEXT.notSetUp : (r.data?.reply || TEXT.serverError);
    patch = { errors: [...s.session.errors, { reply }] };
    effects.push({ type: 'cue', kind: 'problem' });
    if (r.kind === 'unauthorized') effects.push({ type: 'showSetup' });
  }
  const out = nextHeld(s, patch);
  return { state: out.state, effects: [...effects, ...out.effects] };
}

/** The answer to a held question was a corrected phrase ("No, that's one box of crackers"), sent as a list phrase. */
function applyReviewListResult(s, r) {
  const current = s.review.current;
  const item = s.session.held[s.review.index];
  if (r.kind !== 'ok') {
    const reply = r.kind === 'network' ? TEXT.offlineNoQueue : r.kind === 'unauthorized' ? TEXT.notSetUp : (r.data?.reply || TEXT.serverError);
    const out = nextHeld(s, { errors: [...s.session.errors, { reply }] });
    return { state: out.state, effects: [{ type: 'cue', kind: 'problem' }, ...(r.kind === 'unauthorized' ? [{ type: 'showSetup' }] : []), ...out.effects] };
  }
  const d = r.data;
  const effects = [];
  const sess = { ...s.session };
  const place = d.location?.name ?? sess.location?.name ?? null;
  const txns = [];
  const whats = [];
  for (const a of d.applied ?? []) {
    if (a.kind !== 'saved') continue;
    sess.applied = [...sess.applied, { ...a, place }];
    if (a.txn_id) txns.push(a.txn_id);
    whats.push(addParts(a.summary)?.what ?? a.summary);
    effects.push({ type: 'showItem', status: 'saved', text: capitalize(a.summary), txn: a.txn_id });
  }
  for (const e of d.errors ?? []) effects.push({ type: 'showItem', status: 'error', text: stripNothing(e.reply) });
  sess.errors = [...sess.errors, ...(d.errors ?? [])];
  if (d.reply) sess.replies = [...sess.replies, d.reply];
  let st = { ...s, session: sess };
  if (txns.length) st = withUndo(st, { stack: [...st.undo.stack, { key: current.requestId, label: joinList(whats), txns, pending: false, cancelled: false }] });
  const asks = (item?.asks ?? 1) + 1;
  const fresh = (d.held ?? []).map((h) => ({ ...h, from: current.requestId, asks }));
  if (fresh.length && asks <= MAX_ASKS) {
    // the corrected phrase needs a question of its own: it takes the old one's place and is asked now
    for (const h of fresh) effects.push({ type: 'showItem', status: 'held', text: h.question });
    const all = sess.held;
    const held = [...all.slice(0, s.review.index), ...fresh, ...all.slice(s.review.index + 1)];
    const out = askHeld({ ...withSession(st, { held }), review: { ...s.review, current: null, restating: false } });
    return { state: out.state, effects: [...effects, ...out.effects] };
  }
  const out = nextHeld(st, fresh.length ? { skipped: sess.skipped + 1 } : {});
  return { state: out.state, effects: [...effects, ...out.effects] };
}

/**
 * @param s   current state
 * @param ev  {type:"start"} | {type:"heard", id, text, requestId} | {type:"silence", id, elapsedMs?, speech?}
 *            | {type:"response", requestId, result} | {type:"spoken", id} | {type:"undo", requestId}
 *            | {type:"undoExpired", epoch} | {type:"pauseExpired", id} | {type:"cancel"}
 * @param t   timings (config TIMING, with the person's ⚙ choices for listPauseMs / pausedFinishMs)
 * @returns {{state, effects: object[]}}
 */
export function step(s, ev, t = TIMING) {
  const none = { state: s, effects: [] };
  switch (ev.type) {
    case 'start': {
      if (s.mode === 'listening') {
        // tap while listening = "I'm done talking": end the list (or the answer) with what was said so far
        const st = s.session?.open ? withSession(s, { closeRequested: true }) : s;
        return { state: st, effects: [{ type: 'stopListening' }] };
      }
      if (s.mode === 'paused') return listen(withSession(s, { silentMs: 0, continuing: true }), 'list', t.commandListenMs);
      if (s.session && !s.session.open && s.mode !== 'speaking') return none; // finishing up: ignore
      const pre = s.mode === 'speaking' ? [{ type: 'cancelSpeech' }] : [];
      const unasked = s.review ? s.session.held.slice(s.review.index) : [];
      if (unasked.length) pre.push({ type: 'attention', items: unasked }); // interrupted the questions: keep them
      const fresh = { ...s, review: null, session: newSession(s.session?.location ?? s.lastLocation), undo: freshUndo(s.undo.epoch + 1) };
      const l = listen(fresh, 'list', t.commandListenMs);
      return { state: l.state, effects: [...pre, { type: 'clearItems' }, ...l.effects] };
    }

    case 'heard': {
      if (s.mode !== 'listening' || ev.id !== s.listenId) return none;
      const c = classifyUtterance(ev.text);

      if (s.listenKind === 'answer') {
        if (c.kind === 'end' || c.kind === 'cancel') {
          const remaining = s.session.held.length - s.review.index;
          return askHeld({ ...withSession(s, { skipped: s.session.skipped + remaining }), review: { index: s.session.held.length, current: null, waiting: false } });
        }
        if (isSkip(ev.text)) return nextHeld(s, { skipped: s.session.skipped + 1 });
        const item = s.session.held[s.review.index];
        const confirming = Boolean(item.clarify?.missing?.includes('confirm'));
        const restating = Boolean(s.review.restating);
        const no = restating ? (isYes(ev.text) ? null : { rest: String(ev.text).trim() }) : confirming ? parseNo(ev.text) : null;
        if (no && !no.rest) {
          // a plain "No": ask what was meant (counts as an ask, so it can't loop)
          const asks = (item.asks ?? 1) + 1;
          if (asks > MAX_ASKS) return nextHeld(s, { skipped: s.session.skipped + 1 });
          const held = s.session.held.map((h, i) => (i === s.review.index ? { ...h, asks } : h));
          const sp = speak({ ...withSession(s, { held }), review: { ...s.review, current: null, restating: true } }, TEXT.restate, 'answer');
          return { state: sp.state, effects: [{ type: 'cue', kind: 'heard' }, ...sp.effects] };
        }
        if (no) {
          // "No, that's one box of crackers": the corrected phrase replaces the item, in the same place
          const request = { kind: 'list', transcript: no.rest, location: heldPlace(s, item), requestId: ev.requestId };
          return {
            state: { ...s, mode: 'working', listenKind: null, review: { ...s.review, current: request, restating: false } },
            effects: [{ type: 'cue', kind: 'heard' }, { type: 'send', request }],
          };
        }
        const transcript = restating ? 'yes' : String(ev.text).trim(); // changed their mind: "yes" after all
        const request = { kind: 'answer', transcript, pending: item.pending, clarify: item.clarify, requestId: ev.requestId };
        return {
          state: { ...s, mode: 'working', listenKind: null, review: { ...s.review, current: request, restating: false } },
          effects: [{ type: 'cue', kind: 'heard' }, { type: 'send', request }],
        };
      }

      // a list listen (first, after "and", or the grace listen after a phrase without "and")
      let st = withSession(s, { silentMs: 0, graceRetried: false });
      const shown = [];
      if (c.corrects) {
        // "no, I meant …" / "scratch that": the newest phrase is taken back first (ADR-017)
        const fix = correctLast(st, `${ev.requestId}-fix`);
        st = fix.state;
        shown.push(...fix.effects);
      }
      if (c.kind === 'end') {
        const out = chain((x) => closeList(x), maybeFinish)(st);
        return { state: out.state, effects: [...shown, ...out.effects] };
      }
      if (c.kind === 'cancel') return chain((x) => closeList(x, { cancelled: true, queue: [] }), maybeFinish)(st);
      const question = c.question && st.session.chunks === 0; // "what's in the garage freezer?": answer, don't list
      if (c.text) {
        const chunk = { kind: 'list', transcript: c.text, requestId: ev.requestId };
        st = withSession(st, { queue: [...st.session.queue, chunk], chunks: st.session.chunks + 1, lastKey: ev.requestId, lastLabel: c.text });
        st = withUndo(st, { stack: [...st.undo.stack, { key: ev.requestId, label: c.text, txns: [], pending: true, cancelled: false }] });
        shown.push({ type: 'showItem', status: 'pending', text: c.text });
      }
      if (st.session.closeRequested || c.ends || question) {
        const out = chain((x) => closeList(x), pump, maybeFinish)(st);
        return { state: out.state, effects: [...shown, ...out.effects] };
      }
      const sent = pump(withSession(st, { continuing: c.continues, wasContinuing: Boolean(st.session.wasContinuing || c.continues) }));
      const ack = c.text || c.corrects ? [{ type: 'cue', kind: 'heard' }] : [];
      const l = c.continues
        ? listen(sent.state, 'list', t.commandListenMs)
        : listen(sent.state, 'grace', graceMs(sent.state, t)); // a dropped or late "and" still continues the list
      return { state: l.state, effects: [...shown, ...sent.effects, ...ack, ...l.effects] };
    }

    case 'silence': {
      if (s.mode !== 'listening' || ev.id !== s.listenId) return none;
      if (s.listenKind === 'answer') return nextHeld(s, { skipped: s.session.skipped + 1 });
      const sess = s.session;
      if (!sess || sess.chunks === 0) {
        // nothing said at launch → quietly idle
        return { state: { ...s, mode: 'idle', listenKind: null, session: null, lastLocation: sess?.location ?? s.lastLocation }, effects: [] };
      }
      const silentMs = sess.silentMs + (ev.elapsedMs ?? t.commandListenMs);
      if (s.listenKind === 'grace' && ev.speech && !sess.graceRetried && !sess.closeRequested) {
        // the mic picked up speech but made no words of it: give the late phrase one more chance
        return listen(withSession(s, { silentMs, graceRetried: true }), 'grace', graceMs(s, t));
      }
      if (s.listenKind === 'list' && sess.continuing && !sess.closeRequested) {
        const left = t.listPauseMs - silentMs;
        // listen only for what's left of the pause time (a last restart for under 2 s isn't worth an Android beep)
        if (left >= 2000) return listen(withSession(s, { silentMs }), 'list', Math.min(t.commandListenMs, left));
        // a long pause after "and": stop reopening the mic (each start is an Android beep) until a tap
        return {
          state: { ...withSession(s, { silentMs }), mode: 'paused', listenKind: null },
          effects: [{ type: 'cue', kind: 'paused' }, { type: 'pauseTimer', id: s.listenId, ms: t.pausedFinishMs }],
        };
      }
      return chain((x) => closeList(x), maybeFinish)(withSession(s, { silentMs }));
    }

    case 'response': {
      const sess = s.session;
      if (sess?.inFlight && ev.requestId === sess.inFlight.requestId) {
        const after = (x) => (x.review?.waiting ? askHeld(x) : maybeFinish(x));
        const key = sess.inFlight.requestId;
        return chain((x) => applyListResult(x, sess.inFlight, ev.result), pump, (x) => settleCancelled(x, key), after)(s);
      }
      if (s.review?.current && ev.requestId === s.review.current.requestId) {
        return s.review.current.kind === 'list' ? applyReviewListResult(s, ev.result) : applyAnswerResult(s, ev.result);
      }
      if (s.undo.inFlight && ev.requestId === s.undo.inFlight.requestId) {
        return chain((x) => applyUndoResult(x, ev.result), (x) => (x.review?.waiting ? askHeld(x) : maybeFinish(x)))(s);
      }
      return none;
    }

    case 'spoken': {
      if (s.mode !== 'speaking' || ev.id !== s.speakId) return none;
      if (s.after === 'answer' && s.review) return listen({ ...s, review: { ...s.review, current: null } }, 'answer', t.answerListenMs);
      return { state: { ...s, mode: 'idle', after: null, session: null }, effects: [] };
    }

    case 'undo': {
      const top = undoTop(s);
      if (s.undo.waiting || s.undo.inFlight || !top) return none; // busy or nothing of this session left
      // instant feedback; never make a sound while the mic is open (it would hear it)
      const cue = { type: 'cue', kind: 'undo', quiet: s.mode === 'listening' };
      const st = s.session?.open ? withSession(s, { silentMs: 0 }) : s; // a tap is activity: the pause clock restarts
      if (top.pending) return { state: withUndo(withEntry(st, top.key, { cancelled: true }), { waiting: ev.requestId }), effects: [cue] };
      const out = sendUndo(st, top, ev.requestId);
      return { state: out.state, effects: [cue, ...out.effects] };
    }

    case 'pauseExpired': // paused a long while: finish the list (questions, then the read-back)
      if (s.mode !== 'paused' || ev.id !== s.listenId) return none;
      return chain((x) => closeList(x), maybeFinish)(s);

    case 'undoExpired':
      if (ev.epoch !== s.undo.epoch || s.undo.waiting || s.undo.inFlight) return none;
      return { state: withUndo(s, { stack: [] }), effects: [] };

    case 'cancel': { // app hidden / closed: stop talking and listening; unanswered questions go to "Needs attention"
      const held = s.session?.held?.slice(s.review?.index ?? 0) ?? [];
      return {
        state: { ...initialState(), listenId: s.listenId, speakId: s.speakId, undo: freshUndo(s.undo.epoch + 1), lastLocation: s.session?.location ?? s.lastLocation },
        effects: [{ type: 'abortListening' }, { type: 'cancelSpeech' }, ...(held.length ? [{ type: 'attention', items: held }] : [])],
      };
    }

    default:
      return none;
  }
}
