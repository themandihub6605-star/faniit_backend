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