const { Review, CreatorProfile, BrandProfile } = require('../models');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');

/** Recalculates and stores the average rating for whoever just got reviewed. */
async function recalculateRating(userId) {
  const reviews = await Review.find({ toUser: userId, isHidden: false });
  if (reviews.length === 0) return;

  const average = reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length;

  await CreatorProfile.findOneAndUpdate({ user: userId }, { averageRating: average.toFixed(1), reviewCount: reviews.length });
  await BrandProfile.findOneAndUpdate({ user: userId }, { averageRating: average.toFixed(1), reviewCount: reviews.length });
}

const createReview = catchAsync(async (req, res) => {
  const { toUser, relatedModel, relatedId, rating, comment, subRatings } = req.body;

  if (!toUser || !relatedId || !['Campaign', 'Session'].includes(relatedModel)) {
    throw ApiError.badRequest('toUser, relatedModel and relatedId are required');
  }
  if (!Number.isInteger(Number(rating)) || rating < 1 || rating > 5) throw ApiError.badRequest('Rating must be 1 to 5');
  if (String(toUser) === String(req.user._id)) throw ApiError.badRequest('You cannot review yourself');

  // Only the two sides of a completed campaign can review each other.
  if (relatedModel === 'Campaign') {
    const { Campaign } = require('../models');
    const campaign = await Campaign.findById(relatedId)
      .populate('brand', 'user')
      .populate('assignedCreator', 'user');
    if (!campaign || campaign.status !== 'completed') throw ApiError.badRequest('You can review once the campaign is completed');
    const brandUser = String(campaign.brand?.user);
    const creatorUser = String(campaign.assignedCreator?.user);
    const me = String(req.user._id);
    const pairOk = (me === brandUser && String(toUser) === creatorUser) || (me === creatorUser && String(toUser) === brandUser);
    if (!pairOk) throw ApiError.forbidden('Only the brand and creator of this campaign can review each other');
  }

  const existing = await Review.findOne({ fromUser: req.user._id, toUser, relatedModel, relatedId });
  if (existing) throw ApiError.conflict('You have already reviewed this');

  const review = await Review.create({
    fromUser: req.user._id,
    toUser,
    relatedModel,
    relatedId,
    rating,
    comment,
    subRatings,
  });

  await recalculateRating(toUser);

  return new ApiResponse(201, review, 'Review submitted').send(res);
});

const getUserReviews = catchAsync(async (req, res) => {
  const reviews = await Review.find({ toUser: req.params.userId, isHidden: false })
    .populate('fromUser', 'name avatarUrl')
    .sort({ createdAt: -1 });

  return new ApiResponse(200, reviews, 'Reviews fetched').send(res);
});

/** GET /api/reviews/featured — best recent reviews across the whole platform, for the homepage Testimonials section */
const getFeaturedReviews = catchAsync(async (req, res) => {
  const { limit = 8 } = req.query;

  const reviews = await Review.find({ isHidden: false, rating: { $gte: 4 }, comment: { $ne: '' } })
    .populate('fromUser', 'name avatarUrl role')
    .populate('toUser', 'name role')
    .sort({ rating: -1, createdAt: -1 })
    .limit(Number(limit));

  return new ApiResponse(200, reviews, 'Featured reviews fetched').send(res);
});

module.exports = { createReview, getUserReviews, getFeaturedReviews, recalculateRating };