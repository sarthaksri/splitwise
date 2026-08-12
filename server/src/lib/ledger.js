/**
 * Loading the raw material for a balance report, and decorating the result
 * with the user records the client needs to render names and avatars.
 */

import { Expense } from '../models/Expense.js';
import { Settlement } from '../models/Settlement.js';
import { User } from '../models/User.js';
import { buildBalanceReport } from './balances.js';

/** Every live expense and settlement in one scope (a group, or `null`). */
export async function loadScope(groupFilter) {
  const [expenses, settlements] = await Promise.all([
    Expense.find({ ...groupFilter, deletedAt: null }).lean(),
    Settlement.find({ ...groupFilter, deletedAt: null }).lean(),
  ]);
  return { expenses, settlements };
}

/**
 * Turn a balance report's bare user ids into `{ id, name, avatarColor }`, so
 * the client can render a debt line without a second round trip.
 */
export async function hydrateReport(report) {
  const ids = new Set();
  for (const entry of report.net) ids.add(entry.userId);
  for (const list of [report.pairwise, report.simplified]) {
    for (const debt of list) {
      ids.add(debt.from);
      ids.add(debt.to);
    }
  }

  const users = await User.find({ _id: { $in: [...ids] } }).lean();
  const byId = new Map(
    users.map((u) => [
      String(u._id),
      {
        id: String(u._id),
        name: u.name,
        username: u.username,
        email: u.email,
        avatarColor: u.avatarColor,
      },
    ]),
  );
  const look = (id) => byId.get(id) ?? { id, name: 'Unknown', avatarColor: '#999' };

  const decorate = (list) =>
    list.map((d) => ({ ...d, fromUser: look(d.from), toUser: look(d.to) }));

  return {
    ...report,
    net: report.net.map((n) => ({ ...n, user: look(n.userId) })),
    pairwise: decorate(report.pairwise),
    simplified: decorate(report.simplified),
    debts: decorate(report.debts),
  };
}

/** The whole balances payload for one group. */
export async function groupBalanceReport(group) {
  const { expenses, settlements } = await loadScope({ group: group._id });
  const report = buildBalanceReport(expenses, settlements, { simplify: group.simplifyDebts });
  return hydrateReport(report);
}
