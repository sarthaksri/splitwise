import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { Group, GROUP_TYPES } from '../models/Group.js';
import { User } from '../models/User.js';
import { Expense } from '../models/Expense.js';
import { Settlement } from '../models/Settlement.js';
import { RecurringExpense } from '../models/RecurringExpense.js';
import { ApiError, asyncHandler } from '../middleware/error.js';
import { validate } from '../middleware/validate.js';
import { requireAuth, requireGroupMember } from '../middleware/auth.js';
import { catchUpRecurring } from '../middleware/recurring.js';
import { groupBalanceReport } from '../lib/ledger.js';
import { netBalances } from '../lib/balances.js';
import { loadScope } from '../lib/ledger.js';

const router = Router();
router.use(requireAuth);

const objectId = z.string().refine(mongoose.isValidObjectId, 'Not a valid id');

const createSchema = z.object({
  name: z.string().trim().min(1, 'Give the group a name').max(80),
  type: z.enum(GROUP_TYPES).default('other'),
  currency: z.string().length(3).toUpperCase().default('INR'),
  simplifyDebts: z.boolean().default(true),
  memberIds: z.array(objectId).default([]),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  type: z.enum(GROUP_TYPES).optional(),
  simplifyDebts: z.boolean().optional(),
});

const MEMBER_POPULATE = {
  path: 'members.user',
  select: 'name username email avatarColor isPlaceholder',
};

router.post(
  '/',
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const memberIds = new Set(req.body.memberIds.map(String));
    memberIds.delete(String(req.user._id));

    if (memberIds.size > 0) {
      const found = await User.countDocuments({ _id: { $in: [...memberIds] } });
      if (found !== memberIds.size) throw new ApiError(400, 'One of those people does not exist');
    }

    const group = await Group.create({
      name: req.body.name,
      type: req.body.type,
      currency: req.body.currency,
      simplifyDebts: req.body.simplifyDebts,
      createdBy: req.user._id,
      members: [
        { user: req.user._id, role: 'admin' },
        ...[...memberIds].map((id) => ({ user: id, role: 'member' })),
      ],
    });

    await group.populate(MEMBER_POPULATE);
    res.status(201).json({ group });
  }),
);

/** All my groups, each with my own balance in it — enough to render the list. */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const groups = await Group.find({ 'members.user': req.user._id })
      .sort({ updatedAt: -1 })
      .populate(MEMBER_POPULATE);

    const me = String(req.user._id);
    const withBalances = await Promise.all(
      groups.map(async (group) => {
        const { expenses, settlements } = await loadScope({ group: group._id });
        const net = netBalances(expenses, settlements);
        return {
          ...group.toObject(),
          myBalanceCents: net.get(me) ?? 0,
          expenseCount: expenses.length,
        };
      }),
    );

    res.json({ groups: withBalances });
  }),
);

router.get(
  '/:id',
  requireGroupMember,
  asyncHandler(async (req, res) => {
    await req.group.populate(MEMBER_POPULATE);
    res.json({ group: req.group });
  }),
);

router.patch(
  '/:id',
  requireGroupMember,
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    Object.assign(req.group, req.body);
    await req.group.save();
    await req.group.populate(MEMBER_POPULATE);
    res.json({ group: req.group });
  }),
);

/** The balances tab: net positions plus both the raw and simplified debts. */
router.get(
  '/:id/balances',
  requireGroupMember,
  catchUpRecurring,
  asyncHandler(async (req, res) => {
    res.json(await groupBalanceReport(req.group));
  }),
);

router.post(
  '/:id/members',
  requireGroupMember,
  validate(
    z.object({
      userId: objectId.optional(),
      // A username (@aditi) or an email address.
      handle: z.string().trim().min(1).optional(),
      email: z.string().trim().optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const { userId } = req.body;
    const handle = req.body.handle ?? req.body.email;
    if (!userId && !handle) throw new ApiError(400, 'Provide a username or email address');

    const user = userId ? await User.findById(userId) : await User.findByHandle(handle);
    if (!user) throw new ApiError(404, `Nobody here goes by "${handle}"`);

    if (req.group.hasMember(user._id)) {
      throw new ApiError(409, `${user.name} is already in this group`);
    }

    req.group.members.push({ user: user._id, role: 'member' });
    await req.group.save();
    await req.group.populate(MEMBER_POPULATE);
    res.status(201).json({ group: req.group });
  }),
);

/**
 * Add a stand-in for someone without an account — "Priya", who owes for the
 * rent but has never opened the app. They behave like any other member in
 * expenses and balances; they just can't sign in.
 */
router.post(
  '/:id/placeholders',
  requireGroupMember,
  validate(z.object({ name: z.string().trim().min(1, 'Give them a name').max(80) })),
  asyncHandler(async (req, res) => {
    const { name } = req.body;

    const clash = req.group.members.find(
      (m) => (m.user?.name ?? '').toLowerCase() === name.toLowerCase(),
    );
    if (clash) throw new ApiError(409, `${name} is already in this group`);

    const placeholder = await User.createPlaceholder({
      name,
      group: req.group._id,
      addedBy: req.user._id,
    });

    req.group.members.push({ user: placeholder._id, role: 'member' });
    await req.group.save();
    await req.group.populate(MEMBER_POPULATE);

    res.status(201).json({ group: req.group, placeholder: placeholder.toPublic() });
  }),
);

/**
 * Hand a placeholder's history over to a real account, for when the person
 * finally signs up.
 *
 * Without this their expenses would be stranded on a stand-in forever, so the
 * feature would quietly become a trap. Every reference is repointed — expenses,
 * dish participants, settlements and recurring templates — and the placeholder
 * is then removed, which keeps balances identical across the swap because
 * nothing is added or dropped, only relabelled.
 */
router.post(
  '/:id/placeholders/:placeholderId/link',
  requireGroupMember,
  validate(z.object({ handle: z.string().trim().min(1, 'Enter a username or email') })),
  asyncHandler(async (req, res) => {
    const placeholder = await User.findOne({
      _id: req.params.placeholderId,
      isPlaceholder: true,
    });
    if (!placeholder) throw new ApiError(404, 'That stand-in does not exist');
    if (!req.group.hasMember(placeholder._id)) {
      throw new ApiError(404, 'That stand-in is not in this group');
    }

    const real = await User.findByHandle(req.body.handle);
    if (!real) throw new ApiError(404, `Nobody here goes by "${req.body.handle}"`);
    if (req.group.hasMember(real._id)) {
      throw new ApiError(
        409,
        `${real.name} is already in this group — settle or delete the stand-in's expenses instead`,
      );
    }

    const from = placeholder._id;
    const to = real._id;

    await Promise.all([
      Expense.updateMany({ 'paidBy.user': from }, { $set: { 'paidBy.$[e].user': to } },
        { arrayFilters: [{ 'e.user': from }] }),
      Expense.updateMany({ 'shares.user': from }, { $set: { 'shares.$[e].user': to } },
        { arrayFilters: [{ 'e.user': from }] }),
      Expense.updateMany({ 'items.sharedBy': from }, { $set: { 'items.$[].sharedBy.$[s]': to } },
        { arrayFilters: [{ s: from }] }),
      Expense.updateMany({ createdBy: from }, { $set: { createdBy: to } }),
      Settlement.updateMany({ from }, { $set: { from: to } }),
      Settlement.updateMany({ to: from }, { $set: { to } }),
      RecurringExpense.updateMany({ 'paidBy.user': from }, { $set: { 'paidBy.$[e].user': to } },
        { arrayFilters: [{ 'e.user': from }] }),
      RecurringExpense.updateMany({ 'items.sharedBy': from },
        { $set: { 'items.$[].sharedBy.$[s]': to } }, { arrayFilters: [{ s: from }] }),
    ]);

    // splitConfig holds the raw form input keyed by user id, so re-opening an
    // expense to edit it would otherwise still show the stand-in.
    const affected = await Expense.find({ group: req.group._id }).select('splitConfig');
    for (const expense of affected) {
      const cfg = expense.splitConfig ?? {};
      let touched = false;
      for (const key of ['exact', 'percentBps', 'weights']) {
        if (cfg[key] && Object.prototype.hasOwnProperty.call(cfg[key], String(from))) {
          cfg[key][String(to)] = cfg[key][String(from)];
          delete cfg[key][String(from)];
          touched = true;
        }
      }
      if (Array.isArray(cfg.participants) && cfg.participants.some((p) => String(p) === String(from))) {
        cfg.participants = cfg.participants.map((p) => (String(p) === String(from) ? String(to) : p));
        touched = true;
      }
      if (touched) {
        expense.markModified('splitConfig');
        await expense.save();
      }
    }

    req.group.members = req.group.members.filter(
      (m) => String(m.user?._id ?? m.user) !== String(from),
    );
    req.group.members.push({ user: to, role: 'member' });
    await req.group.save();

    await User.deleteOne({ _id: from, isPlaceholder: true });
    await req.group.populate(MEMBER_POPULATE);

    res.json({ group: req.group, linkedTo: real.toPublic() });
  }),
);

router.delete(
  '/:id/members/:userId',
  requireGroupMember,
  asyncHandler(async (req, res) => {
    const target = String(req.params.userId);
    if (!req.group.hasMember(target)) throw new ApiError(404, 'They are not in this group');

    // Removing someone mid-debt would silently destroy money, so block it —
    // the same thing Splitwise does.
    const { expenses, settlements } = await loadScope({ group: req.group._id });
    const balance = netBalances(expenses, settlements).get(target) ?? 0;
    if (balance !== 0) {
      throw new ApiError(400, 'They still have an outstanding balance — settle up first');
    }

    if (req.group.members.length === 1) {
      throw new ApiError(400, 'A group needs at least one member');
    }

    req.group.members = req.group.members.filter(
      (m) => String(m.user?._id ?? m.user) !== target,
    );
    await req.group.save();

    // A stand-in exists only for this group, so removing them from it leaves an
    // orphan record with no way to reach it. Clear it out.
    await User.deleteOne({ _id: target, isPlaceholder: true, placeholderGroup: req.group._id });

    await req.group.populate(MEMBER_POPULATE);
    res.json({ group: req.group });
  }),
);

router.delete(
  '/:id',
  requireGroupMember,
  asyncHandler(async (req, res) => {
    const liveExpenses = await Expense.countDocuments({
      group: req.group._id,
      deletedAt: null,
    });
    if (liveExpenses > 0) {
      throw new ApiError(400, 'Delete the expenses in this group before deleting the group');
    }
    await req.group.deleteOne();
    res.json({ ok: true });
  }),
);

export default router;
