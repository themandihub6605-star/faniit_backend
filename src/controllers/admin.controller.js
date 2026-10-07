const {
  User,
  CreatorProfile,
  BrandProfile,
  AgencyProfile,
  Session,
  Campaign,
  Transaction,
  Review,
  Category,
  ReferralConfig,
  Withdrawal,
  SiteSettings,
  Notification,
  SubscriptionPlan,
  UserSubscription,
  Milestone,
  Post,
} = require('../models');
const escrowService = require('../services/escrow.service');
const subscriptionService = require('../services/subscription.service');
const { sendAccountApprovedEmail, sendAccountRejectedEmail, sendWithdrawalCompletedEmail, sendWithdrawalRejectedEmail } = require('../services/email.service');
const { alertUser } = require('../services/alert.service');
const profileCheck = require('../services/profileCompleteness.service');
const generateSlug = require('../utils/slugify');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');
const { VERIFICATION_STATUS, TRANSACTION_STATUS, ROLES, SUBSCRIPTION_STATUS } = require('../constants/enums');

// Agency profiles reuse their owner's 8-character user referral code.

/** Amounts are stored in paise. */
function rupees(paise) {
  return `₹${(Number(paise || 0) / 100).toLocaleString('en-IN')}`;
}

// ---------- Users ----------

const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Midnight today in India (IST), as a UTC Date. */
function startOfTodayIST() {
  const IST = 5.5 * 60 * 60 * 1000;
  const now = new Date(Date.now() + IST);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - IST);
}

const DAY = 24 * 60 * 60 * 1000;

/** GET /api/admin/users
 *  ?role= &search= (name, email or phone)
 *  &profile= incomplete | unverified | pending | rejected | verified
 *  &joined= today | 7d | 30d
 *  &provider= google | local
 *  Each row also carries `profileSummary` (status, missing fields, %). */
const listUsers = catchAsync(async (req, res) => {
  const { role, search, profile, joined, provider } = req.query;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));

  const filter = {};
  if (role) filter.role = role;
  if (provider === 'google' || provider === 'local') filter.authProvider = provider === 'local' ? { $ne: 'google' } : 'google';
  if (search && String(search).trim()) {
    const rx = new RegExp(escapeRegex(String(search).trim()), 'i');
    filter.$or = [{ name: rx }, { email: rx }, { phone: rx }];
  }
  if (joined === 'today') filter.createdAt = { $gte: startOfTodayIST() };
  else if (joined === '7d') filter.createdAt = { $gte: new Date(Date.now() - 7 * DAY) };
  else if (joined === '30d') filter.createdAt = { $gte: new Date(Date.now() - 30 * DAY) };

  if (profile) {
    const ids =
      profile === 'incomplete'
        ? await profileCheck.incompleteUserIds(role)
        : Object.values(VERIFICATION_STATUS).includes(profile)
          ? await profileCheck.userIdsWithStatus(profile, role)
          : null;
    if (ids) filter._id = { $in: ids };
  }

  const [users, total] = await Promise.all([
    User.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    User.countDocuments(filter),
  ]);
  const summaries = await profileCheck.summarize(users);
  const rows = users.map((u) => ({ ...u.toObject(), profileSummary: summaries[String(u._id)] ?? null }));

  return new ApiResponse(200, { users: rows, total, page, pages: Math.max(1, Math.ceil(total / limit)) }, 'Users fetched').send(res);
});

/** GET /api/admin/users/stats — numbers for the cards on the Users page. */
const getUserStats = catchAsync(async (req, res) => {
  const today = startOfTodayIST();
  const week = new Date(Date.now() - 7 * DAY);
  const month = new Date(Date.now() - 30 * DAY);

  const [total, newToday, new7d, new30d, activeToday, suspended, google, byRoleRows, incompleteIds, pending, changesRequested, unverified] =
    await Promise.all([
      User.countDocuments({}),
      User.countDocuments({ createdAt: { $gte: today } }),
      User.countDocuments({ createdAt: { $gte: week } }),
      User.countDocuments({ createdAt: { $gte: month } }),
      User.countDocuments({ lastLoginAt: { $gte: today } }),
      User.countDocuments({ isSuspended: true }),
      User.countDocuments({ authProvider: 'google' }),
      User.aggregate([{ $group: { _id: '$role', count: { $sum: 1 } } }]),
      profileCheck.incompleteUserIds(),
      profileCheck.userIdsWithStatus(VERIFICATION_STATUS.PENDING),
      profileCheck.userIdsWithStatus(VERIFICATION_STATUS.REJECTED),
      profileCheck.userIdsWithStatus(VERIFICATION_STATUS.UNVERIFIED),
    ]);

  const byRole = Object.fromEntries(byRoleRows.map((r) => [r._id || 'unknown', r.count]));
  return new ApiResponse(
    200,
    {
      total,
      newToday,
      new7d,
      new30d,
      activeToday,
      suspended,
      google,
      email: total - google,
      byRole,
      incompleteProfiles: incompleteIds.length,
      pendingReview: pending.length,
      changesRequested: changesRequested.length,
      notSubmitted: unverified.length,
    },
    'User stats'
  ).send(res);
});

/** Locks one creator / brand / agency into "update your profile" — the app
 * shows the changes screen with the note until they resubmit and an admin
 * approves again. Returns false when the user has no reviewed profile. */
async function askToUpdate(user, note, adminId) {
  if (!profileCheck.hasReviewedProfile(user.role)) return false;
  const Model = profileCheck.PROFILE_MODEL[user.role];
  let profile = await Model.findOne({ user: user._id });
  if (!profile) return false;

  const missing = profileCheck.missingFields(user, profile.toObject());
  const reason =
    (note && String(note).trim()) ||
    (missing.length ? `Please complete your profile: ${missing.join(', ')}.` : 'Please review your profile details and submit them again.');

  profile.verificationStatus = VERIFICATION_STATUS.REJECTED;
  profile.rejectionReason = reason.slice(0, 500);
  await profile.save({ validateBeforeSave: false });

  alertUser({
    userId: user._id,
    fromUser: adminId,
    type: 'account_update',
    title: 'Please update your profile',
    message: `${reason} Open Fanitt, update your details and submit them for review.`,
    relatedModel: 'User',
    relatedId: user._id,
    email: {
      to: user.email,
      name: user.name,
      subject: 'Action needed: update your Fanitt profile',
      heading: 'Please update your profile',
      body: 'To keep your account active, please update your profile details in the Fanitt app and submit them for review.',
      reason,
      reasonLabel: 'What to update',
      ctaLabel: 'Update my profile',
      tone: 'info',
    },
  });
  return true;
}

/** POST /api/admin/users/:id/request-profile-update  { note? } */
const requestProfileUpdate = catchAsync(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) throw ApiError.notFound('User not found');
  if (!profileCheck.hasReviewedProfile(user.role)) throw ApiError.badRequest('Only creators, brands and agencies have a profile to update.');
  const ok = await askToUpdate(user, req.body?.note, req.user._id);
  if (!ok) throw ApiError.badRequest('This user has not set up a profile yet.');
  const summaries = await profileCheck.summarize([user]);
  return new ApiResponse(200, { ...user.toObject(), profileSummary: summaries[String(user._id)] }, 'User asked to update their profile').send(res);
});

/** POST /api/admin/users/request-profile-update
 *  { userIds: [...], note? }  or  { allIncomplete: true, role?, note? } */
const requestProfileUpdateBulk = catchAsync(async (req, res) => {
  const { userIds, allIncomplete, role, note } = req.body || {};
  let ids = [];
  if (allIncomplete) ids = await profileCheck.incompleteUserIds(role || undefined);
  else if (Array.isArray(userIds)) ids = userIds.map(String);
  if (!ids.length) throw ApiError.badRequest('No users selected.');
  if (ids.length > 2000) throw ApiError.badRequest('Too many users at once — narrow it down to 2,000 or fewer.');

  const users = await User.find({ _id: { $in: ids }, role: { $in: Object.keys(profileCheck.PROFILE_MODEL) } });
  let updated = 0;
  for (const user of users) {
    // eslint-disable-next-line no-await-in-loop
    if (await askToUpdate(user, note, req.user._id)) updated += 1;
  }
  return new ApiResponse(200, { requested: ids.length, updated, skipped: ids.length - updated }, `${updated} user${updated === 1 ? '' : 's'} asked to update their profile`).send(res);
});

/** GET /api/admin/users/:id — everything about one user in one call: their
 * account, role-specific profile (Creator/Brand/Agency), recent wallet
 * transactions, and reviews they've received. Built for a detail view so
 * Admin doesn't have to jump between separate lists to understand one user. */
const getUserDetail = catchAsync(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) throw ApiError.notFound('User not found');

  let roleProfile = null;
  let posts = [];
  if (user.role === ROLES.CREATOR) {
    roleProfile = await CreatorProfile.findOne({ user: user._id }).populate('category', 'label');
    // Point-Fix: was never fetched, so the admin User Detail page had no
    // way to show a creator's posts at all — Bug 2 in the current fix
    // round. Only queried for creators, since only they have posts.
    if (roleProfile) {
      posts = await Post.find({ creator: roleProfile._id }).sort({ createdAt: -1 });
    }
  } else if (user.role === ROLES.BRAND) {
    roleProfile = await BrandProfile.findOne({ user: user._id });
  } else if (user.role === ROLES.AGENCY) {
    roleProfile = await AgencyProfile.findOne({ user: user._id });
  }

  const [transactions, reviews, referredCount] = await Promise.all([
    Transaction.find({ $or: [{ from: user._id }, { to: user._id }] }).sort({ createdAt: -1 }).limit(20),
    Review.find({ toUser: user._id, isHidden: false }).sort({ createdAt: -1 }).limit(10).populate('fromUser', 'name'),
    User.countDocuments({ referredBy: user._id }),
  ]);

  return new ApiResponse(
    200,
    { user, roleProfile, posts, transactions, reviews, referredCount },
    'User detail fetched'
  ).send(res);
});

const suspendUser = catchAsync(async (req, res) => {
  const { reason } = req.body;
  const user = await User.findByIdAndUpdate(req.params.id, { isSuspended: true, suspensionReason: reason || '' }, { new: true });
  if (!user) throw ApiError.notFound('User not found');

  alertUser({
    userId: user._id,
    fromUser: req.user._id,
    type: 'account_update',
    title: 'Your Fanitt account has been suspended',
    message: reason ? `Your account was suspended: ${reason}` : 'Your account was suspended. Contact support for help.',
    relatedModel: 'User',
    relatedId: user._id,
    email: {
      body: 'Your Fanitt account has been suspended, so you can’t log in or use Fanitt for now. If you think this is a mistake, reply to this email or write to support.',
      reason,
      reasonLabel: 'Reason',
      tone: 'danger',
      ctaUrl: null,
    },
  });

  return new ApiResponse(200, user, 'User suspended').send(res);
});


const reinstateUser = catchAsync(async (req, res) => {
  const user = await User.findByIdAndUpdate(req.params.id, { isSuspended: false, suspensionReason: '' }, { new: true });
  if (!user) throw ApiError.notFound('User not found');

  alertUser({
    userId: user._id,
    fromUser: req.user._id,
    type: 'account_update',
    title: 'Your Fanitt account is active again',
    message: 'Your account has been reinstated. You can log in and use Fanitt as before.',
    relatedModel: 'User',
    relatedId: user._id,
    email: { tone: 'success', ctaUrl: 'https://fanitt.com/login', ctaLabel: 'Log in' },
  });

  return new ApiResponse(200, user, 'User reinstated').send(res);
});

// ---------- Creator / Brand verification ----------

const listPendingVerifications = catchAsync(async (req, res) => {
  const pendingCreators = await CreatorProfile.find({ verificationStatus: VERIFICATION_STATUS.PENDING })
    .populate('user', 'name email phone avatarUrl')
    .populate('category', 'label');
  const pendingBrands = await BrandProfile.find({ verificationStatus: VERIFICATION_STATUS.PENDING }).populate('user', 'name email phone avatarUrl');

  return new ApiResponse(200, { pendingCreators, pendingBrands }, 'Pending verifications fetched').send(res);
});

const verifyCreator = catchAsync(async (req, res) => {
  const { decision, rejectionReason } = req.body; // 'verified' | 'rejected'
  const creator = await CreatorProfile.findByIdAndUpdate(
    req.params.id,
    { verificationStatus: decision, rejectionReason: decision === 'rejected' ? rejectionReason || '' : '' },
    { new: true }
  ).populate('user', '_id name email');
  if (!creator) throw ApiError.notFound('Creator not found');

  if (creator.user?.email) {
    if (decision === VERIFICATION_STATUS.VERIFIED) {
      sendAccountApprovedEmail({ to: creator.user.email, name: creator.user.name, role: 'creator' });
    } else if (decision === VERIFICATION_STATUS.REJECTED) {
      sendAccountRejectedEmail({ to: creator.user.email, name: creator.user.name, role: 'creator', reason: rejectionReason });
    }
  }
  if (creator.user?._id) {
    const approved = decision === VERIFICATION_STATUS.VERIFIED;
    const rejected = decision === VERIFICATION_STATUS.REJECTED;
    if (approved || rejected) {
      alertUser({
        userId: creator.user._id,
        fromUser: req.user._id,
        type: approved ? 'account_verified' : 'account_update',
        title: approved ? 'Your creator profile is approved 🎉' : 'Your creator profile needs changes',
        message: approved
          ? 'Your dashboard is fully unlocked. Start exploring Fanitt now.'
          : `Your profile wasn’t approved${rejectionReason ? `: ${rejectionReason}` : ''}. Update your details and submit again.`,
        relatedModel: 'User',
        relatedId: creator.user._id,
      });
    }
  }

  return new ApiResponse(200, creator, `Creator ${decision}`).send(res);
});

const verifyBrand = catchAsync(async (req, res) => {
  const { decision, rejectionReason } = req.body;
  const brand = await BrandProfile.findByIdAndUpdate(
    req.params.id,
    { verificationStatus: decision, rejectionReason: decision === 'rejected' ? rejectionReason || '' : '' },
    { new: true }
  ).populate('user', '_id name email');
  if (!brand) throw ApiError.notFound('Brand not found');

  if (brand.user?.email) {
    if (decision === VERIFICATION_STATUS.VERIFIED) {
      sendAccountApprovedEmail({ to: brand.user.email, name: brand.user.name, role: 'brand' });
    } else if (decision === VERIFICATION_STATUS.REJECTED) {
      sendAccountRejectedEmail({ to: brand.user.email, name: brand.user.name, role: 'brand', reason: rejectionReason });
    }
  }
  if (brand.user?._id) {
    const approved = decision === VERIFICATION_STATUS.VERIFIED;
    const rejected = decision === VERIFICATION_STATUS.REJECTED;
    if (approved || rejected) {
      alertUser({
        userId: brand.user._id,
        fromUser: req.user._id,
        type: approved ? 'account_verified' : 'account_update',
        title: approved ? 'Your brand profile is approved 🎉' : 'Your brand profile needs changes',
        message: approved
          ? 'Your dashboard is fully unlocked. Start exploring Fanitt now.'
          : `Your profile wasn’t approved${rejectionReason ? `: ${rejectionReason}` : ''}. Update your details and submit again.`,
        relatedModel: 'User',
        relatedId: brand.user._id,
      });
    }
  }

  return new ApiResponse(200, brand, `Brand ${decision}`).send(res);
});

// ---------- Agency approval ----------

const createAgency = catchAsync(async (req, res) => {
  const { agencyName, ownerName, email, password, mobile, city, state, commissionPercent } = req.body;

  if (!agencyName || !email || !password) {
    throw ApiError.badRequest('agencyName, email and password are required');
  }
  if (password.length < 8) throw ApiError.badRequest('Password must be at least 8 characters');

  const existing = await User.findOne({ email });
  if (existing) throw ApiError.conflict('An account with this email already exists');

  const user = await User.create({
    name: ownerName || agencyName,
    email,
    password,
    role: ROLES.AGENCY,
    roles: [ROLES.AGENCY],
    isEmailVerified: true,
  });

  const agency = await AgencyProfile.create({
    user: user._id,
    agencyName,
    ownerName: ownerName || '',
    mobile: mobile || '',
    city: city || '',
    state: state || '',
    commissionPercent: commissionPercent !== undefined ? commissionPercent : 5,
    referralCode: user.referralCode,
    verificationStatus: VERIFICATION_STATUS.VERIFIED,
  });

  return new ApiResponse(
    201,
    { user: user.toSafeObject(), agency },
    'Agency account created — share these credentials with them so they can log in and change their password'
  ).send(res);
});

const listAgencies = catchAsync(async (req, res) => {
  const { status } = req.query;
  const filter = {};
  if (status) filter.verificationStatus = status;

  const agencies = await AgencyProfile.find(filter).populate('user', 'name email avatarUrl').sort({ createdAt: -1 });
  return new ApiResponse(200, agencies, 'Agencies fetched').send(res);
});

const setAgencyPassword = catchAsync(async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 8) throw ApiError.badRequest('Password must be at least 8 characters');

  const agency = await AgencyProfile.findById(req.params.id).populate('user');
  if (!agency) throw ApiError.notFound('Agency not found');
  if (!agency.user) throw ApiError.notFound('This agency has no linked user account');

  agency.user.password = password;
  await agency.user.save();

  return new ApiResponse(
    200,
    { email: agency.user.email, password },
    'Password set — share this email and password with the agency to log into the Agency Panel'
  ).send(res);
});

const verifyAgency = catchAsync(async (req, res) => {
  const { decision, rejectionReason } = req.body;

  const agency = await AgencyProfile.findByIdAndUpdate(
    req.params.id,
    { verificationStatus: decision, rejectionReason: decision === 'rejected' ? rejectionReason || '' : '' },
    { new: true }
  ).populate('user', '_id name email');
  if (!agency) throw ApiError.notFound('Agency not found');

  if (agency.user?.email) {
    if (decision === VERIFICATION_STATUS.VERIFIED) {
      sendAccountApprovedEmail({ to: agency.user.email, name: agency.user.name, role: 'agency' });
    } else if (decision === VERIFICATION_STATUS.REJECTED) {
      sendAccountRejectedEmail({ to: agency.user.email, name: agency.user.name, role: 'agency', reason: rejectionReason });
    }
  }
  if (agency.user?._id) {
    const approved = decision === VERIFICATION_STATUS.VERIFIED;
    const rejected = decision === VERIFICATION_STATUS.REJECTED;
    if (approved || rejected) {
      alertUser({
        userId: agency.user._id,
        fromUser: req.user._id,
        type: approved ? 'account_verified' : 'account_update',
        title: approved ? 'Your agency profile is approved 🎉' : 'Your agency profile needs changes',
        message: approved
          ? 'Your dashboard is fully unlocked. Start exploring Fanitt now.'
          : `Your profile wasn’t approved${rejectionReason ? `: ${rejectionReason}` : ''}. Update your details and submit again.`,
        relatedModel: 'User',
        relatedId: agency.user._id,
      });
    }
  }

  return new ApiResponse(200, agency, `Agency ${decision}`).send(res);
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

const listAllReviews = catchAsync(async (req, res) => {
  const { flaggedOnly } = req.query;
  const filter = flaggedOnly === 'true' ? { isFlagged: true, isHidden: false } : { isHidden: false };
  const reviews = await Review.find(filter)
    .populate('fromUser', 'name email')
    .populate('toUser', 'name email')
    .sort({ createdAt: -1 })
    .limit(100);
  return new ApiResponse(200, reviews, 'Reviews fetched').send(res);
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

const adminReleaseEscrow = catchAsync(async (req, res) => {
  const transaction = await escrowService.releaseEscrow({ campaignId: req.params.campaignId, releasedByUserId: req.user._id });
  return new ApiResponse(200, transaction, 'Escrow released by admin').send(res);
});

const adminRefundEscrow = catchAsync(async (req, res) => {
  const transaction = await escrowService.refundEscrow({ campaignId: req.params.campaignId, refundedByUserId: req.user._id });
  return new ApiResponse(200, transaction, 'Escrow refunded by admin').send(res);
});

// ---------- Milestones (NEW) — Point-Fix: no admin-wide view of milestone
// status existed anywhere before this; only per-campaign detail (brand
// side) and per-dispute detail (AdminEscrowDisputes) were visible. This
// gives Admin a single list of every milestone platform-wide, with a
// status breakdown, so "how many are funded / awaiting review / stuck"
// is answerable without opening every campaign one by one. ----------

/** GET /api/admin/milestones?status=... — every milestone across every
 * campaign, newest first, with enough brand/creator/campaign context to
 * be useful without extra lookups. Also returns a count-by-status summary
 * (computed independently of the `status` filter, so the tab badges
 * always show the platform-wide totals even while one tab is filtered). */
const listAllMilestones = catchAsync(async (req, res) => {
  const { status, page = 1, limit = 50 } = req.query;
  const filter = {};
  if (status) filter.status = status;

  const [milestones, total, statusCounts] = await Promise.all([
    Milestone.find(filter)
      .populate({
        path: 'campaign',
        select: 'title brand',
        populate: { path: 'brand', select: 'companyName user', populate: { path: 'user', select: 'name email' } },
      })
      .populate({
        path: 'creator',
        select: 'slug user',
        populate: { path: 'user', select: 'name email' },
      })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit)),
    Milestone.countDocuments(filter),
    Milestone.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
  ]);

  const countsByStatus = statusCounts.reduce((acc, c) => {
    acc[c._id] = c.count;
    return acc;
  }, {});

  return new ApiResponse(
    200,
    { milestones, total, page: Number(page), pages: Math.ceil(total / limit), countsByStatus },
    'Milestones fetched'
  ).send(res);
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

  const activeSubscriptionsAgg = await UserSubscription.aggregate([
    { $match: { status: SUBSCRIPTION_STATUS.ACTIVE } },
    { $lookup: { from: 'subscriptionplans', localField: 'plan', foreignField: '_id', as: 'planDoc' } },
    { $unwind: '$planDoc' },
    { $match: { 'planDoc.price': { $gt: 0 } } },
    { $group: { _id: '$planDoc.name', count: { $sum: 1 } } },
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
      activeSubscriptionsByPlan: activeSubscriptionsAgg,
    },
    'Analytics fetched'
  ).send(res);
});

// ---------- Categories ----------

const listCategoriesAdmin = catchAsync(async (req, res) => {
  const categories = await Category.find().sort({ label: 1 });
  return new ApiResponse(200, categories, 'Categories fetched').send(res);
});

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

// ---------- Referral commission configuration ----------

const getReferralConfig = catchAsync(async (req, res) => {
  const config = await ReferralConfig.getSingleton();
  return new ApiResponse(200, config, 'Referral config fetched').send(res);
});

const updateReferralConfig = catchAsync(async (req, res) => {
  const { agentToAgentPercent, agentToBrandOrCreatorPercent, creatorToCreatorPercent, creatorToBrandPercent } = req.body;
  const config = await ReferralConfig.getSingleton();

  if (agentToAgentPercent !== undefined) config.agentToAgentPercent = agentToAgentPercent;
  if (agentToBrandOrCreatorPercent !== undefined) config.agentToBrandOrCreatorPercent = agentToBrandOrCreatorPercent;
  if (creatorToCreatorPercent !== undefined) config.creatorToCreatorPercent = creatorToCreatorPercent;
  if (creatorToBrandPercent !== undefined) config.creatorToBrandPercent = creatorToBrandPercent;

  await config.save();
  return new ApiResponse(200, config, 'Referral config updated').send(res);
});

// ---------- Withdrawal requests ----------

const listWithdrawals = catchAsync(async (req, res) => {
  const { status } = req.query;
  const filter = status ? { status } : {};
  const withdrawals = await Withdrawal.find(filter).populate('user', 'name email role').sort({ createdAt: -1 });
  return new ApiResponse(200, withdrawals, 'Withdrawals fetched').send(res);
});

const markWithdrawalProcessing = catchAsync(async (req, res) => {
  const withdrawal = await Withdrawal.findById(req.params.id);
  if (!withdrawal) throw ApiError.notFound('Withdrawal not found');
  if (withdrawal.status !== 'initiated') throw ApiError.badRequest(`This withdrawal is already ${withdrawal.status}`);

  withdrawal.status = 'processing';
  withdrawal.processedBy = req.user._id;
  await withdrawal.save();

  alertUser({
    userId: withdrawal.user,
    fromUser: req.user._id,
    type: 'withdrawal_update',
    title: 'Your withdrawal is being processed',
    message: `We're sending ${rupees(withdrawal.netPayoutAmount || withdrawal.amount)} to your account. You'll be notified once it's paid.`,
    relatedModel: 'Withdrawal',
    relatedId: withdrawal._id,
  });

  return new ApiResponse(200, withdrawal, 'Withdrawal marked as processing').send(res);
});

const markWithdrawalPaid = catchAsync(async (req, res) => {
  const withdrawal = await Withdrawal.findById(req.params.id).populate('user', 'name email');
  if (!withdrawal) throw ApiError.notFound('Withdrawal not found');
  if (!['initiated', 'processing'].includes(withdrawal.status)) {
    throw ApiError.badRequest(`This withdrawal is already ${withdrawal.status}`);
  }

  withdrawal.status = 'completed';
  withdrawal.processedBy = req.user._id;
  withdrawal.processedAt = new Date();
  await withdrawal.save();

  if (withdrawal.user?.email) {
    sendWithdrawalCompletedEmail({
      to: withdrawal.user.email,
      name: withdrawal.user.name,
      netAmount: withdrawal.netPayoutAmount,
      payoutMethod: withdrawal.payoutMethod,
    });
  }
  alertUser({
    userId: withdrawal.user?._id,
    fromUser: req.user._id,
    type: 'payout_released',
    title: 'Withdrawal paid 💸',
    message: `${rupees(withdrawal.netPayoutAmount || withdrawal.amount)} has been sent to your ${withdrawal.payoutMethod === 'upi' ? 'UPI' : 'bank account'}.`,
    relatedModel: 'Withdrawal',
    relatedId: withdrawal._id,
  });

  return new ApiResponse(200, withdrawal, 'Withdrawal marked as completed').send(res);
});

const rejectWithdrawal = catchAsync(async (req, res) => {
  const { reason } = req.body;
  const withdrawal = await Withdrawal.findById(req.params.id).populate('user', 'name email');
  if (!withdrawal) throw ApiError.notFound('Withdrawal not found');
  if (!['initiated', 'processing'].includes(withdrawal.status)) {
    throw ApiError.badRequest(`This withdrawal is already ${withdrawal.status}`);
  }

  withdrawal.status = 'rejected';
  withdrawal.adminNote = reason || '';
  withdrawal.processedBy = req.user._id;
  withdrawal.processedAt = new Date();
  await withdrawal.save();

  await User.findByIdAndUpdate(withdrawal.user._id, { $inc: { walletBalance: withdrawal.amount } });

  if (withdrawal.user?.email) {
    sendWithdrawalRejectedEmail({
      to: withdrawal.user.email,
      name: withdrawal.user.name,
      amount: withdrawal.amount,
      reason,
    });
  }
  alertUser({
    userId: withdrawal.user?._id,
    fromUser: req.user._id,
    type: 'withdrawal_update',
    title: 'Withdrawal rejected',
    message: `${rupees(withdrawal.amount)} is back in your wallet${reason ? `. Reason: ${reason}` : ''}.`,
    relatedModel: 'Withdrawal',
    relatedId: withdrawal._id,
  });

  return new ApiResponse(200, withdrawal, 'Withdrawal rejected and refunded to wallet').send(res);
});

// ---------- Site settings ----------

const getSiteSettings = catchAsync(async (req, res) => {
  const settings = await SiteSettings.getSingleton();
  return new ApiResponse(200, settings, 'Site settings fetched').send(res);
});

const updateSiteSettings = catchAsync(async (req, res) => {
  const { platformCommissionPercent, supportEmail, maintenanceMode, maintenanceMessage, homepageBannerText, creatorEarlyAccessHours } = req.body;
  const settings = await SiteSettings.getSingleton();

  if (platformCommissionPercent !== undefined) settings.platformCommissionPercent = platformCommissionPercent;
  if (supportEmail !== undefined) settings.supportEmail = supportEmail;
  if (maintenanceMode !== undefined) settings.maintenanceMode = maintenanceMode;
  if (maintenanceMessage !== undefined) settings.maintenanceMessage = maintenanceMessage;
  if (homepageBannerText !== undefined) settings.homepageBannerText = homepageBannerText;
  if (creatorEarlyAccessHours !== undefined) settings.creatorEarlyAccessHours = creatorEarlyAccessHours;
  if (req.body.minCampaignBudget !== undefined) {
    const value = Number(req.body.minCampaignBudget);
    if (!Number.isFinite(value) || value < 0) throw ApiError.badRequest('Minimum campaign budget must be 0 or more');
    settings.minCampaignBudget = Math.round(value);
  }
  if (req.body.requireCampaignApproval !== undefined) settings.requireCampaignApproval = Boolean(req.body.requireCampaignApproval);

  await settings.save();
  return new ApiResponse(200, settings, 'Site settings updated').send(res);
});

// ---------- Broadcast notifications ----------

const broadcastNotification = catchAsync(async (req, res) => {
  const { title, message, role } = req.body;
  if (!title || !message) throw ApiError.badRequest('title and message are required');

  const filter = role ? { role } : {};
  const users = await User.find(filter).select('_id');
  if (users.length === 0) return new ApiResponse(200, { sentTo: 0 }, 'No matching users found').send(res);

  const docs = users.map((u) => ({ user: u._id, type: 'general', title, message }));
  await Notification.insertMany(docs);

  return new ApiResponse(200, { sentTo: users.length }, `Notification sent to ${users.length} user(s)`).send(res);
});

// ---------- Admin accounts ----------

const listAdmins = catchAsync(async (req, res) => {
  const admins = await User.find({ role: ROLES.ADMIN }).select('-password').sort({ createdAt: -1 });
  return new ApiResponse(200, admins, 'Admins fetched').send(res);
});

const createAdmin = catchAsync(async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) throw ApiError.badRequest('name, email and password are required');
  if (password.length < 8) throw ApiError.badRequest('Password must be at least 8 characters');

  const existing = await User.findOne({ email });
  if (existing) throw ApiError.conflict('An account with this email already exists');

  const admin = await User.create({ name, email, password, role: ROLES.ADMIN, roles: [ROLES.ADMIN], isEmailVerified: true });
  return new ApiResponse(201, admin.toSafeObject(), 'Admin account created').send(res);
});

// ---------- Subscription plans (Creator Lite/Pro, Brand Lite/Pro/Elite) ----------

const listSubscriptionPlansAdmin = catchAsync(async (req, res) => {
  const { appliesTo } = req.query;
  const filter = {};
  if (appliesTo) filter.appliesTo = appliesTo;

  const plans = await SubscriptionPlan.find(filter).sort({ appliesTo: 1, sortOrder: 1, price: 1 });
  return new ApiResponse(200, plans, 'Subscription plans fetched').send(res);
});

const createSubscriptionPlan = catchAsync(async (req, res) => {
  const { name, slug, appliesTo, isDefault } = req.body;
  if (!name || !slug || !appliesTo) throw ApiError.badRequest('name, slug and appliesTo are required');

  const existing = await SubscriptionPlan.findOne({ slug });
  if (existing) throw ApiError.conflict('A plan with this slug already exists');

  if (isDefault) {
    await SubscriptionPlan.updateMany({ appliesTo, isDefault: true }, { isDefault: false });
  }

  const plan = await SubscriptionPlan.create(req.body);

  if (plan.price > 0) await subscriptionService.ensureRazorpayPlan(plan);

  return new ApiResponse(201, plan, 'Subscription plan created').send(res);
});

const updateSubscriptionPlan = catchAsync(async (req, res) => {
  const plan = await SubscriptionPlan.findById(req.params.id);
  if (!plan) throw ApiError.notFound('Subscription plan not found');

  if (req.body.isDefault === true && !plan.isDefault) {
    await SubscriptionPlan.updateMany({ appliesTo: plan.appliesTo, isDefault: true }, { isDefault: false });
  }

  const priceChanging = req.body.price !== undefined && req.body.price !== plan.price;
  const cycleChanging = req.body.billingCycle !== undefined && req.body.billingCycle !== plan.billingCycle;
  if ((priceChanging || cycleChanging) && plan.razorpayPlanId) {
    plan.razorpayPlanId = '';
  }

  const editableFields = [
    'name',
    'price',
    'billingCycle',
    'isActive',
    'isDefault',
    'sortOrder',
    'proposalLimit',
    'extraProposalCost',
    'platformFeePercent',
    'campaignAccessTier',
    'hasEarlyAccess',
    'campaignPostLimit',
    'campaignVisibilityTier',
    'canSetApplicantLimit',
    'isFeaturedListing',
    'description',
    'perks',
  ];
  editableFields.forEach((field) => {
    if (req.body[field] !== undefined) plan[field] = req.body[field];
  });

  await plan.save();

  if (plan.price > 0 && !plan.razorpayPlanId) await subscriptionService.ensureRazorpayPlan(plan);

  return new ApiResponse(200, plan, 'Subscription plan updated').send(res);
});

const deleteSubscriptionPlan = catchAsync(async (req, res) => {
  const plan = await SubscriptionPlan.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
  if (!plan) throw ApiError.notFound('Subscription plan not found');
  return new ApiResponse(200, plan, 'Subscription plan deactivated').send(res);
});

// ---------- Per-user subscription override (support tooling) ----------

const getUserSubscription = catchAsync(async (req, res) => {
  const sub = await UserSubscription.findOne({ user: req.params.id }).populate('plan');
  if (!sub) return new ApiResponse(200, null, 'This user has no subscription record yet').send(res);
  return new ApiResponse(200, sub, 'User subscription fetched').send(res);
});

const setUserSubscription = catchAsync(async (req, res) => {
  const { planId, periodDays } = req.body;
  if (!planId) throw ApiError.badRequest('planId is required');

  const plan = await SubscriptionPlan.findById(planId);
  if (!plan) throw ApiError.notFound('Plan not found');

  const targetUser = await User.findById(req.params.id);
  if (!targetUser) throw ApiError.notFound('User not found');

  const expectedRole = plan.appliesTo === 'brand' ? ROLES.BRAND : ROLES.CREATOR;
  if (targetUser.role !== expectedRole) {
    throw ApiError.badRequest(`This plan is for ${plan.appliesTo}s, but the user's role is ${targetUser.role}`);
  }

  let sub = await UserSubscription.findOne({ user: targetUser._id });
  const periodEnd = periodDays
    ? new Date(Date.now() + periodDays * 24 * 3600 * 1000)
    : subscriptionService.addCycle(new Date(), plan.billingCycle);

  if (!sub) {
    sub = new UserSubscription({ user: targetUser._id });
  }
  sub.plan = plan._id;
  sub.status = SUBSCRIPTION_STATUS.ACTIVE;
  sub.currentPeriodStart = new Date();
  sub.currentPeriodEnd = periodEnd;
  sub.proposalsUsedThisCycle = 0;
  sub.campaignsPostedThisCycle = 0;
  sub.razorpaySubscriptionId = '';
  sub.cancelAtPeriodEnd = false;
  await sub.save();

  alertUser({
    userId: targetUser._id,
    fromUser: req.user._id,
    type: 'subscription_update',
    title: `You're now on the ${plan.name} plan`,
    message: `Fanitt has activated the ${plan.name} plan on your account, valid till ${periodEnd.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}.`,
    relatedModel: 'User',
    relatedId: targetUser._id,
    email: { tone: 'success' },
  });

  return new ApiResponse(200, sub, `User moved to ${plan.name}`).send(res);
});

module.exports = {
  listUsers,
  getUserStats,
  requestProfileUpdate,
  requestProfileUpdateBulk,
  getUserDetail,
  suspendUser,
  reinstateUser,
  listPendingVerifications,
  verifyCreator,
  verifyBrand,
  createAgency,
  setAgencyPassword,
  listAgencies,
  verifyAgency,
  getReferralConfig,
  updateReferralConfig,
  listWithdrawals,
  markWithdrawalProcessing,
  markWithdrawalPaid,
  rejectWithdrawal,
  getSiteSettings,
  updateSiteSettings,
  broadcastNotification,
  listAllSessions,
  removeSession,
  listAllCampaigns,
  listAllReviews,
  hideReview,
  listAllTransactions,
  listDisputedEscrows,
  adminReleaseEscrow,
  adminRefundEscrow,
  listAllMilestones,
  getAnalyticsOverview,
  listCategoriesAdmin,
  createCategory,
  updateCategory,
  deleteCategory,
  listAdmins,
  createAdmin,
  listSubscriptionPlansAdmin,
  createSubscriptionPlan,
  updateSubscriptionPlan,
  deleteSubscriptionPlan,
  getUserSubscription,
  setUserSubscription,
};