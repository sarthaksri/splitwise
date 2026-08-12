import { Group } from '../models/Group.js';
import { generateDueExpenses } from '../lib/recurring.js';
import { asyncHandler } from './error.js';

/**
 * Bring recurring expenses up to date before anything reads a ledger.
 *
 * Doing it on read rather than on a schedule means the app needs no cron daemon
 * and no always-on worker: whenever someone looks at their balances, any rent
 * that fell due since the last look is already there. Generation is idempotent,
 * so it doesn't matter how many people trigger it at once.
 *
 * Failures are logged and swallowed — a hiccup generating next month's rent
 * must never take down the balances page.
 */
export const catchUpRecurring = asyncHandler(async (req, _res, next) => {
  try {
    const groups = await Group.find({ 'members.user': req.user._id }).select('_id');
    await generateDueExpenses(groups.map((g) => g._id));
  } catch (err) {
    console.error('[recurring] catch-up failed:', err.message);
  }
  return next();
});
