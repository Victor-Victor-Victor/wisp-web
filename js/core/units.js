// Unit normalization and conversion. Pure; runs in Node (tests) and Apps Script (bundled).
// Weight and volume are never converted into each other. Anything else is a "count" unit label.

const MEASURE = {
  // weight — base: grams
  lb: { dim: 'weight', base: 453.59237, one: 'pound', many: 'pounds' },
  oz: { dim: 'weight', base: 28.349523125, one: 'ounce', many: 'ounces' },
  g: { dim: 'weight', base: 1, one: 'gram', many: 'grams' },
  kg: { dim: 'weight', base: 1000, one: 'kilogram', many: 'kilograms' },
  // volume — base: milliliters
  tsp: { dim: 'volume', base: 4.92892159375, one: 'teaspoon', many: 'teaspoons' },
  tbsp: { dim: 'volume', base: 14.78676478125, one: 'tablespoon', many: 'tablespoons' },
  'fl oz': { dim: 'volume', base: 29.5735295625, one: 'fluid ounce', many: 'fluid ounces' },
  cup: { dim: 'volume', base: 236.5882365, one: 'cup', many: 'cups' },
  pt: { dim: 'volume', base: 473.176473, one: 'pint', many: 'pints' },
  qt: { dim: 'volume', base: 946.352946, one: 'quart', many: 'quarts' },
  gal: { dim: 'volume', base: 3785.411784, one: 'gallon', many: 'gallons' },
  ml: { dim: 'volume', base: 1, one: 'milliliter', many: 'milliliters' },
  l: { dim: 'volume', base: 1000, one: 'liter', many: 'liters' },
};

const ALIASES = {
  pound: 'lb', pounds: 'lb', lbs: 'lb',
  ounce: 'oz', ounces: 'oz',
  gram: 'g', grams: 'g', gm: 'g', gms: 'g',
  kilogram: 'kg', kilograms: 'kg', kilo: 'kg', kilos: 'kg', kgs: 'kg',
  teaspoon: 'tsp', teaspoons: 'tsp',
  tablespoon: 'tbsp', tablespoons: 'tbsp',
  'fluid ounce': 'fl oz', 'fluid ounces': 'fl oz', floz: 'fl oz', 'fl. oz': 'fl oz', 'fl oz.': 'fl oz',
  cups: 'cup', c: 'cup',
  pint: 'pt', pints: 'pt',
  quart: 'qt', quarts: 'qt',
  gallon: 'gal', gallons: 'gal',
  milliliter: 'ml', milliliters: 'ml', millilitre: 'ml', millilitres: 'ml', mls: 'ml',
  liter: 'l', liters: 'l', litre: 'l', litres: 'l',
  // count labels
  ea: 'each', piece: 'each', pieces: 'each', pc: 'each', pcs: 'each', item: 'each', items: 'each',
  pkg: 'package', pkgs: 'package', pack: 'package', packs: 'package', packet: 'package', packets: 'package',
};

const EPS = 1e-9;

/** Round to 6 decimals to keep float noise out of the sheet. */
export function round6(x) {
  return Math.round(x * 1e6) / 1e6;
}

export function isZero(x) {
  return Math.abs(x) <= EPS;
}

function singularize(word) {
  if (/(ch|sh|x|ss)es$/.test(word)) return word.slice(0, -2);
  if (/[^aeiou]ies$/.test(word)) return `${word.slice(0, -3)}y`;
  if (/[^s]s$/.test(word)) return word.slice(0, -1);
  return word;
}

/**
 * Canonical unit string, or null for empty input.
 * Measure units → keys of MEASURE ("lb", "fl oz", …). Anything else → a singular count label ("bag", "package").
 */
export function normalizeUnit(unit) {
  if (unit == null) return null;
  const u = String(unit).toLowerCase().trim().replace(/\s+/g, ' ').replace(/\.$/, '');
  if (!u) return null;
  if (MEASURE[u]) return u;
  if (ALIASES[u]) return ALIASES[u];
  const single = singularize(u);
  return ALIASES[single] ?? single;
}

/** "weight" | "volume" | "count" */
export function dimension(unit) {
  return MEASURE[normalizeUnit(unit)]?.dim ?? 'count';
}

export function isMeasureUnit(unit) {
  return dimension(unit) !== 'count';
}

export function canConvert(from, to) {
  const a = normalizeUnit(from);
  const b = normalizeUnit(to);
  if (a === b) return true;
  return Boolean(MEASURE[a] && MEASURE[b] && MEASURE[a].dim === MEASURE[b].dim);
}

/** Convert qty between compatible units. Throws on incompatible units. */
export function convert(qty, from, to) {
  const a = normalizeUnit(from);
  const b = normalizeUnit(to);
  if (a === b) return qty;
  if (!canConvert(a, b)) throw new Error(`Cannot convert ${a} to ${b}`);
  return round6((qty * MEASURE[a].base) / MEASURE[b].base);
}

/** Number for speech/display: at most 2 decimals, no trailing zeros. */
export function formatNumber(n) {
  return String(Math.round(n * 100) / 100);
}

function pluralLabel(label) {
  if (/(ch|sh|x|s)$/.test(label)) return `${label}es`;
  if (/[^aeiou]y$/.test(label)) return `${label.slice(0, -1)}ies`;
  return `${label}s`;
}

/** Unit word for qty: ("lb", 2) → "pounds"; ("bag", 1) → "bag"; ("box", 2) → "boxes". */
export function unitWord(unit, qty) {
  const u = normalizeUnit(unit);
  const m = MEASURE[u];
  const one = Math.abs(qty - 1) <= EPS;
  if (m) return one ? m.one : m.many;
  return one ? u : pluralLabel(u);
}

/** Spoken amount: (0.5,"lb") → "half a pound"; (2,"lb") → "2 pounds"; (3,"bag") → "3 bags"; (3,"each") → "3". */
export function formatAmount(qty, unit) {
  const u = normalizeUnit(unit);
  if (!u || u === 'each') return formatNumber(qty);
  if (MEASURE[u] && Math.abs(qty - 0.5) <= EPS) return `half a ${MEASURE[u].one}`;
  return `${formatNumber(qty)} ${unitWord(u, qty)}`;
}

/** Package size adjective: (1,"lb") → "1-pound"; (16,"oz") → "16-ounce". */
export function formatSize(qty, unit) {
  const u = normalizeUnit(unit);
  return `${formatNumber(qty)}-${MEASURE[u]?.one ?? u}`;
}
