import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { Expense, EXPENSE_CATEGORIES } from '../models/Expense.js';
import { Group } from '../models/Group.js';
import { MAX_AMOUNT_CENTS } from '../../../shared/money.js';
import { ApiError, asyncHandler } from '../middleware/error.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { catchUpRecurring } from '../middleware/recurring.js';
import { scanLimiter } from '../middleware/rateLimit.js';
import { computeShares, normalizePayers, SPLIT_TYPE_LIST } from '../../../shared/splitEngine.js';
import { normalizeScan, reconcileScan, ScanError } from '../../../shared/receipt.js';
import { extractReceipt, GeminiUnavailable, hasGeminiKey } from '../lib/gemini.js';

const router = Router();
router.use(requireAuth);

const objectId = z.string().refine(mongoose.isValidObjectId, 'Not a valid id');
const cents = z.number().int().nonnegative().max(MAX_AMOUNT_CENTS, 'That amount is too large');

const itemSchema = z.object({
  name: z.string().trim().max(120).default(''),
  priceCents: cents,
  qty: z.number().int().min(1).default(1),
  sharedBy: z.array(objectId).min(1, 'Pick who shared this dish'),
});

const expenseSchema = z.object({
  group: objectId.nullish(),
  description: z.string().trim().min(1, 'Give the expense a description').max(140),
  // Optional for dish-wise: the dishes and extras define the total themselves.
  amountCents: z.number().int().positive().max(MAX_AMOUNT_CENTS, 'That amount is too large').nullish(),
  currency: z.string().length(3).toUpperCase().default('INR'),
  date: z.coerce.date().default(() => new Date()),
  category: z.enum(EXPENSE_CATEGORIES).default('general'),
  notes: z.string().trim().max(1000).default(''),

  paidBy: z
    .array(z.object({ userId: objectId, amountCents: cents }))
    .min(1, 'Say who paid'),

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
  discountMode: z.enum(['amount', 'percent']).default('amount'),
  discountBps: z.number().int().min(0).max(10000).default(0),
});

/**
 * Everyone the expense touches must be a member of the group it's filed under
 * (or, for a non-group expense, must be someone the creator knows).
 *
 * `grandfathered` carries the people already on the expense being edited. Once
 * somebody leaves the group they can't be added to anything new, but the
 * dinners they were actually at must stay correctable — otherwise a departure
 * silently freezes every expense they ever appeared in.
 */
async function assertParticipantsAllowed(req, body, involved, grandfathered = new Set()) {
  if (body.group) {
    const group = await Group.findById(body.group);
    if (!group) throw new ApiError(404, 'Group not found');
    if (!group.hasMember(req.user._id)) {
      throw new ApiError(403, 'You are not a member of this group');
    }
    const members = new Set(group.memberIds());
    const stranger = [...involved].find((id) => !members.has(id) && !grandfathered.has(id));
    if (stranger) throw new ApiError(400, 'Everyone involved must be a member of the group');
    return group;
  }

  // Non-group expense: the creator must be part of it, so nobody can invent
  // debts between two unrelated people.
  if (!involved.has(String(req.user._id))) {
    throw new ApiError(400, 'You must be part of an expense you create outside a group');
  }
  return null;
}

/** Run the split engine over a request body and produce the persistable doc. */
async function buildExpenseDoc(req, body, grandfathered) {
  const { amountCents, shares, itemized } = computeShares({
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
    discountMode: body.discountMode,
    discountBps: body.discountBps,
  });

  const payers = normalizePayers(body.paidBy, amountCents);

  const involved = new Set([
    ...payers.map((p) => p.userId),
    ...shares.map((s) => s.userId),
  ]);
  await assertParticipantsAllowed(req, body, involved, grandfathered);

  return {
    doc: {
      group: body.group ?? null,
      description: body.description,
      amountCents,
      currency: body.currency,
      date: body.date,
      category: body.category,
      notes: body.notes,
      paidBy: payers.map((p) => ({ user: p.userId, amountCents: p.amountCents })),
      splitType: body.splitType,
      // Keep the raw input so re-opening the expense restores the form exactly.
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
      // Store what a percentage actually resolved to, so balances and the
      // detail view never have to recompute it.
      discountCents: itemized?.discountCents ?? body.discountCents,
      discountMode: body.discountMode,
      discountBps: body.discountBps,
      shares: shares.map((s) => ({ user: s.userId, amountCents: s.amountCents })),
    },
    itemized,
  };
}

const POPULATE = [
  { path: 'paidBy.user', select: 'name username email avatarColor' },
  { path: 'shares.user', select: 'name username email avatarColor' },
  { path: 'items.sharedBy', select: 'name username avatarColor' },
  { path: 'createdBy', select: 'name username avatarColor' },
];

/**
 * Read a photographed bill into dish rows the form can be prefilled with.
 *
 * Nothing is saved here. The response is a suggestion the user reviews and
 * edits before pressing "Add expense", which is what makes it acceptable for
 * OCR to be occasionally wrong — a bad read costs a correction, never a wrong
 * balance.
 *
 * The image is read and dropped. It is not written to the database, to disk or
 * to a log: a bill carries names, card digits and where somebody was on a given
 * evening, and none of that needs keeping to work out who owes what.
 */
const scanSchema = z.object({
  // ~2.2M base64 characters ≈ 1.6MB of image, comfortably inside the 3mb body
  // parser mounted for this path and Vercel's 4.5MB request cap.
  imageBase64: z.string().min(64, 'That image is empty').max(2_200_000, 'That image is too large'),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp'], {
    message: 'Use a JPEG, PNG or WebP photo',
  }),
});

router.post(
  '/scan',
  scanLimiter,
  validate(scanSchema),
  asyncHandler(async (req, res) => {
    /*
     * "No engine available here" is a routine branch, not a failure, so it
     * answers 200 with a flag rather than an error status. The browser then
     * runs Tesseract locally. Returning 4xx/5xx would make a working fallback
     * look like a broken app — the same mistake the CORS rejection made.
     */
    if (!hasGeminiKey()) {
      return res.json({ provider: null, fallback: 'tesseract', reason: 'no-key' });
    }

    try {
      const raw = await extractReceipt(req.body);
      const scan = normalizeScan(raw);
      return res.json({ provider: 'gemini', scan, reconcile: reconcileScan(scan) });
    } catch (err) {
      if (err instanceof GeminiUnavailable) {
        // Log the reason, never the image.
        console.warn('[scan] gemini unavailable:', err.message);
        return res.json({ provider: null, fallback: 'tesseract', reason: err.kind ?? 'upstream' });
      }
      if (err instanceof ScanError) throw new ApiError(422, err.message);
      throw err;
    }
  }),
);

router.post(
  '/',
  validate(expenseSchema),
  asyncHandler(async (req, res) => {
    const { doc } = await buildExpenseDoc(req, req.body);
    const expense = await Expense.create({ ...doc, createdBy: req.user._id });
    await expense.populate(POPULATE);
    res.status(201).json({ expense });
  }),
);

router.get(
  '/',
  catchUpRecurring,
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const filter = { deletedAt: null };

    if (req.query.group) {
      const group = await Group.findById(req.query.group);
      if (!group) throw new ApiError(404, 'Group not found');
      if (!group.hasMember(req.user._id)) {
        throw new ApiError(403, 'You are not a member of this group');
      }
      filter.group = group._id;
    } else if (req.query.scope === 'non-group') {
      // Only the one-to-one expenses that involve me.
      filter.group = null;
      filter.$or = [{ 'paidBy.user': req.user._id }, { 'shares.user': req.user._id }];
    } else {
      const groups = await Group.find({ 'members.user': req.user._id }).select('_id');
      filter.$or = [
        { group: { $in: groups.map((g) => g._id) } },
        { group: null, 'paidBy.user': req.user._id },
        { group: null, 'shares.user': req.user._id },
      ];
    }

    const expenses = await Expense.find(filter)
      .sort({ date: -1, createdAt: -1 })
      .limit(limit)
      .populate(POPULATE)
      .populate({ path: 'group', select: 'name currency' });

    res.json({ expenses });
  }),
);

/** Load an expense and confirm the caller is allowed to see it. */
async function loadVisibleExpense(req) {
  const expense = await Expense.findOne({ _id: req.params.id, deletedAt: null });
  if (!expense) throw new ApiError(404, 'Expense not found');

  if (expense.group) {
    const group = await Group.findById(expense.group);
    if (!group?.hasMember(req.user._id)) {
      throw new ApiError(403, 'You are not a member of this group');
    }
  } else {
    const me = String(req.user._id);
    const involved = [
      ...expense.paidBy.map((p) => String(p.user)),
      ...expense.shares.map((s) => String(s.user)),
    ];
    if (!involved.includes(me)) throw new ApiError(403, 'This expense is not yours');
  }
  return expense;
}

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const expense = await loadVisibleExpense(req);
    await expense.populate(POPULATE);
    res.json({ expense });
  }),
);

router.patch(
  '/:id',
  validate(expenseSchema),
  asyncHandler(async (req, res) => {
    const existing = await loadVisibleExpense(req);
    // Anyone already on this expense stays allowed on it, member or not.
    const already = new Set([
      ...existing.paidBy.map((p) => String(p.user)),
      ...existing.shares.map((s) => String(s.user)),
    ]);
    const { doc } = await buildExpenseDoc(req, req.body, already);

    // Moving an expense between groups would silently rewrite two ledgers.
    if (String(doc.group ?? '') !== String(existing.group ?? '')) {
      throw new ApiError(400, 'An expense cannot be moved to a different group');
    }

    Object.assign(existing, doc);
    await existing.save();
    await existing.populate(POPULATE);
    res.json({ expense: existing });
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const expense = await loadVisibleExpense(req);
    // Soft delete, so a mis-click is recoverable and history stays intact.
    expense.deletedAt = new Date();
    await expense.save();
    res.json({ ok: true });
  }),
);

export default router;
