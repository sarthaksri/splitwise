import { describe, it, expect } from 'vitest';
import { recurringNetPerMonth } from './recurring.js';
import { sumValues } from '../../../shared/money.js';
import { toMonthlyCents } from '../../../shared/recurrence.js';

/** A recurring template as the model would hold it (ids as plain strings). */
function template({
  description = 'Bill',
  amountCents,
  frequency,
  interval = 1,
  payer,
  participants,
  group = 'g1',
}) {
  return {
    _id: `t-${description}`,
    group,
    description,
    amountCents,
    frequency,
    interval,
    active: true,
    deletedAt: null,
    paidBy: [{ user: payer, amountCents }],
    splitType: 'EQUAL',
    splitConfig: { participants },
    items: [],
    taxCents: 0,
    tipCents: 0,
    otherCents: 0,
    discountCents: 0,
  };
}

const THREE = ['aditi', 'rahul', 'sara'];

describe('recurringNetPerMonth', () => {
  it('nets a single monthly bill', () => {
    const out = recurringNetPerMonth([
      template({ amountCents: 30_000_00, frequency: 'monthly', payer: 'aditi', participants: THREE }),
    ]);
    const net = Object.fromEntries(out.perMonthNet.map((n) => [n.userId, n.amountCents]));
    expect(net.aditi).toBe(20_000_00); // pays 30k, owes 10k
    expect(net.rahul).toBe(-10_000_00);
    expect(out.standingPayments).toHaveLength(2);
  });

  it('converts a weekly bill to its true monthly cost, not four weeks', () => {
    const out = recurringNetPerMonth([
      template({ amountCents: 600_00, frequency: 'weekly', payer: 'sara', participants: THREE }),
    ]);
    // 600 x 52 / 12 = 2600/month, NOT 2400
    expect(out.items[0].monthlyCents).toBe(2_600_00);
    // Sara fronts it, so she's owed the other two thirds each month. ₹2,600
    // doesn't divide by three, and largest-remainder hands the spare paise to
    // the alphabetically earlier pair — so Sara's own share rounds down and she
    // is owed a paise more than a naive third would suggest.
    const sara = out.perMonthNet.find((n) => n.userId === 'sara');
    expect(sara.amountCents).toBe(2_600_00 - 866_66);
    expect(out.perMonthNet.reduce((s, n) => s + n.amountCents, 0)).toBe(0);
  });

  it('divides by the interval', () => {
    const out = recurringNetPerMonth([
      template({
        amountCents: 1_200_00,
        frequency: 'monthly',
        interval: 3,
        payer: 'aditi',
        participants: THREE,
      }),
    ]);
    expect(out.items[0].monthlyCents).toBe(400_00);
  });

  it('collapses several bills into the fewest standing payments', () => {
    // Each flatmate pays one bill; simplification should beat one payment per bill.
    const out = recurringNetPerMonth([
      template({ description: 'Rent', amountCents: 30_000_00, frequency: 'monthly', payer: 'aditi', participants: THREE }),
      template({ description: 'Net', amountCents: 1_199_00, frequency: 'monthly', payer: 'rahul', participants: THREE }),
      template({ description: 'Cleaner', amountCents: 600_00, frequency: 'weekly', payer: 'sara', participants: THREE }),
    ]);

    expect(out.items).toHaveLength(3);
    // At most n-1 transfers for three people.
    expect(out.standingPayments.length).toBeLessThanOrEqual(2);
    // and they settle the monthly position exactly
    const residual = new Map(out.perMonthNet.map((n) => [n.userId, n.amountCents]));
    for (const p of out.standingPayments) {
      residual.set(p.from, (residual.get(p.from) ?? 0) + p.amountCents);
      residual.set(p.to, (residual.get(p.to) ?? 0) - p.amountCents);
    }
    expect([...residual.values()].every((v) => v === 0)).toBe(true);
  });

  it('conserves money exactly, so the monthly net always sums to zero', () => {
    // Mixed frequencies are where naive scaling leaks a paise and the
    // simplifier then refuses to run.
    const frequencies = ['daily', 'weekly', 'fortnightly', 'monthly', 'quarterly', 'yearly'];
    let seed = 5;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };

    for (let trial = 0; trial < 200; trial += 1) {
      const templates = Array.from({ length: 1 + Math.floor(rand() * 5) }, (_, i) => {
        const participants = THREE.filter(() => rand() > 0.3);
        return template({
          description: `b${i}`,
          amountCents: 1 + Math.floor(rand() * 500_000),
          frequency: frequencies[Math.floor(rand() * frequencies.length)],
          interval: 1 + Math.floor(rand() * 3),
          payer: THREE[Math.floor(rand() * 3)],
          participants: participants.length ? participants : THREE,
        });
      });

      // Must not throw: the drift guard inside would catch a rounding leak.
      const out = recurringNetPerMonth(templates);
      expect(sumValues(new Map(out.perMonthNet.map((n) => [n.userId, n.amountCents])))).toBe(0);
      expect(out.standingPayments.every((p) => p.amountCents > 0)).toBe(true);
    }
  });

  it('ignores paused and deleted templates', () => {
    const base = template({
      amountCents: 30_000_00,
      frequency: 'monthly',
      payer: 'aditi',
      participants: THREE,
    });
    expect(recurringNetPerMonth([{ ...base, active: false }]).items).toEqual([]);
    expect(recurringNetPerMonth([{ ...base, deletedAt: new Date() }]).items).toEqual([]);
    expect(recurringNetPerMonth([]).standingPayments).toEqual([]);
  });

  it('leaves nobody owing when everyone pays their own share', () => {
    const out = recurringNetPerMonth([
      template({ amountCents: 900_00, frequency: 'monthly', payer: 'aditi', participants: ['aditi'] }),
    ]);
    expect(out.perMonthNet).toEqual([]);
    expect(out.standingPayments).toEqual([]);
  });

  it('agrees with toMonthlyCents for every frequency', () => {
    for (const frequency of ['daily', 'weekly', 'fortnightly', 'monthly', 'quarterly', 'yearly']) {
      const out = recurringNetPerMonth([
        template({ amountCents: 1_000_00, frequency, payer: 'aditi', participants: THREE }),
      ]);
      expect(out.items[0].monthlyCents).toBe(toMonthlyCents(1_000_00, { frequency, interval: 1 }));
    }
  });
});
