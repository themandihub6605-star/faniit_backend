const { Community, CommunityMembership } = require('../models');
const generateSlug = require('../utils/slugify');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');

const listCommunities = catchAsync(async (req, res) => {
  const { category, featured, search, page = 1, limit = 20 } = req.query;

  const filter = {};
  if (category) filter.category = category;
  if (featured === 'true') filter.isFeatured = true;
  if (search) filter.name = new RegExp(search, 'i');

  const communities = await Community.find(filter)
    .populate('category', 'label icon')
    .sort({ isFeatured: -1, memberCount: -1 })
    .skip((page - 1) * limit)
    .limit(Number(limit));

  const total = await Community.countDocuments(filter);

  return new ApiResponse(200, { communities, total, page: Number(page), pages: Math.ceil(total / limit) }, 'Communities fetched').send(res);
});

const getCommunityBySlug = catchAsync(async (req, res) => {
  const community = await Community.findOne({ slug: req.params.slug }).populate('category', 'label icon');
  if (!community) throw ApiError.notFound('Community not found');
  return new ApiResponse(200, community, 'Community fetched').send(res);
});

const createCommunity = catchAsync(async (req, res) => {
  const { name, description, category, coverImageUrl, iconUrl } = req.body;
  if (!name) throw ApiError.badRequest('Community name is required');

  const community = await Community.create({
    name,
    slug: generateSlug(name),
    description,
    category,
    coverImageUrl,
    iconUrl,
    createdBy: req.user._id,
    memberCount: 1,
  });

  await CommunityMembership.create({ community: community._id, user: req.user._id, role: 'admin' });

  return new ApiResponse(201, community, 'Community created').send(res);
});

const toggleMembership = catchAsync(async (req, res) => {
  const community = await Community.findById(req.params.id);
  if (!community) throw ApiError.notFound('Community not found');

  const existing = await CommunityMembership.findOne({ community: community._id, user: req.user._id });

  if (existing) {
    await existing.deleteOne();
    community.memberCount = Math.max(0, community.memberCount - 1);
    await community.save();
    return new ApiResponse(200, { joined: false }, 'Left community').send(res);
  }

  await CommunityMembership.create({ community: community._id, user: req.user._id });
  community.memberCount += 1;
  await community.save();

  return new ApiResponse(200, { joined: true }, 'Joined community').send(res);
});

const getMyCommunities = catchAsync(async (req, res) => {
  const memberships = await CommunityMembership.find({ user: req.user._id }).populate('community');
  return new ApiResponse(200, memberships.map((m) => m.community), 'Your communities fetched').send(res);
});

module.exports = { listCommunities, getCommunityBySlug, createCommunity, toggleMembership, getMyCommunities };