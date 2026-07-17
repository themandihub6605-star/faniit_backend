const crypto = require('crypto');
const { User, CreatorProfile, BrandProfile, AgencyProfile } = require('../models');
const { generateAccessToken, generateRefreshToken, verifyRefreshToken } = require('../utils/generateToken');
const generateSlug = require('../utils/slugify');
const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/apiError');
const ApiResponse = require('../utils/apiResponse');
const { ROLES } = require('../constants/enums');

function issueTokens(res, user) {
  const accessToken = generateAccessToken(user._id, user.role);
  const refreshToken = generateRefreshToken(user._id);

  res.cookie('refreshToken', refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });

  return accessToken;
}

const register = catchAsync(async (req, res) => {
  const { name, email, password, phone, role } = req.body;

  const existing = await User.findOne({ email });
  if (existing) throw ApiError.conflict('An account with this email already exists');

  const user = await User.create({ name, email, password, phone, role, roles: [role] });

  // create the role-specific profile alongside the base user
  if (role === ROLES.CREATOR) {
    await CreatorProfile.create({ user: user._id, slug: generateSlug(name) });
  } else if (role === ROLES.BRAND) {
    await BrandProfile.create({ user: user._id, companyName: name, slug: generateSlug(name) });
  } else if (role === ROLES.AGENCY) {
    await AgencyProfile.create({ user: user._id, agencyName: name, referralCode: generateSlug(name).toUpperCase() });
  }

  const accessToken = issueTokens(res, user);
  return new ApiResponse(201, { user: user.toSafeObject(), accessToken }, 'Account created successfully').send(res);
});

const login = catchAsync(async (req, res) => {
  const { email, password } = req.body;

  const user = await User.findOne({ email }).select('+password');
  if (!user || !(await user.comparePassword(password))) {
    throw ApiError.unauthorized('Invalid email or password');
  }
  if (user.isSuspended) throw ApiError.forbidden('Your account has been suspended. Contact support.');

  user.lastLoginAt = new Date();
  await user.save();

  const accessToken = issueTokens(res, user);
  return new ApiResponse(200, { user: user.toSafeObject(), accessToken }, 'Logged in successfully').send(res);
});

const refresh = catchAsync(async (req, res) => {
  const token = req.cookies?.refreshToken;
  if (!token) throw ApiError.unauthorized('No refresh token provided');

  let decoded;
  try {
    decoded = verifyRefreshToken(token);
  } catch {
    throw ApiError.unauthorized('Invalid or expired refresh token');
  }

  const user = await User.findById(decoded.id);
  if (!user) throw ApiError.unauthorized('User no longer exists');

  const accessToken = generateAccessToken(user._id, user.role);
  return new ApiResponse(200, { accessToken }, 'Token refreshed').send(res);
});

const logout = catchAsync(async (req, res) => {
  res.clearCookie('refreshToken');
  return new ApiResponse(200, null, 'Logged out successfully').send(res);
});

const getMe = catchAsync(async (req, res) => {
  return new ApiResponse(200, req.user.toSafeObject(), 'Current user fetched').send(res);
});

const forgotPassword = catchAsync(async (req, res) => {
  const { email } = req.body;
  const user = await User.findOne({ email });

  // Always respond the same way whether or not the email exists, to avoid leaking which emails are registered
  if (user) {
    const resetToken = crypto.randomBytes(32).toString('hex');
    // NOTE: store hashed resetToken + expiry on the user document, and email
    // the raw token via an email service — wiring point for e.g. Resend/SES.
    user.passwordResetToken = crypto.createHash('sha256').update(resetToken).digest('hex');
    user.passwordResetExpires = Date.now() + 15 * 60 * 1000;
    await user.save({ validateBeforeSave: false });
  }

  return new ApiResponse(200, null, 'If that email exists, a reset link has been sent').send(res);
});

const resetPassword = catchAsync(async (req, res) => {
  const { token, newPassword } = req.body;
  const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

  const user = await User.findOne({
    passwordResetToken: hashedToken,
    passwordResetExpires: { $gt: Date.now() },
  });
  if (!user) throw ApiError.badRequest('Reset token is invalid or has expired');

  user.password = newPassword;
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  await user.save();

  return new ApiResponse(200, null, 'Password reset successfully').send(res);
});

/** Lets an existing Fan account add a Creator/Brand/Agency role without a new signup. */
const upgradeRole = catchAsync(async (req, res) => {
  const { role, name } = req.body;
  if (![ROLES.CREATOR, ROLES.BRAND, ROLES.AGENCY].includes(role)) {
    throw ApiError.badRequest('Invalid role to upgrade to');
  }

  const user = req.user;
  if (!user.roles.includes(role)) user.roles.push(role);
  user.role = role; // active role switches to the new one
  await user.save();

  if (role === ROLES.CREATOR && !(await CreatorProfile.findOne({ user: user._id }))) {
    await CreatorProfile.create({ user: user._id, slug: generateSlug(name || user.name) });
  } else if (role === ROLES.BRAND && !(await BrandProfile.findOne({ user: user._id }))) {
    await BrandProfile.create({ user: user._id, companyName: name || user.name, slug: generateSlug(name || user.name) });
  } else if (role === ROLES.AGENCY && !(await AgencyProfile.findOne({ user: user._id }))) {
    await AgencyProfile.create({ user: user._id, agencyName: name || user.name, referralCode: generateSlug(name || user.name).toUpperCase() });
  }

  return new ApiResponse(200, user.toSafeObject(), `Account upgraded to ${role}`).send(res);
});

module.exports = { register, login, refresh, logout, getMe, forgotPassword, resetPassword, upgradeRole };
