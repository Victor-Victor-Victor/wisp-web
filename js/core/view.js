// The browse screens' data (ADR-011): one read-only snapshot of the inventory, shaped for display. It's pure and
// tested. The app caches it, searches it on the phone, and renders Places / Search / Item / Recent from it.
// Amounts are display text in each item's default unit, made by the same formatters as the spoken replies.
import { summarizeStock, parseDetails } from './engine.js';
import { formatAmount, round6 } from './units.js';
import { capitalize } from './reply.js';

const aliasList = (s) => String(s ?? '').split(',').map((a) => a.trim()).filter(Boolean);
const truthy = (v) => v === true || String(v).toUpperCase() === 'TRUE';
const iso = (v) => (v instanceof Date ? v.toISOString() : String(v ?? ''));

/** "3 packages", "2 pounds", "4" (each) — an amount on hand. */
export function amountText(qty, unit) {
  return formatAmount(round6(Number(qty) || 0), unit);
}

/**
 * @param state {items, locations, lots, ledger}
 * @param opts  {user: the person asking (decides what Recent can undo), recent: how many transactions}
 */
export function buildView(state, { user = 'owner', recent = 150 } = {}) {
  const items = state.items ?? [];
  const locations = state.locations ?? [];
  const active = (state.lots ?? []).filter((l) => l.status === 'active');
  const rows = summarizeStock(state);

  const places = locations.map((l) => ({
    id: l.location_id,
    name: l.name,
    area: l.area || '',
    type: l.type || '',
    aliases: aliasList(l.aliases),
    count: rows.filter((r) => r.location_id === l.location_id).length,
  })).sort((a, b) => a.area.localeCompare(b.area) || a.name.localeCompare(b.name));

  const viewItems = items.map((i) => {
    const mine = rows.filter((r) => r.item_id === i.item_id);
    const totalQty = mine.reduce((s, r) => s + r.qty, 0);
    return {
      id: i.item_id,
      name: i.name,
      aliases: aliasList(i.aliases),
      category: i.category || '',
      subcategory: i.subcategory || '',
      tracking: i.tracking === 'measure' ? 'measure' : 'count',
      unit: i.default_unit || '',
      needs_amount: truthy(i.needs_amount),
      pkg_amount: i.default_pkg_amount === '' || i.default_pkg_amount == null ? '' : Number(i.default_pkg_amount),
      notes: i.notes || '',
      total: mine.length ? amountText(totalQty, i.default_unit) : '',
      stock: mine.map((r) => ({
        place_id: r.location_id,
        amount: amountText(r.qty, r.unit),
        oldest: iso(r.oldest_added_at),
        lots: active
          .filter((l) => l.item_id === i.item_id && l.location_id === r.location_id)
          .sort((a, b) => iso(a.added_at).localeCompare(iso(b.added_at)))
          .map((l) => ({ id: l.lot_id, amount: amountText(l.qty, l.unit), added_at: iso(l.added_at), added_by: l.added_by || '' })),
      })),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  return { places, items: viewItems, recent: recentActivity(state.ledger ?? [], { user, limit: recent }) };
}

/** The newest transactions, one entry per txn_id, newest first. */
export function recentActivity(ledger, { user = 'owner', limit = 150 } = {}) {
  const byTxn = new Map();
  for (const r of ledger) {
    if (!r.txn_id) continue;
    if (!byTxn.has(r.txn_id)) byTxn.set(r.txn_id, []);
    byTxn.get(r.txn_id).push(r);
  }
  const summaryOf = (txnRows) => txnRows.map((r) => parseDetails(r.details).summary).filter(Boolean);
  const out = [];
  for (const [txnId, txnRows] of [...byTxn.entries()].reverse()) {
    if (out.length >= limit) break;
    const first = txnRows[0];
    const undone = txnRows.some((r) => truthy(r.undone));
    let text;
    if (first.intent === 'undo') {
      const target = parseDetails(first.details).undid;
      const what = target && byTxn.has(target) ? summaryOf(byTxn.get(target)) : [];
      text = what.length ? `Undid: ${what.join('; ')}` : 'Undid a change';
    } else {
      const parts = summaryOf(txnRows);
      text = parts.length ? capitalize(parts.join('; ')) : capitalize(String(first.intent || 'change'));
    }
    out.push({
      txn_id: txnId,
      at: iso(first.timestamp),
      user: first.user || '',
      intent: first.intent || '',
      text,
      undone,
      undoable: !undone && first.intent !== 'undo' && first.user === user,
    });
  }
  return out;
}
