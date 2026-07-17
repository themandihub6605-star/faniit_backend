const { AgencyProfile, CreatorProfile, BrandProfile, User, Transaction } = require('../models');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');
const { ROLES, VERIFICATION_STATUS, TRANSACTION_TYPE } = require('../constants/enums');

/** GET /api/agency/me — full profile, used to prefill the registration/edit form
 * and to check verificationStatus (unverified/pending/verified/rejected). */
const getMyProfile = catchAsync(async (req, res) => {
  if (req.user.role !== ROLES.AGENCY) throw ApiError.forbidden('Only agencies have an agency profile');

  const agency = await AgencyProfile.findOne({ user: req.user._id }).populate('user', 'name email avatarUrl');
  if (!agency) throw ApiError.notFound('Agency profile not found');

  return new ApiResponse(200, agency, 'Profile fetched').send(res);
});

/** PATCH /api/agency/me — fill in / edit the registration details. Submitting
 * this while verificationStatus is 'unverified' also moves it to 'pending'
 * so it shows up in the admin approval queue. */
const updateMyProfile = catchAsync(async (req, res) => {
  if (req.user.role !== ROLES.AGENCY) throw ApiError.forbidden('Only agencies can update an agency profile');

  const { agencyName, ownerName, mobile, city, state, gstNumber, teamSize, yearsInBusiness, specialization, submitForApproval } = req.body;

  const agency = await AgencyProfile.findOne({ user: req.user._id });
  if (!agency) throw ApiError.notFound('Agency profile not found');

  if (agencyName !== undefined) agency.agencyName = agencyName;
  if (ownerName !== undefined) agency.ownerName = ownerName;
  if (mobile !== undefined) agency.mobile = mobile;
  if (city !== undefined) agency.city = city;
  if (state !== undefined) agency.state = state;
  if (gstNumber !== undefined) agency.gstNumber = gstNumber;
  if (teamSize !== undefined) agency.teamSize = teamSize;
  if (yearsInBusiness !== undefined) agency.yearsInBusiness = yearsInBusiness;
  if (specialization !== undefined) agency.specialization = specialization;

  if (submitForApproval && agency.verificationStatus === VERIFICATION_STATUS.UNVERIFIED) {
    agency.verificationStatus = VERIFICATION_STATUS.PENDING;
  }

  await agency.save();
  return new ApiResponse(200, agency, 'Profile updated').send(res);
});

/** POST /api/agency/upload-document — ID / address proof, moves status to pending. */
const uploadDocument = catchAsync(async (req, res) => {
  if (req.user.role !== ROLES.AGENCY) throw ApiError.forbidden('Only agencies can upload a document');
  if (!req.file) throw ApiError.badRequest('No file uploaded');

  const agency = await AgencyProfile.findOneAndUpdate(
    { user: req.user._id },
    { documentUrl: req.file.path },
    { new: true }
  );
  if (!agency) throw ApiError.notFound('Agency profile not found');

  return new ApiResponse(200, { documentUrl: agency.documentUrl }, 'Document uploaded').send(res);
});

/** POST /api/agency/link-creator — a creator enters an agency's referral code */
const linkCreatorToAgency = catchAsync(async (req, res) => {
  if (req.user.role !== ROLES.CREATOR) throw ApiError.forbidden('Only creators can link to an agency');

  const { referralCode } = req.body;
  const agency = await AgencyProfile.findOne({ referralCode });
  if (!agency) throw ApiError.notFound('Invalid referral code');
  if (agency.verificationStatus !== VERIFICATION_STATUS.VERIFIED) {
    throw ApiError.badRequest('This agency is not yet approved');
  }

  const creator = await CreatorProfile.findOne({ user: req.user._id });
  if (!creator) throw ApiError.notFound('Creator profile not found');
  if (creator.agency) throw ApiError.conflict('You are already linked to an agency');

  creator.agency = agency._id;
  await creator.save();

  agency.referredCreators.push(creator._id);
  await agency.save();

  return new ApiResponse(200, null, 'Linked to agency successfully').send(res);
});

/** POST /api/agency/link-brand — same idea, for brands */
const linkBrandToAgency = catchAsync(async (req, res) => {
  if (req.user.role !== ROLES.BRAND) throw ApiError.forbidden('Only brands can link to an agency');

  const { referralCode } = req.body;
  const agency = await AgencyProfile.findOne({ referralCode });
  if (!agency) throw ApiError.notFound('Invalid referral code');
  if (agency.verificationStatus !== VERIFICATION_STATUS.VERIFIED) {
    throw ApiError.badRequest('This agency is not yet approved');
  }

  const brand = await BrandProfile.findOne({ user: req.user._id });
  if (!brand) throw ApiError.notFound('Brand profile not found');
  if (brand.agency) throw ApiError.conflict('You are already linked to an agency');

  brand.agency = agency._id;
  await brand.save();

  agency.referredBrands.push(brand._id);
  await agency.save();

  return new ApiResponse(200, null, 'Linked to agency successfully').send(res);
});

/** GET /api/agency/me/dashboard — real stats only. Earnings breakdown is
 * computed from actual Transaction records (creator-side vs brand-side vs
 * anything else), not invented — if brand-side commission crediting isn't
 * wired up yet elsewhere in the platform, that slice will genuinely show 0
 * rather than a made-up number. */
const getMyDashboard = catchAsync(async (req, res) => {
  const agency = await AgencyProfile.findOne({ user: req.user._id }).populate({
    path: 'referredCreators',
    populate: { path: 'user', select: 'name avatarUrl' },
  });
  if (!agency) throw ApiError.notFound('Agency profile not found');

  const brandCount = await BrandProfile.countDocuments({ agency: agency._id });

  const breakdown = await Transaction.aggregate([
    { $match: { to: req.user._id, type: TRANSACTION_TYPE.AGENCY_COMMISSION } },
    { $group: { _id: '$relatedModel', total: { $sum: '$agencyCommission' } } },
  ]);

  const user = await User.findById(req.user._id);

  return new ApiResponse(
    200,
    {
      stats: {
        totalReferrals: agency.referredCreators.length + brandCount,
        referredCreatorCount: agency.referredCreators.length,
        referredBrandCount: brandCount,
        totalCommissionEarned: agency.totalCommissionEarned,
        thisMonthCommission: agency.thisMonthCommission,
        walletBalance: user.walletBalance,
        referralCode: agency.referralCode,
        verificationStatus: agency.verificationStatus,
      },
      earningsBreakdown: breakdown, // [{ _id: 'Session'|'Campaign'|null, total }]
      referredCreators: agency.referredCreators,
    },
    'Dashboard data fetched'
  ).send(res);
});

/** GET /api/agency/me/referrals — full list for the "My Referrals" page */
const getMyReferrals = catchAsync(async (req, res) => {
  const agency = await AgencyProfile.findOne({ user: req.user._id })
    .populate({ path: 'referredCreators', populate: { path: 'user', select: 'name avatarUrl' } })
    .populate({ path: 'referredBrands', populate: { path: 'user', select: 'name avatarUrl' } });
  if (!agency) throw ApiError.notFound('Agency profile not found');

  const creators = agency.referredCreators.map((c) => ({
    _id: c._id,
    type: 'creator',
    name: c.user?.name,
    avatarUrl: c.user?.avatarUrl,
    totalEarnings: c.totalEarnings,
    joinedAt: c.createdAt,
  }));
  const brands = agency.referredBrands.map((b) => ({
    _id: b._id,
    type: 'brand',
    name: b.user?.name || b.companyName,
    avatarUrl: b.user?.avatarUrl,
    totalEarnings: null,
    joinedAt: b.createdAt,
  }));

  const referrals = [...creators, ...brands].sort((a, b) => new Date(b.joinedAt) - new Date(a.joinedAt));
  return new ApiResponse(200, referrals, 'Referrals fetched').send(res);
});

module.exports = {
  getMyProfile,
  updateMyProfile,
  uploadDocument,
  linkCreatorToAgency,
  linkBrandToAgency,
  getMyDashboard,
  getMyReferrals,
};
