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

module.exports = { protect };
