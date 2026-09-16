const { Post, CreatorProfile } = require('../models');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');
const { ROLES } = require('../constants/enums');

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

const getCreatorPosts = catchAsync(async (req, res) => {
  const posts = await Post.find({ creator: req.params.creatorId }).sort({ createdAt: -1 });
  return new ApiResponse(200, posts, 'Posts fetched').send(res);
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
    .populate({ path: 'creator', populate: { path: 'user', select: 'name avatarUrl' }, select: 'slug user' })
    .sort({ createdAt: -1 })
    .limit(Number(limit));

  return new ApiResponse(200, posts, 'Feed fetched').send(res);
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
  }
  await post.save();

  return new ApiResponse(200, { liked: !alreadyLiked, likeCount: post.likeCount }, alreadyLiked ? 'Unliked' : 'Liked').send(res);
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

module.exports = { createPost, getCreatorPosts, getMyPosts, getFeed, toggleLike, updatePost, deletePost, MAX_POSTS_PER_CREATOR };