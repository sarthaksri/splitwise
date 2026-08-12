/**
 * Money helpers. Every amount in this app is an integer number of minor units
 * (paise for INR, cents for USD). Floats appear only at the input/display edge.
 *
 * Zero dependencies — this file is imported by both the Express server and the
 * React client, so the two always agree on the arithmetic.
 */

/** Smallest units in one major unit. INR/USD/EUR are all 100. */
export const MINOR_UNITS = 100;

/**
 * Largest amount any single entry may hold: ten billion major units.
 *
 * Far beyond any real dinner, and far below Number.MAX_SAFE_INTEGER, which is
 * the point — the balance code adds these up, and an entry near 2^53 would let
 * a sum lose precision and quietly break the "everything totals zero"
 * invariant the whole app depends on.
 */
export const MAX_AMOUNT_CENTS = 1_000_000_000_00;

/**
 * Parse user input ("1,234.56", 1234.56, "12.5") into integer minor units.
 * Returns NaN for anything unparseable so callers can reject it.
 */
export function toCents(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return NaN;
    return Math.round(value * MINOR_UNITS);
  }
  if (typeof value !== 'string') return NaN;

  const cleaned = value.replace(/[,\s₹$€£]/g, '').trim();
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return NaN;
  if (!/^-?\d*\.?\d*$/.test(cleaned)) return NaN;

  const n = Number(cleaned);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * MINOR_UNITS);
}

/** Integer minor units -> a Number in major units (for display only). */
export function fromCents(cents) {
  return cents / MINOR_UNITS;
}

/**
 * Format minor units for display, e.g. 123456 -> "₹1,234.56".
 * `currency` is an ISO 4217 code; unknown codes fall back to a plain number.
 */
export function formatMoney(cents, currency = 'INR', { showSign = false } = {}) {
  const value = fromCents(Math.abs(cents));
  let body;
  try {
    body = new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    body = value.toFixed(2);
  }
  if (showSign && cents !== 0) return `${cents < 0 ? '-' : '+'}${body}`;
  return cents < 0 ? `-${body}` : body;
}

/**
 * Split `totalCents` across `keys` in proportion to `weights`, using the
 * largest-remainder (Hamilton) method so the parts sum to EXACTLY totalCents.
 *
 * Every leftover unit goes to whoever was rounded down hardest; ties break on
 * ascending key so the result is deterministic and reproducible on both sides
 * of the wire. Handles negative totals (a discount being shared out) by
 * mirroring the logic, so the "most rounded" party is still favoured correctly.
 *
 * @param {number} totalCents integer, may be negative
 * @param {string[]} keys     identifiers (user ids)
 * @param {number[]} [weights] non-negative weights, defaults to equal
 * @returns {Map<string, number>} key -> integer minor units, summing to totalCents
 */
export function allocate(totalCents, keys, weights) {
  if (!Number.isInteger(totalCents)) {
    throw new TypeError(`allocate: totalCents must be an integer, got ${totalCents}`);
  }
  const n = keys.length;
  const result = new Map();
  if (n === 0) {
    if (totalCents !== 0) {
      throw new Error('allocate: cannot distribute a non-zero amount across zero parties');
    }
    return result;
  }

  const w = weights ?? new Array(n).fill(1);
  if (w.length !== n) {
    throw new Error('allocate: weights length must match keys length');
  }
  if (w.some((x) => !Number.isFinite(x) || x < 0)) {
    throw new Error('allocate: weights must be finite and non-negative');
  }

  const totalWeight = w.reduce((a, b) => a + b, 0);
  if (totalWeight === 0) {
    // No weights to go on: fall back to an even split so we never lose money.
    return allocate(totalCents, keys);
  }

  // Work with the magnitude so flooring always rounds *towards* zero, then
  // re-apply the sign. This keeps negative distributions symmetric to positive.
  const sign = totalCents < 0 ? -1 : 1;
  const magnitude = Math.abs(totalCents);

  const base = [];
  let assigned = 0;
  for (let i = 0; i < n; i += 1) {
    const exact = (magnitude * w[i]) / totalWeight;
    const floored = Math.floor(exact);
    base.push({ index: i, floored, remainder: exact - floored });
    assigned += floored;
  }

  let leftover = magnitude - assigned;

  // Hand out the remaining units: biggest fractional part first, then by key.
  const order = [...base].sort((a, b) => {
    if (b.remainder !== a.remainder) return b.remainder - a.remainder;
    return String(keys[a.index]) < String(keys[b.index]) ? -1 : 1;
  });

  for (const entry of order) {
    if (leftover <= 0) break;
    // A zero-weight party is entitled to nothing, so never round them up.
    if (w[entry.index] === 0) continue;
    entry.floored += 1;
    leftover -= 1;
  }

  // Safety net: if every remaining party had zero weight, dump the rest on the
  // first non-zero-weight party rather than silently losing it.
  if (leftover > 0) {
    const fallback = base.find((e) => w[e.index] > 0) ?? base[0];
    fallback.floored += leftover;
    leftover = 0;
  }

  for (const entry of base) {
    result.set(keys[entry.index], sign * entry.floored);
  }
  return result;
}

/** Sum the values of a Map or a plain array of numbers. */
export function sumValues(mapOrArray) {
  const values = mapOrArray instanceof Map ? [...mapOrArray.values()] : mapOrArray;
  return values.reduce((a, b) => a + b, 0);
}

/** Add `amount` to `key` in a Map that treats missing keys as 0. */
export function addTo(map, key, amount) {
  map.set(key, (map.get(key) ?? 0) + amount);
  return map;
}
