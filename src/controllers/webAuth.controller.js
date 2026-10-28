// File: src/controllers/webAuth.controller.js
const { User } = require('../models');
const { generateAccessToken, generateRefreshToken } = require('../utils/generateToken');
const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/apiError');
const ApiResponse = require('../utils/apiResponse');
const otp = require('../services/webLoginOtp.service');

// Website login (fanitt.com) — email → 6-digit code → logged in.
//
//   POST /auth/web/send-code  { email }            → { challenge, resendInSeconds, email }
//   POST /auth/web/verify     { challenge, code }  → { user, accessToken, refreshToken }
//
// Accounts are created in the app; the website only logs in to them.

const cleanEmail = (v) => String(v || '').trim().toLowerCase();

function safeUser(user) {
  return {
    _id: user._id,
    name: user.name,
    email: user.email,
    phone: user.phone || '',
    avatarUrl: user.avatarUrl || '',
    role: user.role,
  };
}

exports.sendCode = catchAsync(async (req, res) => {
  const email = cleanEmail(req.body && req.body.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw ApiError.badRequest('Enter a valid email');

  const user = await User.findOne({ email });
  if (!user) {
    throw ApiError.notFound('No Fanitt account uses this email. Sign up in the Fanitt app first, then log in here.', 'ACCOUNT_NOT_FOUND');
  }
  if (user.isActive === false) throw ApiError.forbidden('This account is being deleted.', 'ACCOUNT_DELETION_PENDING');
  if (user.isSuspended) throw ApiError.forbidden('Your account has been suspended. Contact support.');
  if (user.role === 'admin') throw ApiError.forbidden('Admins log in from the admin panel.');

  const { challenge, resendInSeconds } = await otp.start(user);
  return new ApiResponse(200, { challenge, resendInSeconds, email }, `We sent a 6-digit code to ${email}`).send(res);
});

exports.verify = catchAsync(async (req, res) => {
  const userId = await otp.verify(req.body && req.body.challenge, req.body && req.body.code);
  const user = await User.findById(userId);
  if (!user || user.isActive === false) throw ApiError.unauthorized('Account not found');
  if (user.isSuspended) throw ApiError.forbidden('Your account has been suspended. Contact support.');

  user.lastLoginAt = new Date();
  await user.save();

  const accessToken = generateAccessToken(user._id, user.role);
  const refreshToken = generateRefreshToken(user._id);
  return new ApiResponse(200, { user: safeUser(user), accessToken, refreshToken }, 'Logged in').send(res);
});