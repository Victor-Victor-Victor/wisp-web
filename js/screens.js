// Browse screens (ADR-011): draws Places / one place / Search results / Item / Recent from the cached view, plus the
// correction buttons and the small form dialog they use. DOM only; data shaping and the actions each button sends
// are in browse.js (tested). Rows are big tap targets that link by hash.
import { placesByArea, placeContents, itemDetail, relativeTime, shortDate } from './browse.js';

/** el('a', {class, href, text}, ...children) */
function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  n.append(...children.filter((c) => c != null && c !== false));
  return n;
}

const row = (href, main, side, sub) => el('a', { class: 'row', href },
  el('span', { class: 'row-main' }, el('span', { class: 'row-title', text: main }), sub ? el('span', { class: 'row-sub', text: sub }) : null),
  side ? el('span', { class: 'row-side', text: side }) : null);

const empty = (text) => el('p', { class: 'empty', text });
const plural = (u) => (/(ch|sh|x|s)$/.test(u) ? `${u}es` : `${u}s`);
const button = (text, onclick, extra = {}) => el('button', { class: 'btn', type: 'button', text, onclick, ...extra });

export function renderPlaces(view) {
  const groups = placesByArea(view);
  if (!groups.length) return empty('No places yet. Say something like "pork chops in the garage freezer".');
  return el('div', {}, ...groups.map((g) => el('section', { class: 'group' },
    el('h3', { text: g.area }),
    ...g.places.map((p) => row(`#place/${encodeURIComponent(p.id)}`, p.name, p.count ? `${p.count} kind${p.count > 1 ? 's' : ''}` : 'empty')),
  )));
}

/** @param act {edit(kind, target)} */
export function renderPlace(view, id, now, act) {
  const c = placeContents(view, id);
  if (!c) return empty('That place is gone. It may have been renamed or removed in the sheet.');
  const facts = [c.place.area && `in the ${c.place.area.toLowerCase()}`, c.place.type,
    c.place.aliases.length && `also called: ${c.place.aliases.join(', ')}`].filter(Boolean);
  return el('div', {},
    facts.length ? el('p', { class: 'hint', text: facts.join(' · ') }) : null,
    c.rows.length ? null : empty(`${c.place.name} is empty.`),
    ...c.rows.map((r) => row(`#item/${encodeURIComponent(r.item.id)}`, r.item.name, r.amount, `since ${shortDate(r.oldest, now)}`)),
    el('div', { class: 'actions end' }, button('Edit place', () => act.edit('place', c.place))));
}

export function renderSearchResults(results, q) {
  if (!results.length) return empty(q.trim() ? `Nothing matches "${q.trim()}".` : 'Nothing on hand yet.');
  return el('div', {}, ...results.map(({ item, where }) => row(`#item/${encodeURIComponent(item.id)}`, item.name, item.total || 'none', where || 'none on hand')));
}

/**
 * One item: totals per place with its correction buttons, and its packages.
 * @param act {change(kind, args), edit(kind, target)}
 */
export function renderItem(view, id, now, act) {
  const d = itemDetail(view, id);
  if (!d) return empty('That item is gone. It may have been renamed or removed in the sheet.');
  const { item } = d;
  const measured = item.tracking === 'measure';
  const facts = [
    [item.category, item.subcategory].filter(Boolean).join(' › '),
    measured ? `kept by weight/volume (${item.unit})` : `counted${item.unit && item.unit !== 'each' ? ` in ${plural(item.unit)}` : ''}`,
    item.aliases.length ? `also called: ${item.aliases.join(', ')}` : '',
  ].filter(Boolean);
  return el('div', {},
    el('div', { class: 'item-head' },
      el('p', { class: 'total', text: item.total ? `${item.total} in all` : 'None on hand' }),
      button('Edit item', () => act.edit('item', item), { class: 'btn small' })),
    el('p', { class: 'hint', text: facts.join(' · ') }),
    item.notes ? el('p', { class: 'hint', text: item.notes }) : null,
    item.stock.length ? null : el('p', { class: 'hint', text: `To add some, say it on Talk: "${item.name.toLowerCase()} in the pantry".` }),
    ...d.places.map((p) => {
      const args = { item, placeId: p.place.id };
      const buttons = measured
        ? [button('Use some…', () => act.change('useSome', args)), button('+ Package…', () => act.change('addPackage', args))]
        : [button('−', () => act.change('minusOne', args), { 'aria-label': `One less ${item.name}` }),
          button('+', () => act.change('plusOne', args), { 'aria-label': `One more ${item.name}` }),
          button('Set…', () => act.change('set', { ...args, current: p.amount }))];
      return el('section', { class: 'group' },
        el('h3', {}, el('a', { href: `#place/${encodeURIComponent(p.place.id)}`, text: p.place.name }), el('span', { class: 'h-side', text: p.amount })),
        el('div', { class: 'actions' }, ...buttons, button('Move…', () => act.change('move', args))),
        // the packages (and when each was added) fold away: open when needed — "Used up" lives here (0.7.1)
        p.lots.length ? el('details', { class: 'pkgs' },
          el('summary', {
            text: measured
              ? `${p.lots.length} package${p.lots.length === 1 ? '' : 's'} · oldest ${shortDate(p.oldest, now)}`
              : `Added ${p.lots.length === 1 ? 'once' : `${p.lots.length} times`} · first ${shortDate(p.oldest, now)}`,
          }),
          el('ul', { class: 'lots' }, ...p.lots.map((l) => el('li', {},
            el('span', { class: 'row-main' },
              el('span', { text: l.amount }),
              el('span', { class: 'row-sub', text: `added ${relativeTime(l.added_at, now)}${l.added_by ? ` by ${l.added_by}` : ''}` })),
            measured ? button('Used up', () => act.change('usedUp', { ...args, lotId: l.id }), { class: 'btn small' }) : null)))) : null);
    }));
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

/**
 * A small modal form. Resolves with {name: value} on Save, or null on Cancel.
 * fields: [{name, label, type: 'text'|'number'|'select'|'checkbox'|'textarea', value, options:[{value,label}],
 *          list:[...suggestions], hint, showWhen: {field, value}}]
 */
export function openForm({ title, fields, submit = 'Save' }) {
  return new Promise((resolve) => {
    const inputs = {};
    const rows = fields.map((f) => {
      let input;
      const id = `f-${f.name}`;
      if (f.type === 'select') {
        input = el('select', { id }, ...f.options.map((o) => el('option', { value: o.value, text: o.label })));
        input.value = f.value ?? f.options[0]?.value ?? '';
      } else if (f.type === 'checkbox') {
        input = el('input', { id, type: 'checkbox' });
        input.checked = Boolean(f.value);
      } else if (f.type === 'textarea') {
        input = el('textarea', { id, rows: 3 });
        input.value = f.value ?? '';
      } else {
        const listId = f.list?.length ? `${id}-list` : null;
        input = el('input', {
          id, type: 'text', autocomplete: 'off', list: listId,
          inputmode: f.type === 'number' ? 'decimal' : null, placeholder: f.placeholder ?? null,
        });
        input.value = f.value ?? '';
      }
      inputs[f.name] = input;
      const label = el('label', { class: f.type === 'checkbox' ? 'field check' : 'field', for: id },
        el('span', { text: f.label }), input, f.hint ? el('small', { text: f.hint }) : null);
      if (f.list?.length) label.append(el('datalist', { id: `${id}-list` }, ...f.list.map((v) => el('option', { value: v }))));
      return { f, label };
    });
    const sync = () => {
      for (const { f, label } of rows) {
        if (f.showWhen) label.hidden = inputs[f.showWhen.field].value !== f.showWhen.value;
      }
    };
    for (const input of Object.values(inputs)) input.addEventListener('change', sync);

    const dialog = el('dialog', { class: 'form' });
    const done = (values) => {
      dialog.close();
      dialog.remove();
      resolve(values);
    };
    const form = el('form', { method: 'dialog' },
      el('h2', { text: title }),
      ...rows.map((r) => r.label),
      el('div', { class: 'actions end' },
        button('Cancel', () => done(null)),
        el('button', { class: 'btn primary', type: 'submit', text: submit })));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const values = {};
      for (const [name, input] of Object.entries(inputs)) values[name] = input.type === 'checkbox' ? input.checked : input.value;
      done(values);
    });
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); done(null); });
    dialog.append(form);
    document.body.append(dialog);
    sync();
    dialog.showModal();
    const first = Object.values(inputs).find((i) => i.type === 'text' || i.tagName === 'SELECT');
    first?.focus();
  });
}
