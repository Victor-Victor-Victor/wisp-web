// Deterministic inventory engine (spec §7). Pure: takes the current sheet state and a request of
// structured actions (spec §6 shape), returns a reply plus a diff of rows to write. Never touches I/O.
//
// Result: { status: "ok" | "clarify" | "rejected", reply, clarify?, pending?, data?, txn_id?, changes }
// Multi-action requests are all-or-nothing: a clarify or rejection anywhere means nothing is written.
import { normalizeUnit, dimension, isMeasureUnit, canConvert, convert, round6, isZero, unitWord, formatSize } from './units.js';
import { findItem, findLocation, normalizeName, titleCase, sentenceCase } from './match.js';
import {
  capitalize, joinList, itemName, locationName, article, numberWord,
  countPhrase, packagesPhrase, totalPhrase, stockPhrase,
} from './reply.js';

const EPS = 1e-9;
const QUERY_SPOKEN_LINES = 5;
const LOCATION_TYPES = {
  freezer: 'freezer', fridge: 'fridge', refrigerator: 'fridge', pantry: 'pantry', shelf: 'shelf', shelves: 'shelf',
  drawer: 'drawer', bin: 'bin', cabinet: 'cabinet', cupboard: 'cabinet', closet: 'closet', workbench: 'workbench',
  bench: 'workbench', rack: 'rack', box: 'box', tote: 'bin',
};

class Clarify {
  constructor(question, missing, { options, pendingAction } = {}) {
    this.question = question;
    this.missing = missing;
    this.options = options;
    this.pendingAction = pendingAction;
  }
}

class Reject {
  constructor(message) {
    this.message = message;
  }
}

// ---------- small helpers ----------
function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Reject("That amount doesn't sound right. Nothing was changed.");
  return n;
}

function positive(n) {
  if (n != null && n <= 0) throw new Reject("That amount doesn't sound right. Nothing was changed.");
  return n;
}

const truthy = (v) => v === true || String(v).toUpperCase() === 'TRUE';
const hasRef = (ref) => Boolean(ref && (ref.name || ref.matched_location_id));
const locRef = (loc) => ({ name: loc.name, matched_location_id: loc.location_id, is_new: false });
const itemRef = (item) => ({ name: item.name, matched_item_id: item.item_id, is_new: false, tracking: item.tracking });

function maxId(rows, key) {
  let max = 0;
  for (const r of rows ?? []) {
    const n = parseInt(String(r[key] ?? '').split('_').pop(), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

export function parseDetails(d) {
  if (!d) return {};
  if (typeof d === 'object') return d;
  try { return JSON.parse(d); } catch { return {}; }
}

const oldestFirst = (a, b) => String(a.added_at).localeCompare(String(b.added_at)) || String(a.lot_id).localeCompare(String(b.lot_id));
const snap = (lot) => ({ qty: Number(lot.qty), location_id: lot.location_id, status: lot.status });

// ---------- workspace ----------
function workspace(state, ctx, request) {
  const clone = (rows) => (rows ?? []).map((r) => ({ ...r }));
  const w = {
    now: ctx.now,
    user: ctx.user || 'owner',
    transcript: request.transcript ?? '',
    items: clone(state.items),
    locations: clone(state.locations),
    lots: clone(state.lots),
    ledger: clone(state.ledger),
    baseLedgerLength: (state.ledger ?? []).length,
    created: { items: [], locations: [], lots: [], ledger: [] },
    createdLotIds: new Set(),
    updatedLotIds: new Set(),
    updatedItemIds: new Set(),
    updatedLocationIds: new Set(),
    undoneTxns: [],
    counters: {
      itm: maxId(state.items, 'item_id'),
      loc: maxId(state.locations, 'location_id'),
      lot: maxId(state.lots, 'lot_id'),
      txn: maxId(state.ledger, 'txn_id'),
    },
    txnId: null,
    llmUsage: ctx.llmUsage ?? null,
    llmUsageWritten: false,
  };
  return w;
}

function nextId(w, prefix) {
  w.counters[prefix] += 1;
  return `${prefix}_${String(w.counters[prefix]).padStart(4, '0')}`;
}

function txn(w) {
  if (!w.txnId) w.txnId = nextId(w, 'txn');
  return w.txnId;
}

function changesOf(w) {
  const createdItems = new Set(w.created.items.map((i) => i.item_id));
  const createdLocs = new Set(w.created.locations.map((l) => l.location_id));
  return {
    items: {
      add: w.created.items,
      update: w.items.filter((i) => w.updatedItemIds.has(i.item_id) && !createdItems.has(i.item_id)),
    },
    locations: {
      add: w.created.locations,
      update: w.locations.filter((l) => w.updatedLocationIds.has(l.location_id) && !createdLocs.has(l.location_id)),
    },
    lots: {
      add: w.created.lots,
      update: w.lots.filter((l) => w.updatedLotIds.has(l.lot_id) && !w.createdLotIds.has(l.lot_id)),
    },
    ledger: { add: w.created.ledger, markUndone: w.undoneTxns },
  };
}

const NO_CHANGES = () => ({
  items: { add: [], update: [] }, locations: { add: [], update: [] }, lots: { add: [], update: [] },
  ledger: { add: [], markUndone: [] },
});

/** Per-action record of lot before/after states (for the ledger's undo details). */
function tracker(w) {
  const before = new Map();
  return {
    touch(lot) {
      if (!before.has(lot.lot_id)) before.set(lot.lot_id, snap(lot));
      if (!w.createdLotIds.has(lot.lot_id)) w.updatedLotIds.add(lot.lot_id);
    },
    created(lot) {
      before.set(lot.lot_id, null);
    },
    details() {
      return [...before].map(([lot_id, b]) => ({
        lot_id, before: b, after: snap(w.lots.find((l) => l.lot_id === lot_id)),
      }));
    },
  };
}

// ---------- catalog / location / lot primitives ----------
function createItem(w, ref, tracking, needsAmount, defaultUnit) {
  const item = {
    item_id: nextId(w, 'itm'),
    name: sentenceCase(ref.name),
    aliases: '',
    category: ref.category || 'Other',
    subcategory: ref.subcategory || '',
    tracking,
    default_unit: defaultUnit,
    needs_amount: Boolean(needsAmount),
    default_pkg_amount: '',
    notes: '',
    created_at: w.now,
  };
  w.items.push(item);
  w.created.items.push(item);
  return item;
}

function createLocation(w, name) {
  const pretty = titleCase(name);
  const words = normalizeName(pretty).split(' ');
  const typeWord = [...words].reverse().find((x) => LOCATION_TYPES[x] || LOCATION_TYPES[x.replace(/s$/, '')]);
  const type = typeWord ? LOCATION_TYPES[typeWord] ?? LOCATION_TYPES[typeWord.replace(/s$/, '')] : '';
  const area = words.length >= 2 && !LOCATION_TYPES[words[0]] ? titleCase(words[0]) : '';
  const loc = { location_id: nextId(w, 'loc'), name: pretty, aliases: '', area, type };
  w.locations.push(loc);
  w.created.locations.push(loc);
  return loc;
}

function createLot(w, t, fields) {
  const lot = {
    lot_id: nextId(w, 'lot'),
    item_id: fields.item_id,
    location_id: fields.location_id,
    qty: round6(fields.qty),
    unit: fields.unit,
    added_at: fields.added_at ?? w.now,
    added_by: fields.added_by ?? w.user,
    expires_at: fields.expires_at ?? '',
    note: fields.note ?? '',
    status: 'active',
  };
  w.lots.push(lot);
  w.created.lots.push(lot);
  w.createdLotIds.add(lot.lot_id);
  t.created(lot);
  return lot;
}

function lotsOf(w, itemId, locId) {
  return w.lots
    .filter((l) => l.item_id === itemId && l.status === 'active' && (!locId || l.location_id === locId))
    .sort(oldestFirst);
}

/** A lot's quantity in the item's default unit (measure items), or raw count. */
function inDefault(item, lot) {
  const q = Number(lot.qty);
  if (item.tracking === 'measure' && canConvert(lot.unit, item.default_unit)) return convert(q, lot.unit, item.default_unit);
  return q;
}

function total(item, lots) {
  return round6(lots.reduce((s, l) => s + inDefault(item, l), 0));
}

function placesOf(w, item) {
  const seen = [];
  for (const lot of lotsOf(w, item.item_id)) {
    if (!seen.includes(lot.location_id)) seen.push(lot.location_id);
  }
  return seen.map((id) => w.locations.find((l) => l.location_id === id)).filter(Boolean);
}

/** Take `amount` (default unit) from lots oldest-first. Returns affected lot ids. */
function consume(t, item, lots, amount) {
  const ids = [];
  let remaining = amount;
  for (const lot of lots) {
    if (remaining <= EPS) break;
    const avail = inDefault(item, lot);
    const take = Math.min(avail, remaining);
    t.touch(lot);
    const left = round6(avail - take);
    if (isZero(left)) {
      lot.qty = 0;
      lot.status = 'depleted';
    } else {
      lot.qty = item.tracking === 'measure' && canConvert(lot.unit, item.default_unit)
        ? convert(left, item.default_unit, lot.unit)
        : left;
    }
    remaining = round6(remaining - take);
    ids.push(lot.lot_id);
  }
  return ids;
}

function requireItem(w, action) {
  const item = findItem(w.items, action.item);
  if (!item) {
    const name = String(action.item?.name ?? 'that').toLowerCase();
    throw new Reject(`I don't see any ${name} on record. Nothing was changed.`);
  }
  return item;
}

function ledgerRow(w, t, action, fields) {
  const row = {
    txn_id: txn(w),
    timestamp: w.now,
    user: w.user,
    raw_transcript: w.transcript,
    intent: fields.intent,
    item_id: fields.item_id ?? '',
    location_id: fields.location_id ?? '',
    to_location_id: fields.to_location_id ?? '',
    delta_qty: fields.delta_qty ?? '',
    unit: fields.unit ?? '',
    lot_ids_affected: (fields.lot_ids ?? []).join(','),
    reason: action.reason ?? '',
    undone: false,
    details: { summary: fields.summary, lots: t.details(), ...(fields.extra ?? {}) },
    llm_usage: '',
  };
  if (w.llmUsage && !w.llmUsageWritten) {
    row.llm_usage = w.llmUsage; // parser cost/latency, on the first row of the transaction
    w.llmUsageWritten = true;
  }
  w.ledger.push(row);
  w.created.ledger.push(row);
  return row;
}

/** Where to take an item from (remove/move). Clarifies when ambiguous or when the stated place is wrong. */
function resolveSource(w, action, item, offer) {
  const places = placesOf(w, item);
  const name = itemName(item);
  if (places.length === 0) throw new Reject(`You don't have any ${name} right now. Nothing was changed.`);
  const options = places.map((p) => ({ label: p.name, value: locRef(p) }));

  if (hasRef(action.location)) {
    const loc = findLocation(w.locations, action.location);
    if (loc && places.some((p) => p.location_id === loc.location_id)) return loc;
    const where = loc ? locationName(loc) : locationName({ name: action.location.name ?? 'that place' });
    if (places.length === 1) {
      const other = places[0];
      const have = total(item, lotsOf(w, item.item_id, other.location_id));
      const verb = have <= 1 + EPS ? 'is' : 'are';
      throw new Clarify(
        `I don't see ${name} in ${where}, but there ${verb} ${totalPhrase(have, item.default_unit, item.tracking)} in ${locationName(other)}. ${offer}`,
        ['confirm'],
        { pendingAction: { ...action, location: locRef(other) } },
      );
    }
    throw new Clarify(
      `I don't see ${name} in ${where}. Do you mean ${joinList(places.map(locationName), 'or')}?`,
      ['location'],
      { options },
    );
  }
  if (places.length === 1) return places[0];
  throw new Clarify(`From ${joinList(places.map(locationName), 'or')}?`, ['location'], { options });
}

function setZeroClarify(action, item, loc, have) {
  const stock = isZero(have) ? `no ${itemName(item)}` : stockPhrase(have, item.default_unit, item.tracking, itemName(item));
  return new Clarify(`You only have ${stock} in ${locationName(loc)}. Set it to zero?`, ['confirm'], {
    pendingAction: {
      intent: 'adjust', item: itemRef(item), location: locRef(loc), quantity: 0, unit: null, reason: action.reason ?? null,
    },
  });
}

function lotIdsOf(action) {
  if (Array.isArray(action.lot_ids) && action.lot_ids.length) return action.lot_ids;
  if (action.lot_id) return [action.lot_id];
  return null;
}

function mismatch(item, unit) {
  return new Reject(
    `${capitalize(itemName(item))} is tracked in ${unitWord(item.default_unit, 2)}, not ${unitWord(unit, 2)}. Nothing was changed.`,
  );
}

// ---------- intents ----------
function doAdd(w, action, t) {
  const ref = action.item ?? {};
  let item = findItem(w.items, ref);
  if (!item && !ref.name) throw new Reject("I didn't catch what to add. Nothing was changed.");
  const name = item ? itemName(item) : String(ref.name).trim().toLowerCase();
  if (!hasRef(action.location)) throw new Clarify(`Where should the ${name} go?`, ['location']);

  let tracking = item?.tracking ?? (ref.tracking === 'measure' ? 'measure' : 'count');
  let needsAmount = item ? truthy(item.needs_amount) : (ref.needs_amount ?? tracking === 'measure');
  let qty = positive(num(action.quantity));
  let unit = normalizeUnit(action.unit);
  let packages = positive(num(action.package_count));
  let lotsToMake;
  let defaultUnit = item?.default_unit || null;

  // A new item named by its container with no weight ("a box of rice", or "a bag" as the answer to "How much rice?"):
  // count it in those containers (spec §5: boxes → count) instead of asking for a weight the person may not know.
  if (!item && tracking === 'measure' && !(unit && isMeasureUnit(unit))) {
    const container = unit && dimension(unit) === 'count' && unit !== 'each' ? unit : null;
    if (container || packages) {
      tracking = 'count';
      needsAmount = false;
      qty = container ? (qty ?? packages ?? 1) : packages;
      unit = container ?? 'package';
    }
  }

  if (tracking === 'measure') {
    if (qty != null && unit && dimension(unit) === 'count') {
      packages = packages ?? qty; // "two packages of ground beef" — still need a size
      qty = null;
      unit = null;
    }
    if (qty == null) {
      const pkg = num(item?.default_pkg_amount);
      if (!needsAmount && pkg) {
        qty = pkg;
        unit = item.default_unit;
      } else if (action.weight_asked) {
        // the answer was a count again ("a bag"): say what's needed, and how to get out
        throw new Clarify(`${capitalize(name)} is kept by weight, so I need one, like 2 pounds. Or say skip.`, ['quantity'], {
          pendingAction: action,
        });
      } else {
        throw new Clarify(`How much ${name}?`, ['quantity'], { pendingAction: { ...action, weight_asked: true } });
      }
    }
    if (!unit || !isMeasureUnit(unit)) {
      if (defaultUnit && isMeasureUnit(defaultUnit)) unit = defaultUnit;
      else throw new Clarify(`How much ${name}, in pounds or ounces?`, ['quantity']);
    }
    if (item && !canConvert(unit, item.default_unit)) throw mismatch(item, unit);
    const n = Math.max(1, Math.round(packages ?? 1));
    lotsToMake = Array.from({ length: n }, () => ({ qty, unit }));
    defaultUnit = defaultUnit || unit;
  } else {
    if (unit && isMeasureUnit(unit)) {
      throw new Clarify(`${capitalize(name)} are counted, not weighed. How many?`, ['quantity'], {
        pendingAction: { ...action, quantity: null, unit: null },
      });
    }
    qty = qty ?? packages ?? 1;
    unit = unit || defaultUnit || 'each';
    lotsToMake = [{ qty, unit }];
    defaultUnit = defaultUnit || unit;
  }

  let newItem = false;
  if (!item) {
    item = createItem(w, ref, tracking, needsAmount, defaultUnit);
    newItem = true;
  }
  let loc = findLocation(w.locations, action.location);
  let newLoc = false;
  if (!loc) {
    if (!action.location.name) throw new Reject("I don't know that place. Nothing was changed.");
    loc = createLocation(w, action.location.name);
    newLoc = true;
  }

  const lots = lotsToMake.map((m) => createLot(w, t, {
    item_id: item.item_id, location_id: loc.location_id, qty: m.qty, unit: m.unit, expires_at: action.expires_at,
  }));
  const added = total(item, lots);
  const what = tracking === 'measure'
    ? packagesPhrase(lots.length, qty, unit, itemName(item))
    : countPhrase(qty, unit, itemName(item));
  const summary = `added ${what} to ${locationName(loc)}`;
  const now = total(item, lotsOf(w, item.item_id, loc.location_id));

  let sentence = `${capitalize(summary)}. You have ${totalPhrase(now, item.default_unit, tracking)} there now.`;
  if (newLoc) sentence += ` New location: ${loc.name}.`;
  if (newItem) sentence += ` New item, filed under ${item.category}.`;

  ledgerRow(w, t, action, {
    intent: 'add', item_id: item.item_id, location_id: loc.location_id, delta_qty: added, unit: item.default_unit,
    lot_ids: lots.map((l) => l.lot_id), summary,
    extra: { created_items: newItem ? [item.item_id] : [], created_locations: newLoc ? [loc.location_id] : [] },
  });
  return { sentence };
}

function doRemove(w, action, t) {
  const item = requireItem(w, action);
  const name = itemName(item);
  const loc = resolveSource(w, action, item, 'Take from there?');
  const lots = lotsOf(w, item.item_id, loc.location_id);
  const have = total(item, lots);
  let ids;
  let what;
  let taken;

  const chosenIds = lotIdsOf(action);
  if (chosenIds) {
    const chosen = chosenIds.map((id) => lots.find((l) => l.lot_id === id));
    if (chosen.some((l) => !l)) throw new Reject(`That package isn't in ${locationName(loc)} anymore. Nothing was changed.`);
    taken = total(item, chosen);
    const sameSize = new Set(chosen.map((l) => `${l.qty}|${l.unit}`)).size === 1;
    if (item.tracking !== 'measure') what = countPhrase(taken, chosen[0].unit, name);
    else if (sameSize) what = packagesPhrase(chosen.length, Number(chosen[0].qty), chosen[0].unit, name);
    else what = countPhrase(chosen.length, 'package', name);
    for (const lot of chosen) {
      t.touch(lot);
      lot.qty = 0;
      lot.status = 'depleted';
    }
    ids = chosenIds;
  } else if (item.tracking === 'measure') {
    let qty = positive(num(action.quantity));
    let unit = normalizeUnit(action.unit);
    let pkgCount = positive(num(action.package_count));
    if (qty != null && unit && dimension(unit) === 'count') {
      pkgCount = pkgCount ?? qty;
      qty = null;
    }
    if (qty != null) {
      if (!unit || !isMeasureUnit(unit)) unit = item.default_unit;
      if (!canConvert(unit, item.default_unit)) throw mismatch(item, unit);
      const amount = convert(qty, unit, item.default_unit);
      if (amount > have + EPS) throw setZeroClarify(action, item, loc, have);
      ids = consume(t, item, lots, amount);
      taken = amount;
      what = stockPhrase(qty, unit, 'measure', name);
    } else {
      const n = Math.max(1, Math.round(pkgCount ?? 1));
      if (n > lots.length) throw setZeroClarify(action, item, loc, have);
      const bySize = new Map();
      for (const lot of lots) {
        const key = `${round6(inDefault(item, lot))}`;
        if (!bySize.has(key)) bySize.set(key, []);
        bySize.get(key).push(lot);
      }
      if (bySize.size === 1) {
        const chosen = lots.slice(0, n);
        const size = formatSize(chosen[0].qty, chosen[0].unit);
        throw new Clarify(`${capitalize(numberWord(n))} ${size} package${n > 1 ? 's' : ''}?`, ['confirm'], {
          pendingAction: { ...action, location: locRef(loc), lot_ids: chosen.map((l) => l.lot_id) },
        });
      }
      const groups = [...bySize.values()];
      const allSingles = groups.every((g) => g.length === 1);
      const parts = groups.map((g) => {
        const s = formatSize(g[0].qty, g[0].unit);
        if (allSingles) return `${article(s)} ${s}`;
        return g.length === 1 ? `${article(s)} ${s} package` : `${numberWord(g.length)} ${s} packages`;
      });
      throw new Clarify(`You have ${joinList(parts)}${allSingles ? ' package' : ''}. Which one?`, ['lot_id'], {
        options: groups.map((g) => ({ label: formatSize(g[0].qty, g[0].unit), value: g[0].lot_id })),
        pendingAction: { ...action, location: locRef(loc) },
      });
    }
  } else {
    const n = positive(num(action.quantity)) ?? positive(num(action.package_count)) ?? 1;
    if (n > have + EPS) throw setZeroClarify(action, item, loc, have);
    ids = consume(t, item, lots, n);
    taken = n;
    what = countPhrase(n, lots[0]?.unit, name);
  }

  const left = total(item, lotsOf(w, item.item_id, loc.location_id));
  const summary = `took out ${what}`;
  const leftPhrase = isZero(left) ? 'None' : capitalize(totalPhrase(left, item.default_unit, item.tracking));
  ledgerRow(w, t, action, {
    intent: 'remove', item_id: item.item_id, location_id: loc.location_id, delta_qty: -round6(taken),
    unit: item.default_unit, lot_ids: ids, summary: `${summary} from ${locationName(loc)}`,
  });
  return { sentence: `${capitalize(summary)}. ${leftPhrase} left in ${locationName(loc)}.` };
}

function doMove(w, action, t) {
  const item = requireItem(w, action);
  const name = itemName(item);
  if (!hasRef(action.to_location)) throw new Clarify(`Move the ${name} where?`, ['to_location']);
  const src = resolveSource(w, action, item, 'Move those?');
  let dest = findLocation(w.locations, action.to_location);
  if (dest && dest.location_id === src.location_id) {
    throw new Reject(`They're already in ${locationName(dest)}. Nothing was changed.`);
  }
  const lots = lotsOf(w, item.item_id, src.location_id);
  const have = total(item, lots);

  let amount = have;
  let what = name;
  const chosenIds = lotIdsOf(action);
  let pool = lots;
  if (chosenIds) {
    pool = chosenIds.map((id) => lots.find((l) => l.lot_id === id));
    if (pool.some((l) => !l)) throw new Reject(`That package isn't in ${locationName(src)} anymore. Nothing was changed.`);
    amount = total(item, pool);
    what = countPhrase(pool.length, 'package', name);
  } else {
    let qty = positive(num(action.quantity));
    let unit = normalizeUnit(action.unit);
    if (item.tracking === 'measure' && qty != null && unit && dimension(unit) === 'count') {
      // "move two packages" → whole packages, oldest first
      const n = Math.round(qty);
      if (n > lots.length) throw moveAllClarify(action, item, src, have);
      pool = lots.slice(0, n);
      amount = total(item, pool);
      what = countPhrase(n, 'package', name);
    } else if (qty != null) {
      if (item.tracking === 'measure') {
        if (!unit || !isMeasureUnit(unit)) unit = item.default_unit;
        if (!canConvert(unit, item.default_unit)) throw mismatch(item, unit);
        amount = convert(qty, unit, item.default_unit);
        what = stockPhrase(qty, unit, 'measure', name);
      } else {
        amount = qty;
        what = countPhrase(qty, lots[0]?.unit, name);
      }
      if (amount > have + EPS) throw moveAllClarify(action, item, src, have);
    }
  }

  let newLoc = false;
  if (!dest) {
    if (!action.to_location.name) throw new Reject("I don't know that place. Nothing was changed.");
    dest = createLocation(w, action.to_location.name);
    newLoc = true;
  }

  const ids = [];
  let remaining = amount;
  for (const lot of pool) {
    if (remaining <= EPS) break;
    const avail = inDefault(item, lot);
    const take = Math.min(avail, remaining);
    t.touch(lot);
    if (isZero(avail - take)) {
      lot.location_id = dest.location_id;
      ids.push(lot.lot_id);
    } else {
      const takeInLotUnit = item.tracking === 'measure' && canConvert(lot.unit, item.default_unit)
        ? convert(take, item.default_unit, lot.unit) : take;
      lot.qty = round6(Number(lot.qty) - takeInLotUnit);
      const split = createLot(w, t, {
        item_id: item.item_id, location_id: dest.location_id, qty: takeInLotUnit, unit: lot.unit,
        added_at: lot.added_at, added_by: lot.added_by, expires_at: lot.expires_at, note: `split from ${lot.lot_id}`,
      });
      ids.push(lot.lot_id, split.lot_id);
    }
    remaining = round6(remaining - take);
  }

  const now = total(item, lotsOf(w, item.item_id, dest.location_id));
  const summary = `moved ${what} from ${locationName(src)} to ${locationName(dest)}`;
  let sentence = `${capitalize(summary)}. You have ${totalPhrase(now, item.default_unit, item.tracking)} there now.`;
  if (newLoc) sentence += ` New location: ${dest.name}.`;
  ledgerRow(w, t, action, {
    intent: 'move', item_id: item.item_id, location_id: src.location_id, to_location_id: dest.location_id,
    delta_qty: round6(amount), unit: item.default_unit, lot_ids: ids, summary,
    extra: { created_locations: newLoc ? [dest.location_id] : [] },
  });
  return { sentence };
}

function moveAllClarify(action, item, src, have) {
  const stock = stockPhrase(have, item.default_unit, item.tracking, itemName(item));
  return new Clarify(`You only have ${stock} in ${locationName(src)}. Move all of it?`, ['confirm'], {
    pendingAction: { ...action, location: locRef(src), quantity: null, unit: null, package_count: null, lot_ids: null, lot_id: null },
  });
}

function doAdjust(w, action, t) {
  const item = requireItem(w, action);
  const name = itemName(item);
  const target = num(action.quantity);
  if (target == null) {
    throw new Clarify(item.tracking === 'measure' ? `How much ${name} is there?` : `How many ${name} are there?`, ['quantity']);
  }
  if (target < 0) throw new Reject("That amount doesn't sound right. Nothing was changed.");

  let loc = null;
  let newLocName = null;
  if (hasRef(action.location)) {
    loc = findLocation(w.locations, action.location);
    if (!loc) {
      if (!action.location.name) throw new Reject("I don't know that place. Nothing was changed.");
      newLocName = action.location.name;
    }
  } else {
    const places = placesOf(w, item);
    if (places.length === 1) loc = places[0];
    else if (places.length === 0) throw new Clarify(`Where are the ${name}?`, ['location']);
    else {
      throw new Clarify(`In ${joinList(places.map(locationName), 'or')}?`, ['location'], {
        options: places.map((p) => ({ label: p.name, value: locRef(p) })),
      });
    }
  }

  let targetDefault = target;
  if (item.tracking === 'measure') {
    let unit = normalizeUnit(action.unit);
    if (!unit || !isMeasureUnit(unit)) unit = item.default_unit;
    if (!canConvert(unit, item.default_unit)) throw mismatch(item, unit);
    targetDefault = convert(target, unit, item.default_unit);
  }

  const lots = loc ? lotsOf(w, item.item_id, loc.location_id) : [];
  const current = total(item, lots);
  const delta = round6(targetDefault - current);
  if (isZero(delta) && loc) {
    return { sentence: `That's already right: ${stockPhrase(current, item.default_unit, item.tracking, name)} in ${locationName(loc)}.` };
  }
  let newLoc = false;
  if (!loc) {
    loc = createLocation(w, newLocName);
    newLoc = true;
  }

  let ids;
  if (delta > 0) {
    const lot = createLot(w, t, {
      item_id: item.item_id, location_id: loc.location_id, qty: delta, unit: item.default_unit, note: 'adjust',
    });
    ids = [lot.lot_id];
  } else {
    ids = consume(t, item, lots, -delta);
  }
  const amount = isZero(targetDefault) ? 'zero' : totalPhrase(targetDefault, item.default_unit, item.tracking);
  const summary = `set ${name} in ${locationName(loc)} to ${amount}`;
  let sentence = `Okay, ${summary}.`;
  if (newLoc) sentence += ` New location: ${loc.name}.`;
  ledgerRow(w, t, action, {
    intent: 'adjust', item_id: item.item_id, location_id: loc.location_id, delta_qty: delta,
    unit: item.default_unit, lot_ids: ids, summary,
    extra: { created_locations: newLoc ? [loc.location_id] : [] },
  });
  return { sentence };
}

function stockRows(w, filter) {
  const groups = new Map();
  for (const lot of w.lots) {
    if (lot.status !== 'active') continue;
    const item = w.items.find((i) => i.item_id === lot.item_id);
    const loc = w.locations.find((l) => l.location_id === lot.location_id);
    if (!item || !loc || !filter(item, loc)) continue;
    const key = `${item.item_id}|${loc.location_id}`;
    if (!groups.has(key)) {
      groups.set(key, {
        item_id: item.item_id, item: item.name, location_id: loc.location_id, location: loc.name,
        category: item.category, subcategory: item.subcategory, tracking: item.tracking,
        qty: 0, unit: item.default_unit, oldest_added_at: lot.added_at,
      });
    }
    const g = groups.get(key);
    g.qty = round6(g.qty + inDefault(item, lot));
    if (String(lot.added_at) < String(g.oldest_added_at)) g.oldest_added_at = lot.added_at;
  }
  return [...groups.values()].sort((a, b) =>
    String(a.category).localeCompare(String(b.category)) || a.item.localeCompare(b.item) || a.location.localeCompare(b.location));
}

/** Active stock grouped by item × location (default units), sorted by category/item/location. */
export function summarizeStock(state) {
  return stockRows({ lots: state.lots ?? [], items: state.items ?? [], locations: state.locations ?? [] }, () => true);
}

function spokenList(parts) {
  if (parts.length <= QUERY_SPOKEN_LINES) return { text: joinList(parts), more: false };
  const extra = parts.length - QUERY_SPOKEN_LINES;
  return {
    text: joinList([...parts.slice(0, QUERY_SPOKEN_LINES), `${extra} other thing${extra > 1 ? 's' : ''}`]),
    more: true,
  };
}

function doQuery(w, action) {
  const q = action.query ?? {};
  const scope = q.scope ?? (hasRef(action.location) ? 'location' : action.item?.name ? 'item' : 'all');
  const stock = (r) => stockPhrase(r.qty, r.unit, r.tracking, String(r.item).toLowerCase());

  if (scope === 'location') {
    const ref = { name: q.target ?? action.location?.name, matched_location_id: action.location?.matched_location_id };
    const loc = findLocation(w.locations, ref);
    if (!loc) return { sentence: `I don't know a place called ${String(ref.name ?? 'that').toLowerCase()}.` };
    const rows = stockRows(w, (_, l) => l.location_id === loc.location_id);
    if (!rows.length) return { sentence: `${capitalize(locationName(loc))} is empty.`, data: { scope, target: loc.name, rows } };
    const list = spokenList(rows.map(stock));
    const name = capitalize(String(loc.name).toLowerCase());
    return {
      sentence: `${name}: ${list.text}.${list.more ? ' Full list is on screen.' : ''}`,
      data: { scope, target: loc.name, rows },
    };
  }

  if (scope === 'item') {
    const ref = { name: q.target ?? action.item?.name, matched_item_id: action.item?.matched_item_id };
    const item = findItem(w.items, ref);
    if (!item) return { sentence: `I don't see any ${String(ref.name ?? 'of that').toLowerCase()} on record.` };
    const rows = stockRows(w, (i) => i.item_id === item.item_id);
    const name = itemName(item);
    if (!rows.length) return { sentence: `You don't have any ${name} right now.`, data: { scope, target: item.name, rows } };
    const parts = rows.map((r, i) => `${i === 0 ? stock(r) : totalPhrase(r.qty, r.unit, r.tracking)} in ${locationName({ name: r.location })}`);
    const list = spokenList(parts);
    return {
      sentence: `You have ${list.text}.${list.more ? ' Full list is on screen.' : ''}`,
      data: { scope, target: item.name, rows },
    };
  }

  if (scope === 'category') {
    const target = normalizeName(q.target ?? '');
    const rows = stockRows(w, (i) => normalizeName(i.category) === target || normalizeName(i.subcategory) === target);
    const label = capitalize(String(q.target ?? 'That category'));
    if (!rows.length) return { sentence: `You don't have anything under ${String(q.target ?? 'that').toLowerCase()} right now.`, data: { scope, target: q.target, rows } };
    const list = spokenList(rows.map((r) => `${stock(r)} in ${locationName({ name: r.location })}`));
    return { sentence: `${label}: ${list.text}.${list.more ? ' Full list is on screen.' : ''}`, data: { scope, target: q.target, rows } };
  }

  const rows = stockRows(w, () => true);
  if (!rows.length) return { sentence: 'The inventory is empty.', data: { scope: 'all', target: null, rows } };
  const places = new Set(rows.map((r) => r.location_id)).size;
  return {
    sentence: rows.length === 1
      ? `You have 1 kind of thing, in ${locationName({ name: rows[0].location })}. Full list is on screen.`
      : `You have ${rows.length} kinds of things in ${places} place${places > 1 ? 's' : ''}. Full list is on screen.`,
    data: { scope: 'all', target: null, rows },
  };
}

function doUndo(w, action, t) {
  let row = null;
  if (action.txn_id) {
    // Targeted (the app's Undo button): exactly this transaction, never an older one (ADR-010).
    const target = String(action.txn_id);
    row = w.ledger.slice(0, w.baseLedgerLength).find((r) => r.txn_id === target && r.intent !== 'undo') ?? null;
    if (!row || row.user !== w.user) throw new Reject("I couldn't find that change.");
    if (truthy(row.undone)) throw new Reject("That's already undone.");
  } else {
    for (let i = w.baseLedgerLength - 1; i >= 0; i--) {
      const r = w.ledger[i];
      if (r.user === w.user && !truthy(r.undone) && r.intent !== 'undo') {
        row = r;
        break;
      }
    }
  }
  if (!row) throw new Reject("There's nothing to undo.");
  const txnId = row.txn_id;
  const rows = w.ledger.filter((r) => r.txn_id === txnId);

  const firstBefore = new Map();
  const lastAfter = new Map();
  for (const r of rows) {
    for (const c of parseDetails(r.details).lots ?? []) {
      if (!firstBefore.has(c.lot_id)) firstBefore.set(c.lot_id, c.before);
      lastAfter.set(c.lot_id, c.after);
    }
  }
  for (const [id, after] of lastAfter) {
    const lot = w.lots.find((l) => l.lot_id === id);
    const same = lot && after && round6(Number(lot.qty)) === round6(Number(after.qty))
      && lot.location_id === after.location_id && lot.status === after.status;
    if (!same) throw new Reject("I can't safely undo that, because those items changed since. Nothing was changed.");
  }
  const edits = rows.map((r) => parseDetails(r.details).edit).filter(Boolean);
  for (const e of edits) {
    const target = editTarget(w, e.kind, e.id);
    if (!target || Object.entries(e.after).some(([k, v]) => String(target[k] ?? '') !== String(v ?? ''))) {
      throw new Reject("I can't safely undo that, because it was changed again since. Nothing was changed.");
    }
  }
  for (const e of edits) {
    const target = editTarget(w, e.kind, e.id);
    Object.assign(target, e.before);
    (e.kind === 'item' ? w.updatedItemIds : w.updatedLocationIds).add(e.id);
  }
  for (const [id, before] of firstBefore) {
    const lot = w.lots.find((l) => l.lot_id === id);
    t.touch(lot);
    if (before == null) {
      lot.status = 'undone';
    } else {
      lot.qty = before.qty;
      lot.location_id = before.location_id;
      lot.status = before.status;
    }
  }
  for (const r of rows) r.undone = true;
  w.undoneTxns.push(txnId);

  const summaries = rows.map((r) => parseDetails(r.details).summary).filter(Boolean);
  const what = summaries.length ? joinList(summaries) : 'the last change';
  ledgerRow(w, t, action, {
    intent: 'undo', item_id: row.item_id, location_id: row.location_id, lot_ids: [...firstBefore.keys()],
    summary: `undid ${txnId}`, extra: { undid: txnId },
  });
  return { sentence: `Undid that: ${what}.` };
}

// ---------- edit (from the app's Edit screens only; the parser can't produce it — ADR-011) ----------
const EDITABLE = {
  item: { name: 60, aliases: 200, category: 40, subcategory: 40, needs_amount: 0, default_pkg_amount: 0, notes: 300, tracking: 0, default_unit: 0 },
  location: { name: 60, aliases: 200, area: 40, type: 40 },
};

function editTarget(w, kind, id) {
  return kind === 'item' ? w.items.find((i) => i.item_id === id) : w.locations.find((l) => l.location_id === id);
}

const cleanText = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanAliases = (v) => (Array.isArray(v) ? v : String(v ?? '').split(','))
  .map((a) => cleanText(a, 60)).filter(Boolean).join(', ').slice(0, 200);

function editValue(field, v, max) {
  if (field === 'aliases') return cleanAliases(v);
  if (field === 'needs_amount') return v === true || String(v).toUpperCase() === 'TRUE';
  if (field === 'default_pkg_amount') {
    const n = positive(num(v));
    return n == null ? '' : n;
  }
  if (field === 'tracking') return v === 'measure' ? 'measure' : 'count';
  if (field === 'default_unit') return normalizeUnit(cleanText(v, 20)) || 'each';
  return cleanText(v, max);
}

/** Names and aliases (normalised) used by everything else of this kind. */
function namesTaken(list, idKey, exceptId) {
  const taken = new Map();
  for (const x of list) {
    if (x[idKey] === exceptId) continue;
    for (const n of [x.name, ...String(x.aliases ?? '').split(',')]) {
      const key = normalizeName(n);
      if (key) taken.set(key, x.name);
    }
  }
  return taken;
}

function doEdit(w, action, t) {
  const kind = action.item_id ? 'item' : action.location_id ? 'location' : null;
  const target = kind && editTarget(w, kind, String(kind === 'item' ? action.item_id : action.location_id));
  if (!target) throw new Reject("I couldn't find that. It may have been changed in the sheet. Nothing was changed.");
  const set = action.set && typeof action.set === 'object' ? action.set : {};
  const before = {};
  const after = {};
  for (const [field, max] of Object.entries(EDITABLE[kind])) {
    if (!(field in set)) continue;
    const value = editValue(field, set[field], max);
    if (String(value) === String(target[field] ?? '')) continue;
    before[field] = target[field] ?? '';
    after[field] = value;
  }
  const label = kind === 'item' ? 'item' : 'place';
  if ('name' in after && !after.name) throw new Reject(`The ${label} needs a name. Nothing was changed.`);
  const names = [after.name ?? target.name, ...String(after.aliases ?? target.aliases ?? '').split(',')];
  const taken = kind === 'item' ? namesTaken(w.items, 'item_id', target.item_id) : namesTaken(w.locations, 'location_id', target.location_id);
  for (const n of names) {
    const other = taken.get(normalizeName(n));
    if (other && ('name' in after || 'aliases' in after)) {
      throw new Reject(`There's already ${kind === 'item' ? 'an item' : 'a place'} called ${other}. Nothing was changed.`);
    }
  }
  // counted/weighed and the unit (ADR-014: the phone has no Sheet to do it in) — only while none is on hand, since
  // existing packages are in the old unit
  if (kind === 'item' && ('tracking' in after || 'default_unit' in after)) {
    if (lotsOf(w, target.item_id).length) {
      throw new Reject(`You can change how ${itemName(target)} is measured only when none is on hand. Nothing was changed.`);
    }
    const tracking = after.tracking ?? target.tracking;
    const unit = after.default_unit ?? target.default_unit;
    if (tracking === 'measure' ? !isMeasureUnit(unit) : isMeasureUnit(unit)) {
      throw new Reject(tracking === 'measure'
        ? 'A weighed item needs a weight or volume unit, like pounds. Nothing was changed.'
        : 'A counted item needs a count word, like package or box. Nothing was changed.');
    }
  }
  const fields = Object.keys(after);
  if (!fields.length) return { sentence: 'Nothing to change.' };

  const oldName = String(target.name);
  Object.assign(target, after);
  (kind === 'item' ? w.updatedItemIds : w.updatedLocationIds).add(kind === 'item' ? target.item_id : target.location_id);
  const what = kind === 'item' ? oldName.toLowerCase() : locationName({ name: oldName });
  const others = fields.filter((f) => f !== 'name').map((f) => f.replace(/_/g, ' '));
  const parts = [];
  if ('name' in after) parts.push(`renamed ${what} to ${kind === 'item' ? after.name.toLowerCase() : locationName({ name: after.name })}`);
  if (others.length) parts.push(`${parts.length ? 'and changed' : `changed ${what}:`} ${joinList(others)}`);
  const summary = parts.join(' ');
  ledgerRow(w, t, action, {
    intent: 'edit',
    item_id: kind === 'item' ? target.item_id : '',
    location_id: kind === 'location' ? target.location_id : '',
    summary,
    extra: { edit: { kind, id: kind === 'item' ? target.item_id : target.location_id, before, after } },
  });
  return { sentence: `${capitalize(summary)}.` };
}

// Spoken on "help" / "what can I say?" (Phase 5): short enough to listen to, the rest is in ⚙ and the README guide.
export const HELP = 'Say the place, then the things, like: in the garage freezer, two packs of pork chops. '
  + 'For a list, say "and" after each item, then "that\'s it". '
  + 'You can also ask, like: what\'s in the pantry? '
  + 'Tap Undo to take back the last thing, and use the tabs at the bottom to look around and fix things.';

function runAction(w, action) {
  const intent = String(action?.intent ?? 'unknown').toLowerCase();
  const t = tracker(w);
  switch (intent) {
    case 'add': return doAdd(w, action, t);
    case 'remove': return doRemove(w, action, t);
    case 'move': return doMove(w, action, t);
    case 'adjust': return doAdjust(w, action, t);
    case 'query': return doQuery(w, action);
    case 'undo': return doUndo(w, action, t);
    case 'edit': return doEdit(w, action, t);
    case 'help': return { sentence: HELP };
    default: return { sentence: "Sorry, I didn't get that. Nothing was changed." };
  }
}

/**
 * Apply a request to the inventory.
 * @param {{items,locations,lots,ledger}} state  current sheet rows (ledger.details may be JSON strings)
 * @param {{actions: object[], transcript?: string}} request
 * @param {{now: string, user?: string}} ctx  now = ISO timestamp
 */
export function applyRequest(state, request, ctx) {
  const actions = Array.isArray(request?.actions) ? request.actions : [];
  if (!actions.length) {
    return { status: 'rejected', reply: "I didn't get anything to do. Nothing was changed.", changes: NO_CHANGES() };
  }
  const w = workspace(state, ctx, request ?? {});
  const sentences = [];
  const data = [];
  for (let i = 0; i < actions.length; i++) {
    try {
      const res = runAction(w, actions[i] ?? {});
      sentences.push(res.sentence);
      if (res.data) data.push(res.data);
    } catch (e) {
      if (e instanceof Clarify) {
        return {
          status: 'clarify',
          reply: e.question,
          clarify: { question: e.question, missing: e.missing, action_index: i, ...(e.options ? { options: e.options } : {}) },
          pending: {
            transcript: request.transcript ?? '',
            actions: actions.map((a, j) => (j === i && e.pendingAction ? e.pendingAction : a)),
          },
          changes: NO_CHANGES(),
        };
      }
      if (e instanceof Reject) {
        const wroteEarlier = w.created.ledger.length > 0;
        const reply = wroteEarlier && !/Nothing was (changed|saved)/.test(e.message)
          ? `${e.message} Nothing was saved.`
          : e.message.replace('Nothing was changed.', wroteEarlier ? 'Nothing was saved.' : 'Nothing was changed.');
        return { status: 'rejected', reply, changes: NO_CHANGES() };
      }
      throw e;
    }
  }
  return {
    status: 'ok',
    reply: sentences.join(' '),
    ...(data.length ? { data: data.length === 1 ? data[0] : data } : {}),
    txn_id: w.created.ledger.length ? w.txnId : null,
    changes: changesOf(w),
  };
}
