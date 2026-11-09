// Exact-but-forgiving name matching for items and locations. Fuzzy matching ("the big freezer" →
// "Garage Freezer") is the parser's job via aliases; this only normalizes case, punctuation,
// leading articles and a trailing plural.

const LEADING = /^(the|a|an|some|my|our|any)\s+/;

function singularizeWord(w) {
  if (w.length <= 3) return w;
  if (/(ch|sh|x|ss)es$/.test(w)) return w.slice(0, -2);
  if (/[^aeiou]ies$/.test(w)) return `${w.slice(0, -3)}y`;
  if (/[^s]s$/.test(w)) return w.slice(0, -1);
  return w;
}

/** "The Pork Chops!" → "pork chop" */
export function normalizeName(name) {
  let s = String(name ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(LEADING, '');
  const words = s.split(' ');
  words[words.length - 1] = singularizeWord(words[words.length - 1]);
  return words.join(' ').trim();
}

function keysOf(row) {
  const aliases = String(row.aliases ?? '').split(',').map((a) => a.trim()).filter(Boolean);
  return [row.name, ...aliases].map(normalizeName).filter(Boolean);
}

/** First row whose name or alias matches `name` after normalization; otherwise null. */
export function findByName(rows, name) {
  const target = normalizeName(name);
  if (!target) return null;
  return rows.find((r) => keysOf(r).includes(target)) ?? null;
}

/** Resolve an item ref ({matched_item_id?, name}) against the catalog. */
export function findItem(items, ref) {
  if (!ref) return null;
  if (ref.matched_item_id) {
    const byId = items.find((i) => i.item_id === ref.matched_item_id);
    if (byId) return byId;
  }
  return ref.name ? findByName(items, ref.name) : null;
}

/** Resolve a location ref ({matched_location_id?, name}). */
export function findLocation(locations, ref) {
  if (!ref) return null;
  if (ref.matched_location_id) {
    const byId = locations.find((l) => l.location_id === ref.matched_location_id);
    if (byId) return byId;
  }
  return ref.name ? findByName(locations, ref.name) : null;
}

/** "garage  workbench" → "Garage Workbench" */
export function titleCase(name) {
  return String(name).trim().replace(/\s+/g, ' ').replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

/** "pork chops" → "Pork chops" (catalog style: capitalized first letter only). */
export function sentenceCase(name) {
  const s = String(name).trim().replace(/\s+/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------- changed-word check (ADR-010) ----------
// The parser copies the words the person used into `said` and its interpretation into `name`. Code — not the LLM
// — decides whether that interpretation changed a word they said ("pork chomps" → "Pork chops"), so it can be
// asked out loud instead of saved silently. Adding words ("peas" → "Frozen peas") or using an alias is fine.
const NOT_CONTENT = new Set([
  'a', 'an', 'the', 'some', 'my', 'our', 'any', 'of', 'and', 'in', 'on', 'at', 'to', 'from', 'into', 'for', 'with',
  'few', 'couple', 'dozen', 'half', 'quarter', 'more', 'another', 'other', 'little', 'bit', 'lot', 'lots', 'about',
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'twenty',
  'lb', 'lbs', 'pound', 'ounce', 'oz', 'g', 'gram', 'kg', 'kilo', 'kilogram', 'cup', 'pint', 'pt', 'quart', 'qt',
  'gallon', 'gal', 'ml', 'liter', 'litre', 'l', 'package', 'pack', 'packet', 'bag', 'can', 'box', 'bottle', 'jar',
  'carton', 'roll', 'each', 'piece', 'tin', 'tub', 'container', 'case', 'loaf', 'bunch', 'head', 'sack', 'bundle',
]);
const wordsOf = (text) => String(text ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean).map(singularizeWord);

/**
 * Content words of `said` that the saved interpretation doesn't contain (name + aliases), or that never occurred
 * in the transcript (a "said" that isn't a faithful quote counts as changed too). [] = nothing changed.
 * @param {string} said        the person's words for the thing, as the parser quoted them
 * @param {string} name        the name that would be saved / matched
 * @param {string} aliases     comma-separated aliases of the matched catalog row ("" for a new one)
 * @param {string} transcript  what speech recognition actually heard
 */
export function changedWords(said, name, aliases, transcript) {
  const target = new Set(wordsOf(`${name ?? ''} ${aliases ?? ''}`));
  const heard = new Set(wordsOf(transcript));
  const content = wordsOf(said).filter((w) => !NOT_CONTENT.has(w) && !/^\d/.test(w));
  return [...new Set(content.filter((w) => !target.has(w) || !heard.has(w)))];
}
