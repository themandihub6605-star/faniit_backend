const { User, Transaction, CreatorProfile, BrandProfile } = require('../models');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');
const { TRANSACTION_TYPE } = require('../constants/enums');
const { alertUser } = require('../services/alert.service');

const updateMe = catchAsync(async (req, res) => {
  const { name, phone } = req.body;

  const user = await User.findByIdAndUpdate(
    req.user._id,
    { $set: { ...(name && { name }), ...(phone && { phone }) } },
    { new: true, runValidators: true }
  );

  return new ApiResponse(200, user.toSafeObject(), 'Profile updated').send(res);
});

const updateAvatar = catchAsync(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('No file uploaded');

  const avatarUrl = req.file.path;
  const user = await User.findByIdAndUpdate(req.user._id, { avatarUrl }, { new: true });

  return new ApiResponse(200, { avatarUrl: user.avatarUrl }, 'Avatar updated').send(res);
});

const getUserById = catchAsync(async (req, res) => {
  // Public endpoint — only return public fields (no email, phone, wallet).
  const user = await User.findById(req.params.id).select('name avatarUrl role roles createdAt');
  if (!user) throw ApiError.notFound('User not found');
  return new ApiResponse(200, user, 'User fetched').send(res);
});

const deleteMe = catchAsync(async (req, res) => {
  // Locks the account right away (login, refresh and every protected route
  // reject it) and sends it to the admin for approval. Once approved the
  // account is deleted and the email can be used for a new signup.
  const reason = String(req.body?.reason || '').trim().slice(0, 500);
  await User.findByIdAndUpdate(req.user._id, {
    isActive: false,
    pushTokens: [],
    deletionStatus: 'pending',
    deletionRequestedAt: new Date(),
    deletionReason: reason,
  });
  res.clearCookie('refreshToken');

  // Confirmation by email (the app is signed out, so no in-app notification).
  alertUser({
    userId: req.user._id,
    inApp: false,
    title: 'We received your account deletion request',
    message: 'Your Fanitt account is locked and will be deleted after our team reviews the request.',
    email: {
      to: req.user.email,
      name: req.user.name,
      body: 'Your Fanitt account is now locked and will be deleted once our team reviews the request. After that you can sign up again with this email. If you didn’t ask for this, reply to this email right away.',
    },
  });

  return new ApiResponse(200, null, 'Deletion request sent. Your account will be deleted after review.').send(res);
});

/** POST /api/users/me/push-token — { token, platform } registers this device. */
const registerPushToken = catchAsync(async (req, res) => {
  const { token, platform = 'android' } = req.body;
  if (!token || typeof token !== 'string') throw ApiError.badRequest('token is required');
  if (!['android', 'ios', 'web'].includes(platform)) throw ApiError.badRequest('Invalid platform');

  // A device token belongs to one account at a time.
  await User.updateMany({ 'pushTokens.token': token }, { $pull: { pushTokens: { token } } });
  await User.updateOne(
    { _id: req.user._id },
    { $push: { pushTokens: { $each: [{ token, platform, updatedAt: new Date() }], $slice: -10 } } }
  );
  return new ApiResponse(200, null, 'Device registered').send(res);
});

/** DELETE /api/users/me/push-token — { token } on logout. */
const removePushToken = catchAsync(async (req, res) => {
  const { token } = req.body || {};
  if (token) await User.updateOne({ _id: req.user._id }, { $pull: { pushTokens: { token } } });
  return new ApiResponse(200, null, 'Device removed').send(res);
});

/** PATCH /api/users/me/password — change your own password. Requires the
 * current password to confirm it's really you, not just anyone with a
 * still-valid session token. Works for any role (Admin, Agency, Creator...);
 * Agency accounts in particular are created by an Admin with a temporary
 * password, so this is how they set their own after first login. */
const changePassword = catchAsync(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) throw ApiError.badRequest('Current and new password are required');
  if (newPassword.length < 8) throw ApiError.badRequest('New password must be at least 8 characters');

  const user = await User.findById(req.user._id).select('+password');
  if (!user.password || !(await user.comparePassword(currentPassword))) {
    throw ApiError.unauthorized('Current password is incorrect');
  }

  user.password = newPassword; // pre-save hook hashes it
  await user.save();

  return new ApiResponse(200, null, 'Password updated').send(res);
});

/** GET /api/users/me/referrals — my own referral code, everyone I've
 * referred (any role), and my total referral commission earned so far. */
const getMyFollowing = catchAsync(async (req, res) => {
  const [creators, brands] = await Promise.all([
    CreatorProfile.find({ followers: req.user._id }).select('slug title user').populate('user', 'name avatarUrl'),
    BrandProfile.find({ followers: req.user._id }).select('slug companyName logoUrl'),
  ]);

  // A flat, mixed list — the frontend can filter/render creators and
  // brands however it wants, and can derive the "which IDs am I
  // following" set it needs for follow-button state from `id` here
  // instead of needing a separate endpoint for that.
  const following = [
    ...creators.map((c) => ({
      id: c._id,
      type: 'creator',
      slug: c.slug,
      name: c.user?.name || 'Unknown creator',
      avatarUrl: c.user?.avatarUrl || null,
      subtitle: c.title || null,
    })),
    ...brands.map((b) => ({
      id: b._id,
      type: 'brand',
      slug: b.slug,
      name: b.companyName,
      avatarUrl: b.logoUrl || null,
      subtitle: null,
    })),
  ];

  return new ApiResponse(200, following, 'Following list fetched').send(res);
});

const getMyReferrals = catchAsync(async (req, res) => {
  const [referredUsers, transactions] = await Promise.all([
    User.find({ referredBy: req.user._id }).select('name role avatarUrl createdAt'),
    Transaction.find({ to: req.user._id, type: TRANSACTION_TYPE.REFERRAL_COMMISSION }).sort({ createdAt: -1 }).limit(50),
  ]);

  const totalEarned = transactions.reduce((sum, t) => sum + (t.referralCommission || 0), 0);

  return new ApiResponse(
    200,
    {
      referralCode: req.user.referralCode,
      referredUsers,
      totalEarned,
      recentCommissions: transactions,
    },
    'Referral info fetched'
  ).send(res);
});

module.exports = { updateMe, updateAvatar, getUserById, deleteMe, getMyReferrals, changePassword, getMyFollowing, registerPushToken, removePushToken };