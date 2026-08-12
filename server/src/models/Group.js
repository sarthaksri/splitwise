import mongoose from 'mongoose';
import crypto from 'node:crypto';

export const GROUP_TYPES = ['trip', 'home', 'couple', 'other'];

const memberSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: ['admin', 'member'], default: 'member' },
    joinedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const groupSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    type: { type: String, enum: GROUP_TYPES, default: 'other' },
    members: { type: [memberSchema], default: [] },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // Splitwise defaults this on: show the minimum set of payments rather than
    // the raw who-owes-whom tangle.
    simplifyDebts: { type: Boolean, default: true },
    currency: { type: String, default: 'INR', uppercase: true, minlength: 3, maxlength: 3 },
    inviteCode: {
      type: String,
      unique: true,
      default: () => crypto.randomBytes(5).toString('hex'),
    },
  },
  { timestamps: true },
);

groupSchema.index({ 'members.user': 1 });

groupSchema.methods.hasMember = function hasMember(userId) {
  const target = String(userId);
  return this.members.some((m) => String(m.user?._id ?? m.user) === target);
};

groupSchema.methods.memberIds = function memberIds() {
  return this.members.map((m) => String(m.user?._id ?? m.user));
};

export const Group = mongoose.model('Group', groupSchema);
