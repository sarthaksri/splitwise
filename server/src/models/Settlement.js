import mongoose from 'mongoose';

/** A payment from one person to another, cancelling out part of a debt. */
const settlementSchema = new mongoose.Schema(
  {
    group: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', default: null, index: true },
    from: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    to: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    amountCents: { type: Number, required: true, min: 1 },
    currency: { type: String, default: 'INR', uppercase: true },
    date: { type: Date, default: Date.now },
    note: { type: String, trim: true, maxlength: 280, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

settlementSchema.index({ group: 1, date: -1 });
settlementSchema.index({ from: 1, to: 1, deletedAt: 1 });

export const Settlement = mongoose.model('Settlement', settlementSchema);
