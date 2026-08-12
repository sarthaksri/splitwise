import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { RecurringExpense } from '../models/RecurringExpense.js';
import { Expense, EXPENSE_CATEGORIES } from '../models/Expense.js';
import { Group } from '../models/Group.js';
import { User } from '../models/User.js';
import { MAX_AMOUNT_CENTS } from '../../../shared/money.js';
import { ApiError, asyncHandler } from '../middleware/error.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { computeShares, normalizePayers, SPLIT_TYPE_LIST } from '../../../shared/splitEngine.js';
import { FREQUENCY_LIST, describeSchedule } from '../../../shared/recurrence.js';
import { generateForTemplate, recurringNetPerMonth } from '../lib/recurring.js';

const router = Router();
router.use(requireAuth);

const objectId = z.string().refine(mongoose.isValidObjectId, 'Not a valid id');
const cents = z.number().int().nonnegative().max(MAX_AMOUNT_CENTS, 'That amount is too large');

const itemSchema = z.object({
  name: z.string().trim().max(120).default(''),
  priceCents: cents,
  qty: z.number().int().min(1).default(1),
  sharedBy: z.array(objectId).min(1, 'Pick who shared this'),
});

const recurringSchema = z.object({
  // Recurring expenses are always group-scoped: a standing commitment needs a
  // fixed set of people, which is exactly what a group is.
  group: objectId,
  description: z.string().trim().min(1, 'Give it a description').max(140),
  amountCents: z.number().int().positive().max(MAX_AMOUNT_CENTS, 'That amount is too large').nullish(),
  currency: z.string().length(3).toUpperCase().default('INR'),
  category: z.enum(EXPENSE_CATEGORIES).default('general'),
  notes: z.string().trim().max(1000).default(''),

  paidBy: z.array(z.object({ userId: objectId, amountCents: cents })).min(1, 'Say who pays'),
  splitType: z.enum(SPLIT_TYPE_LIST),
  participants: z.array(objectId).optional(),
  exact: z.record(objectId, z.number().int()).optional(),
  percentBps: z.record(objectId, z.number().int().nonnegative()).optional(),
  weights: z.record(objectId, z.number().nonnegative()).optional(),
  items: z.array(itemSchema).optional(),
  taxCents: cents.default(0),
  tipCents: cents.default(0),
  otherCents: cents.default(0),
  discountCents: cents.default(0),

  frequency: z.enum(FREQUENCY_LIST),
  interval: z.number().int().min(1).max(52).default(1),
  startDate: z.coerce.date(),
  endDate: z.coerce.date().nullish(),
  active: z.boolean().default(true),
});

const POPULATE = [
  { path: 'paidBy.user', select: 'name username avatarColor' },
  { path: 'items.sharedBy', select: 'name username avatarColor' },
  { path: 'group', select: 'name currency' },
];

/** Confirm the caller is in the group and everyone involved is a member. */
async function assertAllowed(req, body, involved) {
  const group = await Group.findById(body.group);
  if (!group) throw new ApiError(404, 'Group not found');
  if (!group.hasMember(req.user._id)) {
    throw new ApiError(403, 'You are not a member of this group');
  }
  const members = new Set(group.memberIds());
  if ([...involved].some((x) => !members.has(x))) {
    throw new ApiError(400, 'Everyone involved must be a member of the group');
  }
  return group;
}

function buildTemplate(body, shares, payers) {
  return {
    group: body.group,
    description: body.description,
    amountCents: shares.amountCents,
    currency: body.currency,
    category: body.category,
    notes: body.notes,
    paidBy: payers.map((p) => ({ user: p.userId, amountCents: p.amountCents })),
    splitType: body.splitType,
    splitConfig: {
      participants: body.participants,
      exact: body.exact,
      percentBps: body.percentBps,
      weights: body.weights,
    },
    items: body.items ?? [],
    taxCents: body.taxCents,
    tipCents: body.tipCents,
    otherCents: body.otherCents,
    discountCents: body.discountCents,
    frequency: body.frequency,
    interval: body.interval,
    startDate: body.startDate,
    endDate: body.endDate ?? null,
    active: body.active,
  };
}

/** Validate the split the same way a one-off expense would be. */
function resolveSplit(body) {
  const result = computeShares({
    splitType: body.splitType,
    amountCents: body.amountCents ?? undefined,
    participants: body.participants,
    exact: body.exact,
    percentBps: body.percentBps,
    weights: body.weights,
    items: body.items,
    taxCents: body.taxCents,
    tipCents: body.tipCents,
    otherCents: body.otherCents,
    discountCents: body.discountCents,
  });
  const payers = normalizePayers(body.paidBy, result.amountCents);
  return { result, payers };
}

router.post(
  '/',
  validate(recurringSchema),
  asyncHandler(async (req, res) => {
    const { result, payers } = resolveSplit(req.body);
    const involved = new Set([
      ...payers.map((p) => p.userId),
      ...result.shares.map((s) => s.userId),
    ]);
    await assertAllowed(req, req.body, involved);

    const template = await RecurringExpense.create({
      ...buildTemplate(req.body, result, payers),
      createdBy: req.user._id,
    });

    // Catch up immediately, so a series starting in the past is honest at once.
    const created = await generateForTemplate(template);
    await template.populate(POPULATE);

    res.status(201).json({ recurring: template, generated: created });
  }),
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const groups = await Group.find({ 'members.user': req.user._id }).select('_id');
    const groupIds = groups.map((g) => g._id);

    const filter = { deletedAt: null, group: { $in: groupIds } };
    if (req.query.group) {
      if (!groupIds.some((g) => String(g) === String(req.query.group))) {
        throw new ApiError(403, 'You are not a member of this group');
      }
      filter.group = req.query.group;
    }

    const templates = await RecurringExpense.find(filter).sort({ createdAt: -1 }).populate(POPULATE);

    res.json({
      recurring: templates.map((t) => ({
        ...t.toObject(),
        scheduleLabel: describeSchedule({
          frequency: t.frequency,
          interval: t.interval,
          startDate: t.startDate,
        }),
      })),
    });
  }),
);

/**
 * The per-cycle netting view: what all these standing commitments come to each
 * month, and the fewest payments that would settle them.
 */
router.get(
  '/summary',
  asyncHandler(async (req, res) => {
    const groups = await Group.find({ 'members.user': req.user._id }).select('_id name');
    const groupIds = groups.map((g) => g._id);

    const filter = { deletedAt: null, active: true, group: { $in: groupIds } };
    if (req.query.group) {
      if (!groupIds.some((g) => String(g) === String(req.query.group))) {
        throw new ApiError(403, 'You are not a member of this group');
      }
      filter.group = req.query.group;
    }

    const templates = await RecurringExpense.find(filter);
    const summary = recurringNetPerMonth(templates);

    // Attach the people so the client can render names without another call.
    const ids = new Set();
    for (const n of summary.perMonthNet) ids.add(n.userId);
    for (const p of summary.standingPayments) {
      ids.add(p.from);
      ids.add(p.to);
    }
    const users = await User.find({ _id: { $in: [...ids] } }).lean();
    const byId = new Map(
      users.map((u) => [
        String(u._id),
        { id: String(u._id), name: u.name, username: u.username, avatarColor: u.avatarColor },
      ]),
    );
    const look = (x) => byId.get(x) ?? { id: x, name: 'Unknown', avatarColor: '#999' };

    res.json({
      perMonthNet: summary.perMonthNet.map((n) => ({ ...n, user: look(n.userId) })),
      standingPayments: summary.standingPayments.map((p) => ({
        ...p,
        fromUser: look(p.from),
        toUser: look(p.to),
      })),
      items: summary.items,
      totalMonthlyCents: summary.items.reduce((sum, i) => sum + i.monthlyCents, 0),
    });
  }),
);

async function loadOwned(req) {
  const template = await RecurringExpense.findOne({ _id: req.params.id, deletedAt: null });
  if (!template) throw new ApiError(404, 'Recurring expense not found');
  const group = await Group.findById(template.group);
  if (!group?.hasMember(req.user._id)) {
    throw new ApiError(403, 'You are not a member of this group');
  }
  return template;
}

router.patch(
  '/:id',
  validate(recurringSchema.partial()),
  asyncHandler(async (req, res) => {
    const template = await loadOwned(req);

    // Pausing/resuming is the common edit and needs no re-validation.
    if (Object.keys(req.body).length === 1 && 'active' in req.body) {
      template.active = req.body.active;
      await template.save();
      await template.populate(POPULATE);
      return res.json({ recurring: template });
    }

    const merged = { ...template.toObject(), ...req.body, group: String(template.group) };
    const { result, payers } = resolveSplit(merged);
    const involved = new Set([
      ...payers.map((p) => p.userId),
      ...result.shares.map((s) => s.userId),
    ]);
    await assertAllowed(req, merged, involved);

    Object.assign(template, buildTemplate(merged, result, payers));
    await template.save();
    await template.populate(POPULATE);
    return res.json({ recurring: template });
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const template = await loadOwned(req);
    template.deletedAt = new Date();
    template.active = false;
    await template.save();

    // Expenses already generated stay put — that money really was owed. Only
    // future cycles stop.
    const kept = await Expense.countDocuments({ recurring: template._id, deletedAt: null });
    res.json({ ok: true, keptExpenses: kept });
  }),
);

export default router;
