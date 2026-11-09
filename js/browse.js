// Browse screens (ADR-011): pure helpers over the backend's `view` snapshot — search, grouping, dates, routes, and
// the cached copy that makes the screens open instantly. No DOM here (screens.js draws); unit-tested.

/** Lowercase words without punctuation, each made singular: "Pork Chops!" → ["pork", "chop"]. */
export function words(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(singular);
}

function singular(w) {
  if (w.length <= 3) return w;
  if (w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (/(ches|shes|xes|sses|zes)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) return w.slice(0, -1);
  return w;
}

const placeById = (view, id) => view.places.find((p) => p.id === id) ?? null;
const byName = (a, b) => a.name.localeCompare(b.name);

/** Where an item is, by place name: "Garage Freezer, Kitchen Freezer". */
export function whereText(view, item) {
  return item.stock.map((s) => placeById(view, s.place_id)?.name).filter(Boolean).join(', ');
}

/**
 * Items matching what was typed: every typed word must start a word of the name, an alias, the category or the
 * subcategory. Best matches first (name, then alias, then category). An empty box lists everything on hand.
 */
export function search(view, q) {
  const want = words(q);
  const results = [];
  for (const item of view.items) {
    let rank;
    if (!want.length) {
      if (!item.stock.length) continue;
      rank = 0;
    } else {
      const fields = [[item.name], item.aliases, [item.category, item.subcategory]];
      rank = fields.findIndex((field) => {
        const have = field.flatMap(words);
        return want.every((w) => have.some((h) => h.startsWith(w)));
      });
      if (rank < 0) {
        const all = fields.flat().flatMap(words); // words spread across name + category ("frozen peas")
        if (!want.every((w) => all.some((h) => h.startsWith(w)))) continue;
        rank = 3;
      }
      if (rank === 0 && words(item.name)[0]?.startsWith(want[0])) rank = -1; // the name starts with it
    }
    results.push({ item, rank, where: whereText(view, item) });
  }
  return results
    .sort((a, b) => a.rank - b.rank || (b.item.stock.length > 0) - (a.item.stock.length > 0) || byName(a.item, b.item))
    .map(({ item, where }) => ({ item, where }));
}

/** Places grouped by area (areas A→Z, "Other" last for places with none). */
export function placesByArea(view) {
  const groups = new Map();
  for (const p of view.places) {
    const area = p.area || 'Other';
    if (!groups.has(area)) groups.set(area, []);
    groups.get(area).push(p);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === 'Other') - (b === 'Other') || a.localeCompare(b))
    .map(([area, places]) => ({ area, places: places.sort(byName) }));
}

/** What's in one place: [{item, amount, oldest}] by item name. Null if the place is unknown. */
export function placeContents(view, placeId) {
  const place = placeById(view, placeId);
  if (!place) return null;
  const rows = [];
  for (const item of view.items) {
    const s = item.stock.find((x) => x.place_id === placeId);
    if (s) rows.push({ item, amount: s.amount, oldest: s.oldest });
  }
  return { place, rows: rows.sort((a, b) => byName(a.item, b.item)) };
}

/** One item with each place it's in. Null if unknown. */
export function itemDetail(view, itemId) {
  const item = view.items.find((i) => i.id === itemId);
  if (!item) return null;
  return {
    item,
    places: item.stock.map((s) => ({ ...s, place: placeById(view, s.place_id) ?? { id: s.place_id, name: '?' } })),
  };
}

/** Find a place or item by its name (for "Open Garage Freezer" after a voice question). */
export function findByName(view, kind, name) {
  const key = words(name).join(' ');
  const list = kind === 'place' ? view?.places : view?.items;
  return list?.find((x) => words(x.name).join(' ') === key || x.aliases.some((a) => words(a).join(' ') === key)) ?? null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Nov 3" (this year) or "Nov 3, 2025". */
export function shortDate(at, now = new Date()) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const md = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === new Date(now).getFullYear() ? md : `${md}, ${d.getFullYear()}`;
}

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", then a date. */
export function relativeTime(at, now = new Date()) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const ms = new Date(now).getTime() - d.getTime();
  const min = Math.round(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(new Date(now)) - midnight(d)) / 86400000);
  if (days <= 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return shortDate(d, now);
}

/** "#place/loc_0001" → {screen:'place', id:'loc_0001'}; unknown → the Talk screen. */
export function routeOf(hash) {
  const h = String(hash ?? '').replace(/^#/, '');
  const [screen, id] = h.split('/');
  if (screen === 'places' || screen === 'search' || screen === 'recent') return { screen };
  if ((screen === 'place' || screen === 'item') && id) return { screen, id: decodeURIComponent(id) };
  return { screen: 'talk' };
}

/** Which tab is lit for a screen. */
export function tabOf(screen) {
  return { place: 'places', item: 'search' }[screen] ?? screen;
}

/** The last view, kept on the phone so the screens open at once (and offline). */
export function createViewStore(storage, key = 'wisp.view') {
  return {
    load() {
      try {
        const v = JSON.parse(storage?.getItem(key) ?? 'null');
        return v && Array.isArray(v.view?.items) && Array.isArray(v.view?.places) ? v : null;
      } catch {
        return null;
      }
    },
    save(view, fetchedAt) {
      const entry = { view, fetched_at: fetchedAt };
      try { storage?.setItem(key, JSON.stringify(entry)); } catch { /* still shown this session */ }
      return entry;
    },
  };
}

// ---------- manual corrections (ADR-011 step B): the structured actions each button sends ----------
const WEIGHT = ['lb', 'oz', 'kg', 'g'];
const VOLUME = ['fl oz', 'cup', 'pt', 'qt', 'gal', 'ml', 'l'];

/** Units offered when typing an amount of this item (its own unit first). */
export function unitChoices(item) {
  const family = WEIGHT.includes(item.unit) ? WEIGHT : VOLUME.includes(item.unit) ? VOLUME : [item.unit || 'each'];
  return [item.unit, ...family.filter((u) => u !== item.unit)].filter(Boolean);
}

function refs(view, item, placeId) {
  const place = view.places.find((p) => p.id === placeId);
  return {
    item: { matched_item_id: item.id, name: item.name },
    location: { matched_location_id: placeId, name: place?.name ?? '' },
  };
}

const positiveNumber = (v) => {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** One button's change as engine actions. Returns null when the typed values aren't usable. */
export function changeAction(view, kind, { item, placeId, lotId, qty, unit, to } = {}) {
  const r = refs(view, item, placeId);
  switch (kind) {
    case 'plusOne': return { intent: 'add', ...r, quantity: 1, unit: item.unit || 'each' };
    case 'minusOne': return { intent: 'remove', ...r, quantity: 1 };
    case 'usedUp': return { intent: 'remove', ...r, lot_ids: [lotId] };
    case 'set': {
      const raw = String(qty ?? '').trim();
      const n = Number(raw.replace(',', '.'));
      return raw !== '' && Number.isFinite(n) && n >= 0 ? { intent: 'adjust', ...r, quantity: n } : null;
    }
    case 'useSome': {
      const n = positiveNumber(qty);
      return n == null ? null : { intent: 'remove', ...r, quantity: n, unit: unit || item.unit };
    }
    case 'addPackage': {
      const n = positiveNumber(qty);
      return n == null ? null : { intent: 'add', ...r, quantity: n, unit: unit || item.unit, package_count: 1 };
    }
    case 'move': {
      const dest = view.places.find((p) => p.id === to?.id);
      const name = String(to?.name ?? '').trim();
      if (!dest && !name) return null;
      return { intent: 'move', ...r, to_location: dest ? { matched_location_id: dest.id, name: dest.name } : { name } };
    }
    default: return null;
  }
}

/** The Edit form's values → an edit action with only what changed (null when nothing did). */
export function editAction(kind, current, values) {
  const fields = kind === 'item'
    ? ['name', 'aliases', 'category', 'subcategory', 'notes', 'needs_amount', 'pkg_amount']
    : ['name', 'aliases', 'area', 'type'];
  const now = (f) => (f === 'aliases' ? current.aliases.join(', ') : current[f]);
  const set = {};
  for (const f of fields) {
    if (!(f in values)) continue;
    let v = values[f];
    if (typeof v === 'string') v = v.replace(/\s+/g, ' ').trim();
    if (f === 'aliases') v = v.split(',').map((a) => a.trim()).filter(Boolean).join(', ');
    if (String(v ?? '') === String(now(f) ?? '')) continue;
    set[f === 'pkg_amount' ? 'default_pkg_amount' : f] = v;
  }
  if (!Object.keys(set).length) return null;
  return kind === 'item' ? { intent: 'edit', item_id: current.id, set } : { intent: 'edit', location_id: current.id, set };
}

/** Categories already in use, for the Edit form's suggestions. */
export function categoriesOf(view) {
  return [...new Set(view.items.map((i) => i.category).filter(Boolean))].sort();
}
