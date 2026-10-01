const { Post, CreatorProfile, User, Notification, Community, CommunityPost, CommunityComment } = require('../models');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');

// Admin tools for every post on the platform:
//   type 'feed'      — creator feed posts (Post)
//   type 'community' — posts inside communities (CommunityPost)
// Search matches the post text/caption OR the author's name/email.

const TYPES = ['feed', 'community'];

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertType(type) {
  if (!TYPES.includes(type)) throw ApiError.badRequest('Post type must be "feed" or "community"');
}

function pageParams(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(query.limit, 10) || 20));
  return { page, limit, skip: (page - 1) * limit };
}

function authorOf(user) {
  if (!user) return null;
  return { _id: user._id, name: user.name, email: user.email, avatarUrl: user.avatarUrl, role: user.role };
}

function serializeFeed(post) {
  return {
    _id: post._id,
    type: 'feed',
    text: post.caption || '',
    media: post.mediaItems || [],
    likeCount: post.likeCount || 0,
    commentCount: 0,
    isPinned: false,
    isAnnouncement: false,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
    author: authorOf(post.creator?.user),
    creatorSlug: post.creator?.slug || null,
    community: null,
  };
}

function serializeCommunityPost(post) {
  return {
    _id: post._id,
    type: 'community',
    text: post.text || '',
    media: post.mediaItems || [],
    likeCount: post.likeCount || 0,
    commentCount: post.commentCount || 0,
    isPinned: Boolean(post.isPinned),
    isAnnouncement: Boolean(post.isAnnouncement),
    hasPoll: Boolean(post.poll && post.poll.options && post.poll.options.length),
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
    author: authorOf(post.author),
    community: post.community ? { _id: post.community._id, name: post.community.name, slug: post.community.slug } : null,
  };
}

async function matchingUserIds(search) {
  const pattern = new RegExp(escapeRegex(search), 'i');
  const users = await User.find({ $or: [{ name: pattern }, { email: pattern }] }).select('_id').limit(500);
  return users.map((u) => u._id);
}

/** GET /api/admin/posts?type=feed|community&search=&page=&limit= */
const listPosts = catchAsync(async (req, res) => {
  const type = req.query.type || 'feed';
  assertType(type);
  const { page, limit, skip } = pageParams(req.query);
  const search = String(req.query.search || '').trim();

  if (type === 'feed') {
    const filter = {};
    if (search) {
      const userIds = await matchingUserIds(search);
      const creators = userIds.length ? await CreatorProfile.find({ user: { $in: userIds } }).select('_id') : [];
      filter.$or = [{ caption: new RegExp(escapeRegex(search), 'i') }, { creator: { $in: creators.map((c) => c._id) } }];
    }
    const [posts, total] = await Promise.all([
      Post.find(filter)
        .populate({ path: 'creator', select: 'slug user', populate: { path: 'user', select: 'name email avatarUrl role' } })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Post.countDocuments(filter),
    ]);
    return new ApiResponse(200, { posts: posts.map(serializeFeed), total, page, pages: Math.ceil(total / limit) }, 'Posts fetched').send(res);
  }

  const filter = {};
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    const userIds = await matchingUserIds(search);
    const communities = await Community.find({ name: pattern }).select('_id').limit(200);
    filter.$or = [
      { text: pattern },
      { author: { $in: userIds } },
      { community: { $in: communities.map((c) => c._id) } },
    ];
  }
  const [posts, total] = await Promise.all([
    CommunityPost.find(filter)
      .populate('author', 'name email avatarUrl role')
      .populate('community', 'name slug')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    CommunityPost.countDocuments(filter),
  ]);
  return new ApiResponse(
    200,
    { posts: posts.map(serializeCommunityPost), total, page, pages: Math.ceil(total / limit) },
    'Posts fetched'
  ).send(res);
});

/**
 * PATCH /api/admin/posts/:type/:id
 * Body (all optional): { text, removeMediaUrls: string[], isPinned, isAnnouncement }
 * Feed posts must keep at least one photo/video.
 */
const updatePost = catchAsync(async (req, res) => {
  const { type, id } = req.params;
  assertType(type);
  const { text, removeMediaUrls, isPinned, isAnnouncement } = req.body;
  const toRemove = new Set(Array.isArray(removeMediaUrls) ? removeMediaUrls.map(String) : []);

  if (type === 'feed') {
    const post = await Post.findById(id);
    if (!post) throw ApiError.notFound('Post not found');
    if (text !== undefined) {
      const caption = String(text).trim();
      if (caption.length > 500) throw ApiError.badRequest('Caption can be up to 500 characters');
      post.caption = caption;
    }
    if (toRemove.size) {
      const remaining = post.mediaItems.filter((m) => !toRemove.has(m.url));
      if (remaining.length === 0) throw ApiError.badRequest('A feed post needs at least one photo or video — delete the post instead');
      post.mediaItems = remaining;
    }
    await post.save();
    await post.populate({ path: 'creator', select: 'slug user', populate: { path: 'user', select: 'name email avatarUrl role' } });
    return new ApiResponse(200, serializeFeed(post), 'Post updated').send(res);
  }

  const post = await CommunityPost.findById(id);
  if (!post) throw ApiError.notFound('Post not found');
  if (text !== undefined) {
    const value = String(text).trim();
    if (value.length > 3000) throw ApiError.badRequest('Posts can be up to 3000 characters');
    post.text = value;
    post.editedAt = new Date();
  }
  if (toRemove.size) post.mediaItems = post.mediaItems.filter((m) => !toRemove.has(m.url));
  if (isPinned !== undefined) {
    post.isPinned = Boolean(isPinned);
    post.pinnedAt = post.isPinned ? new Date() : null;
  }
  if (isAnnouncement !== undefined) post.isAnnouncement = Boolean(isAnnouncement);
  const hasPoll = Boolean(post.poll && post.poll.options && post.poll.options.length);
  if (!post.text && post.mediaItems.length === 0 && !hasPoll) {
    throw ApiError.badRequest("A post can't be empty — delete it instead");
  }
  await post.save();
  await post.populate([
    { path: 'author', select: 'name email avatarUrl role' },
    { path: 'community', select: 'name slug' },
  ]);
  return new ApiResponse(200, serializeCommunityPost(post), 'Post updated').send(res);
});

/** DELETE /api/admin/posts/:type/:id — removes the post and everything tied to it. */
const deletePost = catchAsync(async (req, res) => {
  const { type, id } = req.params;
  assertType(type);

  if (type === 'feed') {
    const post = await Post.findById(id);
    if (!post) throw ApiError.notFound('Post not found');
    await post.deleteOne();
    await Notification.deleteMany({ relatedModel: 'Post', relatedId: post._id });
    return new ApiResponse(200, null, 'Post deleted').send(res);
  }

  const post = await CommunityPost.findById(id);
  if (!post) throw ApiError.notFound('Post not found');
  await CommunityComment.deleteMany({ post: post._id });
  await post.deleteOne();
  await Community.updateOne({ _id: post.community, discussionCount: { $gt: 0 } }, { $inc: { discussionCount: -1 } });
  await Notification.deleteMany({ relatedModel: 'CommunityPost', relatedId: post._id });
  return new ApiResponse(200, null, 'Post deleted').send(res);
});

module.exports = { listPosts, updatePost, deletePost };