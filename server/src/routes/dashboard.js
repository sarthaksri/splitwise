import { Router } from 'express';
import { Group } from '../models/Group.js';
import { User } from '../models/User.js';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { catchUpRecurring } from '../middleware/recurring.js';
import { loadScope } from '../lib/ledger.js';
import { netBalances, pairwiseDebts } from '../lib/balances.js';
import { addTo } from '../../../shared/money.js';

const router = Router();
router.use(requireAuth);

/**
 * The home screen: what you owe, what you're owed, and to whom.
 *
 * The per-person figures come from the pairwise view rather than the simplified
 * one — across group boundaries "you owe Rahul" should mean you genuinely
 * shared expenses with Rahul, not that an optimiser routed you through him.
 */
router.get(
  '/summary',
  catchUpRecurring,
  asyncHandler(async (req, res) => {
    const me = String(req.user._id);
    const groups = await Group.find({ 'members.user': req.user._id }).select(
      'name type currency simplifyDebts members',
    );

    /** counterparty id -> net cents (positive: they owe me) */
    const perFriend = new Map();
    const perGroup = [];
    let netTotal = 0;

    const scopes = [
      ...groups.map((g) => ({ group: g, filter: { group: g._id } })),
      { group: null, filter: { group: null } },
    ];

    for (const scope of scopes) {
      const { expenses, settlements } = await loadScope(scope.filter);

      // The no-group scope holds everyone's one-to-one expenses, so narrow it
      // to the ones I'm actually part of before computing anything.
      const mine = scope.group
        ? expenses
        : expenses.filter(
            (e) =>
              e.paidBy.some((p) => String(p.user) === me) ||
              e.shares.some((s) => String(s.user) === me),
          );
      const mineSettlements = scope.group
        ? settlements
        : settlements.filter((s) => [String(s.from), String(s.to)].includes(me));

      const net = netBalances(mine, mineSettlements);
      const myNet = net.get(me) ?? 0;
      netTotal += myNet;

      if (scope.group) {
        perGroup.push({
          id: String(scope.group._id),
          name: scope.group.name,
          type: scope.group.type,
          currency: scope.group.currency,
          memberCount: scope.group.members.length,
          myBalanceCents: myNet,
        });
      }

      for (const debt of pairwiseDebts(mine, mineSettlements)) {
        if (debt.from === me) addTo(perFriend, debt.to, -debt.amountCents);
        else if (debt.to === me) addTo(perFriend, debt.from, debt.amountCents);
      }
    }

    for (const [id, amount] of perFriend) if (amount === 0) perFriend.delete(id);

    const users = await User.find({ _id: { $in: [...perFriend.keys()] } }).lean();
    const byId = new Map(users.map((u) => [String(u._id), u]));

    const friends = [...perFriend]
      .map(([id, amountCents]) => {
        const u = byId.get(id);
        return {
          user: {
            id,
            name: u?.name ?? 'Unknown',
            username: u?.username,
            email: u?.email,
            avatarColor: u?.avatarColor ?? '#999',
          },
          amountCents,
        };
      })
      .sort((a, b) => b.amountCents - a.amountCents);

    const owedToMeCents = friends
      .filter((f) => f.amountCents > 0)
      .reduce((sum, f) => sum + f.amountCents, 0);
    const iOweCents = friends
      .filter((f) => f.amountCents < 0)
      .reduce((sum, f) => sum - f.amountCents, 0);

    res.json({
      netTotalCents: netTotal,
      owedToMeCents,
      iOweCents,
      friends,
      groups: perGroup.sort((a, b) => Math.abs(b.myBalanceCents) - Math.abs(a.myBalanceCents)),
    });
  }),
);

export default router;
