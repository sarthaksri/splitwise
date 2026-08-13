/**
 * Materialising recurring expenses, and summarising them per cycle.
 *
 * Two jobs:
 *   generateDueExpenses() — turn templates into real Expense documents
 *   recurringNetPerMonth() — net all templates down to the fewest standing payments
 */

import { Expense } from '../models/Expense.js';
import { RecurringExpense } from '../models/RecurringExpense.js';
import { computeShares } from '../../../shared/splitEngine.js';
import { allocate, addTo, sumValues } from '../../../shared/money.js';
import { occurrencesUpTo, cycleKey, toMonthlyCents } from '../../../shared/recurrence.js';
import { simplifyDebts } from './balances.js';

const id = (v) => String(v?._id ?? v);

/** Re-run the split engine so a generated expense is exactly as trustworthy as a typed one. */
function sharesFor(template) {
  const cfg = template.splitConfig ?? {};
  const { shares } = computeShares({
    splitType: template.splitType,
    amountCents: template.splitType === 'ITEMIZED' ? undefined : template.amountCents,
    participants: cfg.participants,
    exact: cfg.exact,
    percentBps: cfg.percentBps,
    weights: cfg.weights,
    items: template.items,
    taxCents: template.taxCents,
    tipCents: template.tipCents,
    otherCents: template.otherCents,
    discountCents: template.discountCents,
  });
  return shares.map((s) => ({ user: s.userId, amountCents: s.amountCents }));
}

/**
 * Would this template still bill the given person on its next cycle?
 *
 * Asked before letting someone leave a group: a standing bill that keeps
 * naming them would quietly rebuild the balance we just checked was zero, and
 * they'd have no way to see it.
 */
export function templateInvolves(template, userId) {
  const target = String(userId);
  if ((template.paidBy ?? []).some((p) => id(p.user) === target)) return true;
  try {
    return sharesFor(template).some((s) => id(s.user) === target);
  } catch {
    // A template that no longer computes can't be reasoned about. Say yes, so
    // the caller errs towards keeping the member rather than losing money.
    return true;
  }
}

/**
 * Create any expenses that have fallen due for one template.
 *
 * Missed cycles are backfilled — three months away means three rents, not one,
 * because the debt genuinely accrued. The unique (recurring, cycleKey) index
 * makes this safe to call concurrently: a losing race is a duplicate-key error,
 * which we swallow, rather than a second charge.
 *
 * @returns {Promise<number>} how many expenses were created
 */
export async function generateForTemplate(template, now = new Date()) {
  if (!template.active || template.deletedAt) return 0;

  const due = occurrencesUpTo(
    {
      startDate: template.startDate,
      endDate: template.endDate,
      frequency: template.frequency,
      interval: template.interval,
    },
    now,
    { after: template.lastGeneratedFor },
  );
  if (due.length === 0) return 0;

  const shares = sharesFor(template);
  let created = 0;
  let latest = template.lastGeneratedFor;

  for (const occurrence of due) {
    const key = cycleKey(occurrence);
    try {
      await Expense.create({
        group: template.group,
        description: template.description,
        amountCents: template.amountCents,
        currency: template.currency,
        date: occurrence,
        category: template.category,
        notes: template.notes,
        paidBy: template.paidBy.map((p) => ({ user: p.user, amountCents: p.amountCents })),
        splitType: template.splitType,
        splitConfig: template.splitConfig,
        items: template.items,
        taxCents: template.taxCents,
        tipCents: template.tipCents,
        otherCents: template.otherCents,
        discountCents: template.discountCents,
        shares,
        createdBy: template.createdBy,
        recurring: template._id,
        cycleKey: key,
      });
      created += 1;
    } catch (err) {
      // 11000 = someone else generated this same cycle first. That's success.
      if (err.code !== 11000) throw err;
    }
    if (!latest || occurrence > latest) latest = occurrence;
  }

  // Move the watermark even for cycles a concurrent request created, so we
  // don't re-walk them next time.
  if (latest && (!template.lastGeneratedFor || latest > template.lastGeneratedFor)) {
    await RecurringExpense.updateOne(
      { _id: template._id },
      { $set: { lastGeneratedFor: latest } },
    );
  }

  return created;
}

/**
 * Bring every recurring template the user can see up to date.
 *
 * Called before reading balances or expense lists, which keeps the app correct
 * without a cron daemon: the ledger is caught up the moment anyone looks at it.
 */
export async function generateDueExpenses(groupIds, now = new Date()) {
  if (!groupIds?.length) return 0;

  const templates = await RecurringExpense.find({
    group: { $in: groupIds },
    active: true,
    deletedAt: null,
  });

  let created = 0;
  for (const template of templates) {
    created += await generateForTemplate(template, now);
  }
  return created;
}

/**
 * Net every recurring commitment down to the fewest standing payments.
 *
 * Each template is converted to its true per-month cost first — a weekly ₹100
 * is ₹433.33 a month, not ₹400 — and both the payer and the ower side are
 * re-allocated across that monthly figure with largest-remainder, so every
 * template still balances to the paise. That keeps the net across everyone at
 * exactly zero, which is what simplifyDebts() requires.
 *
 * @returns {{ perMonthNet: {userId, amountCents}[], standingPayments: [], items: [] }}
 */
export function recurringNetPerMonth(templates = []) {
  const net = new Map();
  const items = [];

  for (const template of templates) {
    if (!template.active || template.deletedAt) continue;

    const rule = { frequency: template.frequency, interval: template.interval ?? 1 };
    const monthlyTotal = toMonthlyCents(template.amountCents, rule);
    if (monthlyTotal === 0) continue;

    // Re-spread the monthly figure using the real split as weights, so the two
    // sides of the template still sum to the same number after scaling.
    const payerIds = template.paidBy.map((p) => id(p.user));
    const payerWeights = template.paidBy.map((p) => p.amountCents);
    const monthlyPaid = allocate(monthlyTotal, payerIds, payerWeights);

    const shares = sharesFor(template);
    const monthlyOwed = allocate(
      monthlyTotal,
      shares.map((s) => id(s.user)),
      shares.map((s) => s.amountCents),
    );

    for (const [userId, cents] of monthlyPaid) addTo(net, userId, cents);
    for (const [userId, cents] of monthlyOwed) addTo(net, userId, -cents);

    items.push({
      id: id(template),
      description: template.description,
      amountCents: template.amountCents,
      monthlyCents: monthlyTotal,
      frequency: template.frequency,
      interval: template.interval ?? 1,
      group: id(template.group),
    });
  }

  for (const [userId, amount] of net) if (amount === 0) net.delete(userId);

  // Invariant: money is conserved by the scaling, so this must be exactly zero.
  const drift = sumValues(net);
  if (drift !== 0) {
    throw new Error(`recurringNetPerMonth: monthly balances drifted by ${drift}`);
  }

  return {
    perMonthNet: [...net]
      .map(([userId, amountCents]) => ({ userId, amountCents }))
      .sort((a, b) => b.amountCents - a.amountCents),
    standingPayments: simplifyDebts(net),
    items,
  };
}
