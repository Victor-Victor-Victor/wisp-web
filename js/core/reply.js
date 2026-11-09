// Spoken-reply helpers: short, plain phrases for the ear.
import { formatAmount, formatNumber, formatSize, normalizeUnit, unitWord } from './units.js';

const EPS = 1e-9;
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

export const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** 1 → "one" … 10 → "ten"; otherwise digits. */
export function numberWord(n) {
  return Number.isInteger(n) && WORDS[n] ? WORDS[n] : formatNumber(n);
}

/** ["a","b","c"] → "a, b, and c"; conj "or" for choices. */
export function joinList(parts, conj = 'and') {
  if (parts.length <= 1) return parts[0] ?? '';
  if (parts.length === 2) return `${parts[0]} ${conj} ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, ${conj} ${parts[parts.length - 1]}`;
}

export function itemName(item) {
  return String(item.name).toLowerCase();
}

/** "Garage Freezer" → "the garage freezer" */
export function locationName(loc) {
  const n = String(loc.name).toLowerCase();
  return n.startsWith('the ') ? n : `the ${n}`;
}

/** Article for a spoken number/size: "an 8-ounce", "an 11-pound", "a 1-pound". */
export function article(phrase) {
  return /^(8|11|18|80)\b|^(8|11|18|80)[-.\d]/.test(phrase) ? 'an' : 'a';
}

/**
 * Count phrase for what was added/removed:
 * (1, package, "pork chops") → "pork chops"; (2, package) → "2 packages of pork chops";
 * (2, each, "drills") → "2 drills".
 */
export function countPhrase(n, unit, name) {
  const u = normalizeUnit(unit) ?? 'each';
  if (Math.abs(n - 1) <= EPS) return name;
  if (u === 'each') return `${formatNumber(n)} ${name}`;
  return `${formatNumber(n)} ${unitWord(u, n)} of ${name}`;
}

/** Packages of a measure item: (1, 1, lb, "ground beef") → "a 1-pound package of ground beef". */
export function packagesPhrase(n, size, unit, name) {
  const s = formatSize(size, unit);
  return n === 1 ? `${article(s)} ${s} package of ${name}` : `${numberWord(n)} ${s} packages of ${name}`;
}

/** Amount on hand without the name: count → "3", measure → "3 pounds". */
export function totalPhrase(qty, unit, tracking) {
  return tracking === 'measure' ? formatAmount(qty, unit) : formatNumber(qty);
}

/** Amount on hand with the name: "3 pork chops", "2 bags of frozen peas", "4 pounds of ground beef". */
export function stockPhrase(qty, unit, tracking, name) {
  if (tracking === 'measure') return `${formatAmount(qty, unit)} of ${name}`;
  const u = normalizeUnit(unit);
  if (u && u !== 'each' && u !== 'package') return `${formatNumber(qty)} ${unitWord(u, qty)} of ${name}`;
  return `${formatNumber(qty)} ${name}`;
}
