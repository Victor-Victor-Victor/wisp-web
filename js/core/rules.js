// Rules-first parser (ADR-013): understands everyday phrases in code — instantly, offline and for free — and hands
// everything else to the LLM. The rule: either every word of the phrase is understood and every name matches the
// catalog or a place exactly (name or alias, via match.js), or the result is null. It never guesses.
// Output has the exact shape parser.js validateParse() returns, so list.js, mergeAnswer and the engine don't care
// which parser ran. Pure; no Apps Script — shared by the server and the phone (web/js/core, ADR-014).
// Phone mode (`allowNew`, ADR-014): with no AI to hand off to, a clear sentence with an unknown item or place becomes
// a *new* item/place at low confidence, so list mode asks "I heard: … Right?" before saving anything.
import { findByName, normalizeName } from './match.js';
import { normalizeUnit } from './units.js';

const CONFIDENCE = 0.95;
const UNSURE = 0.6; // below list.js LIST_CONFIDENCE: asked before it's saved

// Options for the parse in progress (parsing is synchronous, so a module-level slot is safe).
let CTX = { allowNew: false, problem: null };

// ---------- words ----------
const CONTRACTIONS = [
  [/\bwhat'?s\b/g, 'what is'], [/\bwhere'?s\b/g, 'where is'], [/\bthere'?s\b/g, 'there is'], [/\bwe'?re\b/g, 'we are'],
  [/\bi'm\b/g, 'i am'], [/\bit'?s\b/g, 'it is'], [/\bthat'?s\b/g, 'that is'], [/\bdon'?t\b/g, 'do not'],
  [/\bdoesn'?t\b/g, 'does not'], [/\bisn'?t\b/g, 'is not'], [/\baren'?t\b/g, 'are not'], [/\bwe'?ve\b/g, 'we have'],
  [/\bi'?ve\b/g, 'i have'], [/\bthey'?re\b/g, 'they are'], [/\bcan'?t\b/g, 'can not'], [/\bwon'?t\b/g, 'will not'],
];

/** "WISP, what's in the Garage Freezer?" → ["wisp", ",", "what", "is", "in", "the", "garage", "freezer"] */
export function tokenize(text) {
  let s = String(text ?? '').toLowerCase().replace(/[’‘`]/g, "'");
  s = s.replace(/(\d)-(?=[a-z])/g, '$1 '); // "1-pound" → "1 pound"
  for (const [re, to] of CONTRACTIONS) s = s.replace(re, to);
  s = s.replace(/,/g, ' , ').replace(/[^a-z0-9.,' ]+/g, ' ');
  return s.split(/\s+/)
    .map((t) => (/^\d+(\.\d+)?$/.test(t) ? t : t.replace(/[.']/g, '')))
    .filter(Boolean);
}

const WAKE = new Set(['wisp', 'whisp', 'wasp']);
const MAYBE_WAKE = new Set(['with', 'west']); // misheard wake words: only dropped if the rest then parses
const LEAD_FILLER = new Set(['um', 'umm', 'uh', 'uhm', 'hmm', 'okay', 'ok', 'so', 'hey', 'actually', 'also', 'oh', 'well', 'and', ',']);
const NEGATION = new Set(['not', 'no', 'never', 'without', 'nothing', 'none']);
const SEP = new Set([',', 'and']);

function trimFiller(toks) {
  let t = toks.filter((w) => w !== 'please');
  let changed = true;
  while (changed && t.length) {
    changed = false;
    if (LEAD_FILLER.has(t[0]) || WAKE.has(t[0])) { t = t.slice(1); changed = true; }
  }
  while (t.length && (t[t.length - 1] === ',' || t[t.length - 1] === 'and')) t = t.slice(0, -1);
  return t;
}

const joinWords = (toks) => toks.filter((w) => w !== ',').join(' ');
const eq = (toks, phrase) => joinWords(toks) === phrase;

// ---------- amounts ----------
const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};
const MEASURE_WORDS = new Set([
  'lb', 'lbs', 'pound', 'pounds', 'oz', 'ounce', 'ounces', 'gram', 'grams', 'kg', 'kilo', 'kilos', 'kilogram',
  'kilograms', 'cup', 'cups', 'pint', 'pints', 'quart', 'quarts', 'gallon', 'gallons', 'liter', 'liters', 'litre',
  'litres', 'ml', 'milliliter', 'milliliters', 'teaspoon', 'teaspoons', 'tablespoon', 'tablespoons',
]);
const COUNT_WORDS = {
  package: 'package', packages: 'package', pack: 'package', packs: 'package', packet: 'package', packets: 'package',
  bag: 'bag', bags: 'bag', can: 'can', cans: 'can', box: 'box', boxes: 'box', bottle: 'bottle', bottles: 'bottle',
  jar: 'jar', jars: 'jar', carton: 'carton', cartons: 'carton', roll: 'roll', rolls: 'roll', loaf: 'loaf',
  loaves: 'loaf', tin: 'tin', tins: 'tin', tub: 'tub', tubs: 'tub', container: 'container', containers: 'container',
  case: 'case', cases: 'case', sack: 'sack', sacks: 'sack', bunch: 'bunch', bunches: 'bunch',
};
const PACKAGE_WORDS = new Set(['package', 'packages', 'pack', 'packs', 'packet', 'packets']);

/** A number at t[i]: {value, next} or null. "a"/"an" count as 1 only when told to. */
function numberAt(t, i, { article = true } = {}) {
  const w = t[i];
  if (w == null) return null;
  if (/^\d+(\.\d+)?$/.test(w)) return withHalf(t, Number(w), i + 1);
  if (w in NUMBER_WORDS) return withHalf(t, NUMBER_WORDS[w], i + 1);
  if ((w === 'a' || w === 'an') && t[i + 1] === 'couple') return { value: 2, next: t[i + 2] === 'of' ? i + 3 : i + 2 };
  if (w === 'a' && t[i + 1] === 'few') return { value: 3, next: t[i + 2] === 'of' ? i + 3 : i + 2 };
  if (w === 'a' && t[i + 1] === 'dozen') return { value: 12, next: t[i + 2] === 'of' ? i + 3 : i + 2 };
  if (w === 'half' && (t[i + 1] === 'a' || t[i + 1] === 'an')) return { value: 0.5, next: i + 2 };
  if (article && (w === 'a' || w === 'an')) return { value: 1, next: i + 1 };
  return null;
}

/** "one and a half" → 1.5 */
function withHalf(t, value, next) {
  if (t[next] === 'and' && t[next + 1] === 'a' && t[next + 2] === 'half') return { value: value + 0.5, next: next + 3 };
  return { value, next };
}

/** A unit at t[i]: {unit, next} or null ("fluid ounces" is two words). */
function unitAt(t, i) {
  if (t[i] === 'fluid' && /^ounces?$/.test(t[i + 1] ?? '')) return { unit: 'fl oz', next: i + 2 };
  if (MEASURE_WORDS.has(t[i])) return { unit: normalizeUnit(t[i]), next: i + 1 };
  if (t[i] in COUNT_WORDS) return { unit: COUNT_WORDS[t[i]], next: i + 1 };
  return null;
}

/**
 * An amount at the start of t: {quantity, unit, package_count, next}. Nothing said → quantity/unit null, next 0.
 * Returns null for amounts it can't read with certainty (a unit without a number, a number without anything after).
 */
function amountAt(t, i = 0) {
  const n = numberAt(t, i);
  if (!n) {
    if (unitAt(t, i)) return null; // "bag of peas": no number — let the LLM decide
    return { quantity: null, unit: null, package_count: null, next: i };
  }
  let j = n.next;
  // "two 1-pound packages of ground beef": count × size
  const size = numberAt(t, j, { article: false });
  if (size) {
    const u = unitAt(t, size.next);
    if (u && MEASURE_WORDS.has(t[size.next]) && PACKAGE_WORDS.has(t[u.next])) {
      j = u.next + 1;
      if (t[j] === 'of') j += 1;
      return Number.isInteger(n.value) ? { quantity: size.value, unit: u.unit, package_count: n.value, next: j } : null;
    }
    return null; // two numbers in a row
  }
  const u = unitAt(t, j);
  let quantity = n.value;
  let unit = null;
  if (u) {
    unit = u.unit;
    j = u.next;
    if (t[j] === 'and' && t[j + 1] === 'a' && t[j + 2] === 'half') { quantity += 0.5; j += 3; } // "a pound and a half"
    if (t[j] === 'of') j += 1;
  } else if (t[j] === 'of') {
    j += 1; // "two of the pork chops"
  }
  return { quantity, unit, package_count: null, next: j };
}

// ---------- names ----------
const PLACE_PREPS = new Set(['in', 'into', 'inside', 'on', 'onto', 'to', 'at']);

function itemRef(item, said) {
  return {
    name: item.name,
    said,
    matched_item_id: item.item_id,
    is_new: false,
    category: item.category || null,
    subcategory: item.subcategory || null,
    tracking: item.tracking === 'measure' ? 'measure' : 'count',
    needs_amount: item.needs_amount === true || String(item.needs_amount).toUpperCase() === 'TRUE',
  };
}

const placeRef = (loc, said) => ({ name: loc.name, said, matched_location_id: loc.location_id, is_new: false });
const listRef = (l) => {
  if (l?.matched_location_id) return { name: l.name, said: null, matched_location_id: l.matched_location_id, is_new: false };
  // phone mode: a new place named earlier in this list ("In the attic,") — still new until the first item is confirmed
  return CTX.allowNew && l?.name ? { name: l.name, said: null, matched_location_id: null, is_new: true } : null;
};

/** Exactly a known place (name or alias): {loc, said} or null. */
function placeOf(state, toks) {
  if (!toks.length || toks.some((w) => w === ',' || w === 'and')) return null;
  const loc = findByName(state.locations ?? [], toks.join(' '));
  return loc ? { loc, said: toks.filter((w) => w !== 'the').join(' ') } : null;
}

// ---------- phone mode: new names ----------
const NOT_A_NAME = new Set([
  'it', 'that', 'this', 'them', 'those', 'these', 'something', 'stuff', 'thing', 'things', 'everything', 'anything',
  'what', 'which', 'who', 'there', 'here', 'me', 'you', 'us', 'and', 'or', 'but', 'if', 'then', 'in', 'on', 'into',
  'to', 'from', 'out', 'of', 'at', 'for', 'with', 'put', 'took', 'take', 'used', 'use', 'move', 'add', 'got', 'get',
  'bought', 'have', 'has', 'had', 'is', 'are', 'was', 'were', 'be', 'do', 'did', 'does', 'can', 'will', 'would',
  'should', 'need', 'want', 'like', 'go', 'going', 'gonna', 'just', 'um', 'uh', 'okay', 'ok', 'so', 'please', 'yes', 'no',
]);
const ARTICLES = new Set(['the', 'a', 'an', 'some', 'my', 'our', 'any']);

/** Plain words that could name a new item or place: 1–5 letters-only words, none of them pronouns, verbs or links. */
function plainName(toks) {
  const words = toks.filter((w, i) => !(i === 0 && ARTICLES.has(w)));
  if (!words.length || words.length > 5) return null;
  if (words.some((w) => !/^[a-z][a-z'-]*$/.test(w) || NOT_A_NAME.has(w) || NUMBER_WORDS[w] != null)) return null;
  return words.join(' ');
}

const titleWords = (s) => s.replace(/\b([a-z])/g, (m) => m.toUpperCase());
const sayList = (names) => (names.length === 2 ? `${names[0]} or ${names[1]}` : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`);

/**
 * A place in phone mode: known (exact) → that; part of exactly one known name ("the workbench" for Garage
 * Workbench) → that, unsure; part of several ("the freezer") → null with CTX.problem set; else a new place, unsure.
 * @returns {{ref, unsure}|null}
 */
function placeRefOf(state, toks) {
  const exact = placeOf(state, toks);
  if (exact) return { ref: placeRef(exact.loc, exact.said), unsure: false };
  if (!CTX.allowNew) return null;
  const name = plainName(toks);
  if (!name) return null;
  const words = normalizeName(name).split(' ');
  const containing = (state.locations ?? []).filter((l) => {
    const have = normalizeName(l.name).split(' ');
    return words.every((w) => have.includes(w));
  });
  if (containing.length === 1) return { ref: placeRef(containing[0], name), unsure: true };
  if (containing.length > 1) {
    CTX.problem = `Which ${name}? Say ${sayList(containing.map((l) => l.name.toLowerCase()))}.`;
    return null;
  }
  return { ref: { name: titleWords(name), said: name, matched_location_id: null, is_new: true }, unsure: true };
}

/** Exactly a known item: {item, said} or null. */
function itemOf(state, toks) {
  if (!toks.length || toks[0] === 'and' || toks.some((w) => w === ',' || NUMBER_WORDS[w] != null || /^\d/.test(w))) return null;
  const item = findByName(state.items ?? [], toks.join(' '));
  if (!item) return null;
  const said = toks.filter((w) => !['the', 'some', 'any', 'my', 'our'].includes(w)).join(' ');
  return { item, said };
}

/** One item with its amount: "two bags of peas", "half a pound of the ground beef", "the chops". */
function itemPhrase(state, toks) {
  const a = amountAt(toks);
  if (!a) return null;
  const rest = toks.slice(a.next);
  let found = itemOf(state, rest);
  if (!found && CTX.allowNew) {
    const name = plainName(rest); // phone mode: a new item, asked about before it's saved
    if (name) found = { item: null, said: name, newName: name };
  }
  if (!found) return null;
  return { ...found, quantity: a.quantity, unit: a.unit, package_count: a.package_count };
}

/**
 * Several items: split on "and" / commas only where every part is a known item; fewer parts win (a name with
 * "and" in it stays whole). Ambiguous splits → null.
 */
function itemList(state, toks) {
  const memo = new Map();
  const best = (i) => {
    if (memo.has(i)) return memo.get(i);
    let start = i;
    while (start < toks.length && SEP.has(toks[start])) start += 1;
    let result = null;
    if (start >= toks.length) result = { parts: [], ways: 1 };
    else {
      for (let j = toks.length; j > start; j--) {
        if (j < toks.length && !SEP.has(toks[j])) continue;
        const part = itemPhrase(state, toks.slice(start, j));
        if (!part) continue;
        const rest = best(j);
        if (!rest) continue;
        const cand = { parts: [part, ...rest.parts], ways: rest.ways };
        const score = (r) => r.parts.filter((p) => !p.item).length * 100 + r.parts.length; // known names first
        if (!result || score(cand) < score(result)) result = cand;
        else if (score(cand) === score(result)) result = { ...result, ways: result.ways + cand.ways };
      }
    }
    memo.set(i, result);
    return result;
  };
  if (!toks.length || SEP.has(toks[0])) return null;
  const r = best(0);
  return r && r.parts.length && r.ways === 1 ? r.parts : null;
}

/** A place right after a preposition at t[i]: longest match. {ref, unsure, next} or null. */
function placeAfter(state, t, i) {
  if (!PLACE_PREPS.has(t[i]) && t[i] !== 'from') return null;
  for (let j = t.length; j > i + 1; j--) {
    const p = placeOf(state, t.slice(i + 1, j));
    if (p) return { ref: placeRef(p.loc, p.said), unsure: false, next: j };
  }
  if (!CTX.allowNew) return null;
  for (let j = t.length; j > i + 1; j--) {
    if (j < t.length && !SEP.has(t[j]) && !REASON_START.has(t[j])) continue;
    const p = placeRefOf(state, t.slice(i + 1, j));
    if (p) return { ...p, next: j };
  }
  return null;
}

// ---------- actions ----------
const action = (intent, o = {}) => ({
  intent, item: null, quantity: null, unit: null, package_count: null, location: null, to_location: null,
  reason: null, query: null, confidence: CONFIDENCE, ...o,
});
const fromPart = (p, intent, extra = {}, unsurePlace = false) => action(intent, {
  item: p.item ? itemRef(p.item, p.said) : newItemRef(p, extra.location ?? extra.to_location),
  quantity: p.quantity, unit: p.unit, package_count: p.package_count, ...extra,
  confidence: p.item && !unsurePlace ? CONFIDENCE : UNSURE,
});

/** A new item (phone mode): counted unless a weight or volume was said; category from its name or its place. */
function newItemRef(p, place) {
  const weighed = Boolean(p.unit && !Object.values(COUNT_WORDS).includes(p.unit));
  const { category, subcategory } = guessCategory(p.newName, place?.name ?? '');
  return {
    name: p.newName, said: p.said, matched_item_id: null, is_new: true, category, subcategory,
    tracking: weighed ? 'measure' : 'count', needs_amount: false,
  };
}

// Category guesses for new items (phone mode). First match wins; the person can change it with Edit item.
const CATEGORY_WORDS = [
  ['Food', 'Frozen', 'ice cream popsicle popsicles frozen pizza waffles nuggets fish sticks tater tots'],
  ['Food', 'Refrigerated', 'milk cheese yogurt butter eggs egg cream juice lettuce salad tofu hummus deli ham turkey salami bacon sausage hot dogs'],
  ['Food', 'Frozen', 'beef steak steaks chicken pork chops roast ribs lamb shrimp salmon fish meat burgers'],
  ['Food', 'Pantry', 'rice pasta noodles flour sugar salt pepper oil vinegar honey syrup cereal oats oatmeal beans soup crackers chips cookies bread coffee tea spices sauce ketchup mustard mayo peanut jam jelly nuts canned can tuna'],
  ['Food', 'Beverages', 'water soda pop beer wine sparkling seltzer drinks'],
  ['Household', 'Batteries & Bulbs', 'batteries battery bulbs bulb lightbulbs'],
  ['Household', 'Paper', 'paper towels toilet tissues tissue napkins foil wrap bags'],
  ['Household', 'Cleaning', 'soap detergent bleach cleaner wipes sponges sponge dish laundry'],
  ['Tools', 'Hand', 'hammer screwdriver screwdrivers wrench pliers tape measure level saw chisel'],
  ['Tools', 'Power', 'drill sander grinder jigsaw'],
  ['Tools', 'Hardware', 'screws nails bolts nuts washers hooks'],
  ['Garden', '', 'seeds soil mulch fertilizer hose shovel rake trowel pots planter'],
  ['Seasonal & Decor', '', 'christmas lights ornaments wreath halloween decorations decor candles'],
  ['Health & Personal Care', '', 'medicine vitamins bandages shampoo toothpaste lotion sunscreen razors'],
  ['Electronics & Cables', '', 'cable cables charger chargers adapter usb hdmi headphones'],
].map(([category, subcategory, words]) => ({ category, subcategory, words: new Set(words.split(' ')) }));
const PLACE_CATEGORY = [
  [/freezer/, 'Food', 'Frozen'], [/fridge|refrigerator/, 'Food', 'Refrigerated'], [/pantry|cupboard|cabinet/, 'Food', 'Pantry'],
];

export function guessCategory(name, placeName = '') {
  const words = String(name).toLowerCase().split(/\s+/).map((w) => w.replace(/s$/, ''));
  const all = String(name).toLowerCase().split(/\s+/);
  for (const c of CATEGORY_WORDS) {
    if (all.some((w) => c.words.has(w)) || words.some((w) => c.words.has(w))) {
      // food: a freezer or a fridge says more than the name ("ground turkey" in the freezer is frozen)
      if (c.category === 'Food' && /freezer/i.test(placeName)) return { category: 'Food', subcategory: 'Frozen' };
      if (c.category === 'Food' && /fridge|refrigerator/i.test(placeName)) return { category: 'Food', subcategory: 'Refrigerated' };
      return { category: c.category, subcategory: c.subcategory };
    }
  }
  for (const [re, category, subcategory] of PLACE_CATEGORY) if (re.test(placeName.toLowerCase())) return { category, subcategory };
  return { category: 'Other', subcategory: '' };
}

const UNDO = new Set(['undo', 'undo that', 'undo it', 'undo the last one', 'undo the last thing', 'scratch that', 'take that back', 'that is wrong undo that', 'that is wrong , undo that']);
const HELP = new Set(['help', 'what can i say', 'how does this work', 'how do i use this', 'how does it work']);
const CANCEL = new Set(['never mind', 'nevermind', 'cancel', 'cancel that', 'forget it', 'forget that', 'never mind forget it', 'never mind , forget it']);

function shortCommand(t) {
  const s = t.join(' ');
  if (UNDO.has(s) || UNDO.has(joinWords(t))) return [action('undo')];
  if (HELP.has(joinWords(t))) return [action('help')];
  if (CANCEL.has(s) || CANCEL.has(joinWords(t))) return [action('cancel')];
  return null;
}

// "what is in the garage freezer" · "where is the drill" · "do we have any rice" · "how many pork chops do we have"
function query(state, t) {
  const s = joinWords(t);
  if (['what do we have', 'what have we got', 'what is there', 'what do i have'].includes(s)) {
    return [action('query', { query: { scope: 'all', target: null } })];
  }
  // places
  for (const lead of [['what', 'is', 'in'], ['what', 'is', 'on'], ['what', 'do', 'we', 'have', 'in'], ['what', 'is', 'inside']]) {
    if (t.slice(0, lead.length).join(' ') === lead.join(' ')) {
      const p = placeRefOf(state, t.slice(lead.length));
      return p ? [action('query', { location: p.ref, query: { scope: 'location', target: p.ref.name } })] : null;
    }
  }
  // items
  const itemQ = (toks) => {
    let x = toks;
    if (x[0] === 'any') x = x.slice(1);
    while (x.length && ['left', 'there', 'anymore'].includes(x[x.length - 1])) x = x.slice(0, -1);
    const found = itemOf(state, x);
    if (found) return [action('query', { item: itemRef(found.item, found.said), query: { scope: 'item', target: found.item.name } })];
    const name = CTX.allowNew ? plainName(x) : null; // phone mode: the engine answers "I don't see any … on record."
    return name ? [action('query', { item: { name, said: name, matched_item_id: null, is_new: false, category: null, subcategory: null, tracking: null, needs_amount: null }, query: { scope: 'item', target: name } })] : null;
  };
  const leads = [
    [['where', 'is'], []], [['where', 'are'], []], [['where', 'did', 'i', 'put'], []], [['where', 'do', 'we', 'keep'], []],
    [['do', 'we', 'have'], []], [['do', 'i', 'have'], []], [['have', 'we', 'got'], []], [['is', 'there'], []], [['are', 'there'], []],
    [['how', 'much'], ['is', 'left', 'do', 'we', 'have', 'is', 'there']], [['how', 'many'], ['are', 'left', 'do', 'we', 'have', 'are', 'there']],
  ];
  for (const [lead, tails] of leads) {
    if (t.slice(0, lead.length).join(' ') !== lead.join(' ')) continue;
    let rest = t.slice(lead.length);
    for (const tail of [['do', 'we', 'have'], ['is', 'left'], ['are', 'left'], ['is', 'there'], ['are', 'there'], ['do', 'we', 'have', 'left']]) {
      if (tails.length && rest.slice(-tail.length).join(' ') === tail.join(' ')) { rest = rest.slice(0, -tail.length); break; }
    }
    return itemQ(rest);
  }
  // categories: "what tools do we have"
  if (t[0] === 'what' && t.slice(-3).join(' ') === 'do we have' && t.length > 4) {
    const want = normalizeName(t.slice(1, -3).join(' '));
    const cats = new Set();
    for (const i of state.items ?? []) {
      for (const c of [i.category, i.subcategory]) if (c && normalizeName(c) === want) cats.add(c);
    }
    return cats.size === 1 ? [action('query', { query: { scope: 'category', target: [...cats][0] } })] : null;
  }
  return null;
}

const REMOVE_VERBS = new Set(['took', 'take', 'taking', 'used', 'use', 'using', 'ate', 'eat', 'eating', 'remove', 'removed', 'removing', 'grabbed', 'grab', 'grabbing', 'threw', 'throw', 'throwing', 'tossed', 'toss', 'tossing', 'pulled', 'pull', 'pulling']);
const SUBJECTS = [['i', 'am'], ['we', 'are'], ['i', 'have'], ['we', 'have'], ['i', 'just'], ['we', 'just'], ['i'], ['we'], ['just']];
const REASON_START = new Set(['to', 'for', 'because', 'since']);
const REASON_PHRASES = new Set(['it went bad', 'they went bad', 'it expired', 'they expired', 'it is expired', 'it spoiled', 'it is bad', 'it is moldy', 'it went off']);

function afterSubject(t) {
  for (const s of SUBJECTS) if (t.slice(0, s.length).join(' ') === s.join(' ')) return t.slice(s.length);
  return t;
}

/** A trailing reason ("to cook", "for dinner", ", it went bad") at t[i..]: the text, '' when nothing, null if unreadable. */
function reasonAt(t, i) {
  let r = t.slice(i);
  if (!r.length) return '';
  if (r[0] === ',') r = r.slice(1);
  const s = r.join(' ');
  if (REASON_PHRASES.has(s)) return s;
  if (REASON_START.has(r[0]) && r.length >= 2 && r.length <= 6 && !r.includes(',')) return s;
  return null;
}

// "I'm taking pork chops out of the garage freezer to cook" · "I used half a pound of the ground beef" · "threw out the milk"
function remove(state, t) {
  let x = afterSubject(t);
  if (!REMOVE_VERBS.has(x[0])) return null;
  x = x.slice(1);
  if (x[0] === 'out' || x[0] === 'away') x = x.slice(1); // "threw out the milk"
  // the items run until "out of" / "from" / a reason / the end
  for (let k = 1; k <= x.length; k++) {
    const items = itemList(state, x.slice(0, k));
    if (!items) continue;
    let i = k;
    let place = null;
    if (x[i] === 'out' && x[i + 1] === 'of') {
      place = placeAfter(state, ['from', ...x.slice(i + 2)], 0);
      if (!place) continue;
      i = i + 1 + place.next;
    } else if (x[i] === 'from' || (x[i] === 'out' && x[i + 1] === 'from')) {
      const at = x[i] === 'out' ? i + 1 : i;
      place = placeAfter(state, x, at);
      if (!place) continue;
      i = place.next;
    } else if (x[i] === 'out') {
      i += 1; // "took the chops out"
    }
    const reason = reasonAt(x, i);
    if (reason == null) continue;
    return items.map((p) => fromPart(p, 'remove', { location: place ? place.ref : null, reason: reason || null }, place?.unsure));
  }
  return null;
}

// "move the chicken thighs from the garage freezer to the fridge" · "move the peas to the kitchen freezer"
function move(state, t) {
  let x = afterSubject(t);
  if (!['move', 'moving', 'moved'].includes(x[0])) return null;
  x = x.slice(1);
  for (let k = x.length - 1; k > 0; k--) {
    if (x[k] !== 'to') continue;
    const dest = placeAfter(state, x, k);
    if (!dest) continue;
    const reason = reasonAt(x, dest.next);
    if (reason == null) continue;
    let head = x.slice(0, k);
    let source = null;
    const f = head.lastIndexOf('from');
    if (f > 0) {
      source = placeAfter(state, head, f);
      if (!source || source.next !== head.length) continue;
      head = head.slice(0, f);
    }
    const items = itemList(state, head);
    if (!items) continue;
    return items.map((p) => fromPart(p, 'move', {
      location: source ? source.ref : null, to_location: dest.ref, reason: reason || null,
    }, source?.unsure || dest.unsure));
  }
  return null;
}

// "there are only two pork chops in the garage freezer" · "we are out of milk"
function adjust(state, t) {
  const s = joinWords(t);
  for (const lead of ['we are out of', 'we are all out of', 'we ran out of', 'we have run out of', 'out of', 'we finished', 'we finished off', 'we used up', 'i used up', 'i finished']) {
    if (s.startsWith(`${lead} `)) {
      const found = itemOf(state, t.slice(lead.split(' ').length));
      return found ? [action('adjust', { item: itemRef(found.item, found.said), quantity: 0 })] : null;
    }
  }
  if (t[0] !== 'there' || !['is', 'are'].includes(t[1])) return null;
  let x = t.slice(2);
  while (['actually', 'only', 'just', 'really'].includes(x[0])) x = x.slice(1);
  for (let k = x.length; k > 0; k--) {
    let body = x.slice(0, k);
    if (body[body.length - 1] === 'left') body = body.slice(0, -1);
    const p = itemPhrase(state, body);
    if (!p || p.quantity == null) continue;
    let place = null;
    if (k < x.length) {
      place = placeAfter(state, x, k);
      if (!place || place.next !== x.length) continue;
    }
    return [fromPart(p, 'adjust', { location: place ? place.ref : null }, place?.unsure)];
  }
  return null;
}

const ADD_VERBS = [['put', 'away'], ['put'], ['putting'], ['placed'], ['add'], ['added'], ['adding'], ['store'], ['stored'], ['storing'], ['bought'], ['got']];

// "pork chops in the garage freezer" · "put two bags of peas in the big freezer" · "in the garage freezer a chicken breast"
// · "a gallon of milk in the fridge, two pounds of rice and a pack of double A batteries in the pantry" · list pieces
function add(state, t, listLocation) {
  let x = afterSubject(t);
  for (const v of ADD_VERBS) {
    if (x.slice(0, v.length).join(' ') === v.join(' ')) { x = x.slice(v.length); break; }
  }
  if (!x.length) return null;
  // place first: "in the garage freezer, a chicken breast"
  const lead = placeAfter(state, x, 0);
  if (lead && lead.next < x.length) {
    const items = itemList(state, x.slice(x[lead.next] === ',' ? lead.next + 1 : lead.next));
    if (items) return items.map((p) => fromPart(p, 'add', { location: lead.ref }, lead.unsure));
  }
  // items, then their place; repeated groups
  const out = [];
  let i = 0;
  while (i < x.length) {
    while (i < x.length && SEP.has(x[i])) i += 1;
    if (i >= x.length) break;
    let group = null;
    for (let k = i + 1; k < x.length && !group; k++) {
      const place = placeAfter(state, x, k);
      if (!place) continue;
      if (place.next < x.length && !SEP.has(x[place.next])) continue;
      const items = itemList(state, x.slice(i, k));
      if (items) group = { items, place };
    }
    if (!group) {
      const loc = listRef(listLocation);
      const items = loc ? itemList(state, x.slice(i)) : null; // a list piece: the carried place
      if (!items) return null;
      out.push(...items.map((p) => fromPart(p, 'add', { location: loc }, loc.is_new)));
      break;
    }
    out.push(...group.items.map((p) => fromPart(p, 'add', { location: group.place.ref }, group.place.unsure)));
    i = group.place.next;
  }
  return out.length ? out : null;
}

function command(state, t, listLocation) {
  if (!t.length) return null;
  const short = shortCommand(t);
  if (short) return short;
  if (t.some((w) => NEGATION.has(w))) return null;
  return query(state, t) ?? move(state, t) ?? remove(state, t) ?? adjust(state, t) ?? add(state, t, listLocation);
}

const parsed = (actions, answer = null) => ({ actions, answer, clarify: null, confidence: CONFIDENCE });

/**
 * A fresh phrase (or a list piece). @returns the validateParse shape, or null to hand off to the LLM.
 * In a list, a place said on its own ("In the pantry,") comes back as `place` with no actions: it sets the list's
 * place (list.js).
 * @param o {transcript, listLocation?: {name, matched_location_id}, list?: boolean}
 */
export function parseRules(state, { transcript, listLocation = null, list = false, allowNew = false } = {}) {
  const before = CTX;
  CTX = { allowNew, problem: null };
  try {
    const result = parsePhrase(state, transcript, listLocation, list);
    if (result) return result;
    return CTX.problem ? { ...parsed([]), problem: CTX.problem } : null; // e.g. "Which freezer? …" (phone mode)
  } finally {
    CTX = before;
  }
}

function parsePhrase(state, transcript, listLocation, list) {
  const t = trimFiller(tokenize(transcript));
  if (list) {
    const p = placeRefOf(state, PLACE_PREPS.has(t[0]) ? t.slice(1) : t);
    if (p) return { ...parsed([]), place: p.ref };
  }
  const tries = [t];
  if (MAYBE_WAKE.has(t[0])) tries.push(trimFiller(t.slice(1)));
  for (const toks of tries) {
    const actions = command(state, toks, listLocation);
    if (actions?.length) return parsed(actions);
  }
  return null;
}

const YES = new Set(['yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'go ahead', 'do it', 'yes please', 'correct', 'right', 'that is right', 'yes do it', 'yeah go ahead', 'sounds good']);
const NO = new Set(['no', 'nope', 'do not', 'no do not', 'no thanks', 'no , do not', 'nah']);
const HEDGES = new Set(['about', 'around', 'roughly', 'maybe', 'like', 'exactly', 'just', 'approximately']);

/**
 * An answer to WISP's question (answer mode). @returns the validateParse shape with `answer`, or null.
 * @param o {transcript, pending, clarify}
 */
export function answerRules(state, { transcript, clarify, allowNew = false } = {}) {
  const raw = tokenize(transcript).filter((w) => w !== 'please');
  const t = raw[raw.length - 1] === ',' ? raw.slice(0, -1) : raw;
  const s = joinWords(t);
  const missing = Array.isArray(clarify?.missing) ? clarify.missing : [];
  const none = { quantity: null, unit: null, location: null, option_index: null };
  if (CANCEL.has(s)) return parsed([], { type: 'cancel', ...none });
  if (missing.includes('confirm')) {
    if (YES.has(s)) return parsed([], { type: 'yes', ...none });
    if (NO.has(s)) return parsed([], { type: 'no', ...none });
  }
  if (missing.includes('quantity')) {
    let x = t;
    while (HEDGES.has(x[0])) x = x.slice(1);
    if (x[x.length - 1] === 'so' && x[x.length - 2] === 'or') x = x.slice(0, -2);
    const a = amountAt(x);
    if (a && a.quantity != null && a.next === x.length && a.package_count == null) {
      return parsed([], { type: 'value', ...none, quantity: a.quantity, unit: a.unit });
    }
  }
  if (missing.includes('location') || missing.includes('to_location')) {
    let x = trimFiller(t);
    if (PLACE_PREPS.has(x[0])) x = x.slice(1);
    const p = placeOf(state, x);
    if (p) return parsed([], { type: 'value', ...none, location: placeRef(p.loc, p.said) });
  }
  // a different command instead of an answer ("actually, what's in the fridge?")
  const fresh = parseRules(state, { transcript, allowNew });
  if (fresh && fresh.actions.length && fresh.actions.every((a) => a.intent !== 'cancel')) return parsed(fresh.actions, { type: 'new_request', ...none });
  return null;
}
