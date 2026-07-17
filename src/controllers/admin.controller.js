const {
  User,
  CreatorProfile,
  BrandProfile,
  Session,
  Campaign,
  Transaction,
  Review,
  Category,
} = require('../models');
const escrowService = require('../services/escrow.service');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');
const { VERIFICATION_STATUS, TRANSACTION_STATUS } = require('../constants/enums');

// ---------- Users ----------

const listUsers = catchAsync(async (req, res) => {
  const { role, search, page = 1, limit = 30 } = req.query;
  const filter = {};
  if (role) filter.role = role;
  if (search) filter.$or = [{ name: new RegExp(search, 'i') }, { email: new RegExp(search, 'i') }];

  const users = await User.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(Number(limit));
  const total = await User.countDocuments(filter);

  return new ApiResponse(200, { users, total, page: Number(page), pages: Math.ceil(total / limit) }, 'Users fetched').send(res);
});

const suspendUser = catchAsync(async (req, res) => {
  const { reason } = req.body;
  const user = await User.findByIdAndUpdate(req.params.id, { isSuspended: true, suspensionReason: reason || '' }, { new: true });
  if (!user) throw ApiError.notFound('User not found');
  return new ApiResponse(200, user, 'User suspended').send(res);
});

const reinstateUser = catchAsync(async (req, res) => {
  const user = await User.findByIdAndUpdate(req.params.id, { isSuspended: false, suspensionReason: '' }, { new: true });
  if (!user) throw ApiError.notFound('User not found');
  return new ApiResponse(200, user, 'User reinstated').send(res);
});

// ---------- Creator / Brand verification ----------

const listPendingVerifications = catchAsync(async (req, res) => {
  const pendingCreators = await CreatorProfile.find({ verificationStatus: VERIFICATION_STATUS.PENDING }).populate('user', 'name email avatarUrl');
  const pendingBrands = await BrandProfile.find({ verificationStatus: VERIFICATION_STATUS.PENDING }).populate('user', 'name email avatarUrl');

  return new ApiResponse(200, { pendingCreators, pendingBrands }, 'Pending verifications fetched').send(res);
});

const verifyCreator = catchAsync(async (req, res) => {
  const { decision } = req.body; // 'verified' | 'rejected'
  const creator = await CreatorProfile.findByIdAndUpdate(req.params.id, { verificationStatus: decision }, { new: true });
  if (!creator) throw ApiError.notFound('Creator not found');
  return new ApiResponse(200, creator, `Creator ${decision}`).send(res);
});

const verifyBrand = catchAsync(async (req, res) => {
  const { decision } = req.body;
  const brand = await BrandProfile.findByIdAndUpdate(req.params.id, { verificationStatus: decision }, { new: true });
  if (!brand) throw ApiError.notFound('Brand not found');
  return new ApiResponse(200, brand, `Brand ${decision}`).send(res);
});

// ---------- Content moderation ----------

const listAllSessions = catchAsync(async (req, res) => {
  const sessions = await Session.find().populate({ path: 'creator', populate: { path: 'user', select: 'name email' } }).sort({ createdAt: -1 }).limit(100);
  return new ApiResponse(200, sessions, 'Sessions fetched').send(res);
});

const removeSession = catchAsync(async (req, res) => {
  const session = await Session.findByIdAndUpdate(req.params.id, { isCancelled: true }, { new: true });
  if (!session) throw ApiError.notFound('Session not found');
  return new ApiResponse(200, null, 'Session removed').send(res);
});

const listAllCampaigns = catchAsync(async (req, res) => {
  const campaigns = await Campaign.find().populate({ path: 'brand', populate: { path: 'user', select: 'name email' } }).sort({ createdAt: -1 }).limit(100);
  return new ApiResponse(200, campaigns, 'Campaigns fetched').send(res);
});

const hideReview = catchAsync(async (req, res) => {
  const review = await Review.findByIdAndUpdate(req.params.id, { isHidden: true }, { new: true });
  if (!review) throw ApiError.notFound('Review not found');
  return new ApiResponse(200, null, 'Review hidden').send(res);
});

// ---------- Payments / Escrow / Disputes ----------

const listAllTransactions = catchAsync(async (req, res) => {
  const { type, status, page = 1, limit = 50 } = req.query;
  const filter = {};
  if (type) filter.type = type;
  if (status) filter.status = status;

  const transactions = await Transaction.find(filter)
    .populate('from', 'name email')
    .populate('to', 'name email')
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(Number(limit));

  const total = await Transaction.countDocuments(filter);

  return new ApiResponse(200, { transactions, total, page: Number(page), pages: Math.ceil(total / limit) }, 'Transactions fetched').send(res);
});

const listDisputedEscrows = catchAsync(async (req, res) => {
  const disputed = await Campaign.find({ status: 'disputed' }).populate('brand assignedCreator');
  return new ApiResponse(200, disputed, 'Disputed campaigns fetched').send(res);
});

/** Admin manually releases escrow — e.g. dispute resolved in the creator's favor */
const adminReleaseEscrow = catchAsync(async (req, res) => {
  const transaction = await escrowService.releaseEscrow({ campaignId: req.params.campaignId, releasedByUserId: req.user._id });
  return new ApiResponse(200, transaction, 'Escrow released by admin').send(res);
});

/** Admin manually refunds escrow — e.g. dispute resolved in the brand's favor */
const adminRefundEscrow = catchAsync(async (req, res) => {
  const transaction = await escrowService.refundEscrow({ campaignId: req.params.campaignId, refundedByUserId: req.user._id });
  return new ApiResponse(200, transaction, 'Escrow refunded by admin').send(res);
});

// ---------- Analytics ----------

const getAnalyticsOverview = catchAsync(async (req, res) => {
  const [totalUsers, totalCreators, totalBrands, totalSessions, totalCampaigns] = await Promise.all([
    User.countDocuments(),
    CreatorProfile.countDocuments(),
    BrandProfile.countDocuments(),
    Session.countDocuments(),
    Campaign.countDocuments(),
  ]);

  const revenueAgg = await Transaction.aggregate([
    { $match: { status: { $in: [TRANSACTION_STATUS.SUCCESS, TRANSACTION_STATUS.RELEASED] } } },
    { $group: { _id: null, totalRevenue: { $sum: '$amount' }, totalPlatformCommission: { $sum: '$platformCommission' } } },
  ]);

  const escrowAgg = await Transaction.aggregate([
    { $match: { status: TRANSACTION_STATUS.IN_ESCROW } },
    { $group: { _id: null, totalInEscrow: { $sum: '$amount' } } },
  ]);

  const monthlyRevenue = await Transaction.aggregate([
    { $match: { status: { $in: [TRANSACTION_STATUS.SUCCESS, TRANSACTION_STATUS.RELEASED] } } },
    {
      $group: {
        _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } },
        total: { $sum: '$amount' },
      },
    },
    { $sort: { '_id.year': 1, '_id.month': 1 } },
    { $limit: 12 },
  ]);

  return new ApiResponse(
    200,
    {
      totalUsers,
      totalCreators,
      totalBrands,
      totalSessions,
      totalCampaigns,
      totalRevenue: revenueAgg[0]?.totalRevenue || 0,
      totalPlatformCommission: revenueAgg[0]?.totalPlatformCommission || 0,
      totalInEscrow: escrowAgg[0]?.totalInEscrow || 0,
      monthlyRevenue,
    },
    'Analytics fetched'
  ).send(res);
});

// ---------- Categories ----------

const createCategory = catchAsync(async (req, res) => {
  const { label, icon } = req.body;
  const slugify = require('../utils/slugify');
  const category = await Category.create({ label, icon, slug: slugify(label) });
  return new ApiResponse(201, category, 'Category created').send(res);
});

const updateCategory = catchAsync(async (req, res) => {
  const category = await Category.findByIdAndUpdate(req.params.id, req.body, { new: true });
  if (!category) throw ApiError.notFound('Category not found');
  return new ApiResponse(200, category, 'Category updated').send(res);
});

const deleteCategory = catchAsync(async (req, res) => {
  await Category.findByIdAndUpdate(req.params.id, { isActive: false });
  return new ApiResponse(200, null, 'Category removed').send(res);
});

module.exports = {
  listUsers,
  suspendUser,
  reinstateUser,
  listPendingVerifications,
  verifyCreator,
  verifyBrand,
  listAllSessions,
  removeSession,
  listAllCampaigns,
  hideReview,
  listAllTransactions,
  listDisputedEscrows,
  adminReleaseEscrow,
  adminRefundEscrow,
  getAnalyticsOverview,
  createCategory,
  updateCategory,
  deleteCategory,
};
