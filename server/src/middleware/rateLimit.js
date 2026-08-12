import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

/**
 * Rate limiting.
 *
 * A caveat worth knowing: the default store is in-memory, which on a serverless
 * host means one counter per warm instance rather than one globally. That still
 * blunts a naive password-guessing run considerably, but it is not a hard cap.
 * For a deployment that matters, point these at a shared store (Redis, or
 * Upstash on Vercel) via the `store` option — the limits below stay the same.
 */

const shared = {
  standardHeaders: 'draft-7', // RateLimit-* headers so clients can back off
  legacyHeaders: false,
  // Skip while testing, or the API suite trips the limiter and fails.
  skip: () => process.env.NODE_ENV === 'test',
};

/**
 * Login attempts are counted per account *per IP*, not per IP alone.
 *
 * Keying on IP by itself has a nasty failure mode: flatmates share a router,
 * and this is an app for flatmates. A couple of people fumbling their passwords
 * would lock out everyone else in the house.
 */
function loginKey(req, res) {
  // ipKeyGenerator normalises IPv6 into a /64 subnet; skipping it would let an
  // attacker rotate through addresses in a range they already control.
  const ip = ipKeyGenerator(req, res);
  // Whatever they typed — username or email. This runs before validation, so
  // read both keys rather than assuming the normalised one exists.
  const who = String(req.body?.identifier ?? req.body?.email ?? '')
    .trim()
    .toLowerCase()
    .replace(/^@/, '')
    .slice(0, 120);
  return `${ip}:${who}`;
}

/**
 * Login: 5 failed attempts per minute, per account, per IP.
 *
 * A short window recovers quickly for someone who simply mistyped, while still
 * making a password grind impractically slow. Successful sign-ins don't count
 * against it at all.
 */
export const authLimiter = rateLimit({
  ...shared,
  windowMs: 60 * 1000,
  limit: 5,
  // Count only failures, so someone repeatedly signing in fine is unaffected.
  skipSuccessfulRequests: true,
  keyGenerator: loginKey,
  message: { error: 'Too many attempts. Wait a minute and try again.' },
});

/** Sign-ups, to stop a script filling the database with accounts. */
export const registerLimiter = rateLimit({
  ...shared,
  windowMs: 60 * 60 * 1000,
  limit: 10,
  message: { error: 'Too many accounts created from here. Try again later.' },
});

/** Everything else — generous enough that normal use never notices. */
export const apiLimiter = rateLimit({
  ...shared,
  windowMs: 60 * 1000,
  limit: 300,
  message: { error: 'Slow down a moment, then try again.' },
});
