import { Router } from 'express';
import { z } from 'zod';
import { User } from '../models/User.js';
import { Group } from '../models/Group.js';
import { ApiError, asyncHandler } from '../middleware/error.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

/** Find people to add to a group, by name or email. */
router.get(
  '/search',
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (q.length < 2) return res.json({ users: [] });

    // A leading @ means "this is a handle", so don't also match it as a name.
    const handleOnly = q.startsWith('@');
    const term = q.replace(/^@/, '');
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const or = [{ username: new RegExp(`^${escaped}`, 'i') }];
    if (!handleOnly) {
      or.push({ name: new RegExp(escaped, 'i') }, { email: new RegExp(`^${escaped}`, 'i') });
    }

    const users = await User.find({
      _id: { $ne: req.user._id },
      isPlaceholder: { $ne: true }, // stand-ins aren't people you can search for
      $or: or,
    }).limit(10);

    res.json({ users: users.map((u) => u.toPublic()) });
  }),
);

/**
 * Everyone you can split with: people you explicitly added, plus everyone you
 * already share a group with (so you never have to add a groupmate twice).
 */
router.get(
  '/friends',
  asyncHandler(async (req, res) => {
    const groups = await Group.find({ 'members.user': req.user._id }).select('members');
    const ids = new Set(req.user.friends.map(String));
    for (const group of groups) {
      for (const memberId of group.memberIds()) ids.add(memberId);
    }
    ids.delete(String(req.user._id));

    // Placeholders live inside a single group; they aren't friends you can pick
    // when creating a new one.
    const friends = await User.find({
      _id: { $in: [...ids] },
      isPlaceholder: { $ne: true },
    }).sort({ name: 1 });
    res.json({ friends: friends.map((u) => u.toPublic()) });
  }),
);

router.post(
  '/friends',
  validate(
    z.object({
      // A username (@aditi or aditi) or an email — whichever they have to hand.
      handle: z.string().trim().min(1, 'Enter a username or email').optional(),
      email: z.string().trim().optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const handle = req.body.handle ?? req.body.email;
    if (!handle) throw new ApiError(400, 'Enter a username or email address');

    const friend = await User.findByHandle(handle);
    if (!friend) throw new ApiError(404, `Nobody here goes by "${handle}"`);
    if (friend._id.equals(req.user._id)) throw new ApiError(400, 'You cannot add yourself');

    await User.updateOne({ _id: req.user._id }, { $addToSet: { friends: friend._id } });
    // Friendship is mutual — they should see you too.
    await User.updateOne({ _id: friend._id }, { $addToSet: { friends: req.user._id } });

    res.status(201).json({ friend: friend.toPublic() });
  }),
);

export default router;
