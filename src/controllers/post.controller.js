const { Post, CreatorProfile, User } = require('../models');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');
const { ROLES } = require('../constants/enums');
const notificationService = require('../services/notification.service');

const MAX_POSTS_PER_CREATOR = 5;
const MAX_MEDIA_PER_POST = 5;

const createPost = catchAsync(async (req, res) => {
  if (req.user.role !== ROLES.CREATOR) throw ApiError.forbidden('Only creators can post content');

  const files = req.files || [];
  if (files.length === 0) throw ApiError.badRequest('No file uploaded');
  if (files.length > MAX_MEDIA_PER_POST) throw ApiError.badRequest(`You can upload up to ${MAX_MEDIA_PER_POST} photos/videos per post`);

  const creator = await CreatorProfile.findOne({ user: req.user._id });
  if (!creator) throw ApiError.notFound('Creator profile not found');

  const existingCount = await Post.countDocuments({ creator: creator._id });
  if (existingCount >= MAX_POSTS_PER_CREATOR) {
    throw ApiError.badRequest(`You've reached the limit of ${MAX_POSTS_PER_CREATOR} posts. Delete an old one to add a new one.`);
  }

  const mediaItems = files.map((file) => ({
    url: file.path,
    type: file.mimetype.startsWith('video') ? 'video' : 'image',
  }));

  const post = await Post.create({
    creator: creator._id,
    mediaItems,
    caption: req.body.caption || '',
  });

  return new ApiResponse(201, post, 'Post published').send(res);
});

// Attaches isFollowing to each post's creator, based on req.user (may be
// undefined for guests thanks to optionalAuth).
function withFollowFlag(posts, userId) {
  return posts.map((post) => {
    const creator = post.creator;
    if (!creator) return post;
    const isFollowing = !!(userId && creator.followers?.some((f) => f.toString() === userId));
    return {
      ...post,
      creator: { _id: creator._id, slug: creator.slug, user: creator.user, isFollowing },
    };
  });
}

// Attaches likePreview — the first few likers' name/avatar, for the
// Instagram-style "liked by [avatars] X and others" row. One batched
// User query for the whole page of posts, not one query per post.
async function withLikePreview(posts) {
  const previewIds = new Set();
  posts.forEach((p) => {
    (p.likedBy || []).slice(0, 3).forEach((id) => previewIds.add(id.toString()));
  });

  if (previewIds.size === 0) {
    return posts.map((p) => ({ ...p, likePreview: [] }));
  }

  const users = await User.find({ _id: { $in: Array.from(previewIds) } })
    .select('name avatarUrl')
    .lean();
  const userMap = new Map(users.map((u) => [u._id.toString(), u]));

  return posts.map((p) => ({
    ...p,
    likePreview: (p.likedBy || [])
      .slice(0, 3)
      .map((id) => userMap.get(id.toString()))
      .filter(Boolean),
  }));
}

const getCreatorPosts = catchAsync(async (req, res) => {
  const posts = await Post.find({ creator: req.params.creatorId })
    .populate({ path: 'creator', populate: { path: 'user', select: 'name avatarUrl' }, select: 'slug user followers' })
    .sort({ createdAt: -1 })
    .lean();

  const userId = req.user?._id?.toString();
  const withFollow = withFollowFlag(posts, userId);
  const withLikes = await withLikePreview(withFollow);
  return new ApiResponse(200, withLikes, 'Posts fetched').send(res);
});

const getMyPosts = catchAsync(async (req, res) => {
  if (req.user.role !== ROLES.CREATOR) throw ApiError.forbidden('Only creators have posts to manage');

  const creator = await CreatorProfile.findOne({ user: req.user._id });
  if (!creator) throw ApiError.notFound('Creator profile not found');

  const posts = await Post.find({ creator: creator._id }).sort({ createdAt: -1 });
  return new ApiResponse(200, posts, 'Your posts fetched').send(res);
});

const getFeed = catchAsync(async (req, res) => {
  const { limit = 12 } = req.query;

  const posts = await Post.find()
    .populate({ path: 'creator', populate: { path: 'user', select: 'name avatarUrl' }, select: 'slug user followers' })
    .sort({ createdAt: -1 })
    .limit(Number(limit))
    .lean();

  const userId = req.user?._id?.toString();
  const withFollow = withFollowFlag(posts, userId);
  const withLikes = await withLikePreview(withFollow);
  return new ApiResponse(200, withLikes, 'Feed fetched').send(res);
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

    const creator = await CreatorProfile.findById(post.creator);
    if (creator && !creator.user.equals(req.user._id)) {
      await notificationService.notify({
        userId: creator.user,
        fromUser: req.user._id,
        type: 'like',
        relatedModel: 'Post',
        relatedId: post._id,
        title: 'New like',
        message: `${req.user.name} liked your post`,
      });
    }
  }
  await post.save();

  return new ApiResponse(200, { liked: !alreadyLiked, likeCount: post.likeCount }, alreadyLiked ? 'Unliked' : 'Liked').send(res);
});

const getPostLikes = catchAsync(async (req, res) => {
  const post = await Post.findById(req.params.id).populate('likedBy', 'name avatarUrl');
  if (!post) throw ApiError.notFound('Post not found');
  return new ApiResponse(200, post.likedBy, 'Likes fetched').send(res);
});

const updatePost = catchAsync(async (req, res) => {
  const { caption } = req.body;
  const post = await Post.findById(req.params.id).populate('creator');
  if (!post) throw ApiError.notFound('Post not found');
  if (!post.creator.user.equals(req.user._id)) throw ApiError.forbidden('You do not own this post');

  if (caption !== undefined) post.caption = caption;
  await post.save();

  return new ApiResponse(200, post, 'Post updated').send(res);
});

const deletePost = catchAsync(async (req, res) => {
  const post = await Post.findById(req.params.id).populate('creator');
  if (!post) throw ApiError.notFound('Post not found');
  if (!post.creator.user.equals(req.user._id)) throw ApiError.forbidden('You do not own this post');

  await post.deleteOne();
  return new ApiResponse(200, null, 'Post deleted').send(res);
});

module.exports = { createPost, getCreatorPosts, getMyPosts, getFeed, toggleLike, getPostLikes, updatePost, deletePost, MAX_POSTS_PER_CREATOR };