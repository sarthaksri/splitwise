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
 * Photographs of one bill. A long thermal receipt takes two or three shots to
 * capture legibly, and a table that ordered all evening can print a second
 * page; past that, someone is scanning something other than a bill.
 */
export const MAX_PAGES = 8;

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
  // Ahead of `discount`, because "Round Off" contains a standalone "off" and
  // would otherwise be booked as one.
  { field: 'other', re: /\b(delivery|packing|packaging|container|convenience|round[\s-]*off)\b/i, sum: true },
  { field: 'discount', re: /\b(discount|less|off|promo|coupon)\b/i },
  { field: 'tip', re: /\b(tip|gratuity|service\s*charge|svc\s*chg)\b/i },
  /*
   * Indian bills split the tax across CGST and SGST lines (and sometimes a
   * cess), so these have to be added up. Keeping only the last one silently
   * halves the tax — the kind of error that looks entirely plausible on screen.
   *
   * The trailing alternative catches a rate line whose keyword OCR has
   * destroyed: "CGST 2.5%" comes back as "CEST 2.:5%" and "SGST 2.5%" as
   * "SESE 21.5%", and a rule about words cannot survive that while a rule
   * about shape can. Anything charged as a percentage this far down a bill is
   * a tax, and the patterns for discounts and service charges are tried first,
   * so "10% off" and "Service Charge 10%" are still read as what they are.
   */
  { field: 'tax', re: /\b(cgst|sgst|igst|gst|vat|service\s*tax|cess|tax)\b|\d\s*%/i, sum: true },
  { field: 'subtotal', re: /\b(sub\s*total|sub-total)\b/i },
  { field: 'total', re: /\b(grand\s*total|net\s*(payable|amount)|total\s*(due|payable|amount)?|amount\s*payable|bill\s*amount)\b/i },
];

/** Noise a receipt is full of that must never become a dish. */
const IGNORE_LINE =
  /\b(invoice|bill\s*no|table|covers?|gstin|fssai|hsn|sac|kot|user\s*id|stw|phone|tel\b|date|time|cashier|steward|server|thank|visit\s*again|www\.|@|receipt|order\s*no|token|counter|paid|change|cash|card|upi|balance|total\s*items)\b/i;

/**
 * The column header on an itemised bill — "SNo Description Qty Rate Amount".
 * It carries no trailing number, so without this it would be mistaken for a
 * dish name waiting for its price on the next line.
 */
const HEADER_LINE = /\b(s\.?\s*no|description|particulars|item)\b|\bqty\b|\brate\b|\bamount\b/i;

/** A line that is nothing but numbers: the "1 425.00 425.00" under a dish name. */
const NUMBERS_ONLY = /^[\d\s.,]+$/;

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

  /*
   * A price lives in its own right-hand column, so something separates it from
   * the label. A number jammed straight onto the text is an identifier, not an
   * amount — "Food:996331" is an HSN tax code, and read as a price it becomes a
   * ₹9,963.31 dish called "Food". Same for "Bill No:43088".
   */
  const before = m.index === 0 ? ' ' : line[m.index - 1];
  if (!/[\s₹$€£+(]/.test(before)) return null;

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
 * Drop the serial number an itemised bill prints beside each dish
 * ("1  Lotus Wafers"). Only when a real name follows, so "7Up" survives.
 */
function stripSerial(line) {
  const m = line.match(/^\s*\d{1,3}\s+([a-z].*)$/i);
  return m && m[1].trim().length >= 3 ? m[1] : line;
}

/** Every number on a line, in order, as a float. */
function numbersIn(line) {
  return (line.match(/\d[\d,]*(?:\.\d{1,2})?/g) ?? []).map((n) => Number(n.replace(/,/g, '')));
}

/**
 * Turn a bill's "Qty Rate Amount" row into an item.
 *
 * The trap is that Amount is already Qty × Rate. Taking qty=2 and price=550
 * from "2  275.00  550.00" would bill ₹1,100 for a ₹550 line — double, and
 * entirely plausible-looking. So when the three columns multiply out, the rate
 * is used as the price; otherwise quantity is dropped to 1 and the last number
 * taken as the line total, which is right either way.
 */
function columnsToItem(line) {
  const nums = numbersIn(line);
  const last = nums.at(-1) ?? 0;

  if (nums.length >= 3) {
    const [qty, rate] = nums;
    if (
      Number.isInteger(qty) && qty >= 1 && qty < 100 &&
      Math.abs(qty * rate - last) < 0.01
    ) {
      return { qty, price: rate };
    }
  }
  return { qty: 1, price: last };
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
  /*
   * Many Indian POS bills print the dish on one line and its figures on the
   * next:
   *
   *   1  Lotus Wafers
   *          1     425.00     425.00
   *   2  French Fries Spice Dusted
   *          2     275.00     550.00
   *
   * so a name is held here until the numbers underneath it arrive. Without
   * this the name lines have no price and the number lines have no name, and
   * the whole bill reads as empty.
   */
  let pendingName = null;

  for (const line of lines) {
    const amount = trailingAmount(line);

    if (!amount) {
      // Text with no figures: either a dish awaiting its numbers, or noise.
      const candidate = cleanName(stripSerial(line));
      pendingName =
        candidate.length >= 2 &&
        /[a-z]{2}/i.test(candidate) &&
        !HEADER_LINE.test(line) &&
        !IGNORE_LINE.test(line)
          ? candidate
          : null;
      continue;
    }

    // The figures belonging to the dish named on the line above.
    if (pendingName && NUMBERS_ONLY.test(line)) {
      raw.items.push({ name: pendingName, ...columnsToItem(line) });
      pendingName = null;
      continue;
    }

    const label = line.slice(0, amount.at).trim();

    // Noise first. "Total Items : 26" would otherwise be read as a ₹0.26 grand
    // total — and because bills print it *after* the real one, last-wins meant
    // it replaced a correct figure with a nonsense one.
    if (IGNORE_LINE.test(label)) {
      pendingName = null;
      continue;
    }

    // A summary row: record it and move on.
    const matched = SUMMARY_PATTERNS.find((p) => p.re.test(label));
    if (matched) {
      pendingName = null;
      let { field } = matched;
      // A negative round-off is money off the bill, which this app already
      // models as a discount. `other` cannot be negative anywhere downstream.
      if (field === 'other' && amount.negative) field = 'discount';
      if (matched.sum || field === 'discount') {
        // Components of one figure — CGST + SGST, delivery + packing.
        summary[field] = (summary[field] ?? 0) + amount.cents;
      } else if (field === 'total') {
        /*
         * Largest wins, because the grand total is structurally the biggest
         * figure on a bill — bigger than the subtotal it contains, and bigger
         * than any count printed alongside it.
         *
         * Keeping the last one instead looked fine until OCR read "Total Items
         * : 17" as "Total Ttems : 17". The keyword guard missed the typo, the
         * line was taken as a ₹17 grand total, and it replaced a correct
         * ₹8,987.70. A rule about magnitude cannot be defeated by a misread
         * letter, which a rule about words can.
         */
        summary.total = Math.max(summary.total ?? 0, amount.cents);
      } else {
        // Keep the *last* occurrence: bills often print a running figure and
        // then the real one at the foot.
        summary[field] = amount.cents;
      }
      continue;
    }

    pendingName = null;
    // A dish with a negative price is a misread, not a refund line.
    if (!label || amount.negative || IGNORE_LINE.test(label) || HEADER_LINE.test(label)) continue;
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

// --- several photographs of one bill -----------------------------------------

/**
 * How two rows are judged to be "the same line printed twice".
 *
 * Name, quantity and price together — not the name alone, because a table
 * genuinely can order the same dish on two separate lines at different times,
 * and those come out identical only when they really are duplicates.
 */
function itemKey(item) {
  const name = String(item?.name ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  return `${name}|${item?.qty ?? 1}|${item?.price ?? ''}`;
}

/**
 * Drop the part of `next` that is already the tail of `soFar`.
 *
 * People photograph a long receipt in overlapping pieces — deliberately, so no
 * line falls in the crack between two shots — which means the last few dishes
 * of one photo are the first few of the next. Concatenating naively bills those
 * dishes twice.
 *
 * The overlap is matched as a *run at the boundary*, longest first, so it only
 * ever removes rows that repeat in the same order at the join. Two identical
 * dishes ordered at different points in the meal sit in the middle of the list,
 * never at the seam, and survive untouched.
 */
function dropOverlap(soFar, next) {
  for (let k = Math.min(soFar.length, next.length); k > 0; k--) {
    const tail = soFar.slice(soFar.length - k).map(itemKey).join('\n');
    const head = next.slice(0, k).map(itemKey).join('\n');
    if (tail === head) return next.slice(k);
  }
  return next;
}

/**
 * Fold the scans of several photos into the one bill they came from.
 *
 * Items are concatenated with the boundary overlap removed. The summary fields
 * take the **largest** value seen rather than the sum, which is the right rule
 * for photos of the same piece of paper: the tax block usually appears on the
 * last shot only, but when two shots overlap it appears on both, and adding
 * them would double a figure the user has no reason to re-check.
 *
 * The cost of `max` is a tax split across a page boundary — CGST at the foot of
 * one photo, SGST at the head of the next — which comes out as the larger half
 * alone. That leaves a shortfall against the printed total, which the
 * reconciliation strip shows in as many words. Double-counting produces no
 * warning at all, so it is the worse way to be wrong.
 *
 * @param {object[]} raws raw scans, in the order the photos were taken
 * @returns {object} a single raw scan for `normalizeScan`
 */
export function mergeRawScans(raws) {
  const merged = { items: [], currency: 'INR' };

  for (const raw of raws) {
    if (!raw || typeof raw !== 'object') continue;
    const items = Array.isArray(raw.items) ? raw.items : [];
    merged.items.push(...dropOverlap(merged.items, items));

    for (const field of ['tax', 'tip', 'other', 'discount', 'total']) {
      const value = Number(raw[field]);
      if (!Number.isFinite(value)) continue;
      merged[field] = Math.max(merged[field] ?? 0, value);
    }
    if (raw.currency && raw.currency !== 'INR') merged.currency = raw.currency;
  }

  return merged;
}

/**
 * The local engine's answer for one bill photographed several times.
 *
 * Each photo is parsed on its own before merging, rather than parsing one
 * concatenated blob. The line-by-line heuristics carry state across lines — a
 * dish name waiting for the figures printed underneath it — and running that
 * state off the end of one photo and into the header of the next pairs a dish
 * with somebody else's numbers.
 *
 * @param {string[]} pages raw OCR text, one entry per photo, in order
 * @returns {object} a raw scan, ready for `normalizeScan`
 */
export function parseReceiptPages(pages) {
  const texts = (Array.isArray(pages) ? pages : [pages]).slice(0, MAX_PAGES);
  return mergeRawScans(texts.map((text) => parseReceiptText(text)));
}
