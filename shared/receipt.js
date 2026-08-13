/**
 * Turning a photographed bill into something the dish-wise splitter can use.
 *
 * Two very different sources feed this file:
 *
 *   Gemini      — reads the image and returns structured JSON directly.
 *   Tesseract   — returns a wall of raw text that `parseReceiptText` has to
 *                 make sense of, line by line.
 *
 * Both end up in `normalizeScan`, so everything downstream sees one shape and
 * one set of guarantees. Zero dependencies beyond `money.js`, like the rest of
 * `shared/`, so the server and the browser run identical code.
 *
 * The scan only ever *prefills a form*. Nothing here decides a split or
 * persists anything — a person reviews every number before it becomes an
 * expense, which is what makes it acceptable for OCR to be occasionally wrong.
 */

import { toCents, MAX_AMOUNT_CENTS } from './money.js';

export class ScanError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScanError';
  }
}

/** Longest dish name we'll keep; anything past this is OCR noise, not a name. */
const MAX_NAME = 80;
/** More lines than any real bill — a guard against a runaway parse. */
const MAX_ITEMS = 120;

/**
 * The JSON contract we ask Gemini for, and the shape `parseReceiptText`
 * produces. Exported so the server can hand it to the model as a response
 * schema rather than describing it in prose and hoping.
 */
export const SCAN_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          qty: { type: 'integer' },
          // Major units (rupees), as printed. Converted to paise here.
          price: { type: 'number' },
        },
        required: ['name', 'price'],
      },
    },
    tax: { type: 'number' },
    tip: { type: 'number' },
    other: { type: 'number' },
    discount: { type: 'number' },
    total: { type: 'number' },
    currency: { type: 'string' },
  },
  required: ['items'],
};

/**
 * Clamp a parsed amount into something sane, or return null.
 *
 * OCR misreads produce spectacular numbers — a smudged decimal point turns
 * ₹32.00 into ₹3200, and a stray digit can exceed what the ledger can safely
 * add up. Anything at or beyond MAX_AMOUNT_CENTS is refused rather than
 * silently truncated, because a wrong-but-plausible number is worse than none.
 */
function amountCents(value) {
  if (value == null || value === '') return null;
  const cents = toCents(value);
  if (!Number.isFinite(cents)) return null;
  if (cents < 0) return null;
  if (cents >= MAX_AMOUNT_CENTS) return null;
  return cents;
}

function cleanName(raw) {
  return String(raw ?? '')
    // Leading item numbers ("1.", "01)") and trailing dot leaders ("....").
    .replace(/^\s*\d{1,3}\s*[.)]\s*/, '')
    .replace(/[.·_]{2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME);
}

/**
 * Bring a raw scan — from either engine — into the shape the form expects.
 *
 * Everything is integer paise from here on, matching the rest of the app.
 * A row with no name is dropped — that's OCR noise. A row with a name but an
 * unreadable price is *kept*, at zero, because that is the failure OCR actually
 * has: it read "Masala Chai 60.00" as "Masala Chai 00.00". Dropping it would
 * throw away the dish name too and leave the user staring at a ₹60 discrepancy
 * with nothing to tell them what was missing. Kept, it's a row with the name
 * already filled in and one number to type.
 *
 * @throws {ScanError} when nothing usable came back at all.
 */
export function normalizeScan(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new ScanError("Couldn't read that bill. Try a straighter, brighter photo.");
  }

  const items = [];
  for (const item of Array.isArray(raw.items) ? raw.items : []) {
    if (items.length >= MAX_ITEMS) break;
    const name = cleanName(item?.name);
    // A name is required; an unreadable price becomes 0 for the user to fix.
    const price = amountCents(item?.price ?? item?.priceCents / 100) ?? 0;
    if (!name) continue;

    // Quantity multiplies the price, so a bad one distorts the whole bill.
    // Anything outside 1–99 is not a quantity we can believe — it's a price
    // fragment or a table number that landed in the wrong column — so fall
    // back to 1 rather than clamping to 99 and inventing a huge line.
    const qtyRaw = Number(item?.qty);
    const qty =
      Number.isFinite(qtyRaw) && qtyRaw >= 1 && qtyRaw < 100 ? Math.floor(qtyRaw) : 1;

    items.push({ name, qty, priceCents: price });
  }

  if (items.length === 0) {
    throw new ScanError(
      "Couldn't find any dishes on that bill. Add them by hand, or try a clearer photo.",
    );
  }

  return {
    items,
    taxCents: amountCents(raw.tax ?? raw.taxCents / 100) ?? 0,
    tipCents: amountCents(raw.tip ?? raw.tipCents / 100) ?? 0,
    otherCents: amountCents(raw.other ?? raw.otherCents / 100) ?? 0,
    discountCents: amountCents(raw.discount ?? raw.discountCents / 100) ?? 0,
    // What the bill claims the total is. Not used in the split — it's the
    // cross-check that catches a dish we missed.
    totalCents: amountCents(raw.total ?? raw.totalCents / 100),
    currency: typeof raw.currency === 'string' && raw.currency.length === 3
      ? raw.currency.toUpperCase()
      : 'INR',
  };
}

/**
 * Does the bill's own total agree with the lines we extracted?
 *
 * This is the safety net for the whole feature. OCR drops a line far more
 * often than it invents one, and a dropped dish produces a split that looks
 * perfectly reasonable and is quietly wrong. Comparing against the printed
 * total is the one check that catches it.
 *
 * @returns {{derivedCents: number, printedCents: number|null, diffCents: number}}
 *          `diffCents` is positive when the bill says more than the lines do.
 */
export function reconcileScan(scan) {
  const derivedCents =
    scan.items.reduce((sum, i) => sum + i.priceCents * (i.qty ?? 1), 0) +
    (scan.taxCents ?? 0) +
    (scan.tipCents ?? 0) +
    (scan.otherCents ?? 0) -
    (scan.discountCents ?? 0);

  const printedCents = scan.totalCents ?? null;
  return {
    derivedCents,
    printedCents,
    diffCents: printedCents == null ? 0 : printedCents - derivedCents,
  };
}

// --- the Tesseract path ------------------------------------------------------

/**
 * Lines that are a bill's summary rather than something anyone ate. Order
 * matters: `TOTAL` has to be tried after `SUBTOTAL`, or every subtotal is read
 * as the grand total and the reconciliation check compares against the wrong
 * number.
 */
const SUMMARY_PATTERNS = [
  { field: 'discount', re: /\b(discount|less|off|promo|coupon)\b/i },
  { field: 'tip', re: /\b(tip|gratuity|service\s*charge|svc\s*chg)\b/i },
  // Indian bills split the tax across CGST and SGST lines (and sometimes a
  // cess), so these have to be added up. Keeping only the last one silently
  // halves the tax — the kind of error that looks entirely plausible on screen.
  { field: 'tax', re: /\b(cgst|sgst|igst|gst|vat|service\s*tax|cess|tax)\b/i, sum: true },
  { field: 'other', re: /\b(delivery|packing|packaging|container|convenience|round[\s-]*off)\b/i, sum: true },
  { field: 'subtotal', re: /\b(sub\s*total|sub-total)\b/i },
  { field: 'total', re: /\b(grand\s*total|net\s*(payable|amount)|total\s*(due|payable|amount)?|amount\s*payable|bill\s*amount)\b/i },
];

/** Noise a receipt is full of that must never become a dish. */
const IGNORE_LINE =
  /\b(invoice|bill\s*no|table|covers?|gstin|fssai|phone|tel\b|date|time|cashier|steward|server|thank|visit\s*again|www\.|@|receipt|order\s*no|token|counter|qty\b\s*$|paid|change|cash|card|upi|balance)\b/i;

/**
 * Pull the trailing price off a line.
 *
 * Deliberately anchored to the end: a dish name can contain digits ("7Up",
 * "Biryani 65") and grabbing the first number in the line gets those wrong.
 * The price on a receipt is always the last column.
 *
 * The magnitude and the sign come back separately. Bills print discounts as
 * "Discount -20.00", and treating that as a negative amount would fail the
 * non-negative check and drop the line entirely — losing a real discount.
 */
function trailingAmount(line) {
  const m = line.match(/(-?\d[\d,]*(?:[.,]\d{1,2})?)\s*(?:\/-|₹|rs\.?)?\s*$/i);
  if (!m) return null;
  let text = m[1];

  const negative = text.startsWith('-');
  if (negative) text = text.slice(1);

  // "1.234,56" (rare here, but harmless to support) vs "1,234.56".
  if (/,\d{2}$/.test(text) && !/\.\d/.test(text)) text = text.replace(/\./g, '').replace(',', '.');
  else text = text.replace(/,/g, '');

  const cents = amountCents(text);
  return cents == null ? null : { cents, negative, at: m.index };
}

/**
 * Read a leading quantity, e.g. "2 Paneer Tikka" or "2 x Paneer Tikka".
 * Returns `[qty, rest]`, defaulting to 1 when there's nothing to read.
 */
function leadingQty(text) {
  const m = text.match(/^\s*(\d{1,2})\s*(?:x|×|\*)?\s+(.+)$/i);
  if (!m) return [1, text];
  const qty = Number(m[1]);
  // A "2024" or a price-looking number isn't a quantity.
  if (!Number.isFinite(qty) || qty < 1 || qty > 99) return [1, text];
  return [qty, m[2]];
}

/**
 * Best-effort structure from raw OCR text.
 *
 * This is genuinely heuristic and will be wrong sometimes — which is the whole
 * reason the result lands in an editable form with a reconciliation warning
 * rather than going straight into the ledger. It's the fallback engine; Gemini
 * does this far better when a key is configured.
 *
 * @param {string} text raw output from Tesseract
 * @returns {object} a raw scan, ready for `normalizeScan`
 */
export function parseReceiptText(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const raw = { items: [], currency: 'INR' };
  const summary = {};

  for (const line of lines) {
    const amount = trailingAmount(line);
    if (!amount) continue;

    const label = line.slice(0, amount.at).trim();

    // A summary row: record it and move on. Checked before the ignore list so
    // a "Total" line still counts even though it also matches nothing else.
    const matched = SUMMARY_PATTERNS.find((p) => p.re.test(label));
    if (matched) {
      if (matched.sum) {
        // Components of one figure — CGST + SGST, delivery + packing.
        summary[matched.field] = (summary[matched.field] ?? 0) + amount.cents;
      } else {
        // Keep the *last* occurrence: bills often print a running total and
        // then the real one at the foot.
        summary[matched.field] = amount.cents;
      }
      continue;
    }

    // A dish with a negative price is a misread, not a refund line.
    if (!label || amount.negative || IGNORE_LINE.test(label)) continue;
    // A line that is only punctuation or a lone letter after cleaning is noise.
    const [qty, rest] = leadingQty(label);
    const name = cleanName(rest);
    if (name.length < 2 || !/[a-z]/i.test(name)) continue;

    raw.items.push({ name, qty, price: amount.cents / 100 });
  }

  for (const field of ['tax', 'tip', 'other', 'discount', 'total']) {
    if (summary[field] != null) raw[field] = summary[field] / 100;
  }

  if (/[$]/.test(text)) raw.currency = 'USD';
  else if (/€/.test(text)) raw.currency = 'EUR';

  return raw;
}
