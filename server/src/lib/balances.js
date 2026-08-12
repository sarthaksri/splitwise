/**
 * Balance computation: turning a pile of expenses and settlements into
 * "who owes whom, and how little can we move to make it all go away".
 *
 * Three views, all derived from the same expense list:
 *   netBalances   — one number per person (+ owed to them, − they owe)
 *   pairwiseDebts — the literal who-owes-whom edges
 *   simplifyDebts — the minimum-ish set of payments that clears everything
 */

import { addTo, sumValues } from '../../../shared/money.js';

const id = (v) => String(v?._id ?? v);

/**
 * Net position per person, over a set of expenses and settlements.
 *
 *   net[u] = (what u paid out) − (what u owed) + (settlements u paid) − (settlements u received)
 *
 * Positive means the group owes them; negative means they owe the group.
 * The sum across everyone is always exactly zero — money is conserved.
 *
 * @returns {Map<string, number>} userId -> integer minor units
 */
export function netBalances(expenses = [], settlements = []) {
  const net = new Map();

  for (const expense of expenses) {
    if (expense.deletedAt) continue;
    for (const payer of expense.paidBy ?? []) {
      addTo(net, id(payer.user), payer.amountCents);
    }
    for (const share of expense.shares ?? []) {
      addTo(net, id(share.user), -share.amountCents);
    }
  }

  for (const s of settlements) {
    if (s.deletedAt) continue;
    // Paying someone reduces what you owe: your net moves up, theirs down.
    addTo(net, id(s.from), s.amountCents);
    addTo(net, id(s.to), -s.amountCents);
  }

  // Drop settled-up people so callers don't render a wall of zeroes.
  for (const [userId, amount] of net) {
    if (amount === 0) net.delete(userId);
  }
  return net;
}

/**
 * The un-simplified ledger: debts traced expense by expense, so you can see
 * "you owe Rahul ₹300 for dinner" rather than a group-wide rearrangement.
 *
 * Each expense is resolved on its own and the results accumulated, then
 * opposite edges between the same two people are netted off. Contrast with
 * simplifyDebts(), which is free to rearrange debts *across* expenses and can
 * leave you paying someone you never actually shared an expense with.
 *
 * @returns {{from: string, to: string, amountCents: number}[]} positive edges only
 */
export function pairwiseDebts(expenses = [], settlements = []) {
  /** @type {Map<string, Map<string, number>>} debtor -> creditor -> cents */
  const ledger = new Map();

  const owe = (debtor, creditor, cents) => {
    if (cents === 0 || debtor === creditor) return;
    if (!ledger.has(debtor)) ledger.set(debtor, new Map());
    addTo(ledger.get(debtor), creditor, cents);
  };

  for (const expense of expenses) {
    if (expense.deletedAt) continue;

    // Net the expense within itself first: what each person put in, minus what
    // they consumed. Somebody who paid 2500 on a 3333 share owes only the 833
    // difference, which is what you'd expect to see.
    const delta = new Map();
    for (const payer of expense.paidBy ?? []) addTo(delta, id(payer.user), payer.amountCents);
    for (const share of expense.shares ?? []) addTo(delta, id(share.user), -share.amountCents);
    for (const [userId, value] of delta) if (value === 0) delta.delete(userId);

    // Turn this one expense's deltas into edges. With a single payer — the
    // overwhelmingly common case — this is exactly "everyone who owes, owes
    // the payer". Doing it via the matching keeps the arithmetic exact: naively
    // pro-rating each ower across several payers rounds every row independently
    // and leaves the columns off by a paise.
    for (const t of simplifyDebts(delta)) owe(t.from, t.to, t.amountCents);
  }

  // A settlement is a payment in the opposite direction to the debt.
  for (const s of settlements) {
    if (s.deletedAt) continue;
    owe(id(s.to), id(s.from), s.amountCents);
  }

  // Net off the two directions of each pair so we never show both
  // "A owes B ₹500" and "B owes A ₹300".
  const seen = new Set();
  const edges = [];
  for (const [debtor, creditors] of ledger) {
    for (const [creditor, cents] of creditors) {
      const key = [debtor, creditor].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      const reverse = ledger.get(creditor)?.get(debtor) ?? 0;
      const value = cents - reverse;
      if (value > 0) edges.push({ from: debtor, to: creditor, amountCents: value });
      else if (value < 0) edges.push({ from: creditor, to: debtor, amountCents: -value });
    }
  }

  return edges.sort(
    (a, b) => b.amountCents - a.amountCents || a.from.localeCompare(b.from),
  );
}

/**
 * Debt simplification — Splitwise's headline trick.
 *
 * Greedy min-cash-flow: repeatedly match the person who owes the most with the
 * person who is owed the most, move the smaller of the two amounts, and drop
 * whoever hits zero. Each transfer zeroes out at least one person, so this
 * always emits at most n−1 payments for n people with a non-zero balance.
 *
 * (Finding the provably fewest transfers is subset-sum hard. Greedy is what
 * Splitwise itself does: optimal for essentially every real group, and always
 * far better than the raw pairwise tangle.)
 *
 * @param {Map<string, number>|Array<[string, number]>} balances userId -> net cents
 * @returns {{from: string, to: string, amountCents: number}[]}
 */
export function simplifyDebts(balances) {
  const entries = [...(balances instanceof Map ? balances : new Map(balances))];

  const total = entries.reduce((sum, [, v]) => sum + v, 0);
  if (total !== 0) {
    throw new Error(`simplifyDebts: balances must sum to zero, got ${total}`);
  }

  // Sorted descending by magnitude; ties broken on userId so the output is
  // stable between calls and between server and client.
  const byMagnitude = (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]);
  const creditors = entries.filter(([, v]) => v > 0).sort(byMagnitude);
  const debtors = entries
    .filter(([, v]) => v < 0)
    .map(([k, v]) => [k, -v])
    .sort(byMagnitude);

  const transfers = [];
  let ci = 0;
  let di = 0;

  while (ci < creditors.length && di < debtors.length) {
    const [creditorId, credit] = creditors[ci];
    const [debtorId, debt] = debtors[di];
    const amount = Math.min(credit, debt);

    if (amount > 0) {
      transfers.push({ from: debtorId, to: creditorId, amountCents: amount });
    }

    creditors[ci][1] -= amount;
    debtors[di][1] -= amount;
    if (creditors[ci][1] === 0) ci += 1;
    if (debtors[di][1] === 0) di += 1;
  }

  return transfers;
}

/**
 * Everything the balances tab needs for one scope (a group, or the
 * no-group scope), in the shape the client renders directly.
 */
export function buildBalanceReport(expenses, settlements, { simplify = true } = {}) {
  const net = netBalances(expenses, settlements);
  const pairwise = pairwiseDebts(expenses, settlements);
  const simplified = simplifyDebts(net);

  return {
    net: [...net]
      .map(([userId, amountCents]) => ({ userId, amountCents }))
      .sort((a, b) => b.amountCents - a.amountCents),
    pairwise,
    simplified,
    // What the UI should actually show, honouring the group's setting.
    debts: simplify ? simplified : pairwise,
    simplifyEnabled: simplify,
    totalOwedCents: sumValues([...net.values()].filter((v) => v > 0)),
  };
}

/**
 * One person's slice of a balance report: who they owe and who owes them.
 */
export function balancesForUser(report, userId) {
  const me = String(userId);
  const owes = report.debts.filter((d) => d.from === me);
  const owed = report.debts.filter((d) => d.to === me);
  const netEntry = report.net.find((n) => n.userId === me);
  return {
    netCents: netEntry?.amountCents ?? 0,
    owes,
    owed,
  };
}
