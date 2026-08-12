import mongoose from 'mongoose';
import { SPLIT_TYPE_LIST } from '../../../shared/splitEngine.js';

export const EXPENSE_CATEGORIES = [
  'general', 'food', 'groceries', 'rent', 'utilities', 'transport',
  'entertainment', 'shopping', 'travel', 'health', 'other',
];

const payerSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    amountCents: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const shareSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    amountCents: { type: Number, required: true },
  },
  { _id: false },
);

const itemSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, maxlength: 120, default: '' },
    priceCents: { type: Number, required: true, min: 0 },
    qty: { type: Number, default: 1, min: 1 },
    sharedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  },
  { _id: false },
);

const expenseSchema = new mongoose.Schema(
  {
    // null => a one-to-one expense outside any group
    group: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', default: null, index: true },
    description: { type: String, required: true, trim: true, maxlength: 140 },
    amountCents: { type: Number, required: true, min: 1 },
    currency: { type: String, default: 'INR', uppercase: true },
    date: { type: Date, default: Date.now },
    category: { type: String, enum: EXPENSE_CATEGORIES, default: 'general' },
    notes: { type: String, trim: true, maxlength: 1000, default: '' },

    paidBy: { type: [payerSchema], required: true },

    splitType: { type: String, enum: SPLIT_TYPE_LIST, required: true },
    // The raw form input (percentages, weights, exact amounts). Kept so that
    // re-opening an expense restores exactly what was typed.
    splitConfig: { type: mongoose.Schema.Types.Mixed, default: {} },

    // Dish-wise fields. Empty for the other split types.
    items: { type: [itemSchema], default: [] },
    taxCents: { type: Number, default: 0, min: 0 },
    tipCents: { type: Number, default: 0, min: 0 },
    otherCents: { type: Number, default: 0, min: 0 },
    // The resolved discount in minor units, whichever way it was entered.
    discountCents: { type: Number, default: 0, min: 0 },
    // How it was typed, so re-opening the expense shows "20%" not "₹174".
    discountMode: { type: String, enum: ['amount', 'percent'], default: 'amount' },
    discountBps: { type: Number, default: 0, min: 0, max: 10000 },

    // Always server-computed from the above. Never trusted from the client.
    shares: { type: [shareSchema], required: true },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    deletedAt: { type: Date, default: null },

    // Set when this expense was generated from a recurring template.
    recurring: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'RecurringExpense',
      default: null,
    },
    /** Which occurrence this is, as "YYYY-MM-DD". See the unique index below. */
    cycleKey: { type: String, default: null },
  },
  { timestamps: true },
);

// The two access patterns that matter: a group's ledger, and "everything
// involving me" for the dashboard.
expenseSchema.index({ group: 1, date: -1 });

/**
 * The guarantee that nobody is ever charged twice for the same rent.
 *
 * Generation is idempotent because this index makes a duplicate cycle a
 * database error rather than a second expense — which matters because several
 * flatmates opening the app at once will all try to generate March at the same
 * moment. Partial, so the millions of one-off expenses (both fields null) don't
 * collide with each other.
 */
expenseSchema.index(
  { recurring: 1, cycleKey: 1 },
  {
    unique: true,
    partialFilterExpression: { recurring: { $type: 'objectId' } },
  },
);
expenseSchema.index({ 'shares.user': 1, deletedAt: 1 });
expenseSchema.index({ 'paidBy.user': 1, deletedAt: 1 });

export const Expense = mongoose.model('Expense', expenseSchema);
