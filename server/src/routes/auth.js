import { Router } from 'express';
import { z } from 'zod';
import { User, USERNAME_RE } from '../models/User.js';
import { ApiError, asyncHandler } from '../middleware/error.js';
import { validate } from '../middleware/validate.js';
import {
  requireAuth,
  signToken,
  setAuthCookie,
  clearAuthCookie,
} from '../middleware/auth.js';
import { authLimiter, registerLimiter } from '../middleware/rateLimit.js';

const router = Router();

const registerSchema = z.object({
  name: z.string().trim().min(1, 'Enter your name').max(80),
  username: z
    .string()
    .trim()
    .toLowerCase()
    .transform((v) => v.replace(/^@/, ''))
    .pipe(
      z
        .string()
        .regex(USERNAME_RE, 'Usernames use 3-20 letters, numbers or underscores'),
    ),
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  password: z.string().min(8, 'Use at least 8 characters').max(200),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  password: z.string().min(1, 'Enter your password'),
});

router.post(
  '/register',
  registerLimiter,
  validate(registerSchema),
  asyncHandler(async (req, res) => {
    const { name, username, email, password } = req.body;

    if (await User.exists({ email })) {
      throw new ApiError(409, 'An account with that email already exists');
    }
    if (await User.exists({ username })) {
      throw new ApiError(409, `The username @${username} is already taken`);
    }

    const user = await User.create({
      name,
      username,
      email,
      passwordHash: await User.hashPassword(password),
    });

    setAuthCookie(res, signToken(user._id));
    res.status(201).json({ user: user.toPublic() });
  }),
);

router.post(
  '/login',
  authLimiter,
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    // `isPlaceholder` guards against signing in as a stand-in. Their password is
    // random bytes nobody has, so this is belt and braces — but an account you
    // can't authenticate as shouldn't depend on that alone.
    const user = await User.findOne({ email, isPlaceholder: { $ne: true } }).select(
      '+passwordHash',
    );

    // Always run a hash comparison, even when there's no such account. Bailing
    // out early would return in a couple of milliseconds instead of a few
    // hundred, and that difference is enough to enumerate which emails are
    // registered — the identical error message below wouldn't help.
    const ok = user
      ? await user.verifyPassword(password)
      : await User.burnPasswordComparison(password);

    if (!ok) throw new ApiError(401, 'Incorrect email or password');

    setAuthCookie(res, signToken(user._id));
    res.json({ user: user.toPublic() });
  }),
);

/** Live check for the sign-up form, so a taken handle is caught before submit. */
router.get(
  '/username-available',
  asyncHandler(async (req, res) => {
    const username = String(req.query.username ?? '')
      .trim()
      .toLowerCase()
      .replace(/^@/, '');

    if (!USERNAME_RE.test(username)) {
      return res.json({
        available: false,
        reason: 'Usernames use 3-20 letters, numbers or underscores',
      });
    }
    const taken = await User.exists({ username });
    return res.json({
      available: !taken,
      reason: taken ? `@${username} is already taken` : null,
    });
  }),
);

router.post('/logout', (_req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user.toPublic() });
});

export default router;
