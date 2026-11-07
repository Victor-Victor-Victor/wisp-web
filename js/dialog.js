// The voice conversation as a pure state machine (spec §8; list protocol ADR-009, turn-taking ADR-010). No browser
// APIs: app.js feeds it events and carries out the effects it returns, so every rule here is unit-tested.
//
// A *session* is one spoken list; a single command is a one-chunk list.
//   start → listen ──"…, and"──→ ack ("Okay") · chunk sent in the background · listen again (long) ─┐
//                  ←─────────────────────────────────────────────────────────────────────────────────┘
//          ──a phrase with no "and"──→ ack · 3 s grace listen (more speech continues the list)
//          ──"that's it" / grace silence / tap──→ list closed ("done" cue)
//   long silence after "and" → list *paused* (mic off, no Android beeps) until a tap resumes it
//   closed → held questions asked one by one (even while the last chunk is still saving) → spoken read-back → idle
// Server results make no sound mid-list: they show on screen, and anything that needs you waits for the review.
// Undo (the button) reverses exactly one item saved in *this* session, by txn_id — never anything older.
// Every listen/speak/request has an id; events from a stale one are ignored.
import { TIMING } from './config.js';
import { classifyUtterance } from './utterance.js';

export const TEXT = {
  offline: "I couldn't reach the inventory. I saved this and will retry.",
  offlineNoQueue: "I couldn't reach the inventory. That one wasn't saved.",
  notSetUp: "This phone isn't set up yet. Scan the setup code on your computer.",
  serverError: 'Something went wrong with that one.',
  undoOffline: "I couldn't reach the inventory, so nothing was undone.",
  okay: 'Okay.',
};
const READ_BACK_MAX = 6;

const freshUndo = (epoch = 0) => ({ stack: [], waiting: null, inFlight: null, epoch });

export function initialState() {
  return { mode: 'idle', listenId: 0, listenKind: null, speakId: 0, after: null, session: null, review: null, lastLocation: null, undo: freshUndo() };
}

function newSession(location) {
  return {
    location, open: true, continuing: false, chunks: 0, silentMs: 0, queue: [], inFlight: null,
    applied: [], held: [], errors: [], replies: [], skipped: 0, undone: 0, cancelled: false, closeRequested: false,
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
    return `Okay, I have ${joinList(shown)} in the ${adds[0].place}.`;
  }
  const shown = more ? [...summaries.slice(0, READ_BACK_MAX - 1), `${more} more — on screen`] : summaries;
  return `Okay: ${joinList(shown)}.`;
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

/** After the list closes: ask held items (without waiting for chunks still saving), then wrap up. */
function maybeFinish(s) {
  const sess = s.session;
  if (!sess || sess.open || s.review || s.mode === 'listening' || s.mode === 'speaking') return { state: s, effects: [] };
  if (sess.held.length && !sess.cancelled) return askHeld({ ...s, review: { index: 0, current: null, waiting: false } });
  if (pendingChunks(sess)) return { state: { ...s, mode: 'working' }, effects: [] };
  return wrapUp(s);
}

function askHeld(s) {
  const item = s.session.held[s.review.index];
  if (item) {
    const sp = speak({ ...s, review: { ...s.review, waiting: false } }, item.question, 'answer');
    return { state: sp.state, effects: [{ type: 'cue', kind: 'needsYou' }, ...sp.effects] };
  }
  if (pendingChunks(s.session)) return { state: { ...s, mode: 'working', review: { ...s.review, waiting: true } }, effects: [] };
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
function sendUndo(s, requestId) {
  const top = s.undo.stack[s.undo.stack.length - 1];
  if (!top) return { state: withUndo(s, { waiting: null }), effects: [] };
  const inFlight = { requestId, txn_id: top.txn_id, label: top.label };
  return {
    state: withUndo(s, { waiting: null, inFlight }),
    effects: [{ type: 'send', request: { kind: 'undo', txnId: top.txn_id, requestId } }],
  };
}

/** A tap that arrived while chunks were saving goes out once they've settled (so it undoes the newest item). */
function flushUndo(s) {
  if (!s.undo.waiting || pendingChunks(s.session)) return { state: s, effects: [] };
  return sendUndo(s, s.undo.waiting);
}

function applyUndoResult(s, r) {
  const { txn_id: txn, label } = s.undo.inFlight;
  let st = withUndo(s, { inFlight: null });
  const effects = [];
  const done = r.kind === 'ok' && (r.data.status === 'ok' || r.data.reply === "That's already undone.");
  if (done) {
    st = withUndo(st, { stack: st.undo.stack.filter((e) => e.txn_id !== txn) });
    if (st.session) {
      st = withSession(st, {
        undone: st.session.undone + 1,
        applied: st.session.applied.map((a) => (a.txn_id === txn ? { ...a, undone: true } : a)),
      });
    }
    effects.push({ type: 'showItem', status: 'undo', text: `Undid: ${label}`, txn });
  } else {
    const text = r.kind === 'network' ? TEXT.undoOffline : r.kind === 'ok' ? r.data.reply : TEXT.serverError;
    effects.push({ type: 'cue', kind: 'problem' }, { type: 'showItem', status: 'error', text });
  }
  return { state: st, effects };
}

// ---------- server results ----------
function applyListResult(s, chunk, r) {
  let sess = { ...s.session, inFlight: null };
  let { undo } = s;
  const effects = [];
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
    for (const a of d.applied ?? []) {
      if (a.kind === 'undo') {
        // a spoken "undo": the server reversed this person's newest save — the top of our stack
        sess.undone += 1;
        const top = undo.stack[undo.stack.length - 1];
        if (top) {
          undo = { ...undo, stack: undo.stack.slice(0, -1) };
          sess.applied = sess.applied.map((x) => (x.txn_id === top.txn_id ? { ...x, undone: true } : x));
        }
        effects.push({ type: 'showItem', status: 'undo', text: a.reply, txn: top?.txn_id });
        continue;
      }
      sess.applied = [...sess.applied, { ...a, place }];
      undo = { ...undo, stack: [...undo.stack, { txn_id: a.txn_id, label: addParts(a.summary)?.what ?? a.summary }] };
      effects.push({ type: 'showItem', status: 'saved', text: capitalize(a.summary), txn: a.txn_id });
    }
    for (const h of d.held ?? []) effects.push({ type: 'showItem', status: 'held', text: h.question });
    for (const e of d.errors ?? []) effects.push({ type: 'showItem', status: 'error', text: stripNothing(e.reply) });
    sess.held = [...sess.held, ...(d.held ?? [])];
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
    const held = s.session.held.map((h, i) => (i === s.review.index ? { ...h, question: r.data.reply, pending: r.data.pending, clarify: r.data.clarify } : h));
    return askHeld({ ...withSession(s, { held }), review: { ...s.review, current: null } });
  }
  let patch = {};
  if (r.kind === 'ok' && r.data.status === 'ok') {
    const summary = r.data.summary ?? r.data.reply;
    const saved = { kind: 'saved', txn_id: r.data.txn_id, summary, place: s.session.location?.name ?? null };
    patch = { applied: [...s.session.applied, saved] };
    effects.push({ type: 'showItem', status: 'saved', text: capitalize(summary), txn: r.data.txn_id });
    if (r.data.txn_id) s = withUndo(s, { stack: [...s.undo.stack, { txn_id: r.data.txn_id, label: addParts(summary)?.what ?? summary }] });
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

/**
 * @param s   current state
 * @param ev  {type:"start"} | {type:"heard", id, text, requestId} | {type:"silence", id, elapsedMs?}
 *            | {type:"response", requestId, result} | {type:"spoken", id} | {type:"undo", requestId}
 *            | {type:"undoExpired", epoch} | {type:"cancel"}
 * @returns {{state, effects: object[]}}
 */
export function step(s, ev) {
  const none = { state: s, effects: [] };
  switch (ev.type) {
    case 'start': {
      if (s.mode === 'listening') {
        // tap while listening = "I'm done talking": end the list (or the answer) with what was said so far
        const st = s.session?.open ? withSession(s, { closeRequested: true }) : s;
        return { state: st, effects: [{ type: 'stopListening' }] };
      }
      if (s.mode === 'paused') return listen(withSession(s, { silentMs: 0, continuing: true }), 'list', TIMING.commandListenMs);
      if (s.session && !s.session.open && s.mode !== 'speaking') return none; // finishing up: ignore
      const pre = s.mode === 'speaking' ? [{ type: 'cancelSpeech' }] : [];
      const unasked = s.review ? s.session.held.slice(s.review.index) : [];
      if (unasked.length) pre.push({ type: 'attention', items: unasked }); // interrupted the questions: keep them
      const fresh = { ...s, review: null, session: newSession(s.session?.location ?? s.lastLocation), undo: freshUndo(s.undo.epoch + 1) };
      const l = listen(fresh, 'list', TIMING.commandListenMs);
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
        const item = s.session.held[s.review.index];
        const request = { kind: 'answer', transcript: String(ev.text).trim(), pending: item.pending, clarify: item.clarify, requestId: ev.requestId };
        return {
          state: { ...s, mode: 'working', listenKind: null, review: { ...s.review, current: request } },
          effects: [{ type: 'cue', kind: 'heard' }, { type: 'send', request }],
        };
      }

      // a list listen (first, after "and", or the grace listen after a phrase without "and")
      let st = withSession(s, { silentMs: 0 });
      if (c.kind === 'end') return chain((x) => closeList(x), maybeFinish)(st);
      if (c.kind === 'cancel') return chain((x) => closeList(x, { cancelled: true, queue: [] }), maybeFinish)(st);
      const shown = [];
      if (c.text) {
        const chunk = { kind: 'list', transcript: c.text, requestId: ev.requestId };
        st = withSession(st, { queue: [...st.session.queue, chunk], chunks: st.session.chunks + 1 });
        shown.push({ type: 'showItem', status: 'pending', text: c.text });
      }
      if (st.session.closeRequested || c.ends) {
        const out = chain((x) => closeList(x), pump, maybeFinish)(st);
        return { state: out.state, effects: [...shown, ...out.effects] };
      }
      const sent = pump(withSession(st, { continuing: c.continues }));
      const ack = c.text ? [{ type: 'cue', kind: 'heard' }] : [];
      const l = c.continues
        ? listen(sent.state, 'list', TIMING.commandListenMs)
        : listen(sent.state, 'grace', TIMING.graceListenMs); // a dropped or late "and" still continues the list
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
      const silentMs = sess.silentMs + (ev.elapsedMs ?? TIMING.commandListenMs);
      if (s.listenKind === 'list' && sess.continuing && !sess.closeRequested) {
        if (silentMs < TIMING.listPauseMs) return listen(withSession(s, { silentMs }), 'list', TIMING.commandListenMs);
        // a long pause after "and": stop reopening the mic (each start is an Android beep) until a tap
        return { state: { ...withSession(s, { silentMs }), mode: 'paused', listenKind: null }, effects: [{ type: 'cue', kind: 'paused' }] };
      }
      return chain((x) => closeList(x), maybeFinish)(withSession(s, { silentMs }));
    }

    case 'response': {
      const sess = s.session;
      if (sess?.inFlight && ev.requestId === sess.inFlight.requestId) {
        const after = (x) => (x.review?.waiting ? askHeld(x) : maybeFinish(x));
        return chain((x) => applyListResult(x, sess.inFlight, ev.result), pump, flushUndo, after)(s);
      }
      if (s.review?.current && ev.requestId === s.review.current.requestId) return applyAnswerResult(s, ev.result);
      if (s.undo.inFlight && ev.requestId === s.undo.inFlight.requestId) return applyUndoResult(s, ev.result);
      return none;
    }

    case 'spoken': {
      if (s.mode !== 'speaking' || ev.id !== s.speakId) return none;
      if (s.after === 'answer' && s.review) return listen({ ...s, review: { ...s.review, current: null } }, 'answer', TIMING.answerListenMs);
      return { state: { ...s, mode: 'idle', after: null, session: null }, effects: [] };
    }

    case 'undo': {
      if (s.undo.waiting || s.undo.inFlight || !s.undo.stack.length) return none; // busy or nothing of this session left
      // instant feedback; never speak while the mic is open (it would hear "undo")
      const cue = { type: 'cue', kind: 'undo', quiet: s.mode === 'listening' };
      if (pendingChunks(s.session)) return { state: withUndo(s, { waiting: ev.requestId }), effects: [cue] };
      const out = sendUndo(s, ev.requestId);
      return { state: out.state, effects: [cue, ...out.effects] };
    }

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
