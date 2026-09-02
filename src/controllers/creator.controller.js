const { CreatorProfile, Session, Booking, Transaction, Review, UserSubscription } = require('../models');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');
const { ROLES, TRANSACTION_TYPE, TRANSACTION_STATUS } = require('../constants/enums');
const { VERIFICATION_STATUS } = require('../constants/enums');
const listCreators = catchAsync(async (req, res) => {
  const { category, location, minFollowers, search, page = 1, limit = 20 } = req.query;

  const filter = { verificationStatus: { $ne: 'rejected' } };
  if (category) filter.category = category;
  if (location) filter.location = new RegExp(location, 'i');
  if (minFollowers) filter.followerCount = { $gte: Number(minFollowers) };
  if (search) {
    filter.$or = [{ bio: new RegExp(search, 'i') }];
  }

  // NOTE: the earlier Lite-only-sees-Lite / Pro-sees-everyone visibility
  // filter (Point 5) has been removed per later instruction — every
  // creator is now visible to every viewer regardless of plan tier.
  // subscriptionService.getProTierUserIds / isViewerOnLiteTier still exist
  // and are harmless if unused elsewhere; nothing to clean up there.

  const creators = await CreatorProfile.find(filter)
    .populate('user', 'name avatarUrl')
    .populate('category', 'label icon')
    .sort({ followerCount: -1 })
    .skip((page - 1) * limit)
    .limit(Number(limit));

  // Real completed-session counts for exactly the creators on this page — one
  // aggregate query, not N+1, and not a fabricated number.
  const creatorIds = creators.map((c) => c._id);
  const completedCounts = await Session.aggregate([
    { $match: { creator: { $in: creatorIds }, isCompleted: true } },
    { $group: { _id: '$creator', count: { $sum: 1 } } },
  ]);
  const countMap = new Map(completedCounts.map((c) => [String(c._id), c.count]));

  // Plan badge info (replaces the old blue verified-tick on listing
  // cards) — one batched query for every creator on this page rather
  // than a per-card lookup. A creator with no UserSubscription row yet
  // is implicitly on the free default plan, same reasoning as elsewhere
  // in subscription.service.js — defaults to 'Lite' / not-pro.
  const userIds = creators.map((c) => c.user?._id).filter(Boolean);
  const subs = await UserSubscription.find({ user: { $in: userIds } }).populate('plan', 'name price');
  const planMap = new Map(subs.map((s) => [String(s.user), s.plan]));

  const creatorsWithStats = creators.map((c) => {
    const plan = planMap.get(String(c.user?._id));
    return {
      ...c.toObject(),
      projectsCompletedCount: countMap.get(String(c._id)) || 0,
      planName: plan ? plan.name : 'Lite',
      isProPlan: plan ? plan.price > 0 : false,
    };
  });

  const total = await CreatorProfile.countDocuments(filter);

  return new ApiResponse(200, { creators: creatorsWithStats, total, page: Number(page), pages: Math.ceil(total / limit) }, 'Creators fetched').send(res);
});

const getCreatorBySlug = catchAsync(async (req, res) => {
  const creator = await CreatorProfile.findOneAndUpdate(
    { slug: req.params.slug },
    { $inc: { profileViews: 1 } },
    { new: true }
  )
    .populate('user', 'name avatarUrl email')
    .populate('category', 'label icon');

  if (!creator) throw ApiError.notFound('Creator not found');

  const sessions = await Session.find({ creator: creator._id, isCancelled: false, isCompleted: false }).sort({ scheduledAt: 1 });
  const reviews = await Review.find({ toUser: creator.user._id, isHidden: false }).sort({ createdAt: -1 }).limit(10);

  // Real, computed trust metrics — not hardcoded.
  const projectsCompletedCount = await Session.countDocuments({ creator: creator._id, isCompleted: true });

  // Plan badge info for this profile — same defaulting as listCreators
  // (no UserSubscription row yet = implicitly Lite). Used by the
  // frontend to show a Lite viewer an upgrade prompt when they open a
  // Pro creator's profile.
  const sub = await UserSubscription.findOne({ user: creator.user._id }).populate('plan', 'name price');
  const creatorWithPlan = {
    ...creator.toObject(),
    planName: sub ? sub.plan.name : 'Lite',
    isProPlan: sub ? sub.plan.price > 0 : false,
  };

  return new ApiResponse(
    200,
    { creator: creatorWithPlan, sessions, reviews, stats: { projectsCompletedCount } },
    'Creator profile fetched'
  ).send(res);
});

const getMyProfile = catchAsync(async (req, res) => {
  if (req.user.role !== ROLES.CREATOR) throw ApiError.forbidden('Only creators have a creator profile');

  const creator = await CreatorProfile.findOne({ user: req.user._id })
    .populate('user', 'name avatarUrl email phone')
    .populate('category', 'label icon');

  if (!creator) throw ApiError.notFound('Creator profile not found');
  return new ApiResponse(200, creator, 'Profile fetched').send(res);
});


const updateMyProfile = catchAsync(async (req, res) => {
  if (req.user.role !== ROLES.CREATOR) throw ApiError.forbidden('Only creators can update a creator profile');

  const { bio, title, category, skills, location, socials, isAvailableForWork, responseTime, languages, yearsOfExperience, portfolioLink, submitForApproval } = req.body;

  const creator = await CreatorProfile.findOne({ user: req.user._id });
  if (!creator) throw ApiError.notFound('Creator profile not found');

  if (bio !== undefined) creator.bio = bio;
  if (title !== undefined) creator.title = title;
  if (category) creator.category = category;
  if (skills) creator.skills = skills;
  if (location) creator.location = location;
  if (socials) creator.socials = socials;
  if (isAvailableForWork !== undefined) creator.isAvailableForWork = isAvailableForWork;
  if (responseTime !== undefined) creator.responseTime = responseTime;
  if (languages) creator.languages = languages;
  if (yearsOfExperience !== undefined) creator.yearsOfExperience = yearsOfExperience;
  if (portfolioLink !== undefined) creator.portfolioLink = portfolioLink;

  if (submitForApproval && creator.verificationStatus === VERIFICATION_STATUS.UNVERIFIED) {
    creator.verificationStatus = VERIFICATION_STATUS.PENDING;
  }

  await creator.save();
  return new ApiResponse(200, creator, 'Profile updated').send(res);
});

const getMyDashboard = catchAsync(async (req, res) => {
  const creator = await CreatorProfile.findOne({ user: req.user._id });
  if (!creator) throw ApiError.notFound('Creator profile not found');

  const upcomingSessions = await Session.find({ creator: creator._id, isCompleted: false, isCancelled: false })
    .sort({ scheduledAt: 1 })
    .limit(10);

  const recentTransactions = await Transaction.find({ to: req.user._id, status: { $in: [TRANSACTION_STATUS.SUCCESS, TRANSACTION_STATUS.RELEASED] } })
    .sort({ createdAt: -1 })
    .limit(10);

  const earningsBreakdown = await Transaction.aggregate([
    { $match: { to: req.user._id, status: { $in: [TRANSACTION_STATUS.SUCCESS, TRANSACTION_STATUS.RELEASED] } } },
    { $group: { _id: '$type', total: { $sum: '$netAmount' } } },
  ]);

  return new ApiResponse(
    200,
    {
      creatorId: creator._id,
      stats: {
        totalEarnings: creator.totalEarnings,
        thisMonthEarnings: creator.thisMonthEarnings,
        followerCount: creator.followerCount,
        averageRating: creator.averageRating,
        reviewCount: creator.reviewCount,
        profileViews: creator.profileViews,
      },
      upcomingSessions,
      recentTransactions,
      earningsBreakdown,
    },
    'Dashboard data fetched'
  ).send(res);
});

const followCreator = catchAsync(async (req, res) => {
  const creator = await CreatorProfile.findById(req.params.id);
  if (!creator) throw ApiError.notFound('Creator not found');

  const alreadyFollowing = creator.followers.some((f) => f.equals(req.user._id));
  if (alreadyFollowing) {
    creator.followers.pull(req.user._id);
    creator.followerCount = Math.max(0, creator.followerCount - 1);
  } else {
    creator.followers.push(req.user._id);
    creator.followerCount += 1;
  }
  await creator.save();

  return new ApiResponse(200, { following: !alreadyFollowing }, alreadyFollowing ? 'Unfollowed' : 'Followed').send(res);
});

module.exports = { listCreators, getCreatorBySlug, getMyProfile, updateMyProfile, getMyDashboard, followCreator };