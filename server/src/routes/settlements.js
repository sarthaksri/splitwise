import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { Settlement } from '../models/Settlement.js';
import { Group } from '../models/Group.js';
import { MAX_AMOUNT_CENTS } from '../../../shared/money.js';
import { ApiError, asyncHandler } from '../middleware/error.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const objectId = z.string().refine(mongoose.isValidObjectId, 'Not a valid id');

const settlementSchema = z.object({
  group: objectId.nullish(),
  from: objectId,
  to: objectId,
  amountCents: z.number().int().positive('Enter an amount greater than zero').max(MAX_AMOUNT_CENTS, 'That amount is too large'),
  currency: z.string().length(3).toUpperCase().default('INR'),
  date: z.coerce.date().default(() => new Date()),
  note: z.string().trim().max(280).default(''),
});

const POPULATE = [
  { path: 'from', select: 'name username email avatarColor' },
  { path: 'to', select: 'name username email avatarColor' },
  // Anyone in the group can edit a payment, so the detail view needs to say who
  // entered it — otherwise a corrected amount has no author.
  { path: 'createdBy', select: 'name username avatarColor' },
];

router.post(
  '/',
  validate(settlementSchema),
  asyncHandler(async (req, res) => {
    const { group: groupId, from, to } = req.body;
    if (from === to) throw new ApiError(400, 'A payment needs two different people');

    if (groupId) {
      const group = await Group.findById(groupId);
      if (!group) throw new ApiError(404, 'Group not found');
      if (!group.hasMember(req.user._id)) {
        throw new ApiError(403, 'You are not a member of this group');
      }
      if (!group.hasMember(from) || !group.hasMember(to)) {
        throw new ApiError(400, 'Both people must be members of the group');
      }
    } else if (![from, to].includes(String(req.user._id))) {
      // Outside a group you can only record payments you were part of.
      throw new ApiError(403, 'You can only record a payment you are part of');
    }

    const settlement = await Settlement.create({ ...req.body, createdBy: req.user._id });
    await settlement.populate(POPULATE);
    res.status(201).json({ settlement });
  }),
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const filter = { deletedAt: null };

    if (req.query.group) {
      const group = await Group.findById(req.query.group);
      if (!group) throw new ApiError(404, 'Group not found');
      if (!group.hasMember(req.user._id)) {
        throw new ApiError(403, 'You are not a member of this group');
      }
      filter.group = group._id;
    } else {
      filter.$or = [{ from: req.user._id }, { to: req.user._id }];
    }

    const settlements = await Settlement.find(filter)
      .sort({ date: -1 })
      .limit(200)
      .populate(POPULATE)
      .populate({ path: 'group', select: 'name' });

    res.json({ settlements });
  }),
);

/**
 * Load a payment the caller is allowed to change.
 *
 * Inside a group, any member may edit or delete any payment: the whole group
 * shares one ledger, and a mistyped payment distorts everyone's balance, so
 * everyone needs to be able to correct it. Outside a group there is no shared
 * ledger, so it stays limited to the two people involved (and whoever recorded
 * it).
 */
async function loadEditable(req) {
  const settlement = await Settlement.findOne({ _id: req.params.id, deletedAt: null });
  if (!settlement) throw new ApiError(404, 'Payment not found');

  if (settlement.group) {
    const group = await Group.findById(settlement.group);
    if (!group?.hasMember(req.user._id)) {
      throw new ApiError(403, 'You are not a member of this group');
    }
    return { settlement, group };
  }

  const me = String(req.user._id);
  const mine = [String(settlement.from), String(settlement.to), String(settlement.createdBy)];
  if (!mine.includes(me)) throw new ApiError(403, 'That payment is not yours');
  return { settlement, group: null };
}

const updateSchema = z.object({
  from: objectId.optional(),
  to: objectId.optional(),
  amountCents: z.number().int().positive('Enter an amount greater than zero').max(MAX_AMOUNT_CENTS, 'That amount is too large').optional(),
  date: z.coerce.date().optional(),
  note: z.string().trim().max(280).optional(),
});

router.patch(
  '/:id',
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    const { settlement, group } = await loadEditable(req);

    const from = req.body.from ?? String(settlement.from);
    const to = req.body.to ?? String(settlement.to);
    if (from === to) throw new ApiError(400, 'A payment needs two different people');

    if (group && (!group.hasMember(from) || !group.hasMember(to))) {
      throw new ApiError(400, 'Both people must be members of the group');
    }
    if (!group && ![from, to].includes(String(req.user._id))) {
      throw new ApiError(403, 'You can only record a payment you are part of');
    }

    Object.assign(settlement, req.body, { from, to });
    await settlement.save();
    await settlement.populate(POPULATE);
    res.json({ settlement });
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { settlement } = await loadEditable(req);
    // Soft delete, so an accidental removal is recoverable and the balance
    // change is traceable.
    settlement.deletedAt = new Date();
    await settlement.save();
    res.json({ ok: true });
  }),
);

export default router;
