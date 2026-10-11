const mongoose = require('mongoose');
const { Post, CreatorProfile, BrandProfile } = require('../models');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');
const notificationService = require('../services/notification.service');
const feed = require('../services/feed.service');

// Feed posts and reels by creators and brands.
//
//   POST   /posts                   multipart `media` (1-10 files), caption, kind=post|reel, durations
//   GET    /posts/config            limits for the apps
//   GET    /posts/feed              posts only (no reels), newest first, paged
//   GET    /posts/reels             reels, newest first, paged; ?start=<id> puts that reel first
//   GET    /posts/me                my posts + reels (?kind=)
//   GET    /posts/saved · POST /posts/:id/save   saved posts
//   GET    /posts/creator/:id       a creator's posts (?kind=)
//   GET    /posts/brand/:id         a brand's posts (?kind=)
//   GET    /posts/:id               one post / reel
//   POST   /posts/:id/like · GET /posts/:id/likes · POST /posts/:id/view (reels)
//   PATCH  /posts/:id (caption) · DELETE /posts/:id

const { KINDS, LIMITS } = Post;
const MAX_POSTS = 50; // per account
const MAX_REELS = 50; // per account
const MAX_POSTS_PER_CREATOR = MAX_POSTS; // kept for old imports

function pageParams(query, def = 12, max = 30) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(max, Math.max(1, parseInt(query.limit, 10) || def));
  return { page, limit, skip: (page - 1) * limit };
}

function kindFilter(kind) {
  if (kind === KINDS.REEL) return { kind: KINDS.REEL };
  if (kind === KINDS.POST) return { kind: { $ne: KINDS.REEL } }; // old posts have no kind
  return {};
}

/** Lean query with author populated → API shape. */
async function load(filter, { sort = { createdAt: -1 }, skip = 0, limit = 0 } = {}, userId) {
  let q = Post.find(filter).sort(sort).populate(feed.POPULATE).lean();
  if (skip) q = q.skip(skip);
  if (limit) q = q.limit(limit);
  return feed.serializePosts(await q, userId);
}

/** Old posts only have `creator`; treat it as the author for ownership. */
async function isOwner(post, user) {
  if (post.author && String(post.author) === String(user._id)) return true;
  if (post.creator) return Boolean(await CreatorProfile.exists({ _id: post.creator, user: user._id }));
  if (post.brand) return Boolean(await BrandProfile.exists({ _id: post.brand, user: user._id }));
  return false;
}

// ---------- create ----------

const createPost = catchAsync(async (req, res) => {
  const files = req.files || [];
  const kind = req.body.kind === KINDS.REEL ? KINDS.REEL : KINDS.POST;
  if (!files.length) throw ApiError.badRequest('Add a photo or video');

  const poster = await feed.resolvePoster(req.user);
  const durations = feed.parseDurations(req.body.durations);
  const ratios = feed.parseDurations(req.body.aspectRatios); // same JSON-array format
  const mediaItems = files.map((f, i) => feed.mediaFromFile(f, durations[i], ratios[i]));

  if (kind === KINDS.REEL) {
    if (files.length !== 1 || mediaItems[0].type !== 'video') throw ApiError.badRequest('A reel is one short video');
    if (mediaItems[0].duration > LIMITS.REEL_MAX_SECONDS) {
      throw ApiError.badRequest(`Reels can be up to ${LIMITS.REEL_MAX_SECONDS} seconds — post it as a normal post instead`);
    }
  } else if (files.length > LIMITS.MEDIA_PER_POST) {
    throw ApiError.badRequest(`You can add up to ${LIMITS.MEDIA_PER_POST} photos/videos per post`);
  }

  const cap = kind === KINDS.REEL ? MAX_REELS : MAX_POSTS;
  const count = await Post.countDocuments({ ...feed.ownerFilter(poster), ...kindFilter(kind) });
  if (count >= cap) throw ApiError.badRequest(`You've reached the limit of ${cap} ${kind}s. Delete an old one to add a new one.`);

  const post = await Post.create({
    kind,
    author: req.user._id,
    ...poster,
    mediaItems,
    caption: String(req.body.caption || '').slice(0, 500),
  });
  const [shaped] = await load({ _id: post._id }, {}, req.user._id);
  return new ApiResponse(201, shaped, kind === KINDS.REEL ? 'Reel published' : 'Post published').send(res);
});

// ---------- read ----------

const getConfig = catchAsync(async (req, res) =>
  new ApiResponse(200, { maxPosts: MAX_POSTS, maxReels: MAX_REELS, mediaPerPost: LIMITS.MEDIA_PER_POST, reelMaxSeconds: LIMITS.REEL_MAX_SECONDS }, 'Post config').send(res)
);

/** Feed = normal posts only. Reels come from /posts/reels (shown as a row). */
const getFeed = catchAsync(async (req, res) => {
  const { limit, skip } = pageParams(req.query);
  const posts = await load(kindFilter(KINDS.POST), { skip, limit }, req.user?._id);
  return new ApiResponse(200, posts, 'Feed fetched').send(res);
});

/** Reels, newest first. `start` (a reel id) is put first — for opening the player on it. */
const getReels = catchAsync(async (req, res) => {
  const { page, limit, skip } = pageParams(req.query, 10, 30);
  const filter = { kind: KINDS.REEL };
  const startId = mongoose.isValidObjectId(req.query.start) ? req.query.start : null;
  if (startId) filter._id = { $ne: new mongoose.Types.ObjectId(startId) };
  const [reels, total] = await Promise.all([load(filter, { skip, limit }, req.user?._id), Post.countDocuments(filter)]);
  let items = reels;
  if (startId && page === 1) {
    const [first] = await load({ _id: startId, kind: KINDS.REEL }, {}, req.user?._id);
    if (first) items = [first, ...reels];
  }
  return new ApiResponse(200, { items, total, page, pages: Math.ceil(total / limit), hasMore: skip + reels.length < total }, 'Reels fetched').send(res);
});

const getPost = catchAsync(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw ApiError.notFound('Post not found');
  const [post] = await load({ _id: req.params.id }, {}, req.user?._id);
  if (!post) throw ApiError.notFound('Post not found');
  return new ApiResponse(200, post, 'Post fetched').send(res);
});

const getCreatorPosts = catchAsync(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.creatorId)) return new ApiResponse(200, [], 'Posts fetched').send(res);
  const posts = await load({ creator: req.params.creatorId, ...kindFilter(req.query.kind) }, {}, req.user?._id);
  return new ApiResponse(200, posts, 'Posts fetched').send(res);
});

const getBrandPosts = catchAsync(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.brandId)) return new ApiResponse(200, [], 'Posts fetched').send(res);
  const posts = await load({ brand: req.params.brandId, ...kindFilter(req.query.kind) }, {}, req.user?._id);
  return new ApiResponse(200, posts, 'Posts fetched').send(res);
});

const getMyPosts = catchAsync(async (req, res) => {
  const poster = await feed.resolvePoster(req.user);
  const posts = await load({ ...feed.ownerFilter(poster), ...kindFilter(req.query.kind) }, {}, req.user._id);
  return new ApiResponse(200, posts, 'Your posts fetched').send(res);
});

/** GET /posts/me/stats — numbers for the Profile screen (any role). */
const getMyStats = catchAsync(async (req, res) => {
  const me = req.user._id;
  const [creator, brand, followingCreators, followingBrands] = await Promise.all([
    CreatorProfile.findOne({ user: me }).select('_id followerCount'),
    BrandProfile.findOne({ user: me }).select('_id followerCount'),
    CreatorProfile.countDocuments({ followers: me }),
    BrandProfile.countDocuments({ followers: me }),
  ]);
  const profile = creator || brand;
  const owner = creator ? { creator: creator._id } : brand ? { brand: brand._id } : null;
  const [posts, reels] = owner
    ? await Promise.all([Post.countDocuments({ ...owner, ...kindFilter(KINDS.POST) }), Post.countDocuments({ ...owner, kind: KINDS.REEL })])
    : [0, 0];
  return new ApiResponse(
    200,
    { followers: profile?.followerCount || 0, following: followingCreators + followingBrands, posts, reels, canPost: Boolean(owner) },
    'Profile stats'
  ).send(res);
});

/** GET /posts/saved — posts the current user saved, newest first. */
const getSavedPosts = catchAsync(async (req, res) => {
  const posts = await load({ savedBy: req.user._id }, { limit: 100 }, req.user._id);
  return new ApiResponse(200, posts, 'Saved posts fetched').send(res);
});

// ---------- actions ----------

/** POST /posts/:id/save — save or unsave a post. */
const toggleSave = catchAsync(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw ApiError.notFound('Post not found');
  const post = await Post.findById(req.params.id).select('_id savedBy');
  if (!post) throw ApiError.notFound('Post not found');
  const alreadySaved = post.savedBy.some((id) => id.equals(req.user._id));
  await Post.updateOne({ _id: post._id }, alreadySaved ? { $pull: { savedBy: req.user._id } } : { $addToSet: { savedBy: req.user._id } });
  return new ApiResponse(200, { saved: !alreadySaved }, alreadySaved ? 'Removed from saved' : 'Saved').send(res);
});

const toggleLike = catchAsync(async (req, res) => {
  const post = await Post.findById(req.params.id);
  if (!post) throw ApiError.notFound('Post not found');

  const alreadyLiked = post.likedBy.some((id) => id.equals(req.user._id));
  if (alreadyLiked) {
    post.likedBy.pull(req.user._id);
    post.likeCount = Math.max(0, post.likeCount - 1);
  } else {
    post.likedBy.push(req.user._id);
    post.likeCount += 1;
    const ownerId = post.author || (post.creator && (await CreatorProfile.findById(post.creator).select('user'))?.user);
    if (ownerId && String(ownerId) !== String(req.user._id)) {
      await notificationService
        .notify({
          userId: ownerId,
          fromUser: req.user._id,
          type: 'like',
          relatedModel: 'Post',
          relatedId: post._id,
          title: 'New like',
          message: `${req.user.name} liked your ${post.kind === KINDS.REEL ? 'reel' : 'post'}`,
        })
        .catch(() => {});
    }
  }
  await post.save();
  return new ApiResponse(200, { liked: !alreadyLiked, likeCount: post.likeCount }, alreadyLiked ? 'Unliked' : 'Liked').send(res);
});

/** Counts a reel view (the app calls it once per reel per session). */
const addView = catchAsync(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw ApiError.notFound('Post not found');
  const res1 = await Post.updateOne({ _id: req.params.id }, { $inc: { viewCount: 1 } });
  if (!res1.matchedCount) throw ApiError.notFound('Post not found');
  const post = await Post.findById(req.params.id).select('viewCount').lean();
  return new ApiResponse(200, { viewCount: post.viewCount }, 'Viewed').send(res);
});

const getPostLikes = catchAsync(async (req, res) => {
  const post = await Post.findById(req.params.id).populate('likedBy', 'name avatarUrl');
  if (!post) throw ApiError.notFound('Post not found');
  return new ApiResponse(200, post.likedBy, 'Likes fetched').send(res);
});

const updatePost = catchAsync(async (req, res) => {
  const post = await Post.findById(req.params.id);
  if (!post) throw ApiError.notFound('Post not found');
  if (!(await isOwner(post, req.user))) throw ApiError.forbidden('You do not own this post');
  if (req.body.caption !== undefined) post.caption = String(req.body.caption).slice(0, 500);
  await post.save();
  const [shaped] = await load({ _id: post._id }, {}, req.user._id);
  return new ApiResponse(200, shaped, 'Post updated').send(res);
});

const deletePost = catchAsync(async (req, res) => {
  const post = await Post.findById(req.params.id);
  if (!post) throw ApiError.notFound('Post not found');
  if (!(await isOwner(post, req.user))) throw ApiError.forbidden('You do not own this post');
  await post.deleteOne();
  return new ApiResponse(200, null, 'Post deleted').send(res);
});

module.exports = {
  createPost,
  getConfig,
  getFeed,
  getReels,
  getPost,
  getCreatorPosts,
  getBrandPosts,
  getMyPosts,
  getSavedPosts,
  getMyStats,
  toggleSave,
  toggleLike,
  addView,
  getPostLikes,
  updatePost,
  deletePost,
  MAX_POSTS_PER_CREATOR,
};