import { describe, it, expect } from 'vitest';
import {
  netBalances,
  pairwiseDebts,
  simplifyDebts,
  buildBalanceReport,
} from './balances.js';
import { computeShares, SPLIT_TYPES } from '../../../shared/splitEngine.js';
import { sumValues } from '../../../shared/money.js';

/** Build an expense the way the API would, so tests exercise the real engine. */
function expense({ paidBy, splitType = SPLIT_TYPES.EQUAL, ...rest }) {
  const { amountCents, shares } = computeShares({ splitType, ...rest });
  return {
    amountCents,
    paidBy: paidBy.map(([user, cents]) => ({ user, amountCents: cents })),
    shares: shares.map((s) => ({ user: s.userId, amountCents: s.amountCents })),
  };
}

const settlement = (from, to, amountCents) => ({ from, to, amountCents });

/**
 * Apply a set of transfers to a set of net balances and return what is left.
 * A correct set of transfers settles the group, so the residual is empty —
 * that is the property every debt view has to satisfy.
 */
function residual(net, transfers) {
  const out = new Map(net);
  for (const t of transfers) {
    out.set(t.from, (out.get(t.from) ?? 0) + t.amountCents);
    out.set(t.to, (out.get(t.to) ?? 0) - t.amountCents);
  }
  for (const [k, v] of out) if (v === 0) out.delete(k);
  return out;
}

/** Assert that these transfers leave everybody square. */
function expectSettles(net, transfers) {
  expect([...residual(net, transfers)]).toEqual([]);
}

describe('netBalances', () => {
  it('credits the payer and debits everyone who owes', () => {
    const e = expense({
      amountCents: 30000,
      participants: ['a', 'b', 'c'],
      paidBy: [['a', 30000]],
    });
    const net = netBalances([e]);
    expect(net.get('a')).toBe(20000); // paid 30000, owes 10000
    expect(net.get('b')).toBe(-10000);
    expect(net.get('c')).toBe(-10000);
    expect(sumValues(net)).toBe(0);
  });

  it('always sums to zero, including with multiple payers', () => {
    const net = netBalances([
      expense({
        amountCents: 10000,
        participants: ['a', 'b', 'c'],
        paidBy: [['a', 6000], ['b', 4000]],
      }),
      expense({ amountCents: 5000, participants: ['b', 'c'], paidBy: [['c', 5000]] }),
    ]);
    expect(sumValues(net)).toBe(0);
  });

  it('applies settlements and omits people who are square', () => {
    const e = expense({ amountCents: 10000, participants: ['a', 'b'], paidBy: [['a', 10000]] });
    expect(netBalances([e]).get('b')).toBe(-5000);

    const after = netBalances([e], [settlement('b', 'a', 5000)]);
    expect(after.size).toBe(0); // everyone settled up, nobody listed
  });

  it('ignores soft-deleted expenses and settlements', () => {
    const e = expense({ amountCents: 10000, participants: ['a', 'b'], paidBy: [['a', 10000]] });
    expect(netBalances([{ ...e, deletedAt: new Date() }]).size).toBe(0);
    const live = netBalances([e], [{ ...settlement('b', 'a', 5000), deletedAt: new Date() }]);
    expect(live.get('b')).toBe(-5000);
  });

  it('handles a dish-wise expense end to end', () => {
    const e = expense({
      splitType: SPLIT_TYPES.ITEMIZED,
      items: [
        { name: 'Pizza', priceCents: 60000, qty: 1, sharedBy: ['a', 'b'] },
        { name: 'Beer', priceCents: 20000, qty: 1, sharedBy: ['b'] },
      ],
      taxCents: 8000,
      paidBy: [['a', 88000]],
    });
    const net = netBalances([e]);
    // a ate 30000 of 80000 food -> 3000 of the tax -> owes 33000, paid 88000
    expect(net.get('a')).toBe(55000);
    expect(net.get('b')).toBe(-55000);
  });
});

describe('pairwiseDebts', () => {
  it('points every ower at the person who paid', () => {
    const e = expense({
      amountCents: 30000,
      participants: ['a', 'b', 'c'],
      paidBy: [['a', 30000]],
    });
    const edges = pairwiseDebts([e]);
    expect(edges).toHaveLength(2);
    expect(edges).toContainEqual({ from: 'b', to: 'a', amountCents: 10000 });
    expect(edges).toContainEqual({ from: 'c', to: 'a', amountCents: 10000 });
  });

  it('nets a part-payer down to the difference they still owe', () => {
    // a and b both chip in; b's 2500 does not quite cover b's 3333 share.
    const e = expense({
      amountCents: 10000,
      participants: ['a', 'b', 'c'],
      paidBy: [['a', 7500], ['b', 2500]],
    });
    const edges = pairwiseDebts([e]);
    // b owes only the shortfall, not the full share
    expect(edges).toContainEqual({ from: 'b', to: 'a', amountCents: 833 });
    // c paid nothing, so c owes their whole share
    expect(edges).toContainEqual({ from: 'c', to: 'a', amountCents: 3333 });
    expectSettles(netBalances([e]), edges);
  });

  it('nets the two directions of a pair into one edge', () => {
    const edges = pairwiseDebts([
      expense({ amountCents: 10000, participants: ['a', 'b'], paidBy: [['a', 10000]] }),
      expense({ amountCents: 4000, participants: ['a', 'b'], paidBy: [['b', 4000]] }),
    ]);
    expect(edges).toEqual([{ from: 'b', to: 'a', amountCents: 3000 }]);
  });

  it('lets a settlement cancel a debt', () => {
    const e = expense({ amountCents: 10000, participants: ['a', 'b'], paidBy: [['a', 10000]] });
    expect(pairwiseDebts([e], [settlement('b', 'a', 5000)])).toEqual([]);
  });

  it('always reconciles with netBalances', () => {
    const expenses = [
      expense({ amountCents: 30000, participants: ['a', 'b', 'c'], paidBy: [['a', 30000]] }),
      expense({ amountCents: 12000, participants: ['b', 'c'], paidBy: [['b', 12000]] }),
      expense({
        amountCents: 9000,
        participants: ['a', 'b', 'c'],
        paidBy: [['c', 5000], ['a', 4000]],
      }),
    ];
    const settlements = [settlement('c', 'a', 2500)];
    expectSettles(
      netBalances(expenses, settlements),
      pairwiseDebts(expenses, settlements),
    );
  });
});

describe('simplifyDebts', () => {
  it('collapses a chain into a single payment', () => {
    // a owes b 500, b owes c 500  =>  a pays c 500
    const transfers = simplifyDebts(new Map([['a', -500], ['b', 0], ['c', 500]]));
    expect(transfers).toEqual([{ from: 'a', to: 'c', amountCents: 500 }]);
  });

  it('clears every balance exactly', () => {
    const net = new Map([['a', -3000], ['b', -1500], ['c', 2000], ['d', 2500]]);
    expectSettles(net, simplifyDebts(net));
  });

  it('never needs more than n-1 transfers', () => {
    const net = new Map([
      ['a', -1000], ['b', -2000], ['c', -3000], ['d', 1500], ['e', 4500],
    ]);
    const transfers = simplifyDebts(net);
    expect(transfers.length).toBeLessThanOrEqual(net.size - 1);
    expectSettles(net, transfers);
  });

  it('beats the raw pairwise count on a tangled group', () => {
    // Everyone pays for one thing, split across all four: 4 expenses, 12 edges.
    const people = ['a', 'b', 'c', 'd'];
    const expenses = people.map((p, i) =>
      expense({ amountCents: 10000 + i * 1000, participants: people, paidBy: [[p, 10000 + i * 1000]] }),
    );
    const report = buildBalanceReport(expenses, []);
    expect(report.pairwise.length).toBeGreaterThan(3);
    expect(report.simplified.length).toBeLessThan(report.pairwise.length);
    // Fewer payments, same outcome: both views settle the group completely.
    const net = netBalances(expenses, []);
    expectSettles(net, report.simplified);
    expectSettles(net, report.pairwise);
  });

  it('returns nothing when everyone is square', () => {
    expect(simplifyDebts(new Map())).toEqual([]);
    expect(simplifyDebts(new Map([['a', 0], ['b', 0]]))).toEqual([]);
  });

  it('refuses balances that do not sum to zero (a corrupted ledger)', () => {
    expect(() => simplifyDebts(new Map([['a', 100]]))).toThrow(/sum to zero/);
  });

  it('conserves money and stays exact across randomised ledgers', () => {
    let seed = 99;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const people = ['a', 'b', 'c', 'd', 'e', 'f'];

    for (let trial = 0; trial < 200; trial += 1) {
      const expenses = Array.from({ length: 1 + Math.floor(rand() * 6) }, () => {
        const participants = people.filter(() => rand() > 0.4);
        if (participants.length === 0) participants.push('a');
        const amountCents = 100 + Math.floor(rand() * 500_000);
        const payer = participants[Math.floor(rand() * participants.length)];
        return expense({ amountCents, participants, paidBy: [[payer, amountCents]] });
      });

      const net = netBalances(expenses);
      expect(sumValues(net)).toBe(0);

      const transfers = simplifyDebts(net);
      expectSettles(net, transfers);
      expect(transfers.length).toBeLessThanOrEqual(Math.max(0, net.size - 1));
      expect(transfers.every((t) => t.amountCents > 0)).toBe(true);

      // and the un-simplified view must describe the same reality
      expectSettles(net, pairwiseDebts(expenses));
    }
  });
});

describe('buildBalanceReport', () => {
  it('honours the simplify flag when choosing what to display', () => {
    const expenses = [
      expense({ amountCents: 30000, participants: ['a', 'b', 'c'], paidBy: [['a', 30000]] }),
      expense({ amountCents: 30000, participants: ['a', 'b', 'c'], paidBy: [['b', 30000]] }),
    ];
    expect(buildBalanceReport(expenses, [], { simplify: true }).debts).toEqual(
      buildBalanceReport(expenses, [], { simplify: true }).simplified,
    );
    expect(buildBalanceReport(expenses, [], { simplify: false }).debts).toEqual(
      buildBalanceReport(expenses, [], { simplify: false }).pairwise,
    );
  });

  it('reports the total amount in flight', () => {
    const report = buildBalanceReport(
      [expense({ amountCents: 30000, participants: ['a', 'b', 'c'], paidBy: [['a', 30000]] })],
      [],
    );
    expect(report.totalOwedCents).toBe(20000);
    expect(report.net[0]).toEqual({ userId: 'a', amountCents: 20000 });
  });
});
