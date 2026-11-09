// Pure: combine an answer to WISP's question with the pending actions (shared by server and phone — ADR-014).

// ---------- answer mode ----------
/**
 * Combine a clarification answer with the pending actions.
 * @returns {{status:"apply", actions}|{status:"cancelled"}|{status:"reask"}|{status:"new_request", actions}}
 */
export function mergeAnswer(pending, clarify, parsed) {
  const answer = parsed.answer;
  const actions = Array.isArray(pending?.actions) ? pending.actions.map((a) => ({ ...a })) : [];
  const idx = Number.isInteger(clarify?.action_index) ? clarify.action_index : 0;
  const missing = clarify?.missing ?? [];
  const options = Array.isArray(clarify?.options) ? clarify.options : [];

  if (!answer) {
    const allCancel = parsed.actions.length && parsed.actions.every((a) => a.intent === 'cancel');
    if (allCancel) return { status: 'cancelled' };
    return parsed.actions.length && parsed.actions.some((a) => a.intent !== 'unknown')
      ? { status: 'new_request', actions: parsed.actions }
      : { status: 'reask' };
  }
  if (answer.type === 'cancel' || answer.type === 'no') return { status: 'cancelled' };
  if (answer.type === 'new_request') {
    return parsed.actions.length ? { status: 'new_request', actions: parsed.actions } : { status: 'reask' };
  }
  if (!actions[idx]) return { status: 'reask' };
  if (answer.type === 'yes') return missing.includes('confirm') ? { status: 'apply', actions } : { status: 'reask' };

  // answer.type === 'value'
  const a = actions[idx];
  const pick = answer.option_index != null ? options[answer.option_index - 1] : null;
  if (missing.includes('quantity')) {
    if (answer.quantity == null) return { status: 'reask' };
    a.quantity = answer.quantity;
    if (answer.unit) a.unit = answer.unit;
  } else if (missing.includes('lot_id')) {
    if (!pick) return { status: 'reask' };
    a.lot_id = pick.value;
  } else if (missing.includes('location') || missing.includes('to_location')) {
    const field = missing.includes('to_location') ? 'to_location' : 'location';
    if (pick && pick.value && typeof pick.value === 'object') a[field] = pick.value;
    else if (answer.location) a[field] = answer.location;
    else return { status: 'reask' };
  } else if (missing.includes('item')) {
    return { status: 'reask' };
  } else {
    return { status: 'reask' };
  }
  return { status: 'apply', actions };
}
