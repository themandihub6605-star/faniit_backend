const { AgencyProfile, CreatorProfile, User } = require('../models');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');
const { ROLES } = require('../constants/enums');

/** POST /api/agency/link-creator — a creator signs up / enters an agency's referral code */
const linkCreatorToAgency = catchAsync(async (req, res) => {
  if (req.user.role !== ROLES.CREATOR) throw ApiError.forbidden('Only creators can link to an agency');

  const { referralCode } = req.body;
  const agency = await AgencyProfile.findOne({ referralCode });
  if (!agency) throw ApiError.notFound('Invalid referral code');

  const creator = await CreatorProfile.findOne({ user: req.user._id });
  if (!creator) throw ApiError.notFound('Creator profile not found');
  if (creator.agency) throw ApiError.conflict('You are already linked to an agency');

  creator.agency = agency._id;
  await creator.save();

  agency.referredCreators.push(creator._id);
  await agency.save();

  return new ApiResponse(200, null, 'Linked to agency successfully').send(res);
});

const getMyDashboard = catchAsync(async (req, res) => {
  const agency = await AgencyProfile.findOne({ user: req.user._id }).populate({
    path: 'referredCreators',
    populate: { path: 'user', select: 'name avatarUrl' },
  });
  if (!agency) throw ApiError.notFound('Agency profile not found');

  return new ApiResponse(
    200,
    {
      stats: {
        totalCommissionEarned: agency.totalCommissionEarned,
        thisMonthCommission: agency.thisMonthCommission,
        referredCreatorCount: agency.referredCreators.length,
        referralCode: agency.referralCode,
      },
      referredCreators: agency.referredCreators,
    },
    'Dashboard data fetched'
  ).send(res);
});

const updateMyProfile = catchAsync(async (req, res) => {
  const { agencyName, logoUrl } = req.body;
  const agency = await AgencyProfile.findOneAndUpdate(
    { user: req.user._id },
    { $set: { ...(agencyName && { agencyName }), ...(logoUrl && { logoUrl }) } },
    { new: true }
  );
  if (!agency) throw ApiError.notFound('Agency profile not found');
  return new ApiResponse(200, agency, 'Profile updated').send(res);
});

module.exports = { linkCreatorToAgency, getMyDashboard, updateMyProfile };
