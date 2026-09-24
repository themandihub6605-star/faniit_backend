const { CreatorProfile, Session, Booking, Transaction, Review, UserSubscription } = require('../models');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');
const { ROLES, TRANSACTION_TYPE, TRANSACTION_STATUS } = require('../constants/enums');
const { VERIFICATION_STATUS } = require('../constants/enums');
const notificationService = require('../services/notification.service');

const listCreators = catchAsync(async (req, res) => {
  const { category, location, minFollowers, search, page = 1, limit = 20 } = req.query;

  const filter = { verificationStatus: { $ne: 'rejected' } };
  if (category) filter.category = category;
  if (location) filter.location = new RegExp(location, 'i');
  if (minFollowers) filter.followerCount = { $gte: Number(minFollowers) };
  if (search) {
    const escaped = String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(escaped, 'i');
    filter.$or = [{ bio: pattern }, { title: pattern }, { skills: pattern }, { location: pattern }];
  }

  const creators = await CreatorProfile.find(filter)
    .populate('user', 'name avatarUrl')
    .populate('category', 'label icon')
    .sort({ followerCount: -1 })
    .skip((page - 1) * limit)
    .limit(Number(limit));

  const creatorIds = creators.map((c) => c._id);
  const completedCounts = await Session.aggregate([
    { $match: { creator: { $in: creatorIds }, isCompleted: true } },
    { $group: { _id: '$creator', count: { $sum: 1 } } },
  ]);
  const countMap = new Map(completedCounts.map((c) => [String(c._id), c.count]));

  const userIds = creators.map((c) => c.user?._id).filter(Boolean);
  const subs = await UserSubscription.find({ user: { $in: userIds } }).populate('plan', 'name price');
  const planMap = new Map(subs.map((s) => [String(s.user), s.plan]));

  const creatorsWithStats = creators
    // Never recommend a logged-in user to follow their own creator profile.
    .filter((c) => !(req.user && c.user?._id?.equals(req.user._id)))
    .map((c) => {
      const plan = planMap.get(String(c.user?._id));
      // Tell the frontend the real follow state, instead of it starting
      // from an empty Set and guessing purely from clicks.
      const isFollowing = !!(req.user && c.followers.some((f) => f.equals(req.user._id)));
      return {
        ...c.toObject(),
        projectsCompletedCount: countMap.get(String(c._id)) || 0,
        planName: plan ? plan.name : 'Lite',
        isProPlan: plan ? plan.price > 0 : false,
        isFollowing,
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
    .populate('user', 'name avatarUrl')
    .populate('category', 'label icon');

  if (!creator) throw ApiError.notFound('Creator not found');

  const sessions = await Session.find({ creator: creator._id, isCancelled: false, isCompleted: false }).sort({ scheduledAt: 1 });
  const reviews = await Review.find({ toUser: creator.user._id, isHidden: false }).sort({ createdAt: -1 }).limit(10);

  const projectsCompletedCount = await Session.countDocuments({ creator: creator._id, isCompleted: true });

  const sub = await UserSubscription.findOne({ user: creator.user._id }).populate('plan', 'name price');
  const creatorWithPlan = {
    ...creator.toObject(),
    planName: sub ? sub.plan.name : 'Lite',
    isProPlan: sub ? sub.plan.price > 0 : false,
  };

  const isFollowing = !!(req.user && creator.followers.some((f) => f.equals(req.user._id)));

  return new ApiResponse(
    200,
    { creator: { ...creatorWithPlan, isFollowing }, sessions, reviews, stats: { projectsCompletedCount } },
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

  if (submitForApproval && [VERIFICATION_STATUS.UNVERIFIED, VERIFICATION_STATUS.REJECTED].includes(creator.verificationStatus)) {
    creator.verificationStatus = VERIFICATION_STATUS.PENDING;
    creator.rejectionReason = '';
  }

  await creator.save();
  return new ApiResponse(200, creator, 'Profile updated').send(res);
});

const getMyDashboard = catchAsync(async (req, res) => {
  const creator = await CreatorProfile.findOne({ user: req.user._id });
  if (!creator) throw ApiError.notFound('Creator profile not found');

  const upcomingSessions = await Session.find({ creator: creator._id, isCompleted: false, isCancelled: false })
    .select('+zoomStartUrl +zoomJoinUrl')
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

  if (creator.user.equals(req.user._id)) throw ApiError.badRequest("You can't follow yourself");

  const alreadyFollowing = creator.followers.some((f) => f.equals(req.user._id));
  if (alreadyFollowing) {
    creator.followers.pull(req.user._id);
    creator.followerCount = Math.max(0, creator.followerCount - 1);
  } else {
    creator.followers.push(req.user._id);
    creator.followerCount += 1;

    await notificationService.notify({
      userId: creator.user,
      fromUser: req.user._id,
      type: 'follow',
      relatedModel: 'User',
      relatedId: req.user._id,
      title: 'New follower',
      message: `${req.user.name} started following you`,
    });
  }
  await creator.save();

  return new ApiResponse(200, { following: !alreadyFollowing, followerCount: creator.followerCount }, alreadyFollowing ? 'Unfollowed' : 'Followed').send(res);
});

module.exports = { listCreators, getCreatorBySlug, getMyProfile, updateMyProfile, getMyDashboard, followCreator };