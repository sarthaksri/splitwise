import crypto from 'node:crypto';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

/** Deterministic avatar colour so a person looks the same everywhere. */
const AVATAR_COLORS = [
  '#1cc29f', '#5bc5a7', '#ff652f', '#8e6bbf', '#3fa9f5',
  '#f5a623', '#d0021b', '#417505', '#bd10e0', '#0d8a72',
];

function pickAvatarColor(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

/** Usernames are the handle people use to find each other: @aditi */
export const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

/** Turn a name or email into a plausible starting username. */
export function suggestUsername(seed) {
  const base = String(seed ?? '')
    .split('@')[0]
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 20);
  return base.length >= 3 ? base : `${base}user`.slice(0, 20);
}

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    username: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
      match: [USERNAME_RE, 'Usernames use 3-20 letters, numbers or underscores'],
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    passwordHash: { type: String, required: true, select: false },
    avatarColor: { type: String },
    // Explicitly added friends. People you merely share a group with are
    // surfaced too, but only these survive leaving the group.
    friends: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

    /**
     * A stand-in for someone who hasn't signed up: a flatmate who owes for the
     * rent but has never opened the app.
     *
     * They're ordinary User documents on purpose — that way expenses, balances,
     * pairwise debts and simplification all treat them exactly like anyone else
     * with no special cases anywhere downstream. They just can't sign in.
     */
    isPlaceholder: { type: Boolean, default: false },
    /** Which group they were created for; they're only usable inside it. */
    placeholderGroup: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', default: null },
    addedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

userSchema.pre('save', function assignColor(next) {
  if (!this.avatarColor) this.avatarColor = pickAvatarColor(this.email || String(this._id));
  next();
});

userSchema.methods.verifyPassword = function verifyPassword(plain) {
  return bcrypt.compare(plain, this.passwordHash);
};

/** The shape sent to the client — never includes the hash. */
userSchema.methods.toPublic = function toPublic() {
  const base = {
    id: this._id.toString(),
    name: this.name,
    avatarColor: this.avatarColor,
  };
  // A placeholder's username and email are internal filler to satisfy the
  // unique indexes. Showing them would be worse than showing nothing — people
  // would try to email a made-up address.
  if (this.isPlaceholder) {
    return { ...base, isPlaceholder: true, placeholderGroup: this.placeholderGroup?.toString() };
  }
  return { ...base, username: this.username, email: this.email };
};

/**
 * Find a person by "@handle", a bare username, or an email address — so every
 * "add someone" field in the app can accept whichever the user has to hand.
 */
userSchema.statics.findByHandle = function findByHandle(input) {
  const raw = String(input ?? '').trim().toLowerCase();
  if (!raw) return null;
  // Placeholders are excluded: their handles are internal filler, and they
  // belong to one group rather than being people you can look up and befriend.
  const real = { isPlaceholder: { $ne: true } };
  if (raw.includes('@') && !raw.startsWith('@')) return this.findOne({ ...real, email: raw });
  return this.findOne({ ...real, username: raw.replace(/^@/, '') });
};

userSchema.statics.hashPassword = function hashPassword(plain) {
  return bcrypt.hash(plain, 12);
};

/**
 * A throwaway comparison against a fixed hash, used when the email doesn't
 * exist so that login takes the same time either way. Always resolves false.
 */
/**
 * Create a stand-in for someone without an account.
 *
 * `username`, `email` and `passwordHash` are all required and unique on this
 * schema, and relaxing that would mean rebuilding indexes on a live database.
 * Filling them with unguessable internal values is cheaper and safer, and the
 * password is random bytes nobody holds — so there's nothing to sign in with
 * even before the explicit check in the login route.
 */
userSchema.statics.createPlaceholder = async function createPlaceholder({ name, group, addedBy }) {
  const id = new mongoose.Types.ObjectId();
  const suffix = id.toString().slice(-10);
  return this.create({
    _id: id,
    name,
    isPlaceholder: true,
    placeholderGroup: group,
    addedBy,
    username: `guest_${suffix}`,
    email: `guest_${suffix}@placeholder.invalid`,
    passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12),
  });
};

const DUMMY_HASH = bcrypt.hashSync('a-password-that-is-never-valid', 12);
userSchema.statics.burnPasswordComparison = async function burnPasswordComparison(plain) {
  await bcrypt.compare(String(plain ?? ''), DUMMY_HASH);
  return false;
};

export const User = mongoose.model('User', userSchema);
export { AVATAR_COLORS };
