const { verifyAccessToken } = require('../utils/generateToken');
const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/apiError');
const { User } = require('../models');

/**
 * Verifies the JWT sent in the Authorization header (Bearer token) and
 * attaches the authenticated user to req.user. Every protected route uses
 * this before any role-specific check.
 */
const protect = catchAsync(async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw ApiError.unauthorized('You must be logged in to access this resource');
  }

  const token = authHeader.split(' ')[1];

  let decoded;
  try {
    decoded = verifyAccessToken(token);
  } catch (err) {
    throw ApiError.unauthorized('Invalid or expired token');
  }

  const user = await User.findById(decoded.id);
  if (!user) throw ApiError.unauthorized('User no longer exists');
  if (user.isSuspended) throw ApiError.forbidden('Your account has been suspended');

  req.user = user;
  next();
});

/**
 * Same token verification as `protect`, but never blocks the request.
 * Used on public listing routes (e.g. GET /creators, GET /brands) that
 * need to know WHO is asking — for tier-matched visibility (Point 5) —
 * without requiring login to view them at all.
 *
 * - No Authorization header, or a malformed one → req.user stays
 *   undefined, request proceeds normally (anonymous visitor).
 * - A token that fails verification (expired/invalid/tampered) → same:
 *   treated as anonymous rather than rejected, since this route must
 *   stay public regardless of a stale token.
 * - A valid token for a user that no longer exists or is suspended →
 *   also treated as anonymous, for the same reason — this middleware
 *   never throws.
 * - A valid token for an active user → req.user is attached exactly
 *   like `protect` does, so downstream code (req.user?.role checks in
 *   creator.controller.js / brand.controller.js) works unchanged.
 */
const optionalAuth = catchAsync(async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next();
  }

  const token = authHeader.split(' ')[1];

  let decoded;
  try {
    decoded = verifyAccessToken(token);
  } catch (err) {
    return next();
  }

  const user = await User.findById(decoded.id);
  if (user && !user.isSuspended) {
    req.user = user;
  }

  next();
});

module.exports = { protect, optionalAuth };