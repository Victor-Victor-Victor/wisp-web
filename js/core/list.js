// List mode (ADR-009): one spoken chunk of a list ("a bag of peas, and…") is handled item by item.
// Confident, complete items are saved at once, each as its own transaction (so "undo" removes just the last
// one); anything that needs an amount, a choice, or a confirmation is *held* for the end-of-list review, in
// the existing answer-mode shape. The place carries over from chunk to chunk.
import { applyRequest } from './engine.js';
import { findItem, findLocation, changedWords } from './match.js';

export const LIST_CONFIDENCE = 0.75;
const WRITES = new Set(['add', 'remove', 'move', 'adjust']);

/** "added 2 bags of peas to the garage freezer" → "add 2 bags of peas to the garage freezer" (for "I heard: …"). */
function heardPhrase(summary) {
  return String(summary)
    .replace(/^added /, 'add ')
    .replace(/^took out /, 'take out ')
    .replace(/^moved /, 'move ');
}

const lowerName = (n) => String(n ?? '').toLowerCase();

/**
 * Did the parser change a word the person said? (ADR-010: code decides, from item/location `said`.)
 * @returns {string|null} the spoken confirm question, or null when nothing changed
 */
export function changedWordQuestion(state, action, transcript) {
  const item = action.item;
  const known = item ? findItem(state.items ?? [], item) : null;
  const itemChanged = item?.said
    ? changedWords(item.said, known?.name ?? item.name, known?.aliases ?? '', transcript).length > 0
    : false;
  const ref = action.intent === 'move' ? action.to_location : action.location;
  const place = ref ? findLocation(state.locations ?? [], ref) : null;
  const placeChanged = ref?.said
    ? changedWords(ref.said, place?.name ?? ref.name, place?.aliases ?? '', transcript).length > 0
    : false;
  const itemName = lowerName(known?.name ?? item?.name);
  const placeName = lowerName(place?.name ?? ref?.name).replace(/^the /, '');
  if (itemChanged && placeChanged) return `Did you mean ${itemName} in the ${placeName}?`;
  if (itemChanged) return `Did you mean ${itemName}?`;
  if (placeChanged) return `Did you mean the ${placeName}?`;
  return null;
}

function locationRef(state, ref) {
  if (!ref) return null;
  const found = findLocation(state.locations, ref);
  return found ? { name: found.name, matched_location_id: found.location_id } : { name: ref.name, matched_location_id: null };
}

/**
 * @param state   current inventory
 * @param parsed  validated parse ({actions})
 * @param opts    {transcript, listLocation, now, user, usage, commit(state, changes) => newState}
 *                commit writes one item's changes (sheet + cache) and returns the post-write state.
 * @returns {{state, applied[], held[], errors[], location, reply, data[]}}
 */
export function runList(state, parsed, { transcript, listLocation = null, now, user, usage = null, commit }) {
  let s = state;
  let usageLeft = usage;
  let location = listLocation;
  const applied = [];
  const held = [];
  const errors = [];
  const replies = [];
  const data = [];
  const run = (action) => applyRequest(s, { actions: [action], transcript }, { now, user, llmUsage: usageLeft });
  const save = (result) => {
    s = commit(s, result.changes);
    usageLeft = null; // parser usage goes on the first saved row only
  };
  if (parsed.place) location = locationRef(s, parsed.place); // "In the pantry," on its own (rules, ADR-013)
  const carry = (action) => {
    const ref = action.intent === 'move' ? action.to_location : action.location;
    if (ref) location = locationRef(s, ref);
  };

  let restated = false;
  for (const [order, original] of parsed.actions.entries()) {
    let action = original;
    const { intent } = action;
    if (intent === 'cancel') continue;
    if (intent === 'unknown') {
      // not a dead end (ADR-017, 0.9.1): asked at the end — "What did you mean?" — and the answer is a new phrase
      if (!restated) {
        const question = `I didn't catch "${transcript}". What did you mean?`;
        held.push({ kind: 'restate', question, what: transcript, location, order });
        restated = true;
      }
      continue;
    }
    if (intent === 'query' || intent === 'help') {
      const r = run(action);
      replies.push(r.reply);
      if (r.data) data.push(r.data);
      continue;
    }
    if (intent === 'undo') {
      const r = run(action);
      if (r.status === 'ok') {
        save(r);
        applied.push({ kind: 'undo', txn_id: r.txn_id, reply: r.reply });
      } else {
        errors.push({ reply: r.reply });
      }
      continue;
    }
    if (!WRITES.has(intent)) continue;

    if (intent === 'add' && !action.location && location) action = { ...action, location };
    const confident = (action.confidence ?? 1) >= LIST_CONFIDENCE;
    const changed = changedWordQuestion(s, action, transcript);
    const r = run(action);
    if (r.status === 'rejected') {
      errors.push({ reply: r.reply });
      continue;
    }
    if (r.status === 'clarify') {
      const question = confident && !changed ? r.reply : `I heard ${lowerName(action.item?.name ?? 'something')}. ${r.reply}`;
      held.push({ kind: 'clarify', question, clarify: { ...r.clarify, question }, pending: r.pending, what: action.item?.name ?? null, order });
      carry(action);
      continue;
    }
    const summary = r.changes.ledger.add[0]?.details?.summary ?? r.reply;
    if (!confident || changed) {
      const question = confident ? changed : `I heard: ${heardPhrase(summary)}. Right?`;
      held.push({
        kind: 'confirm',
        question,
        clarify: { question, missing: ['confirm'], action_index: 0 },
        pending: { transcript, actions: [action] },
        what: summary,
        order,
      });
      carry(action);
      continue;
    }
    save(r);
    applied.push({
      kind: 'saved',
      txn_id: r.txn_id,
      summary,
      reply: r.reply,
      new_location: r.changes.locations.add[0]?.name ?? null,
      new_item: r.changes.items.add[0]?.name ?? null,
      order, // where it was in the phrase: a spoken correction takes back only the last item (0.9.1)
    });
    carry(action);
  }
  return { state: s, applied, held, errors, location, reply: replies.join(' ') || null, data };
}
