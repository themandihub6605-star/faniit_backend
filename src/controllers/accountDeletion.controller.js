const { User } = require('../models');
const catchAsync = require('../utils/catchAsync');
const ApiError = require('../utils/apiError');
const ApiResponse = require('../utils/apiResponse');
const { alertUser } = require('../services/alert.service');

// Admin review of "Delete account" requests from the app / website.
//   pending  → account locked, waiting for admin
//   approved → personal data removed, email freed for a new signup
//   rejected → account restored, user can log in again

const SAFE_FIELDS =
  'name email deletedEmail phone avatarUrl role roles authProvider walletBalance createdAt lastLoginAt deletionStatus deletionRequestedAt deletionReviewedAt deletionReason deletionNote';

// Accounts deleted before this feature have isActive=false but no status.
const PENDING = { isActive: false, deletionStatus: { $nin: ['approved'] } };
const APPROVED = { deletionStatus: 'approved' };

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** GET /api/admin/account-deletions?status=pending|approved&search=&page= */
const listDeletions = catchAsync(async (req, res) => {
  const status = req.query.status === 'approved' ? 'approved' : 'pending';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const search = String(req.query.search || '').trim();

  const filter = { ...(status === 'approved' ? APPROVED : PENDING) };
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ name: rx }, { email: rx }, { deletedEmail: rx }, { phone: rx }];
  }

  const sortField = status === 'approved' ? 'deletionReviewedAt' : 'deletionRequestedAt';
  const [requests, total, pendingCount, approvedCount] = await Promise.all([
    User.find(filter)
      .select(SAFE_FIELDS)
      .sort({ [sortField]: -1, updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    User.countDocuments(filter),
    User.countDocuments(PENDING),
    User.countDocuments(APPROVED),
  ]);

  return new ApiResponse(
    200,
    { requests, total, page, pages: Math.max(1, Math.ceil(total / limit)), counts: { pending: pendingCount, approved: approvedCount } },
    'Deletion requests fetched'
  ).send(res);
});

/** PATCH /api/admin/account-deletions/:id/approve — deletes the account.
 * The record stays (old payments, campaigns, chats still point to it) but
 * all personal data is removed and the email is renamed, so the same
 * person can create a brand-new account with their email / Google. */
const approveDeletion = catchAsync(async (req, res) => {
  const user = await User.findById(req.params.id).select('name email isActive deletionStatus');
  if (!user) throw ApiError.notFound('User not found');
  if (user.deletionStatus === 'approved') throw ApiError.badRequest('This account is already deleted');
  if (user.isActive !== false) throw ApiError.badRequest('This user has not asked to delete their account');

  const now = new Date();
  await User.updateOne(
    { _id: user._id },
    {
      $set: {
        deletedEmail: user.email,
        email: `deleted.${user._id}.${now.getTime()}@deleted.fanitt.invalid`,
        name: 'Deleted user',
        phone: '',
        avatarUrl: '',
        googleId: null,
        pushTokens: [],
        isActive: false,
        deletionStatus: 'approved',
        deletionReviewedAt: now,
        deletionNote: String(req.body?.note || '').trim().slice(0, 500),
      },
      $unset: { passwordResetToken: 1, passwordResetExpires: 1 },
    }
  );

  // Email only — the account is gone, so no in-app notification.
  alertUser({
    userId: user._id,
    inApp: false,
    title: 'Your Fanitt account has been deleted',
    message: 'As you requested, your Fanitt account and personal details have been deleted.',
    email: {
      to: user.email,
      name: user.name,
      body: 'As you requested, your Fanitt account and personal details have been deleted. You can create a new account with this email anytime.',
      ctaUrl: 'https://fanitt.com/signup',
      ctaLabel: 'Create a new account',
    },
  });

  return new ApiResponse(200, { _id: user._id, deletionStatus: 'approved' }, 'Account deleted. The email can now be used for a new account.').send(res);
});

/** PATCH /api/admin/account-deletions/:id/reject — restores the account. */
const rejectDeletion = catchAsync(async (req, res) => {
  const user = await User.findById(req.params.id).select('isActive deletionStatus');
  if (!user) throw ApiError.notFound('User not found');
  if (user.deletionStatus === 'approved') throw ApiError.badRequest('This account is already deleted and cannot be restored');
  if (user.isActive !== false) throw ApiError.badRequest('This account is already active');

  await User.updateOne(
    { _id: user._id },
    {
      $set: {
        isActive: true,
        deletionStatus: 'rejected',
        deletionReviewedAt: new Date(),
        deletionNote: String(req.body?.note || '').trim().slice(0, 500),
      },
    }
  );

  const note = String(req.body?.note || '').trim();
  alertUser({
    userId: user._id,
    fromUser: req.user._id,
    type: 'account_update',
    title: 'Your account was not deleted',
    message: note ? `Your deletion request was declined: ${note}. You can log in again.` : 'Your deletion request was declined and your account is active again. You can log in as before.',
    relatedModel: 'User',
    relatedId: user._id,
    email: {
      body: 'Your account deletion request was declined, so your Fanitt account is active again. You can log in as before.',
      reason: note,
      reasonLabel: 'Note from Fanitt',
      ctaUrl: 'https://fanitt.com/login',
      ctaLabel: 'Log in',
    },
  });

  return new ApiResponse(200, { _id: user._id, deletionStatus: 'rejected' }, 'Account restored. The user can log in again.').send(res);
});

module.exports = { listDeletions, approveDeletion, rejectDeletion };