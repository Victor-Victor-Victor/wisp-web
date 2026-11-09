// Pure inventory-state helpers shared by the server (sheet.js) and the phone (local.js) — ADR-014.

/**
 * Several engine diffs made one after another (list mode: one transaction per item) as one diff, so they can be
 * written with a single round of sheet calls (0.6.5). Later updates win; a row created earlier and changed later is
 * written once, as created-with-its-final-values. Pure.
 */
export function mergeChanges(list) {
  const out = {
    items: { add: [], update: [] }, locations: { add: [], update: [] }, lots: { add: [], update: [] },
    ledger: { add: [], markUndone: [] },
  };
  const upsert = (group, idKey, row) => {
    const added = group.add.findIndex((r) => r[idKey] === row[idKey]);
    if (added >= 0) { group.add[added] = row; return; }
    const updated = group.update.findIndex((r) => r[idKey] === row[idKey]);
    if (updated >= 0) group.update[updated] = row;
    else group.update.push(row);
  };
  for (const c of list) {
    out.items.add.push(...c.items.add);
    out.locations.add.push(...c.locations.add);
    out.lots.add.push(...c.lots.add);
    for (const r of c.items.update ?? []) upsert(out.items, 'item_id', r);
    for (const r of c.locations.update ?? []) upsert(out.locations, 'location_id', r);
    for (const r of c.lots.update) upsert(out.lots, 'lot_id', r);
    for (const txnId of c.ledger.markUndone) {
      const fresh = out.ledger.add.filter((r) => r.txn_id === txnId);
      if (fresh.length) fresh.forEach((r) => { r.undone = true; }); // undone within the same write
      else out.ledger.markUndone.push(txnId);
    }
    out.ledger.add.push(...c.ledger.add);
  }
  return out;
}

const asStored = (v) => (v && typeof v === 'object' ? JSON.stringify(v) : v);

/**
 * The state loadState() would return after applyChanges() — computed in memory (pure), so the cached snapshot
 * can be refreshed without re-reading the sheet. `appended` (from applyChanges) supplies the new rows' _row.
 */
export function nextState(state, changes, appended = {}) {
  const withRows = (rows, start) => rows.map((r, i) => ({ ...r, ...(start ? { _row: start + i } : {}) }));
  const updates = new Map(changes.lots.update.map((l) => [l.lot_id, l]));
  const keepRow = (map, key) => (x) => (map.has(x[key]) ? { ...map.get(x[key]), ...(x._row ? { _row: x._row } : {}) } : x);
  const itemUpdates = new Map((changes.items.update ?? []).map((i) => [i.item_id, i]));
  const locUpdates = new Map((changes.locations.update ?? []).map((l) => [l.location_id, l]));
  const undone = new Set(changes.ledger.markUndone);
  const ledgerAdds = changes.ledger.add.map((r) => ({ ...r, details: asStored(r.details), llm_usage: asStored(r.llm_usage) }));
  return {
    ...state,
    items: [...state.items.map(keepRow(itemUpdates, 'item_id')), ...withRows(changes.items.add, appended.Catalog)],
    locations: [...state.locations.map(keepRow(locUpdates, 'location_id')), ...withRows(changes.locations.add, appended.Locations)],
    lots: [
      ...state.lots.map((l) => (updates.has(l.lot_id) ? { ...updates.get(l.lot_id), ...(l._row ? { _row: l._row } : {}) } : l)),
      ...withRows(changes.lots.add, appended.Lots),
    ],
    ledger: [...state.ledger.map((r) => (undone.has(r.txn_id) ? { ...r, undone: true } : r)), ...withRows(ledgerAdds, appended.Ledger)],
  };
}
