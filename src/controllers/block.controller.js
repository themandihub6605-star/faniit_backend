// File: src/controllers/block.controller.js
const mongoose = require('mongoose');
const { Block, User, CreatorProfile, BrandProfile } = require('../models');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');
const { isBlockedBetween } = require('../utils/blocks');

// Blocking.
//
//   GET    /blocks                 people I blocked (for Settings → Blocked accounts)
//   GET    /blocks/ids             { blocked: [ids I blocked], hidden: [ids hidden both ways] }
//   GET    /blocks/status/:userId  { blockedByMe, blockedMe }
//   POST   /blocks/:userId         block
//   DELETE /blocks/:userId         unblock

const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ''));

/** Stop following each other (creator + brand profiles), keeping counts right. */
async function unfollowBothWays(a, b) {
  const pairs = [
    [a, b],
    [b, a],
  ];
  for (const [follower, owner] of pairs) {
    for (const Model of [CreatorProfile, BrandProfile]) {
      await Model.updateMany({ user: owner, followers: follower }, { $pull: { followers: follower }, $inc: { followerCount: -1 } });
    }
  }
}

exports.block = catchAsync(async (req, res) => {
  const { userId } = req.params;
  if (!isId(userId)) throw ApiError.badRequest('Invalid account');
  if (String(userId) === String(req.user._id)) throw ApiError.badRequest('You can’t block yourself');

  const other = await User.findById(userId).select('role name');
  if (!other) throw ApiError.notFound('Account not found');
  if (other.role === 'admin') throw ApiError.badRequest('This account can’t be blocked');

  try {
    await Block.create({ blocker: req.user._id, blocked: userId });
  } catch (err) {
    if (!err || err.code !== 11000) throw err; // already blocked → fine
  }
  await unfollowBothWays(req.user._id, other._id);

  return new ApiResponse(200, { userId: String(userId), blocked: true }, `${other.name || 'Account'} blocked`).send(res);
});

exports.unblock = catchAsync(async (req, res) => {
  const { userId } = req.params;
  if (!isId(userId)) throw ApiError.badRequest('Invalid account');
  await Block.deleteOne({ blocker: req.user._id, blocked: userId });
  return new ApiResponse(200, { userId: String(userId), blocked: false }, 'Unblocked').send(res);
});

exports.list = catchAsync(async (req, res) => {
  const rows = await Block.find({ blocker: req.user._id }).sort({ createdAt: -1 }).populate('blocked', 'name avatarUrl role').lean();

  // Brands show their company name and logo, like everywhere else.
  const brandIds = rows.filter((r) => r.blocked && r.blocked.role === 'brand').map((r) => r.blocked._id);
  const brands = brandIds.length ? await BrandProfile.find({ user: { $in: brandIds } }).select('user companyName logoUrl').lean() : [];
  const brandBy = new Map(brands.map((b) => [String(b.user), b]));

  const items = rows
    .filter((r) => r.blocked)
    .map((r) => {
      const u = r.blocked;
      const b = brandBy.get(String(u._id));
      return {
        userId: String(u._id),
        name: b ? b.companyName : u.name || 'Fanitt user',
        avatarUrl: b ? b.logoUrl || u.avatarUrl || '' : u.avatarUrl || '',
        role: u.role,
        blockedAt: r.createdAt,
      };
    });
  return new ApiResponse(200, items).send(res);
});

exports.ids = catchAsync(async (req, res) => {
  const me = String(req.user._id);
  const rows = await Block.find({ $or: [{ blocker: req.user._id }, { blocked: req.user._id }] }).select('blocker blocked').lean();
  const blocked = [];
  const hidden = new Set();
  rows.forEach((r) => {
    if (String(r.blocker) === me) {
      blocked.push(String(r.blocked));
      hidden.add(String(r.blocked));
    } else {
      hidden.add(String(r.blocker));
    }
  });
  return new ApiResponse(200, { blocked, hidden: [...hidden] }).send(res);
});

exports.status = catchAsync(async (req, res) => {
  const { userId } = req.params;
  if (!isId(userId)) throw ApiError.badRequest('Invalid account');
  const [byMe, me] = await Promise.all([
    Block.exists({ blocker: req.user._id, blocked: userId }),
    Block.exists({ blocker: userId, blocked: req.user._id }),
  ]);
  return new ApiResponse(200, { blockedByMe: Boolean(byMe), blockedMe: Boolean(me) }).send(res);
});

/**
 * Runs before POST /creators/:id/follow and /brands/:id/follow (see
 * routes/index.js). `:id` is the profile id. Calls next() when allowed.
 */
exports.followGuard = (kind) =>
  catchAsync(async (req, res, next) => {
    if (!req.user || !isId(req.params.id)) return next();
    const Model = kind === 'brand' ? BrandProfile : CreatorProfile;
    const profile = await Model.findById(req.params.id).select('user').lean();
    if (profile && (await isBlockedBetween(req.user._id, profile.user))) {
      throw ApiError.forbidden('You can’t follow this account', 'BLOCKED');
    }
    return next();
  });