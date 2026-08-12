import { describe, it, expect } from 'vitest';
import {
  computeShares,
  normalizePayers,
  itemizedTotalCents,
  itemsSubtotalCents,
  SPLIT_TYPES,
  SplitError,
} from './splitEngine.js';
import { sumValues } from './money.js';

const shareOf = (result, userId) => result.sharesMap.get(userId) ?? 0;

describe('EQUAL', () => {
  it('splits a clean amount evenly', () => {
    const r = computeShares({
      splitType: SPLIT_TYPES.EQUAL,
      amountCents: 90000,
      participants: ['a', 'b', 'c'],
    });
    expect(shareOf(r, 'a')).toBe(30000);
    expect(sumValues(r.sharesMap)).toBe(90000);
  });

  it('distributes the odd paise rather than dropping it', () => {
    const r = computeShares({
      splitType: SPLIT_TYPES.EQUAL,
      amountCents: 10000,
      participants: ['a', 'b', 'c'],
    });
    expect(sumValues(r.sharesMap)).toBe(10000);
    expect([...r.sharesMap.values()].sort()).toEqual([3333, 3333, 3334]);
  });

  it('ignores duplicate participants', () => {
    const r = computeShares({
      splitType: SPLIT_TYPES.EQUAL,
      amountCents: 1000,
      participants: ['a', 'a', 'b'],
    });
    expect(r.shares).toHaveLength(2);
  });

  it('rejects an empty participant list', () => {
    expect(() =>
      computeShares({ splitType: SPLIT_TYPES.EQUAL, amountCents: 1000, participants: [] }),
    ).toThrow(SplitError);
  });
});

describe('EXACT', () => {
  it('uses the amounts as given', () => {
    const r = computeShares({
      splitType: SPLIT_TYPES.EXACT,
      amountCents: 10000,
      exact: { a: 6000, b: 4000 },
    });
    expect(shareOf(r, 'a')).toBe(6000);
    expect(shareOf(r, 'b')).toBe(4000);
  });

  it('rejects amounts that do not add up to the total', () => {
    expect(() =>
      computeShares({
        splitType: SPLIT_TYPES.EXACT,
        amountCents: 10000,
        exact: { a: 6000, b: 3000 },
      }),
    ).toThrow(/add up to 90/);
  });
});

describe('PERCENT', () => {
  it('splits by basis points', () => {
    const r = computeShares({
      splitType: SPLIT_TYPES.PERCENT,
      amountCents: 20000,
      percentBps: { a: 2500, b: 7500 },
    });
    expect(shareOf(r, 'a')).toBe(5000);
    expect(shareOf(r, 'b')).toBe(15000);
  });

  it('stays exact on percentages that do not divide cleanly', () => {
    const r = computeShares({
      splitType: SPLIT_TYPES.PERCENT,
      amountCents: 10000,
      percentBps: { a: 3333, b: 3333, c: 3334 },
    });
    expect(sumValues(r.sharesMap)).toBe(10000);
  });

  it('rejects percentages that do not total 100%', () => {
    expect(() =>
      computeShares({
        splitType: SPLIT_TYPES.PERCENT,
        amountCents: 10000,
        percentBps: { a: 5000, b: 4000 },
      }),
    ).toThrow(/must total 100%/);
  });
});

describe('SHARES', () => {
  it('splits by weight', () => {
    const r = computeShares({
      splitType: SPLIT_TYPES.SHARES,
      amountCents: 12000,
      weights: { a: 2, b: 1, c: 1 },
    });
    expect(shareOf(r, 'a')).toBe(6000);
    expect(shareOf(r, 'b')).toBe(3000);
    expect(sumValues(r.sharesMap)).toBe(12000);
  });

  it('rejects all-zero weights', () => {
    expect(() =>
      computeShares({ splitType: SPLIT_TYPES.SHARES, amountCents: 100, weights: { a: 0, b: 0 } }),
    ).toThrow(/greater than zero/);
  });
});

describe('ITEMIZED (dish-wise)', () => {
  // A realistic restaurant bill: Aditi skipped the dessert.
  const dinner = {
    splitType: SPLIT_TYPES.ITEMIZED,
    items: [
      { name: 'Paneer Tikka', priceCents: 32000, qty: 1, sharedBy: ['aditi', 'rahul', 'sara'] },
      { name: 'Butter Naan', priceCents: 6000, qty: 4, sharedBy: ['aditi', 'rahul', 'sara'] },
      { name: 'Tiramisu', priceCents: 24000, qty: 1, sharedBy: ['rahul', 'sara'] },
    ],
    taxCents: 5000,
    tipCents: 4000,
  };

  it('derives the total from dishes plus extras', () => {
    expect(itemsSubtotalCents(dinner.items)).toBe(32000 + 24000 + 24000);
    expect(itemizedTotalCents(dinner)).toBe(80000 + 9000);
  });

  it('charges each person only for the dishes they shared', () => {
    const r = computeShares(dinner);
    // Shared food is 56000 across three; the dessert is 24000 across two.
    // Aditi skipped dessert, so she pays materially less than the other two.
    expect(shareOf(r, 'aditi')).toBeLessThan(shareOf(r, 'rahul'));
    expect(shareOf(r, 'rahul') - shareOf(r, 'aditi')).toBeGreaterThan(12_00);
    // Rahul and Sara ate identically, so they land within one paise of each
    // other — ₹560 genuinely cannot be divided into three equal parts, and the
    // odd paise has to sit with somebody rather than vanish.
    expect(Math.abs(shareOf(r, 'rahul') - shareOf(r, 'sara'))).toBeLessThanOrEqual(1);
    // Pinned exact values, so a future refactor of the rounding is visible.
    expect(shareOf(r, 'aditi')).toBe(20767);
    expect(shareOf(r, 'rahul')).toBe(34117);
    expect(shareOf(r, 'sara')).toBe(34116);
    expect(sumValues(r.sharesMap)).toBe(89000);
  });

  it('shares tax and tip in proportion to what each person ate', () => {
    const r = computeShares(dinner);
    const { subtotals, extraShares } = r.itemized;
    const itemsTotal = sumValues(subtotals);
    expect(sumValues(extraShares)).toBe(9000);
    // Aditi's slice of the extras tracks her slice of the food.
    const foodRatio = subtotals.get('aditi') / itemsTotal;
    expect(extraShares.get('aditi') / 9000).toBeCloseTo(foodRatio, 3);
    // and she pays strictly less tax than the dessert-eaters
    expect(extraShares.get('aditi')).toBeLessThan(extraShares.get('rahul'));
  });

  it('handles a dish only one person ordered', () => {
    const r = computeShares({
      splitType: SPLIT_TYPES.ITEMIZED,
      items: [
        { name: 'Coffee', priceCents: 15000, qty: 1, sharedBy: ['a'] },
        { name: 'Cake', priceCents: 25000, qty: 1, sharedBy: ['b'] },
      ],
    });
    expect(shareOf(r, 'a')).toBe(15000);
    expect(shareOf(r, 'b')).toBe(25000);
  });

  it('applies a discount proportionally', () => {
    const r = computeShares({
      splitType: SPLIT_TYPES.ITEMIZED,
      items: [
        { name: 'A', priceCents: 30000, qty: 1, sharedBy: ['a'] },
        { name: 'B', priceCents: 10000, qty: 1, sharedBy: ['b'] },
      ],
      discountCents: 4000,
    });
    expect(shareOf(r, 'a')).toBe(27000); // 30000 - 75% of 4000
    expect(shareOf(r, 'b')).toBe(9000); // 10000 - 25% of 4000
    expect(sumValues(r.sharesMap)).toBe(36000);
  });

  it('applies a percentage discount off the dishes, before tax', () => {
    const r = computeShares({
      splitType: SPLIT_TYPES.ITEMIZED,
      items: [
        { name: 'A', priceCents: 30000, qty: 1, sharedBy: ['a'] },
        { name: 'B', priceCents: 10000, qty: 1, sharedBy: ['b'] },
      ],
      discountMode: 'percent',
      discountBps: 2000, // 20%
      taxCents: 5000,
    });
    // 20% of the 40000 subtotal is 8000, taken off the food only; the 5000 tax
    // is still charged on the full menu price, as on a real bill.
    expect(r.itemized.discountCents).toBe(8000);
    expect(r.amountCents).toBe(40000 - 8000 + 5000);
    // and the saving lands in proportion: a had 75% of the food
    expect(shareOf(r, 'a') + shareOf(r, 'b')).toBe(37000);
    expect(shareOf(r, 'a')).toBe(27750);
  });

  it('treats 100% off as free food, and rejects more', () => {
    const free = computeShares({
      splitType: SPLIT_TYPES.ITEMIZED,
      items: [{ name: 'A', priceCents: 20000, qty: 1, sharedBy: ['a'] }],
      discountMode: 'percent',
      discountBps: 10000,
      tipCents: 3000,
    });
    expect(free.amountCents).toBe(3000); // just the tip
    expect(shareOf(free, 'a')).toBe(3000);

    expect(() =>
      computeShares({
        splitType: SPLIT_TYPES.ITEMIZED,
        items: [{ name: 'A', priceCents: 20000, qty: 1, sharedBy: ['a'] }],
        discountMode: 'percent',
        discountBps: 12000,
      }),
    ).toThrow(/more than 100%/);
  });

  it('ignores the flat amount when in percentage mode, and vice versa', () => {
    const base = {
      splitType: SPLIT_TYPES.ITEMIZED,
      items: [{ name: 'A', priceCents: 10000, qty: 1, sharedBy: ['a'] }],
    };
    // percent mode: the stale rupee figure must not also be subtracted
    const pct = computeShares({ ...base, discountMode: 'percent', discountBps: 1000, discountCents: 9999 });
    expect(pct.amountCents).toBe(9000);
    // amount mode: a stale percentage must not leak in
    const amt = computeShares({ ...base, discountMode: 'amount', discountCents: 2500, discountBps: 5000 });
    expect(amt.amountCents).toBe(7500);
  });

  it('rounds a percentage discount to whole paise and stays exact', () => {
    const r = computeShares({
      splitType: SPLIT_TYPES.ITEMIZED,
      items: [{ name: 'A', priceCents: 33333, qty: 1, sharedBy: ['a', 'b', 'c'] }],
      discountMode: 'percent',
      discountBps: 1750, // 17.5% of 33333 = 5833.275
    });
    expect(r.itemized.discountCents).toBe(5833);
    expect(sumValues(r.sharesMap)).toBe(33333 - 5833);
  });

  it('multiplies price by quantity', () => {
    const r = computeShares({
      splitType: SPLIT_TYPES.ITEMIZED,
      items: [{ name: 'Naan', priceCents: 5000, qty: 3, sharedBy: ['a'] }],
    });
    expect(shareOf(r, 'a')).toBe(15000);
  });

  it('never loses a paise across many awkward bills', () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const people = ['a', 'b', 'c', 'd', 'e'];
    for (let trial = 0; trial < 400; trial += 1) {
      const items = Array.from({ length: 1 + Math.floor(rand() * 6) }, (_, i) => {
        const eaters = people.filter(() => rand() > 0.45);
        return {
          name: `item${i}`,
          priceCents: 1 + Math.floor(rand() * 50_000),
          qty: 1 + Math.floor(rand() * 3),
          sharedBy: eaters.length ? eaters : [people[0]],
        };
      });
      const input = {
        splitType: SPLIT_TYPES.ITEMIZED,
        items,
        taxCents: Math.floor(rand() * 5000),
        tipCents: Math.floor(rand() * 3000),
      };
      const r = computeShares(input);
      expect(sumValues(r.sharesMap)).toBe(itemizedTotalCents(input));
    }
  });

  it('rejects a dish nobody is marked as sharing', () => {
    expect(() =>
      computeShares({
        splitType: SPLIT_TYPES.ITEMIZED,
        items: [{ name: 'Fries', priceCents: 1000, qty: 1, sharedBy: [] }],
      }),
    ).toThrow(/Nobody is marked as sharing "Fries"/);
  });

  it('rejects a stated total that disagrees with the dishes', () => {
    expect(() => computeShares({ ...dinner, amountCents: 99999 })).toThrow(
      /ITEMIZED_TOTAL_MISMATCH|add up to/,
    );
  });

  it('accepts a stated total that agrees', () => {
    const r = computeShares({ ...dinner, amountCents: 89000 });
    expect(r.amountCents).toBe(89000);
  });

  it('rejects a discount bigger than the bill', () => {
    expect(() =>
      computeShares({
        splitType: SPLIT_TYPES.ITEMIZED,
        items: [{ name: 'A', priceCents: 1000, qty: 1, sharedBy: ['a'] }],
        discountCents: 5000,
      }),
    ).toThrow(/discount is larger/);
  });

  it('rejects an empty dish list and bad prices', () => {
    expect(() => computeShares({ splitType: SPLIT_TYPES.ITEMIZED, items: [] })).toThrow(
      /at least one dish/,
    );
    expect(() =>
      computeShares({
        splitType: SPLIT_TYPES.ITEMIZED,
        items: [{ name: 'A', priceCents: 10.5, qty: 1, sharedBy: ['a'] }],
      }),
    ).toThrow(/valid price/);
    expect(() =>
      computeShares({
        splitType: SPLIT_TYPES.ITEMIZED,
        items: [{ name: 'A', priceCents: 100, qty: 0, sharedBy: ['a'] }],
      }),
    ).toThrow(/quantity of at least 1/);
  });
});

describe('computeShares guards', () => {
  it('rejects unknown split types and non-positive amounts', () => {
    expect(() => computeShares({ splitType: 'WAT', amountCents: 100 })).toThrow(/Unknown split/);
    expect(() =>
      computeShares({ splitType: SPLIT_TYPES.EQUAL, amountCents: 0, participants: ['a'] }),
    ).toThrow(/greater than zero/);
    expect(() =>
      computeShares({ splitType: SPLIT_TYPES.EQUAL, amountCents: 10.5, participants: ['a'] }),
    ).toThrow(/whole number/);
  });
});

describe('normalizePayers', () => {
  it('accepts a single payer covering the whole bill', () => {
    const payers = normalizePayers([{ userId: 'a', amountCents: 5000 }], 5000);
    expect(payers).toEqual([{ userId: 'a', amountCents: 5000 }]);
  });

  it('accepts multiple payers and merges duplicates', () => {
    const payers = normalizePayers(
      [
        { userId: 'a', amountCents: 3000 },
        { userId: 'b', amountCents: 1000 },
        { userId: 'a', amountCents: 1000 },
      ],
      5000,
    );
    expect(payers).toContainEqual({ userId: 'a', amountCents: 4000 });
    expect(payers).toHaveLength(2);
  });

  it('rejects payers that do not cover the expense', () => {
    expect(() => normalizePayers([{ userId: 'a', amountCents: 4000 }], 5000)).toThrow(
      /payers put in 40/,
    );
    expect(() => normalizePayers([], 5000)).toThrow(/who paid/);
  });
});
