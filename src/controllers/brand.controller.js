const { BrandProfile, Campaign, Transaction } = require('../models');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');
const generateSlug = require('../utils/slugify');
const { ROLES, TRANSACTION_TYPE } = require('../constants/enums');

const uploadLogo = catchAsync(async (req, res) => {
  if (req.user.role !== ROLES.BRAND) throw ApiError.forbidden('Only brands can upload a logo');
  if (!req.file) throw ApiError.badRequest('No file uploaded');

  const logoUrl = req.file.path;

  const brand = await BrandProfile.findOneAndUpdate({ user: req.user._id }, { logoUrl }, { new: true });
  if (!brand) throw ApiError.notFound('Brand profile not found');

  return new ApiResponse(200, { logoUrl }, 'Logo uploaded').send(res);
});

const getBrandById = catchAsync(async (req, res) => {
  const brand = await BrandProfile.findById(req.params.id).populate('user', 'name avatarUrl');
  if (!brand) throw ApiError.notFound('Brand not found');
  return new ApiResponse(200, brand, 'Brand fetched').send(res);
});

// Public profile page — matches the pattern used for creator profiles (/creators/:slug)
const getBrandBySlug = catchAsync(async (req, res) => {
  const brand = await BrandProfile.findOneAndUpdate(
    { slug: req.params.slug },
    { $inc: { profileViews: 1 } },
    { new: true }
  ).populate('user', 'name avatarUrl email');

  if (!brand) throw ApiError.notFound('Brand not found');

  // Real, computed counts — not hardcoded.
  const campaignsPosted = await Campaign.countDocuments({ brand: brand._id });
  const campaigns = await Campaign.find({ brand: brand._id, status: 'open' }).sort({ createdAt: -1 }).limit(6);

  return new ApiResponse(200, { brand, campaigns, stats: { campaignsPosted } }, 'Brand profile fetched').send(res);
});

const getMyProfile = catchAsync(async (req, res) => {
  if (req.user.role !== ROLES.BRAND) throw ApiError.forbidden('Only brands have a brand profile');

  let brand = await BrandProfile.findOne({ user: req.user._id }).populate('user', 'name avatarUrl email phone');
  if (!brand) throw ApiError.notFound('Brand profile not found');

  // Backfill a slug for brand accounts created before public profile pages existed.
  if (!brand.slug) {
    brand.slug = generateSlug(brand.companyName);
    await brand.save();
  }

  return new ApiResponse(200, brand, 'Profile fetched').send(res);
});

const updateMyProfile = catchAsync(async (req, res) => {
  if (req.user.role !== ROLES.BRAND) throw ApiError.forbidden('Only brands can update a brand profile');

  const {
    companyName,
    tagline,
    website,
    industry,
    about,
    location,
    foundedYear,
    companySize,
    whatWeOffer,
    socials,
  } = req.body;

  const brand = await BrandProfile.findOneAndUpdate(
    { user: req.user._id },
    {
      $set: {
        ...(companyName && { companyName }),
        ...(tagline !== undefined && { tagline }),
        ...(website !== undefined && { website }),
        ...(industry !== undefined && { industry }),
        ...(about !== undefined && { about }),
        ...(location !== undefined && { location }),
        ...(foundedYear !== undefined && { foundedYear }),
        ...(companySize !== undefined && { companySize }),
        ...(whatWeOffer && { whatWeOffer }),
        ...(socials && { socials }),
      },
    },
    { new: true, runValidators: true }
  );

  if (!brand) throw ApiError.notFound('Brand profile not found');
  return new ApiResponse(200, brand, 'Profile updated').send(res);
});

const getMyDashboard = catchAsync(async (req, res) => {
  const brand = await BrandProfile.findOne({ user: req.user._id });
  if (!brand) throw ApiError.notFound('Brand profile not found');

  const campaigns = await Campaign.find({ brand: brand._id }).sort({ createdAt: -1 });

  const spendBreakdown = await Transaction.aggregate([
    { $match: { from: req.user._id, type: TRANSACTION_TYPE.CAMPAIGN_ESCROW_DEPOSIT } },
    { $group: { _id: '$status', total: { $sum: '$amount' } } },
  ]);

  return new ApiResponse(
    200,
    {
      stats: {
        totalCampaigns: brand.totalCampaigns,
        totalSpent: brand.totalSpent,
        averageRating: brand.averageRating,
        profileViews: brand.profileViews,
      },
      campaigns,
      spendBreakdown,
    },
    'Dashboard data fetched'
  ).send(res);
});

const followBrand = catchAsync(async (req, res) => {
  const brand = await BrandProfile.findById(req.params.id);
  if (!brand) throw ApiError.notFound('Brand not found');

  const alreadyFollowing = brand.followers.some((f) => f.equals(req.user._id));
  if (alreadyFollowing) {
    brand.followers.pull(req.user._id);
    brand.followerCount = Math.max(0, brand.followerCount - 1);
  } else {
    brand.followers.push(req.user._id);
    brand.followerCount += 1;
  }
  await brand.save();

  return new ApiResponse(200, { following: !alreadyFollowing }, alreadyFollowing ? 'Unfollowed' : 'Followed').send(res);
});

module.exports = { getBrandById, getBrandBySlug, getMyProfile, updateMyProfile, getMyDashboard, uploadLogo, followBrand };
