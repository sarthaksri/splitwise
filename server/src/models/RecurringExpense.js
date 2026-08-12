import mongoose from 'mongoose';
import { SPLIT_TYPE_LIST } from '../../../shared/splitEngine.js';
import { FREQUENCY_LIST } from '../../../shared/recurrence.js';
import { EXPENSE_CATEGORIES } from './Expense.js';

/**
 * A template for an expense that repeats — rent, the internet bill, a cleaner.
 *
 * It holds everything an Expense needs plus a schedule. Real Expense documents
 * are generated from it, so a recurring bill behaves exactly like a normal one
 * in balances, pairwise debts and simplification. Nothing downstream has to
 * know recurring expenses exist.
 */

const payerSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    amountCents: { type: Number, required: true, min: 0 },
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

const recurringSchema = new mongoose.Schema(
  {
    group: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', required: true, index: true },
    description: { type: String, required: true, trim: true, maxlength: 140 },
    amountCents: { type: Number, required: true, min: 1 },
    currency: { type: String, default: 'INR', uppercase: true },
    category: { type: String, enum: EXPENSE_CATEGORIES, default: 'general' },
    notes: { type: String, trim: true, maxlength: 1000, default: '' },

    paidBy: { type: [payerSchema], required: true },
    splitType: { type: String, enum: SPLIT_TYPE_LIST, required: true },
    splitConfig: { type: mongoose.Schema.Types.Mixed, default: {} },
    items: { type: [itemSchema], default: [] },
    taxCents: { type: Number, default: 0, min: 0 },
    tipCents: { type: Number, default: 0, min: 0 },
    otherCents: { type: Number, default: 0, min: 0 },
    discountCents: { type: Number, default: 0, min: 0 },

    // --- schedule ---
    frequency: { type: String, enum: FREQUENCY_LIST, required: true },
    interval: { type: Number, default: 1, min: 1 },
    startDate: { type: Date, required: true },
    endDate: { type: Date, default: null },
    /**
     * The last cycle we have actually created an Expense for. Generation
     * resumes from here, so a gap of months is filled in rather than skipped.
     */
    lastGeneratedFor: { type: Date, default: null },
    active: { type: Boolean, default: true },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

recurringSchema.index({ group: 1, active: 1, deletedAt: 1 });

export const RecurringExpense = mongoose.model('RecurringExpense', recurringSchema);
