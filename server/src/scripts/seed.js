/**
 * Fill the database with a small demo group so there's something to look at.
 *
 *   npm run seed --workspace server
 *
 * Every demo account uses the password `password123`.
 * Running it twice wipes and recreates the same demo data.
 */

import mongoose from 'mongoose';
import { connectDB, disconnectDB } from '../config/db.js';
import { User } from '../models/User.js';
import { Group } from '../models/Group.js';
import { Expense } from '../models/Expense.js';
import { Settlement } from '../models/Settlement.js';
import { RecurringExpense } from '../models/RecurringExpense.js';
import { computeShares, SPLIT_TYPES } from '../../../shared/splitEngine.js';
import { generateForTemplate } from '../lib/recurring.js';

const PEOPLE = [
  { name: 'Aditi Sharma', username: 'aditi', email: 'aditi@example.com' },
  { name: 'Rahul Verma', username: 'rahul', email: 'rahul@example.com' },
  { name: 'Sara Khan', username: 'sara', email: 'sara@example.com' },
];

/** Build a persistable expense by running the real split engine. */
function makeExpense({ group, description, category, date, paidBy, createdBy, ...split }) {
  const { amountCents, shares } = computeShares(split);
  return {
    group,
    description,
    category,
    date,
    amountCents,
    paidBy: paidBy.map(([user, cents]) => ({
      user,
      amountCents: cents === 'all' ? amountCents : cents,
    })),
    splitType: split.splitType,
    splitConfig: { participants: split.participants },
    items: split.items ?? [],
    taxCents: split.taxCents ?? 0,
    tipCents: split.tipCents ?? 0,
    otherCents: split.otherCents ?? 0,
    discountCents: split.discountCents ?? 0,
    shares: shares.map((s) => ({ user: s.userId, amountCents: s.amountCents })),
    createdBy,
  };
}

async function seed() {
  await connectDB();
  console.log('Connected. Clearing demo data…');

  const emails = PEOPLE.map((p) => p.email);
  const existing = await User.find({ email: { $in: emails } }).select('_id');
  const oldIds = existing.map((u) => u._id);
  if (oldIds.length) {
    const groups = await Group.find({ 'members.user': { $in: oldIds } }).select('_id');
    const groupIds = groups.map((g) => g._id);
    await Expense.deleteMany({ group: { $in: groupIds } });
    await Settlement.deleteMany({ group: { $in: groupIds } });
    await RecurringExpense.deleteMany({ group: { $in: groupIds } });
    await Group.deleteMany({ _id: { $in: groupIds } });
    await User.deleteMany({ _id: { $in: oldIds } });
  }

  const passwordHash = await User.hashPassword('password123');
  const users = await User.create(PEOPLE.map((p) => ({ ...p, passwordHash })));
  const [aditi, rahul, sara] = users;
  const ids = users.map((u) => String(u._id));

  // Everyone is friends with everyone.
  for (const user of users) {
    user.friends = users.filter((u) => !u._id.equals(user._id)).map((u) => u._id);
    await user.save();
  }

  const group = await Group.create({
    name: 'Goa Trip',
    type: 'trip',
    createdBy: aditi._id,
    simplifyDebts: true,
    members: users.map((u, i) => ({ user: u._id, role: i === 0 ? 'admin' : 'member' })),
  });

  const daysAgo = (n) => new Date(Date.now() - n * 86_400_000);

  const expenses = [
    // The headline one: a restaurant bill split dish by dish. Aditi skipped
    // dessert, so she pays less — and a smaller slice of the GST and tip.
    makeExpense({
      group: group._id,
      description: 'Dinner at Fisherman’s Wharf',
      category: 'food',
      date: daysAgo(2),
      createdBy: aditi._id,
      splitType: SPLIT_TYPES.ITEMIZED,
      items: [
        { name: 'Prawn Balchão', priceCents: 48000, qty: 1, sharedBy: ids },
        { name: 'Goan Fish Curry', priceCents: 39000, qty: 1, sharedBy: ids },
        { name: 'Beer', priceCents: 22000, qty: 3, sharedBy: [ids[1], ids[2]] },
        { name: 'Bebinca', priceCents: 26000, qty: 1, sharedBy: [ids[1], ids[2]] },
      ],
      taxCents: 8730,
      tipCents: 10000,
      paidBy: [[rahul._id, 'all']],
    }),
    makeExpense({
      group: group._id,
      description: 'Beach shack lunch',
      category: 'food',
      date: daysAgo(3),
      createdBy: sara._id,
      splitType: SPLIT_TYPES.ITEMIZED,
      items: [
        { name: 'Chicken Xacuti', priceCents: 34000, qty: 1, sharedBy: [ids[0], ids[2]] },
        { name: 'Veg Thali', priceCents: 25000, qty: 1, sharedBy: [ids[1]] },
        { name: 'Fresh lime soda', priceCents: 12000, qty: 3, sharedBy: ids },
      ],
      taxCents: 4750,
      discountCents: 5000,
      paidBy: [[sara._id, 'all']],
    }),
    makeExpense({
      group: group._id,
      description: 'Beach villa — 2 nights',
      category: 'travel',
      date: daysAgo(4),
      createdBy: aditi._id,
      splitType: SPLIT_TYPES.EQUAL,
      amountCents: 1_440_00,
      participants: ids,
      paidBy: [[aditi._id, 'all']],
    }),
    makeExpense({
      group: group._id,
      description: 'Scooter rental',
      category: 'transport',
      date: daysAgo(3),
      createdBy: rahul._id,
      splitType: SPLIT_TYPES.EQUAL,
      amountCents: 90_00,
      participants: ids,
      paidBy: [[rahul._id, 'all']],
    }),
    // Sara covered the cab, but Rahul chipped in cash — two payers.
    makeExpense({
      group: group._id,
      description: 'Airport cab',
      category: 'transport',
      date: daysAgo(5),
      createdBy: sara._id,
      splitType: SPLIT_TYPES.EQUAL,
      amountCents: 210_00,
      participants: ids,
      paidBy: [[sara._id, 150_00], [rahul._id, 60_00]],
    }),
  ];

  await Expense.insertMany(expenses);

  // --- a flatshare, to show recurring bills ------------------------------
  const flat = await Group.create({
    name: 'Flat 402',
    type: 'home',
    createdBy: aditi._id,
    simplifyDebts: true,
    members: users.map((u, i) => ({ user: u._id, role: i === 0 ? 'admin' : 'member' })),
  });

  // Started four months ago, so generation has real cycles to backfill and the
  // ledger looks like an app that's been in use for a while.
  const monthsAgo = (n) => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 1));
  };

  const recurring = [
    {
      description: 'Rent',
      amountCents: 3_000_000,
      category: 'rent',
      frequency: 'monthly',
      startDate: monthsAgo(3),
      paidBy: [{ user: aditi._id, amountCents: 3_000_000 }],
      splitType: SPLIT_TYPES.EQUAL,
      splitConfig: { participants: ids },
    },
    {
      description: 'Internet',
      amountCents: 119_900,
      category: 'utilities',
      frequency: 'monthly',
      startDate: monthsAgo(3),
      paidBy: [{ user: rahul._id, amountCents: 119_900 }],
      splitType: SPLIT_TYPES.EQUAL,
      splitConfig: { participants: ids },
    },
    {
      // Weekly, to exercise the 52/12 monthly conversion in the netting view.
      description: 'Cleaner',
      amountCents: 60_000,
      category: 'general',
      frequency: 'weekly',
      startDate: monthsAgo(1),
      paidBy: [{ user: sara._id, amountCents: 60_000 }],
      splitType: SPLIT_TYPES.EQUAL,
      splitConfig: { participants: ids },
    },
  ];

  let generated = 0;
  for (const spec of recurring) {
    const { shares } = computeShares({
      splitType: spec.splitType,
      amountCents: spec.amountCents,
      participants: spec.splitConfig.participants,
    });
    const template = await RecurringExpense.create({
      ...spec,
      group: flat._id,
      interval: 1,
      createdBy: aditi._id,
      shares: shares.map((s) => ({ user: s.userId, amountCents: s.amountCents })),
    });
    generated += await generateForTemplate(template);
  }

  console.log(`\n✓ Seeded "${group.name}" with ${expenses.length} expenses`);
  console.log(
    `✓ Seeded "${flat.name}" with ${recurring.length} recurring bills (${generated} expenses generated)\n`,
  );
  console.log('  Sign in with any of these (password: password123):');
  for (const p of PEOPLE) console.log(`    ${p.email}  @${p.username}`);
  console.log('');

  await disconnectDB();
}

seed().catch(async (err) => {
  console.error('\n✗ Seed failed:', err.message, '\n');
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
