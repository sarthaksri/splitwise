/**
 * The split engine.
 *
 * Every expense — however it was entered — normalises down to one thing:
 * a list of `{ userId, amountCents }` shares that sums to EXACTLY the expense
 * total. Balances, pairwise debts and debt simplification all read only that
 * list and never care whether the user typed percentages or ticked dishes.
 *
 * Pure and dependency-free: the client runs it for the live preview while you
 * type, the server runs it as the source of truth. One implementation, no drift.
 */

import { allocate, sumValues, addTo } from './money.js';

export const SPLIT_TYPES = /** @type {const} */ ({
  EQUAL: 'EQUAL',
  EXACT: 'EXACT',
  PERCENT: 'PERCENT',
  SHARES: 'SHARES',
  ITEMIZED: 'ITEMIZED',
});

export const SPLIT_TYPE_LIST = Object.values(SPLIT_TYPES);

/** Percentages are stored as basis points (1% = 100 bps) to stay integral. */
export const BPS_TOTAL = 10_000;

/** A validation failure the UI can show verbatim next to the offending field. */
export class SplitError extends Error {
  constructor(message, { code = 'INVALID_SPLIT', field = null } = {}) {
    super(message);
    this.name = 'SplitError';
    this.code = code;
    this.field = field;
  }
}

const asId = (v) => (v == null ? '' : String(v));
const isInt = (v) => Number.isInteger(v);

function requireIntegerCents(value, label) {
  if (!isInt(value)) {
    throw new SplitError(`${label} must be a whole number of paise/cents`, {
      code: 'NOT_INTEGER',
    });
  }
}

function assertPositive(amountCents) {
  if (amountCents <= 0) {
    throw new SplitError('The expense amount must be greater than zero', {
      code: 'NON_POSITIVE_AMOUNT',
      field: 'amountCents',
    });
  }
}

/** Unique, order-preserving list of ids. */
function uniqueIds(ids) {
  const seen = new Set();
  const out = [];
  for (const raw of ids) {
    const id = asId(raw);
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Normalise a `{ userId: number }` map (or array of `{ userId, value }`) into
 * a Map, dropping empty ids.
 */
function toNumberMap(input, label) {
  const map = new Map();
  if (!input) return map;

  const entries = Array.isArray(input)
    ? input.map((e) => [e.userId ?? e.user, e.value ?? e.amountCents ?? e.weight ?? e.bps])
    : Object.entries(input);

  for (const [rawId, rawValue] of entries) {
    const id = asId(rawId);
    if (!id) continue;
    const value = Number(rawValue);
    if (!Number.isFinite(value)) {
      throw new SplitError(`${label} contains a non-numeric value`, { code: 'NOT_A_NUMBER' });
    }
    map.set(id, value);
  }
  return map;
}

/* -------------------------------------------------------------------------- */
/* Itemized (dish-wise) helpers                                               */
/* -------------------------------------------------------------------------- */

/** Line total for one dish: unit price × quantity. */
export function itemTotalCents(item) {
  const price = Number(item?.priceCents);
  const qty = item?.qty == null ? 1 : Number(item.qty);
  if (!isInt(price)) {
    throw new SplitError(`"${item?.name || 'Item'}" needs a valid price`, {
      code: 'BAD_ITEM_PRICE',
      field: 'priceCents',
    });
  }
  if (!isInt(qty) || qty < 1) {
    throw new SplitError(`"${item?.name || 'Item'}" needs a quantity of at least 1`, {
      code: 'BAD_ITEM_QTY',
      field: 'qty',
    });
  }
  if (price < 0) {
    throw new SplitError(`"${item?.name || 'Item'}" cannot have a negative price`, {
      code: 'BAD_ITEM_PRICE',
      field: 'priceCents',
    });
  }
  return price * qty;
}

/** Sum of all dish line totals, before tax/tip/discount. */
export function itemsSubtotalCents(items = []) {
  return items.reduce((sum, item) => sum + itemTotalCents(item), 0);
}

export const DISCOUNT_MODES = /** @type {const} */ ({ AMOUNT: 'amount', PERCENT: 'percent' });

/**
 * What the discount actually comes to, in minor units.
 *
 * A discount can be entered either as a flat amount ("₹50 off") or as a
 * percentage ("20% off"). A percentage is taken off the **dishes subtotal**,
 * before tax and tip — that's how a restaurant applies one, and it means the
 * tax you pay is still computed on the full menu price, as on a real bill.
 *
 * @param {number} itemsSubtotal dishes total, before extras
 * @returns {number} integer minor units, never more than the subtotal
 */
export function resolveDiscountCents(itemsSubtotal, input = {}) {
  const mode = input.discountMode ?? DISCOUNT_MODES.AMOUNT;

  if (mode === DISCOUNT_MODES.PERCENT) {
    const bps = Number(input.discountBps ?? 0);
    if (!isInt(bps) || bps < 0) {
      throw new SplitError('The discount percentage must not be negative', {
        code: 'BAD_DISCOUNT_PERCENT',
        field: 'discountBps',
      });
    }
    if (bps > BPS_TOTAL) {
      throw new SplitError('A discount cannot be more than 100%', {
        code: 'DISCOUNT_OVER_100',
        field: 'discountBps',
      });
    }
    return Math.round((itemsSubtotal * bps) / BPS_TOTAL);
  }

  const cents = Number(input.discountCents ?? 0);
  requireIntegerCents(cents, 'Discount');
  if (cents < 0) {
    throw new SplitError('The discount must not be negative', {
      code: 'NEGATIVE_EXTRA',
      field: 'discountCents',
    });
  }
  return cents;
}

/**
 * tax + tip + other − discount. May be negative if the discount dominates.
 *
 * `itemsSubtotal` is needed because a percentage discount is relative to it.
 */
export function extrasTotalCents(input = {}, itemsSubtotal = 0) {
  const { taxCents = 0, tipCents = 0, otherCents = 0 } = input;
  requireIntegerCents(taxCents, 'Tax');
  requireIntegerCents(tipCents, 'Tip');
  requireIntegerCents(otherCents, 'Other charges');
  if (taxCents < 0 || tipCents < 0 || otherCents < 0) {
    throw new SplitError('Tax, tip and other charges must not be negative', {
      code: 'NEGATIVE_EXTRA',
    });
  }
  return taxCents + tipCents + otherCents - resolveDiscountCents(itemsSubtotal, input);
}

/**
 * The grand total a dish-wise bill implies. The UI uses this to auto-fill the
 * amount field, and the server uses it to reject a total that disagrees.
 */
export function itemizedTotalCents(input = {}) {
  const subtotal = itemsSubtotalCents(input.items ?? []);
  return subtotal + extrasTotalCents(input, subtotal);
}

/**
 * Dish-wise split.
 *
 *   1. each dish's line total is shared equally among the people who ate it
 *   2. tax / tip / other charges / discount are then shared out in proportion
 *      to what each person's dishes came to
 *
 * So if your dishes were 40% of the food bill, you pay 40% of the GST and 40%
 * of the tip — which is what "split the tax fairly" actually means.
 */
function computeItemized(input) {
  const items = input.items ?? [];
  if (items.length === 0) {
    throw new SplitError('Add at least one dish to split by dish', {
      code: 'NO_ITEMS',
      field: 'items',
    });
  }

  const subtotals = new Map(); // userId -> cents from dishes
  const perItem = []; // for the UI breakdown

  for (const item of items) {
    const eaters = uniqueIds(item.sharedBy ?? []);
    if (eaters.length === 0) {
      throw new SplitError(`Nobody is marked as sharing "${item.name || 'this dish'}"`, {
        code: 'ITEM_HAS_NO_EATERS',
        field: 'sharedBy',
      });
    }
    const lineTotal = itemTotalCents(item);
    const perEater = allocate(lineTotal, eaters);
    for (const [userId, cents] of perEater) addTo(subtotals, userId, cents);
    perItem.push({ name: item.name ?? '', lineTotalCents: lineTotal, perEater });
  }

  const itemsTotal = sumValues(subtotals);
  const extras = extrasTotalCents(input, itemsTotal);
  const discountCents = resolveDiscountCents(itemsTotal, input);

  if (itemsTotal + extras < 0) {
    throw new SplitError('The discount is larger than the bill', {
      code: 'DISCOUNT_TOO_LARGE',
      field: 'discountCents',
    });
  }

  // Proportional to each person's food subtotal. If every dish somehow came to
  // zero, fall back to an even split of the extras so nothing is lost.
  const diners = [...subtotals.keys()];
  const weights = diners.map((id) => subtotals.get(id));
  const extraShares =
    itemsTotal === 0 ? allocate(extras, diners) : allocate(extras, diners, weights);

  const shares = new Map();
  for (const id of diners) {
    shares.set(id, subtotals.get(id) + (extraShares.get(id) ?? 0));
  }

  return {
    shares,
    itemized: {
      itemsTotalCents: itemsTotal,
      extrasCents: extras,
      // The resolved discount, so callers persisting the expense record the
      // rupee figure a percentage worked out to.
      discountCents,
      subtotals,
      extraShares,
      perItem,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The other four modes                                                        */
/* -------------------------------------------------------------------------- */

function computeEqual(amountCents, participants) {
  if (participants.length === 0) {
    throw new SplitError('Select at least one person to split between', {
      code: 'NO_PARTICIPANTS',
      field: 'participants',
    });
  }
  return { shares: allocate(amountCents, participants) };
}

function computeExact(amountCents, input) {
  const exact = toNumberMap(input.exact, 'Exact amounts');
  if (exact.size === 0) {
    throw new SplitError('Enter an amount for at least one person', {
      code: 'NO_PARTICIPANTS',
      field: 'exact',
    });
  }
  for (const [, cents] of exact) {
    requireIntegerCents(cents, 'Each exact amount');
  }
  const total = sumValues(exact);
  if (total !== amountCents) {
    throw new SplitError(
      `The exact amounts add up to ${total / 100}, but the expense is ${amountCents / 100}`,
      { code: 'EXACT_SUM_MISMATCH', field: 'exact' },
    );
  }
  return { shares: exact };
}

function computePercent(amountCents, input) {
  const bps = toNumberMap(input.percentBps ?? input.percent, 'Percentages');
  if (bps.size === 0) {
    throw new SplitError('Enter a percentage for at least one person', {
      code: 'NO_PARTICIPANTS',
      field: 'percentBps',
    });
  }
  for (const [, value] of bps) {
    if (!isInt(value) || value < 0) {
      throw new SplitError('Percentages must be non-negative (in basis points)', {
        code: 'BAD_PERCENT',
        field: 'percentBps',
      });
    }
  }
  const total = sumValues(bps);
  if (total !== BPS_TOTAL) {
    throw new SplitError(`Percentages add up to ${total / 100}%, they must total 100%`, {
      code: 'PERCENT_SUM_MISMATCH',
      field: 'percentBps',
    });
  }
  const ids = [...bps.keys()];
  return { shares: allocate(amountCents, ids, ids.map((id) => bps.get(id))) };
}

function computeByShares(amountCents, input) {
  const weights = toNumberMap(input.weights ?? input.shares, 'Shares');
  if (weights.size === 0) {
    throw new SplitError('Enter a share for at least one person', {
      code: 'NO_PARTICIPANTS',
      field: 'weights',
    });
  }
  for (const [, value] of weights) {
    if (!Number.isFinite(value) || value < 0) {
      throw new SplitError('Shares must be non-negative numbers', {
        code: 'BAD_SHARES',
        field: 'weights',
      });
    }
  }
  if (sumValues(weights) <= 0) {
    throw new SplitError('Total shares must be greater than zero', {
      code: 'ZERO_SHARES',
      field: 'weights',
    });
  }
  const ids = [...weights.keys()];
  return { shares: allocate(amountCents, ids, ids.map((id) => weights.get(id))) };
}

/* -------------------------------------------------------------------------- */
/* Public entry point                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Turn an expense's split configuration into the canonical share list.
 *
 * @param {object} input
 * @param {string} input.splitType     one of SPLIT_TYPES
 * @param {number} input.amountCents   expense total in minor units
 * @param {string[]} [input.participants]   EQUAL
 * @param {Object<string,number>} [input.exact]       EXACT: userId -> cents
 * @param {Object<string,number>} [input.percentBps]  PERCENT: userId -> basis points
 * @param {Object<string,number>} [input.weights]     SHARES: userId -> weight
 * @param {Array} [input.items]        ITEMIZED: [{ name, priceCents, qty, sharedBy[] }]
 * @param {number} [input.taxCents]
 * @param {number} [input.tipCents]
 * @param {number} [input.otherCents]
 * @param {number} [input.discountCents]
 * @returns {{ shares: {userId: string, amountCents: number}[], sharesMap: Map<string,number>, itemized?: object }}
 * @throws {SplitError} with a user-facing message when the input can't be split
 */
export function computeShares(input) {
  const splitType = input?.splitType;
  if (!SPLIT_TYPE_LIST.includes(splitType)) {
    throw new SplitError(`Unknown split type "${splitType}"`, { code: 'UNKNOWN_SPLIT_TYPE' });
  }

  let amountCents = input.amountCents;
  let result;

  if (splitType === SPLIT_TYPES.ITEMIZED) {
    // Split the dishes FIRST, so a specific complaint ("nobody is sharing the
    // fries", "that discount is bigger than the bill") reaches the user instead
    // of a generic one about the total, which is derived from the dishes anyway.
    result = computeItemized(input);
    const derived = result.itemized.itemsTotalCents + result.itemized.extrasCents;

    if (amountCents == null) {
      amountCents = derived;
    } else {
      requireIntegerCents(amountCents, 'Amount');
      if (amountCents !== derived) {
        throw new SplitError(
          `The dishes, tax and tip add up to ${derived / 100}, but the expense total is ${amountCents / 100}`,
          { code: 'ITEMIZED_TOTAL_MISMATCH', field: 'amountCents' },
        );
      }
    }
    assertPositive(amountCents);
  } else {
    requireIntegerCents(amountCents, 'Amount');
    assertPositive(amountCents);

    switch (splitType) {
      case SPLIT_TYPES.EQUAL:
        result = computeEqual(amountCents, uniqueIds(input.participants ?? []));
        break;
      case SPLIT_TYPES.EXACT:
        result = computeExact(amountCents, input);
        break;
      case SPLIT_TYPES.PERCENT:
        result = computePercent(amountCents, input);
        break;
      case SPLIT_TYPES.SHARES:
        result = computeByShares(amountCents, input);
        break;
      default:
        throw new SplitError(`Unknown split type "${splitType}"`, { code: 'UNKNOWN_SPLIT_TYPE' });
    }
  }

  // The invariant the entire app rests on. If this ever trips it's a bug in the
  // engine, not bad user input, so it is an Error rather than a SplitError.
  const total = sumValues(result.shares);
  if (total !== amountCents) {
    throw new Error(
      `Split engine bug: shares total ${total} but expense is ${amountCents} (${splitType})`,
    );
  }

  return {
    amountCents,
    sharesMap: result.shares,
    shares: [...result.shares].map(([userId, cents]) => ({ userId, amountCents: cents })),
    ...(result.itemized ? { itemized: result.itemized } : {}),
  };
}

/**
 * Validate the payer side of an expense: who put money down, and how much.
 * Mirrors the share side — the amounts must total the expense exactly.
 *
 * @returns {{userId: string, amountCents: number}[]}
 */
export function normalizePayers(paidBy, amountCents) {
  const list = Array.isArray(paidBy) ? paidBy : [];
  const map = new Map();

  for (const entry of list) {
    const id = asId(entry?.userId ?? entry?.user);
    if (!id) continue;
    const cents = Number(entry.amountCents);
    requireIntegerCents(cents, 'Each paid amount');
    if (cents < 0) {
      throw new SplitError('A payer cannot pay a negative amount', {
        code: 'NEGATIVE_PAYMENT',
        field: 'paidBy',
      });
    }
    addTo(map, id, cents);
  }

  if (map.size === 0) {
    throw new SplitError('Select who paid for this expense', {
      code: 'NO_PAYERS',
      field: 'paidBy',
    });
  }

  const total = sumValues(map);
  if (total !== amountCents) {
    throw new SplitError(
      `The payers put in ${total / 100}, but the expense is ${amountCents / 100}`,
      { code: 'PAYER_SUM_MISMATCH', field: 'paidBy' },
    );
  }

  return [...map].map(([userId, cents]) => ({ userId, amountCents: cents }));
}
