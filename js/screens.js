// Browse screens (ADR-011): draws Places / one place / Search results / Item / Recent from the cached view.
// DOM only; the data shaping is in browse.js (tested). Every row is a big tap target that links by hash.
import { placesByArea, placeContents, itemDetail, relativeTime, shortDate } from './browse.js';

/** el('a', {class, href, text}, ...children) */
function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  n.append(...children.filter((c) => c != null && c !== false));
  return n;
}

const row = (href, main, side, sub) => el('a', { class: 'row', href },
  el('span', { class: 'row-main' }, el('span', { class: 'row-title', text: main }), sub ? el('span', { class: 'row-sub', text: sub }) : null),
  side ? el('span', { class: 'row-side', text: side }) : null);

const empty = (text) => el('p', { class: 'empty', text });
const plural = (u) => (/(ch|sh|x|s)$/.test(u) ? `${u}es` : `${u}s`);

export function renderPlaces(view) {
  const groups = placesByArea(view);
  if (!groups.length) return empty('No places yet. Say something like "pork chops in the garage freezer".');
  return el('div', {}, ...groups.map((g) => el('section', { class: 'group' },
    el('h3', { text: g.area }),
    ...g.places.map((p) => row(`#place/${encodeURIComponent(p.id)}`, p.name, p.count ? `${p.count} kind${p.count > 1 ? 's' : ''}` : 'empty')),
  )));
}

export function renderPlace(view, id, now) {
  const c = placeContents(view, id);
  if (!c) return empty('That place is gone. It may have been renamed or removed in the sheet.');
  const aka = c.place.aliases.length ? el('p', { class: 'hint', text: `Also called: ${c.place.aliases.join(', ')}` }) : null;
  if (!c.rows.length) return el('div', {}, aka, empty(`${c.place.name} is empty.`));
  return el('div', {}, aka, ...c.rows.map((r) => row(`#item/${encodeURIComponent(r.item.id)}`, r.item.name, r.amount, `since ${shortDate(r.oldest, now)}`)));
}

export function renderSearchResults(results, q) {
  if (!results.length) return empty(q.trim() ? `Nothing matches "${q.trim()}".` : 'Nothing on hand yet.');
  return el('div', {}, ...results.map(({ item, where }) => row(`#item/${encodeURIComponent(item.id)}`, item.name, item.total || 'none', where || 'none on hand')));
}

export function renderItem(view, id, now) {
  const d = itemDetail(view, id);
  if (!d) return empty('That item is gone. It may have been renamed or removed in the sheet.');
  const { item } = d;
  const facts = [
    [item.category, item.subcategory].filter(Boolean).join(' › '),
    item.tracking === 'measure' ? `kept by weight/volume (${item.unit})` : `counted${item.unit && item.unit !== 'each' ? ` in ${plural(item.unit)}` : ''}`,
    item.aliases.length ? `also called: ${item.aliases.join(', ')}` : '',
  ].filter(Boolean);
  return el('div', {},
    el('p', { class: 'total', text: item.total ? `${item.total} in all` : 'None on hand' }),
    el('p', { class: 'hint', text: facts.join(' · ') }),
    item.notes ? el('p', { class: 'hint', text: item.notes }) : null,
    ...d.places.map((p) => el('section', { class: 'group' },
      el('h3', {}, el('a', { href: `#place/${encodeURIComponent(p.place.id)}`, text: p.place.name }), el('span', { class: 'h-side', text: p.amount })),
      el('ul', { class: 'lots' }, ...p.lots.map((l) => el('li', {},
        el('span', { text: l.amount }),
        el('span', { class: 'row-sub', text: `added ${relativeTime(l.added_at, now)}${l.added_by ? ` by ${l.added_by}` : ''}` }))))),
    ));
}

/** Recent changes, newest first; own changes get an Undo button (targeted, like the Talk screen's). */
export function renderRecent(view, now, onUndo) {
  if (!view.recent.length) return empty('No changes yet.');
  return el('ul', { class: 'recent' }, ...view.recent.map((r) => el('li', { class: r.undone ? 'undone' : '' },
    el('span', { class: 'row-main' },
      el('span', { class: 'row-title', text: r.text }),
      el('span', { class: 'row-sub', text: `${relativeTime(r.at, now)}${r.user ? ` · ${r.user}` : ''}${r.undone ? ' · undone' : ''}` })),
    r.undoable ? el('button', { class: 'btn small', text: 'Undo', onclick: (e) => onUndo(r.txn_id, e.currentTarget) }) : null,
  )));
}
