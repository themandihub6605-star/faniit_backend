const { BrandProfile, Campaign, Transaction, UserSubscription } = require('../models');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');
const generateSlug = require('../utils/slugify');
const { ROLES, TRANSACTION_TYPE, VERIFICATION_STATUS } = require('../constants/enums');

const listBrands = catchAsync(async (req, res) => {
  const { industry, location, search, page = 1, limit = 20 } = req.query;

  const filter = { verificationStatus: { $ne: 'rejected' } };
  if (industry) filter.industry = new RegExp(industry, 'i');
  if (location) filter.location = new RegExp(location, 'i');
  if (search) {
    filter.$or = [{ companyName: new RegExp(search, 'i') }, { tagline: new RegExp(search, 'i') }];
  }

  // NOTE: the earlier Lite-only-sees-Lite / Pro-sees-everyone visibility
  // filter (Point 5) has been removed per later instruction — every
  // brand is now visible to every viewer regardless of plan tier.

  const [brands, total] = await Promise.all([
    BrandProfile.find(filter)
      .populate('user', 'name avatarUrl')
      .sort({ followerCount: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit)),
    BrandProfile.countDocuments(filter),
  ]);

  // Plan badge info (replaces the old blue verified-tick on listing
  // cards) — one batched query for every brand on this page rather than
  // a per-card lookup. A brand with no UserSubscription row yet is
  // implicitly on the free default plan — defaults to 'Lite' / not-pro.
  const userIds = brands.map((b) => b.user?._id).filter(Boolean);
  const subs = await UserSubscription.find({ user: { $in: userIds } }).populate('plan', 'name price');
  const planMap = new Map(subs.map((s) => [String(s.user), s.plan]));

  const brandsWithPlan = brands.map((b) => {
    const plan = planMap.get(String(b.user?._id));
    return {
      ...b.toObject(),
      planName: plan ? plan.name : 'Lite',
      isProPlan: plan ? plan.price > 0 : false,
    };
  });

  return new ApiResponse(200, { brands: brandsWithPlan, total, page: Number(page), limit: Number(limit) }, 'Brands fetched').send(res);
});

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

const getBrandBySlug = catchAsync(async (req, res) => {
  const brand = await BrandProfile.findOneAndUpdate(
    { slug: req.params.slug },
    { $inc: { profileViews: 1 } },
    { new: true }
  ).populate('user', 'name avatarUrl email');

  if (!brand) throw ApiError.notFound('Brand not found');

  const campaignsPosted = await Campaign.countDocuments({ brand: brand._id });
  const campaigns = await Campaign.find({ brand: brand._id, status: 'open' }).sort({ createdAt: -1 }).limit(6);

  // Plan badge info for this profile — same defaulting as listBrands (no
  // UserSubscription row yet = implicitly Lite). Used by the frontend to
  // show a Lite viewer an upgrade prompt when they open a Pro brand's
  // profile.
  const sub = await UserSubscription.findOne({ user: brand.user._id }).populate('plan', 'name price');
  const brandWithPlan = {
    ...brand.toObject(),
    planName: sub ? sub.plan.name : 'Lite',
    isProPlan: sub ? sub.plan.price > 0 : false,
  };

  return new ApiResponse(200, { brand: brandWithPlan, campaigns, stats: { campaignsPosted } }, 'Brand profile fetched').send(res);
});

const getMyProfile = catchAsync(async (req, res) => {
  if (req.user.role !== ROLES.BRAND) throw ApiError.forbidden('Only brands have a brand profile');

  let brand = await BrandProfile.findOne({ user: req.user._id }).populate('user', 'name avatarUrl email phone');
  if (!brand) throw ApiError.notFound('Brand profile not found');

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
    targetAudience,
    contactDesignation,
    submitForApproval,
  } = req.body;

  const brand = await BrandProfile.findOne({ user: req.user._id });
  if (!brand) throw ApiError.notFound('Brand profile not found');

  if (companyName) brand.companyName = companyName;
  if (tagline !== undefined) brand.tagline = tagline;
  if (website !== undefined) brand.website = website;
  if (industry !== undefined) brand.industry = industry;
  if (about !== undefined) brand.about = about;
  if (location !== undefined) brand.location = location;
  if (foundedYear !== undefined) brand.foundedYear = foundedYear;
  if (companySize !== undefined) brand.companySize = companySize;
  if (whatWeOffer) brand.whatWeOffer = whatWeOffer;
  if (socials) brand.socials = socials;
  if (targetAudience !== undefined) brand.targetAudience = targetAudience;
  if (contactDesignation !== undefined) brand.contactDesignation = contactDesignation;

  if (submitForApproval && brand.verificationStatus === VERIFICATION_STATUS.UNVERIFIED) {
    brand.verificationStatus = VERIFICATION_STATUS.PENDING;
  }

  await brand.save();
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

module.exports = { listBrands, getBrandById, getBrandBySlug, getMyProfile, updateMyProfile, getMyDashboard, uploadLogo, followBrand };