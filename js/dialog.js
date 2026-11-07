// The voice conversation as a pure state machine (spec §8, list protocol ADR-009). No browser APIs:
// app.js feeds it events and carries out the effects it returns, so every rule here is unit-tested.
//
// A *session* is one spoken list. A single command is just a one-chunk list.
//   start → listening ──heard "…, and"──→ (chunk sent in the background; mic reopens at once) ─┐
//                     ←────────────────────────────────────────────────────────────────────────┘
//           ──heard "that's it" / an item without "and" / tap──→ list closed (stop cue)
//   closed + all chunks answered → review (held items asked one by one) → spoken wrap-up
//   → 4 s follow-up listen (same place carried) → idle
// Every listen/speak/request has an id; events from a stale one are ignored.
import { TIMING } from './config.js';
import { classifyUtterance } from './utterance.js';

export const LIST_SILENCE_CAP_MS = 3 * 60 * 1000;

export const TEXT = {
  gotIt: 'Got it.',
  offline: "I couldn't reach the inventory. I saved this and will retry.",
  offlineNoQueue: "I couldn't reach the inventory. That one wasn't saved.",
  notSetUp: "This phone isn't set up yet. Scan the setup code on your computer.",
  serverError: 'Something went wrong with that one.',
  okay: 'Okay.',
};

export function initialState() {
  return { mode: 'idle', listenId: 0, listenKind: null, speakId: 0, after: null, session: null, review: null, undoTxn: null, lastLocation: null };
}

function newSession(location, extra = {}) {
  return {
    location, open: true, continuing: false, chunks: 0, silentMs: 0, queue: [], inFlight: null,
    applied: [], held: [], errors: [], replies: [], skipped: 0, cancelled: false, followup: false, ...extra,
  };
}

// ---------- small builders ----------
function listen(s, kind, timeoutMs, cue) {
  const listenId = s.listenId + 1;
  const effects = cue ? [{ type: 'cue', kind: 'listening' }] : [];
  effects.push({ type: 'listen', id: listenId, kind, timeoutMs });
  return { state: { ...s, mode: 'listening', listenKind: kind, listenId }, effects };
}

function speak(s, text, after) {
  const speakId = s.speakId + 1;
  return { state: { ...s, mode: 'speaking', listenKind: null, after, speakId }, effects: [{ type: 'speak', id: speakId, text }] };
}

const withSession = (s, patch) => ({ ...s, session: { ...s.session, ...patch } });
const lower = (t) => String(t ?? '').toLowerCase();
const stripNothing = (t) => String(t ?? '').replace(/\s*Nothing was (changed|saved)\.\s*$/, '').trim();
const capitalize = (t) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);

/** Send the next queued chunk if nothing is in flight (chunks go strictly in order: the place carries over). */
function pump(s) {
  const sess = s.session;
  if (!sess || sess.inFlight || !sess.queue.length) return { state: s, effects: [] };
  const [next, ...rest] = sess.queue;
  const request = next.kind === 'undo'
    ? { kind: 'undo', requestId: next.requestId }
    : { kind: 'list', transcript: next.transcript, location: sess.location, requestId: next.requestId };
  return { state: withSession(s, { inFlight: next, queue: rest }), effects: [{ type: 'send', request }] };
}

/** One spoken wrap-up for the whole session. */
export function wrapUpText(sess) {
  const parts = [...sess.replies];
  for (const e of sess.errors) parts.push(stripNothing(e.reply));
  for (const u of sess.applied.filter((a) => a.kind === 'undo')) parts.push(u.reply);
  const saved = sess.applied.filter((a) => a.kind === 'saved');
  if (saved.length) {
    const places = [...new Set(saved.map((a) => a.place).filter(Boolean))];
    const where = places.length === 1 ? ` in the ${lower(places[0]).replace(/^the /, '')}` : '';
    parts.push(saved.length === 1 && !sess.errors.length && !sess.skipped ? TEXT.gotIt : `Got it — ${saved.length === 1 ? 'one thing' : `${saved.length} things`}${where}.`);
    const fresh = [...new Set(saved.map((a) => a.new_location).filter(Boolean))];
    if (fresh.length) parts.push(`New place${fresh.length > 1 ? 's' : ''}: ${fresh.join(', ')}.`);
  }
  if (sess.skipped) parts.push(`Skipped ${sess.skipped === 1 ? 'one' : sess.skipped}.`);
  if (!parts.length && sess.cancelled) parts.push(TEXT.okay);
  return parts.filter(Boolean).join(' ');
}

/** After the list closes and every chunk is answered: ask held items one by one, then wrap up. */
function maybeFinish(s) {
  const sess = s.session;
  if (!sess || sess.open || sess.inFlight || sess.queue.length || s.review || s.mode === 'listening' || s.mode === 'speaking') {
    return { state: s, effects: [] };
  }
  if (sess.held.length && !sess.cancelled) return askHeld({ ...s, review: { index: 0, current: null } });
  return wrapUp(s);
}

function askHeld(s) {
  const item = s.session.held[s.review.index];
  if (!item) return wrapUp({ ...s, review: null });
  return speak(s, item.question, 'answer');
}

function nextHeld(s, patch = {}) {
  return askHeld({ ...withSession(s, patch), review: { index: s.review.index + 1, current: null } });
}

function wrapUp(s) {
  const sess = s.session;
  const text = wrapUpText(sess);
  const pre = s.undoTxn ? [{ type: 'undoCountdown' }] : [];
  const next = { ...s, review: null, lastLocation: sess.location ?? s.lastLocation };
  if (!text) return { state: { ...next, mode: 'idle', session: null }, effects: pre };
  const sp = speak(next, text, sess.noFollowup ? 'idle' : 'followup');
  return { state: sp.state, effects: [...pre, ...sp.effects] };
}

function closeList(s, extra = {}) {
  if (!s.session?.open) return { state: withSession(s, extra), effects: [] };
  return { state: { ...withSession(s, { open: false, continuing: false, ...extra }), mode: 'working', listenKind: null }, effects: [{ type: 'cue', kind: 'stop' }] };
}

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

// ---------- list responses ----------
function applyListResult(s, chunk, r) {
  let sess = { ...s.session, inFlight: null };
  const effects = [];
  if (r.kind === 'network') {
    if (!sess.errors.some((e) => e.reply === TEXT.offline)) sess.errors = [...sess.errors, { reply: TEXT.offline }];
    effects.push({ type: 'cue', kind: 'problem' }, { type: 'showItem', status: 'queued', text: chunk.transcript ?? 'Undo' });
  } else if (r.kind === 'unauthorized') {
    sess = { ...sess, errors: [...sess.errors, { reply: TEXT.notSetUp }], open: false, queue: [] };
    effects.push({ type: 'cue', kind: 'problem' }, { type: 'showSetup' });
    if (s.mode === 'listening') {
      s = { ...s, mode: 'working', listenKind: null }; // close the mic: nothing more can be saved
      effects.push({ type: 'abortListening' });
    }
  } else if (r.kind !== 'ok') {
    sess.errors = [...sess.errors, { reply: r.data?.reply || TEXT.serverError }];
    effects.push({ type: 'cue', kind: 'problem' }, { type: 'showItem', status: 'error', text: r.data?.reply || TEXT.serverError });
  } else if (chunk.kind === 'undo') {
    const d = r.data;
    if (d.status === 'ok') {
      sess.applied = [...sess.applied, { kind: 'undo', reply: d.reply }];
      effects.push({ type: 'cue', kind: 'tick' }, { type: 'showItem', status: 'undo', text: d.reply });
    } else {
      sess.errors = [...sess.errors, { reply: d.reply }];
      effects.push({ type: 'cue', kind: 'problem' }, { type: 'showItem', status: 'error', text: d.reply });
    }
  } else {
    const d = r.data;
    const place = d.location?.name ?? sess.location?.name ?? null;
    sess.location = d.location ?? sess.location;
    for (const a of d.applied ?? []) {
      sess.applied = [...sess.applied, { ...a, place }];
      effects.push({ type: 'showItem', status: a.kind === 'undo' ? 'undo' : 'saved', text: a.kind === 'undo' ? a.reply : capitalize(a.summary) });
    }
    for (const h of d.held ?? []) effects.push({ type: 'showItem', status: 'held', text: h.question });
    for (const e of d.errors ?? []) effects.push({ type: 'showItem', status: 'error', text: stripNothing(e.reply) });
    sess.held = [...sess.held, ...(d.held ?? [])];
    sess.errors = [...sess.errors, ...(d.errors ?? [])];
    if (d.reply) sess.replies = [...sess.replies, d.reply];
    if (d.data) effects.push({ type: 'showData', data: d.data });
    const cue = (d.errors ?? []).length ? 'problem' : (d.held ?? []).length ? 'later' : (d.applied ?? []).length ? 'tick' : null;
    if (cue) effects.unshift({ type: 'cue', kind: cue });
    const lastSaved = [...(d.applied ?? [])].reverse().find((a) => a.kind === 'saved');
    if (lastSaved) {
      s = { ...s, undoTxn: lastSaved.txn_id };
      effects.push({ type: 'showUndo', txn: lastSaved.txn_id });
    }
  }
  return { state: { ...s, session: sess }, effects };
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
    const saved = { kind: 'saved', txn_id: r.data.txn_id, summary: r.data.reply, place: s.session.location?.name ?? null };
    patch = { applied: [...s.session.applied, saved] };
    effects.push({ type: 'cue', kind: 'tick' }, { type: 'showItem', status: 'saved', text: r.data.reply });
    if (r.data.txn_id) {
      s = { ...s, undoTxn: r.data.txn_id };
      effects.push({ type: 'showUndo', txn: r.data.txn_id });
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

/**
 * @param s   current state
 * @param ev  {type:"start"} | {type:"heard", id, text, requestId} | {type:"silence", id, elapsedMs?}
 *            | {type:"response", requestId, result} | {type:"spoken", id} | {type:"undo", requestId}
 *            | {type:"undoExpired", txn} | {type:"cancel"}
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
      if (s.session && !s.session.open && s.mode !== 'speaking') return none; // finishing up: ignore
      const pre = s.mode === 'speaking' ? [{ type: 'cancelSpeech' }] : [];
      const unasked = s.review ? s.session.held.slice(s.review.index) : [];
      if (unasked.length) pre.push({ type: 'attention', items: unasked }); // interrupted the questions: keep them
      const l = listen({ ...s, review: null, session: newSession(s.session?.location ?? s.lastLocation) }, 'list', TIMING.commandListenMs, true);
      return { state: l.state, effects: [...pre, { type: 'clearItems' }, ...l.effects] };
    }

    case 'heard': {
      if (s.mode !== 'listening' || ev.id !== s.listenId) return none;
      const c = classifyUtterance(ev.text);

      if (s.listenKind === 'answer') {
        if (c.kind === 'end' || c.kind === 'cancel') {
          const remaining = s.session.held.length - s.review.index;
          return askHeld({ ...withSession(s, { skipped: s.session.skipped + remaining }), review: { index: s.session.held.length, current: null } });
        }
        const item = s.session.held[s.review.index];
        const request = { kind: 'answer', transcript: String(ev.text).trim(), pending: item.pending, clarify: item.clarify, requestId: ev.requestId };
        return { state: { ...s, mode: 'working', listenKind: null, review: { ...s.review, current: request } }, effects: [{ type: 'send', request }] };
      }

      // a list listen (first, continuing, or follow-up)
      let st = withSession(s, { silentMs: 0 });
      if (c.kind === 'end') return chain((x) => closeList(x), maybeFinish)(st);
      if (c.kind === 'cancel') return chain((x) => closeList(x, { cancelled: true, queue: [] }), maybeFinish)(st);
      if (c.text) {
        const chunk = { kind: 'list', transcript: c.text, requestId: ev.requestId };
        st = withSession(st, { queue: [...st.session.queue, chunk], chunks: st.session.chunks + 1 });
      }
      if (c.continues && !st.session.closeRequested) {
        st = withSession(st, { continuing: true });
        const sent = pump(st);
        const l = listen(sent.state, 'list', TIMING.commandListenMs, false);
        return { state: l.state, effects: [...(c.text ? [{ type: 'showItem', status: 'pending', text: c.text }] : []), ...sent.effects, ...l.effects] };
      }
      const shown = c.text ? [{ type: 'showItem', status: 'pending', text: c.text }] : [];
      const out = chain((x) => closeList(x), pump, maybeFinish)(st);
      return { state: out.state, effects: [...shown, ...out.effects] };
    }

    case 'silence': {
      if (s.mode !== 'listening' || ev.id !== s.listenId) return none;
      if (s.listenKind === 'answer') return nextHeld(s, { skipped: s.session.skipped + 1 });
      const sess = s.session;
      if (!sess || sess.chunks === 0) {
        // nothing said at launch / in the follow-up window → quietly idle
        return { state: { ...s, mode: 'idle', listenKind: null, session: null, lastLocation: sess?.location ?? s.lastLocation }, effects: [] };
      }
      const silentMs = sess.silentMs + (ev.elapsedMs ?? TIMING.commandListenMs);
      if (sess.continuing && !sess.closeRequested && silentMs < LIST_SILENCE_CAP_MS) {
        return listen(withSession(s, { silentMs }), 'list', TIMING.commandListenMs, false); // keep waiting after "and…"
      }
      return chain((x) => closeList(x), maybeFinish)(withSession(s, { silentMs }));
    }

    case 'response': {
      const sess = s.session;
      if (sess?.inFlight && ev.requestId === sess.inFlight.requestId) {
        const out = chain((x) => applyListResult(x, sess.inFlight, ev.result), pump, maybeFinish)(s);
        return out;
      }
      if (s.review?.current && ev.requestId === s.review.current.requestId) return applyAnswerResult(s, ev.result);
      return none;
    }

    case 'spoken': {
      if (s.mode !== 'speaking' || ev.id !== s.speakId) return none;
      if (s.after === 'answer' && s.review) {
        return listen({ ...s, review: { ...s.review, current: null } }, 'answer', TIMING.answerListenMs, true);
      }
      if (s.after === 'followup') {
        const l = listen({ ...s, session: newSession(s.session?.location ?? s.lastLocation, { followup: true }) }, 'list', TIMING.followupListenMs, false);
        return l;
      }
      return { state: { ...s, mode: 'idle', after: null, session: null }, effects: [] };
    }

    case 'undo': {
      if (!s.undoTxn) return none;
      const item = { kind: 'undo', requestId: ev.requestId };
      if (s.session?.open && !s.session.followup) {
        const out = pump(withSession(s, { queue: [...s.session.queue, item] }));
        return { state: out.state, effects: [{ type: 'showItem', status: 'pending', text: 'Undo' }, ...out.effects] };
      }
      if (s.session && !s.session.open && !s.session.followup && s.mode !== 'speaking') {
        const out = pump(withSession(s, { queue: [...s.session.queue, item] }));
        return out; // still finishing a list: undo goes after the queued chunks
      }
      const pre = s.mode === 'speaking' ? [{ type: 'cancelSpeech' }] : s.mode === 'listening' ? [{ type: 'abortListening' }] : [];
      const fresh = { ...s, mode: 'working', listenKind: null, review: null, session: newSession(s.session?.location ?? s.lastLocation, { open: false, noFollowup: true }) };
      const out = pump(withSession(fresh, { queue: [item] }));
      return { state: out.state, effects: [...pre, { type: 'hideUndo' }, ...out.effects] };
    }

    case 'undoExpired':
      if (ev.txn !== s.undoTxn) return none;
      return { state: { ...s, undoTxn: null }, effects: [{ type: 'hideUndo' }] };

    case 'cancel': { // app hidden / closed: stop talking and listening; unanswered questions go to "Needs attention"
      const held = s.session?.held?.slice(s.review?.index ?? 0) ?? [];
      return {
        state: { ...initialState(), listenId: s.listenId, speakId: s.speakId, undoTxn: s.undoTxn, lastLocation: s.session?.location ?? s.lastLocation },
        effects: [{ type: 'abortListening' }, { type: 'cancelSpeech' }, ...(held.length ? [{ type: 'attention', items: held }] : [])],
      };
    }

    default:
      return none;
  }
}
