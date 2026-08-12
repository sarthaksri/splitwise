import jwt from 'jsonwebtoken';
import { User } from '../models/User.js';
import { Group } from '../models/Group.js';
import { ApiError, asyncHandler } from './error.js';

export const TOKEN_COOKIE = 'sw_token';

function secret() {
  const value = process.env.JWT_SECRET;
  if (!value) throw new Error('JWT_SECRET is not set — see server/.env.example');
  return value;
}

/**
 * How long a session lasts. Empty or "never" means the token carries no `exp`
 * claim and stays valid indefinitely — you stay signed in until you sign out.
 *
 * The cost of that is worth stating plainly: a token that never expires can
 * never be timed out, and nothing here can revoke one that has leaked. Signing
 * out clears the browser's cookie, but a copy captured from a shared machine or
 * a proxy log keeps working. Set JWT_EXPIRES_IN (e.g. `30d`) to get an expiry
 * back.
 */
function tokenLifetime() {
  const raw = (process.env.JWT_EXPIRES_IN ?? '').trim().toLowerCase();
  return raw === '' || raw === 'never' || raw === 'infinite' ? null : raw;
}

export function signToken(userId) {
  const expiresIn = tokenLifetime();
  return jwt.sign({ sub: String(userId) }, secret(), expiresIn ? { expiresIn } : {});
}

/** Ten years. Cookies must carry a date, so "forever" is spelled like this. */
const FOREVER_MS = 10 * 365 * 24 * 60 * 60 * 1000;

/** Set the auth cookie. httpOnly so client JS — and any XSS — can't read it. */
export function setAuthCookie(res, token) {
  const isProd = process.env.NODE_ENV === 'production';

  // Keep the cookie's lifetime tied to the token's. Hardcoding it would mean a
  // shortened JWT_EXPIRES_IN left the browser sending a long-dead token, so
  // every request 401s until the user thinks to clear their cookies.
  const decoded = jwt.decode(token);
  const maxAge = decoded?.exp ? decoded.exp * 1000 - Date.now() : FOREVER_MS;

  res.cookie(TOKEN_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd,
    maxAge: Math.max(maxAge, 0),
    path: '/',
  });
}

export function clearAuthCookie(res) {
  res.clearCookie(TOKEN_COOKIE, { path: '/' });
}

/** Populates req.user, or 401s. */
export const requireAuth = asyncHandler(async (req, _res, next) => {
  const bearer = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : null;
  const token = req.cookies?.[TOKEN_COOKIE] ?? bearer;
  if (!token) throw new ApiError(401, 'You need to sign in');

  let payload;
  try {
    payload = jwt.verify(token, secret());
  } catch (err) {
    // With expiry off, a rejected token means tampered or signed with a
    // different secret — not aged out. Say which, rather than blaming time.
    throw new ApiError(
      401,
      err.name === 'TokenExpiredError'
        ? 'Your session has expired, please sign in again'
        : 'Your session is no longer valid, please sign in again',
    );
  }

  const user = await User.findById(payload.sub);
  if (!user) throw new ApiError(401, 'That account no longer exists');

  req.user = user;
  return next();
});

/**
 * Load the group named by `:groupId` (or `:id`) and confirm the caller belongs
 * to it. Everything group-scoped goes through here — otherwise anyone with an
 * id could read a group's whole ledger.
 */
export const requireGroupMember = asyncHandler(async (req, _res, next) => {
  const groupId = req.params.groupId ?? req.params.id;
  const group = await Group.findById(groupId);
  if (!group) throw new ApiError(404, 'Group not found');
  if (!group.hasMember(req.user._id)) {
    throw new ApiError(403, 'You are not a member of this group');
  }
  req.group = group;
  return next();
});
