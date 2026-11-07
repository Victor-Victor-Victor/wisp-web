// The voice conversation as a pure state machine (spec §8). No browser APIs: app.js feeds it events and
// carries out the effects it returns, so every rule here is unit-tested.
//
//   idle ─start→ listening(command) ─heard→ thinking ─response→ speaking ─spoken→ listening(followup|answer) | idle
//
// Every listen/speak/request has an id; events from a stale one (e.g. a listen that was aborted) are ignored.
import { TIMING } from './config.js';

export const TEXT = {
  offline: "I couldn't reach the inventory. I saved this and will retry.",
  offlineNoQueue: "I couldn't reach the inventory. Nothing was saved.",
  cancelled: 'Okay, cancelled. Nothing saved.',
  notSetUp: "This phone isn't set up yet. Scan the setup code on your computer.",
  serverError: 'Something went wrong. Nothing was saved.',
};

export function initialState() {
  return { mode: 'idle', listenKind: null, listenId: 0, speakId: 0, after: 'idle', pending: null, request: null, undoTxn: null };
}

const none = (state) => ({ state, effects: [] });

function listen(s, kind, timeoutMs, chime) {
  const listenId = s.listenId + 1;
  return {
    state: { ...s, mode: 'listening', listenKind: kind, listenId },
    effect: { type: 'listen', id: listenId, kind, timeoutMs, chime },
  };
}

function speak(s, text, after, extra = {}) {
  const speakId = s.speakId + 1;
  return {
    state: { ...s, ...extra, mode: 'speaking', after, speakId, listenKind: null, request: null },
    effect: { type: 'speak', id: speakId, text },
  };
}

const isUndoParse = (parse) => Array.isArray(parse?.actions) && parse.actions.length > 0 && parse.actions.every((a) => a.intent === 'undo');

/**
 * @param s   current state
 * @param ev  {type:"start"} | {type:"heard", id, text, requestId} | {type:"silence", id}
 *            | {type:"response", requestId, result} | {type:"spoken", id} | {type:"undo", requestId}
 *            | {type:"undoExpired", txn} | {type:"cancel"}
 * @returns {{state, effects: object[]}}
 */
export function step(s, ev) {
  switch (ev.type) {
    case 'start': {
      if (s.mode === 'thinking') return none(s);
      if (s.mode === 'listening') return { state: s, effects: [{ type: 'stopListening' }] }; // tap again = done talking
      const pre = s.mode === 'speaking' ? [{ type: 'cancelSpeech' }] : [];
      const l = listen({ ...s, pending: null }, 'command', TIMING.commandListenMs, true);
      return { state: l.state, effects: [...pre, l.effect] };
    }

    case 'heard': {
      if (s.mode !== 'listening' || ev.id !== s.listenId) return none(s);
      const text = String(ev.text ?? '').trim();
      if (!text) return step(s, { type: 'silence', id: ev.id });
      const request = s.listenKind === 'answer' && s.pending
        ? { kind: 'answer', transcript: text, pending: s.pending.pending, clarify: s.pending.clarify, requestId: ev.requestId }
        : { kind: 'command', transcript: text, requestId: ev.requestId };
      return {
        state: { ...s, mode: 'thinking', listenKind: null, request, pending: request.kind === 'answer' ? s.pending : null },
        effects: [{ type: 'send', request }],
      };
    }

    case 'silence': {
      if (s.mode !== 'listening' || ev.id !== s.listenId) return none(s);
      if (s.listenKind === 'answer') {
        const sp = speak(s, TEXT.cancelled, 'idle', { pending: null });
        return { state: sp.state, effects: [sp.effect] };
      }
      return none({ ...s, mode: 'idle', listenKind: null });
    }

    case 'response': {
      if (s.mode !== 'thinking' || !s.request || ev.requestId !== s.request.requestId) return none(s);
      const req = s.request;
      const r = ev.result;
      if (r.kind === 'network') {
        // The request runner (app.js) has already queued a failed *command* — even one whose reply arrives
        // after the app was hidden, which this machine would ignore. Answers and undos can't be replayed later.
        const sp = speak(s, req.kind === 'command' ? TEXT.offline : TEXT.offlineNoQueue, 'idle', { pending: null });
        return { state: sp.state, effects: [sp.effect] };
      }
      if (r.kind === 'unauthorized') {
        const sp = speak(s, TEXT.notSetUp, 'idle', { pending: null });
        return { state: sp.state, effects: [{ type: 'showSetup' }, sp.effect] };
      }
      if (r.kind !== 'ok') {
        const sp = speak(s, r.data?.reply || TEXT.serverError, 'idle', { pending: null });
        return { state: sp.state, effects: [sp.effect] };
      }
      const d = r.data;
      if (d.status === 'clarify') {
        const sp = speak(s, d.reply, 'answer', { pending: { pending: d.pending, clarify: d.clarify } });
        return { state: sp.state, effects: [sp.effect] };
      }
      const effects = [];
      if (d.data) effects.push({ type: 'showData', data: d.data });
      const undoable = d.status === 'ok' && Boolean(d.txn_id) && req.kind !== 'undo' && !isUndoParse(d.parse);
      if (undoable) effects.push({ type: 'showUndo', txn: d.txn_id });
      const sp = speak(s, d.reply, d.status === 'ok' ? 'followup' : 'idle', {
        pending: null,
        undoTxn: undoable ? d.txn_id : req.kind === 'undo' ? null : s.undoTxn,
      });
      return { state: sp.state, effects: [...effects, sp.effect] };
    }

    case 'spoken': {
      if (s.mode !== 'speaking' || ev.id !== s.speakId) return none(s);
      if (s.after === 'answer' && s.pending) {
        const l = listen(s, 'answer', TIMING.answerListenMs, true);
        return { state: l.state, effects: [l.effect] };
      }
      if (s.after === 'followup') {
        const l = listen(s, 'followup', TIMING.followupListenMs, false);
        return { state: l.state, effects: [l.effect] };
      }
      return none({ ...s, mode: 'idle', after: 'idle' });
    }

    case 'undo': {
      if (s.mode === 'thinking' || !s.undoTxn) return none(s);
      const pre = s.mode === 'speaking' ? [{ type: 'cancelSpeech' }] : s.mode === 'listening' ? [{ type: 'abortListening' }] : [];
      const request = { kind: 'undo', requestId: ev.requestId };
      return {
        state: { ...s, mode: 'thinking', listenKind: null, request, pending: null, undoTxn: null },
        effects: [...pre, { type: 'hideUndo' }, { type: 'send', request }],
      };
    }

    case 'undoExpired':
      if (ev.txn !== s.undoTxn) return none(s);
      return { state: { ...s, undoTxn: null }, effects: [{ type: 'hideUndo' }] };

    case 'cancel': // app hidden / closed
      return {
        state: { ...initialState(), listenId: s.listenId, speakId: s.speakId, undoTxn: s.undoTxn },
        effects: [{ type: 'abortListening' }, { type: 'cancelSpeech' }],
      };

    default:
      return none(s);
  }
}
