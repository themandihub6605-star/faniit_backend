const { Community, CommunityMembership, CommunityPost, CommunityComment, CommunityMessage, User } = require('../models');
const generateSlug = require('../utils/slugify');
const catchAsync = require('../utils/catchAsync');
const { pinnedIds } = require('../utils/pinnedIds');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');
const notificationService = require('../services/notification.service');
const cs = require('../services/community.service');

const MAX_PINNED = 3;

// --- helpers -------------------------------------------------------------

function pageParams(query, defaultLimit = 20, maxLimit = 50) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Accepts an array, a JSON array string, or newline-separated text. */
function parseList(value) {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // not JSON — fall through
  }
  return String(value).split('\n');
}

function cleanRules(value) {
  return parseList(value)
    .map((r) => String(r).trim())
    .filter(Boolean)
    .slice(0, 10)
    .map((r) => r.slice(0, 300));
}

function toBool(value) {
  return value === true || value === 'true';
}

function serializeCommunity(community, membership) {
  const obj = community.toObject ? community.toObject() : { ...community };
  const active = cs.isActive(membership);
  obj.membership = membership
    ? { role: membership.role, status: membership.status, notificationsMuted: membership.notificationsMuted }
    : null;
  obj.canPost = active && (obj.postPermission === 'all' || cs.isModRole(membership.role));
  obj.canModerate = active && cs.isModRole(membership.role);
  obj.isOwner = active && membership.role === 'admin';
  if (!obj.canModerate) delete obj.pendingRequestCount;
  return obj;
}

/** Adds isLiked / myVote for the viewer and strips internal arrays. */
async function serializePosts(posts, userId) {
  const ids = posts.map((p) => p._id);
  let liked = new Set();
  const votes = new Map();
  if (userId && ids.length) {
    const likedDocs = await CommunityPost.find({ _id: { $in: ids }, likedBy: userId }).select('_id');
    liked = new Set(likedDocs.map((d) => String(d._id)));
    const voted = await CommunityPost.find({ _id: { $in: ids }, 'poll.voters.user': userId }, { 'poll.voters.$': 1 });
    for (const doc of voted) {
      const vote = doc.poll?.voters?.[0];
      if (vote) votes.set(String(doc._id), vote.optionIndex);
    }
  }
  const now = new Date();
  return posts.map((post) => {
    const obj = post.toObject ? post.toObject() : { ...post };
    delete obj.likedBy;
    if (obj.poll && obj.poll.options?.length) {
      delete obj.poll.voters;
      obj.poll.myVote = votes.has(String(obj._id)) ? votes.get(String(obj._id)) : null;
      obj.poll.isClosed = Boolean(obj.poll.endsAt && new Date(obj.poll.endsAt) < now);
    } else {
      obj.poll = null;
    }
    obj.isLiked = liked.has(String(obj._id));
    return obj;
  });
}

async function serializeComments(comments, userId) {
  const ids = comments.map((c) => c._id);
  let liked = new Set();
  if (userId && ids.length) {
    const likedDocs = await CommunityComment.find({ _id: { $in: ids }, likedBy: userId }).select('_id');
    liked = new Set(likedDocs.map((d) => String(d._id)));
  }
  return comments.map((c) => {
    const obj = c.toObject ? c.toObject() : { ...c };
    delete obj.likedBy;
    obj.isLiked = liked.has(String(obj._id));
    return obj;
  });
}

function serializeMessage(message) {
  const obj = message.toObject ? message.toObject() : { ...message };
  if (obj.isRemoved) obj.text = '';
  return obj;
}

async function loadPostWithAccess(postId, userId) {
  const post = await CommunityPost.findById(postId);
  if (!post) throw ApiError.notFound('Post not found');
  const community = await Community.findById(post.community);
  if (!community) throw ApiError.notFound('Community not found');
  const membership = await cs.getMembership(community._id, userId);
  return { post, community, membership };
}

// --- communities ---------------------------------------------------------

const listCommunities = catchAsync(async (req, res) => {
  const { category, featured, search, sort } = req.query;
  const { page, limit, skip } = pageParams(req.query);

  const filter = {};
  const ids = pinnedIds(req.query);
  if (ids) filter._id = { $in: ids };
  if (category) filter.category = category;
  if (featured === 'true') filter.isFeatured = true;
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ name: pattern }, { description: pattern }];
  }

  const sortBy =
    {
      trending: { lastActivityAt: -1, memberCount: -1 },
      popular: { memberCount: -1 },
      new: { createdAt: -1 },
    }[sort] || { isFeatured: -1, memberCount: -1 };

  const [communities, total] = await Promise.all([
    Community.find(filter).populate('category', 'label icon').sort(sortBy).skip(skip).limit(limit),
    Community.countDocuments(filter),
  ]);

  let memberships = new Map();
  if (req.user) {
    const mine = await CommunityMembership.find({ user: req.user._id, community: { $in: communities.map((c) => c._id) } });
    memberships = new Map(mine.map((m) => [String(m.community), m]));
  }

  return new ApiResponse(
    200,
    {
      communities: communities.map((c) => serializeCommunity(c, memberships.get(String(c._id)))),
      total,
      page,
      pages: Math.ceil(total / limit),
    },
    'Communities fetched'
  ).send(res);
});

const getMyCommunities = catchAsync(async (req, res) => {
  const memberships = await CommunityMembership.find({ user: req.user._id, status: { $in: ['active', 'pending'] } })
    .populate({ path: 'community', populate: { path: 'category', select: 'label icon' } })
    .sort({ updatedAt: -1 });

  const result = [];
  for (const m of memberships) {
    if (!m.community) continue;
    const obj = serializeCommunity(m.community, m);
    if (m.status === 'active' && m.community.chatEnabled) {
      // eslint-disable-next-line no-await-in-loop
      obj.unreadChatCount = await CommunityMessage.countDocuments({
        community: m.community._id,
        isRemoved: false,
        sender: { $ne: req.user._id },
        ...(m.lastReadChatAt ? { createdAt: { $gt: m.lastReadChatAt } } : {}),
      });
    } else {
      obj.unreadChatCount = 0;
    }
    result.push(obj);
  }
  return new ApiResponse(200, result, 'Your communities fetched').send(res);
});

const getCommunity = catchAsync(async (req, res) => {
  const community = await cs.findCommunity(req.params.slug);
  await community.populate([
    { path: 'category', select: 'label icon' },
    { path: 'createdBy', select: cs.AUTHOR_FIELDS },
  ]);
  const membership = await cs.getMembership(community._id, req.user?._id);
  const moderators = await CommunityMembership.find({ community: community._id, status: 'active', role: { $in: cs.MOD_ROLES } })
    .populate('user', cs.AUTHOR_FIELDS)
    .limit(20);

  const data = serializeCommunity(community, membership);
  data.moderators = moderators.filter((m) => m.user).map((m) => ({ user: m.user, role: m.role }));
  return new ApiResponse(200, data, 'Community fetched').send(res);
});

const createCommunity = catchAsync(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (name.length < 3) throw ApiError.badRequest('Community name must be at least 3 characters');
  if (name.length > 60) throw ApiError.badRequest('Community name can be up to 60 characters');

  const visibility = Community.VISIBILITY.includes(req.body.visibility) ? req.body.visibility : 'public';
  const postPermission = Community.POST_PERMISSION.includes(req.body.postPermission) ? req.body.postPermission : 'all';

  const community = await Community.create({
    name,
    slug: generateSlug(name),
    description: String(req.body.description || '').slice(0, 1000),
    category: req.body.category || undefined,
    rules: cleanRules(req.body.rules),
    visibility,
    postPermission,
    chatEnabled: req.body.chatEnabled === undefined ? true : toBool(req.body.chatEnabled),
    iconUrl: req.files?.icon?.[0]?.path || '',
    coverImageUrl: req.files?.cover?.[0]?.path || '',
    createdBy: req.user._id,
    memberCount: 1,
  });
  const membership = await CommunityMembership.create({ community: community._id, user: req.user._id, role: 'admin' });

  return new ApiResponse(201, serializeCommunity(community, membership), 'Community created').send(res);
});

const updateCommunity = catchAsync(async (req, res) => {
  const community = await cs.findCommunity(req.params.id);
  const membership = await cs.getMembership(community._id, req.user._id);
  cs.assertModerator(membership);
  const isOwner = membership.role === 'admin';

  const b = req.body;
  if (b.description !== undefined) community.description = String(b.description).slice(0, 1000);
  if (b.rules !== undefined) community.rules = cleanRules(b.rules);
  if (b.category !== undefined) community.category = b.category || undefined;
  if (req.files?.icon?.[0]) community.iconUrl = req.files.icon[0].path;
  if (req.files?.cover?.[0]) community.coverImageUrl = req.files.cover[0].path;

  if (isOwner) {
    if (b.name !== undefined) {
      const name = String(b.name).trim();
      if (name.length < 3 || name.length > 60) throw ApiError.badRequest('Community name must be 3–60 characters');
      community.name = name;
    }
    if (b.postPermission !== undefined && Community.POST_PERMISSION.includes(b.postPermission)) {
      community.postPermission = b.postPermission;
    }
    if (b.chatEnabled !== undefined) community.chatEnabled = toBool(b.chatEnabled);
    if (b.visibility !== undefined && Community.VISIBILITY.includes(b.visibility) && b.visibility !== community.visibility) {
      community.visibility = b.visibility;
      // Going public lets everyone who was waiting straight in.
      if (b.visibility === 'public') {
        const result = await CommunityMembership.updateMany({ community: community._id, status: 'pending' }, { status: 'active' });
        community.memberCount += result.modifiedCount || 0;
        community.pendingRequestCount = 0;
      }
    }
  }

  await community.save();
  await community.populate('category', 'label icon');
  return new ApiResponse(200, serializeCommunity(community, membership), 'Community updated').send(res);
});

const deleteCommunity = catchAsync(async (req, res) => {
  const community = await cs.findCommunity(req.params.id);
  if (req.user.role !== 'admin') {
    const membership = await cs.getMembership(community._id, req.user._id);
    cs.assertOwner(membership);
  }
  await Promise.all([
    CommunityMembership.deleteMany({ community: community._id }),
    CommunityPost.deleteMany({ community: community._id }),
    CommunityComment.deleteMany({ community: community._id }),
    CommunityMessage.deleteMany({ community: community._id }),
  ]);
  await community.deleteOne();
  return new ApiResponse(200, null, 'Community deleted').send(res);
});

/** Join / leave / request / cancel request — one toggle endpoint. */
const toggleMembership = catchAsync(async (req, res) => {
  const community = await cs.findCommunity(req.params.id);
  const existing = await cs.getMembership(community._id, req.user._id);

  if (existing?.status === 'banned') throw ApiError.forbidden('You have been removed from this community');

  if (existing?.status === 'active') {
    if (existing.role === 'admin') {
      throw ApiError.badRequest("You own this community — delete it or make someone else the owner before leaving");
    }
    await existing.deleteOne();
    community.memberCount = Math.max(0, community.memberCount - 1);
    await community.save();
    return new ApiResponse(200, { joined: false, status: null }, 'Left community').send(res);
  }

  if (existing?.status === 'pending') {
    await existing.deleteOne();
    community.pendingRequestCount = Math.max(0, community.pendingRequestCount - 1);
    await community.save();
    return new ApiResponse(200, { joined: false, status: null }, 'Request cancelled').send(res);
  }

  if (community.visibility === 'private') {
    await CommunityMembership.create({ community: community._id, user: req.user._id, status: 'pending' });
    community.pendingRequestCount += 1;
    await community.save();

    const mods = await cs.moderatorUserIds(community._id);
    cs.notifyMany(mods, {
      fromUser: req.user._id,
      type: 'community_join_request',
      title: 'New join request',
      message: `${req.user.name} wants to join ${community.name}.`,
      relatedModel: 'Community',
      relatedId: community._id,
    });
    return new ApiResponse(200, { joined: false, status: 'pending' }, 'Request sent').send(res);
  }

  await CommunityMembership.create({ community: community._id, user: req.user._id });
  community.memberCount += 1;
  await community.save();
  return new ApiResponse(200, { joined: true, status: 'active' }, 'Joined community').send(res);
});

const updateMySettings = catchAsync(async (req, res) => {
  const community = await cs.findCommunity(req.params.id);
  const membership = await cs.getMembership(community._id, req.user._id);
  cs.assertMember(membership);
  if (req.body.notificationsMuted !== undefined) membership.notificationsMuted = toBool(req.body.notificationsMuted);
  await membership.save();
  return new ApiResponse(200, { notificationsMuted: membership.notificationsMuted }, 'Settings saved').send(res);
});

// --- members -------------------------------------------------------------

const listMembers = catchAsync(async (req, res) => {
  const community = await cs.findCommunity(req.params.id);
  const membership = await cs.getMembership(community._id, req.user?._id);
  const status = ['pending', 'banned'].includes(req.query.status) ? req.query.status : 'active';

  if (status === 'active') cs.assertCanView(community, membership);
  else cs.assertModerator(membership);

  const { page, limit, skip } = pageParams(req.query, 30, 100);
  const match = { community: community._id, status };
  if (req.query.search) {
    const users = await User.find({ name: new RegExp(escapeRegex(req.query.search), 'i') }).select('_id').limit(200);
    match.user = { $in: users.map((u) => u._id) };
  }

  const [rows, total] = await Promise.all([
    CommunityMembership.aggregate([
      { $match: match },
      {
        $addFields: {
          roleRank: {
            $switch: {
              branches: [
                { case: { $eq: ['$role', 'admin'] }, then: 0 },
                { case: { $eq: ['$role', 'moderator'] }, then: 1 },
              ],
              default: 2,
            },
          },
        },
      },
      { $sort: { roleRank: 1, createdAt: 1 } },
      { $skip: skip },
      { $limit: limit },
    ]),
    CommunityMembership.countDocuments(match),
  ]);
  await CommunityMembership.populate(rows, { path: 'user', select: cs.AUTHOR_FIELDS });

  const members = rows
    .filter((r) => r.user)
    .map((r) => ({ user: r.user, role: r.role, status: r.status, joinedAt: r.createdAt }));
  return new ApiResponse(200, { members, total, page, pages: Math.ceil(total / limit) }, 'Members fetched').send(res);
});

const manageMember = catchAsync(async (req, res) => {
  const { action } = req.body;
  const community = await cs.findCommunity(req.params.id);
  const actor = await cs.getMembership(community._id, req.user._id);
  cs.assertModerator(actor);

  const target = await CommunityMembership.findOne({ community: community._id, user: req.params.userId });
  if (!target) throw ApiError.notFound('Member not found');
  if (String(target.user) === String(req.user._id)) throw ApiError.badRequest("You can't do that to yourself");
  if (target.role === 'admin') throw ApiError.forbidden("The owner can't be changed");

  const actorIsOwner = actor.role === 'admin';
  const requireOwnerFor = () => {
    if (!actorIsOwner) throw ApiError.forbidden('Only the owner can do this');
  };
  // Moderators can only act on regular members.
  if (!actorIsOwner && target.role === 'moderator') throw ApiError.forbidden('Only the owner can manage moderators');

  switch (action) {
    case 'approve': {
      if (target.status !== 'pending') throw ApiError.badRequest('This user has no pending request');
      target.status = 'active';
      await target.save();
      community.pendingRequestCount = Math.max(0, community.pendingRequestCount - 1);
      community.memberCount += 1;
      await community.save();
      await notificationService.notify({
        userId: target.user,
        fromUser: req.user._id,
        type: 'community_join_approved',
        title: 'Request approved',
        message: `You're now a member of ${community.name}.`,
        relatedModel: 'Community',
        relatedId: community._id,
      });
      break;
    }
    case 'reject': {
      if (target.status !== 'pending') throw ApiError.badRequest('This user has no pending request');
      await target.deleteOne();
      community.pendingRequestCount = Math.max(0, community.pendingRequestCount - 1);
      await community.save();
      break;
    }
    case 'make_moderator': {
      requireOwnerFor();
      if (target.status !== 'active') throw ApiError.badRequest('Only active members can be moderators');
      target.role = 'moderator';
      await target.save();
      break;
    }
    case 'remove_moderator': {
      requireOwnerFor();
      target.role = 'member';
      await target.save();
      break;
    }
    case 'remove':
    case 'ban': {
      const wasActive = target.status === 'active';
      const wasPending = target.status === 'pending';
      if (action === 'ban') {
        target.status = 'banned';
        target.role = 'member';
        await target.save();
      } else {
        await target.deleteOne();
      }
      if (wasActive) community.memberCount = Math.max(0, community.memberCount - 1);
      if (wasPending) community.pendingRequestCount = Math.max(0, community.pendingRequestCount - 1);
      await community.save();
      break;
    }
    case 'unban': {
      if (target.status !== 'banned') throw ApiError.badRequest('This user is not banned');
      await target.deleteOne();
      break;
    }
    default:
      throw ApiError.badRequest('Unknown action');
  }

  return new ApiResponse(200, { action }, 'Member updated').send(res);
});

// --- posts ---------------------------------------------------------------

const listPosts = catchAsync(async (req, res) => {
  const community = await cs.findCommunity(req.params.id);
  const membership = await cs.getMembership(community._id, req.user?._id);
  cs.assertCanView(community, membership);

  const { page, limit, skip } = pageParams(req.query, 15, 30);
  const sortBy = req.query.sort === 'top' ? { likeCount: -1, createdAt: -1 } : { isPinned: -1, pinnedAt: -1, createdAt: -1 };
  const filter = { community: community._id };
  if (req.query.announcements === 'true') filter.isAnnouncement = true;

  const [posts, total] = await Promise.all([
    CommunityPost.find(filter).populate('author', cs.AUTHOR_FIELDS).sort(sortBy).skip(skip).limit(limit),
    CommunityPost.countDocuments(filter),
  ]);

  return new ApiResponse(
    200,
    { posts: await serializePosts(posts, req.user?._id), total, page, pages: Math.ceil(total / limit) },
    'Posts fetched'
  ).send(res);
});

function parsePoll(raw) {
  if (!raw) return null;
  let poll = raw;
  if (typeof raw === 'string') {
    try {
      poll = JSON.parse(raw);
    } catch {
      throw ApiError.badRequest('Poll data is invalid');
    }
  }
  const options = (Array.isArray(poll.options) ? poll.options : [])
    .map((o) => String(typeof o === 'string' ? o : o?.text || '').trim())
    .filter(Boolean);
  const unique = [...new Set(options.map((o) => o.toLowerCase()))];
  if (options.length < 2 || options.length > 6) throw ApiError.badRequest('A poll needs 2 to 6 options');
  if (unique.length !== options.length) throw ApiError.badRequest('Poll options must be different');
  if (options.some((o) => o.length > 80)) throw ApiError.badRequest('Poll options can be up to 80 characters');

  const hours = Math.min(24 * 30, Math.max(1, Number(poll.durationHours) || 24 * 3));
  return {
    question: String(poll.question || '').trim().slice(0, 200),
    options: options.map((text) => ({ text, votes: 0 })),
    voters: [],
    totalVotes: 0,
    endsAt: new Date(Date.now() + hours * 3600 * 1000),
  };
}

const createPost = catchAsync(async (req, res) => {
  const community = await cs.findCommunity(req.params.id);
  const membership = await cs.getMembership(community._id, req.user._id);
  cs.assertMember(membership);

  const isMod = cs.isModRole(membership.role);
  if (community.postPermission === 'moderators' && !isMod) {
    throw ApiError.forbidden('Only the owner and moderators can post in this community');
  }
  const isAnnouncement = toBool(req.body.isAnnouncement);
  if (isAnnouncement && !isMod) throw ApiError.forbidden('Only the owner and moderators can post announcements');

  const text = String(req.body.text || '').trim();
  const mediaItems = (req.files || []).map((file) => ({
    url: file.path,
    type: file.mimetype.startsWith('video') ? 'video' : 'image',
  }));
  const poll = parsePoll(req.body.poll);
  if (!text && mediaItems.length === 0 && !poll) throw ApiError.badRequest('Write something, add media or create a poll');
  if (text.length > 3000) throw ApiError.badRequest('Posts can be up to 3000 characters');

  const mentions = await cs.validMentions(community._id, parseList(req.body.mentions), req.user._id);

  const post = await CommunityPost.create({
    community: community._id,
    author: req.user._id,
    text,
    mediaItems,
    poll,
    isAnnouncement,
    mentions,
  });
  await Community.updateOne({ _id: community._id }, { $inc: { discussionCount: 1 }, lastActivityAt: new Date() });
  await post.populate('author', cs.AUTHOR_FIELDS);

  const preview = text ? `: "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"` : '';
  if (mentions.length) {
    cs.notifyMany(mentions, {
      fromUser: req.user._id,
      type: 'community_mention',
      title: `Mentioned in ${community.name}`,
      message: `${req.user.name} mentioned you in a post${preview}`,
      relatedModel: 'CommunityPost',
      relatedId: post._id,
    });
  }
  if (isAnnouncement) {
    const members = await CommunityMembership.find({
      community: community._id,
      status: 'active',
      notificationsMuted: { $ne: true },
      user: { $ne: req.user._id },
    }).select('user');
    cs.notifyMany(
      members.map((m) => m.user),
      {
        fromUser: req.user._id,
        type: 'community_announcement',
        title: `📣 ${community.name}`,
        message: text ? text.slice(0, 140) : 'New announcement',
        relatedModel: 'CommunityPost',
        relatedId: post._id,
      }
    );
  }

  const [serialized] = await serializePosts([post], req.user._id);
  return new ApiResponse(201, serialized, 'Post published').send(res);
});

const getPost = catchAsync(async (req, res) => {
  const { post, community, membership } = await loadPostWithAccess(req.params.postId, req.user?._id);
  cs.assertCanView(community, membership);
  await post.populate('author', cs.AUTHOR_FIELDS);
  const [serialized] = await serializePosts([post], req.user?._id);
  serialized.community = serializeCommunity(community, membership);
  return new ApiResponse(200, serialized, 'Post fetched').send(res);
});

const updatePost = catchAsync(async (req, res) => {
  const { post } = await loadPostWithAccess(req.params.postId, req.user._id);
  if (String(post.author) !== String(req.user._id)) throw ApiError.forbidden('You can only edit your own posts');
  const text = String(req.body.text ?? '').trim();
  if (!text && post.mediaItems.length === 0 && !post.poll?.options?.length) throw ApiError.badRequest("A post can't be empty");
  if (text.length > 3000) throw ApiError.badRequest('Posts can be up to 3000 characters');
  post.text = text;
  post.editedAt = new Date();
  await post.save();
  await post.populate('author', cs.AUTHOR_FIELDS);
  const [serialized] = await serializePosts([post], req.user._id);
  return new ApiResponse(200, serialized, 'Post updated').send(res);
});

const deletePost = catchAsync(async (req, res) => {
  const { post, community, membership } = await loadPostWithAccess(req.params.postId, req.user._id);
  const isAuthor = String(post.author) === String(req.user._id);
  const isMod = cs.isActive(membership) && cs.isModRole(membership.role);
  if (!isAuthor && !isMod && req.user.role !== 'admin') throw ApiError.forbidden('You can’t delete this post');

  await CommunityComment.deleteMany({ post: post._id });
  await post.deleteOne();
  await Community.updateOne({ _id: community._id, discussionCount: { $gt: 0 } }, { $inc: { discussionCount: -1 } });
  return new ApiResponse(200, null, 'Post deleted').send(res);
});

const togglePostLike = catchAsync(async (req, res) => {
  const { post, membership } = await loadPostWithAccess(req.params.postId, req.user._id);
  cs.assertMember(membership);

  const alreadyLiked = await CommunityPost.exists({ _id: post._id, likedBy: req.user._id });
  const update = alreadyLiked
    ? { $pull: { likedBy: req.user._id }, $inc: { likeCount: -1 } }
    : { $addToSet: { likedBy: req.user._id }, $inc: { likeCount: 1 } };
  const updated = await CommunityPost.findByIdAndUpdate(post._id, update, { new: true });
  return new ApiResponse(200, { liked: !alreadyLiked, likeCount: Math.max(0, updated.likeCount) }, 'Updated').send(res);
});

const togglePin = catchAsync(async (req, res) => {
  const { post, community, membership } = await loadPostWithAccess(req.params.postId, req.user._id);
  cs.assertModerator(membership);

  if (!post.isPinned) {
    const pinned = await CommunityPost.countDocuments({ community: community._id, isPinned: true });
    if (pinned >= MAX_PINNED) throw ApiError.badRequest(`You can pin up to ${MAX_PINNED} posts — unpin one first`);
  }
  post.isPinned = !post.isPinned;
  post.pinnedAt = post.isPinned ? new Date() : null;
  await post.save();
  return new ApiResponse(200, { isPinned: post.isPinned }, post.isPinned ? 'Post pinned' : 'Post unpinned').send(res);
});

const votePoll = catchAsync(async (req, res) => {
  const { post, membership } = await loadPostWithAccess(req.params.postId, req.user._id);
  cs.assertMember(membership);
  if (!post.poll || !post.poll.options?.length) throw ApiError.badRequest('This post has no poll');
  if (post.poll.endsAt && post.poll.endsAt < new Date()) throw ApiError.badRequest('This poll has ended');

  const optionIndex = Number(req.body.optionIndex);
  if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= post.poll.options.length) {
    throw ApiError.badRequest('Pick a valid option');
  }

  // Atomic: only succeeds if this user hasn't voted yet.
  const updated = await CommunityPost.findOneAndUpdate(
    { _id: post._id, 'poll.voters.user': { $ne: req.user._id } },
    {
      $push: { 'poll.voters': { user: req.user._id, optionIndex } },
      $inc: { [`poll.options.${optionIndex}.votes`]: 1, 'poll.totalVotes': 1 },
    },
    { new: true }
  );
  if (!updated) throw ApiError.conflict('You have already voted');

  const poll = updated.toObject().poll;
  delete poll.voters;
  poll.myVote = optionIndex;
  poll.isClosed = false;
  return new ApiResponse(200, poll, 'Vote counted').send(res);
});

// --- comments ------------------------------------------------------------

const listComments = catchAsync(async (req, res) => {
  const { post, community, membership } = await loadPostWithAccess(req.params.postId, req.user?._id);
  cs.assertCanView(community, membership);

  const { page, limit, skip } = pageParams(req.query, 30, 50);
  const filter = { post: post._id, parentComment: null };
  const [roots, total] = await Promise.all([
    CommunityComment.find(filter).populate('author', cs.AUTHOR_FIELDS).sort({ createdAt: 1 }).skip(skip).limit(limit),
    CommunityComment.countDocuments(filter),
  ]);
  const replies = await CommunityComment.find({ parentComment: { $in: roots.map((r) => r._id) } })
    .populate('author', cs.AUTHOR_FIELDS)
    .sort({ createdAt: 1 });

  const all = await serializeComments([...roots, ...replies], req.user?._id);
  const byId = new Map(all.map((c) => [String(c._id), c]));
  const result = roots.map((r) => {
    const root = byId.get(String(r._id));
    root.replies = all.filter((c) => c.parentComment && String(c.parentComment) === String(r._id));
    return root;
  });

  return new ApiResponse(200, { comments: result, total, page, pages: Math.ceil(total / limit) }, 'Comments fetched').send(res);
});

const addComment = catchAsync(async (req, res) => {
  const { post, community, membership } = await loadPostWithAccess(req.params.postId, req.user._id);
  cs.assertMember(membership);

  const text = String(req.body.text || '').trim();
  if (!text) throw ApiError.badRequest('Write a comment');
  if (text.length > 1000) throw ApiError.badRequest('Comments can be up to 1000 characters');

  let parent = null;
  if (req.body.parentId) {
    parent = await CommunityComment.findById(req.body.parentId);
    if (!parent || String(parent.post) !== String(post._id)) throw ApiError.notFound('Comment not found');
    // Keep threads two levels deep.
    if (parent.parentComment) parent = await CommunityComment.findById(parent.parentComment);
  }

  const mentions = await cs.validMentions(community._id, parseList(req.body.mentions), req.user._id);
  const comment = await CommunityComment.create({
    post: post._id,
    community: community._id,
    author: req.user._id,
    parentComment: parent?._id || null,
    text,
    mentions,
  });
  await CommunityPost.updateOne({ _id: post._id }, { $inc: { commentCount: 1 } });
  if (parent) await CommunityComment.updateOne({ _id: parent._id }, { $inc: { replyCount: 1 } });
  cs.touch(community._id).catch(() => {});
  await comment.populate('author', cs.AUTHOR_FIELDS);

  const snippet = `"${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`;
  const notified = new Set([String(req.user._id)]);
  const send = (userId, title, message, type = 'community_reply') => {
    if (!userId || notified.has(String(userId))) return;
    notified.add(String(userId));
    notificationService
      .notify({ userId, fromUser: req.user._id, type, title, message, relatedModel: 'CommunityPost', relatedId: post._id })
      .catch(() => {});
  };
  if (parent) send(parent.author, `Reply in ${community.name}`, `${req.user.name} replied to your comment: ${snippet}`);
  send(post.author, `New comment in ${community.name}`, `${req.user.name} commented on your post: ${snippet}`);
  mentions.forEach((m) =>
    send(m, `Mentioned in ${community.name}`, `${req.user.name} mentioned you in a comment: ${snippet}`, 'community_mention')
  );

  const [serialized] = await serializeComments([comment], req.user._id);
  serialized.replies = [];
  return new ApiResponse(201, serialized, 'Comment added').send(res);
});

const deleteComment = catchAsync(async (req, res) => {
  const comment = await CommunityComment.findById(req.params.commentId);
  if (!comment) throw ApiError.notFound('Comment not found');
  const membership = await cs.getMembership(comment.community, req.user._id);
  const isAuthor = String(comment.author) === String(req.user._id);
  const isMod = cs.isActive(membership) && cs.isModRole(membership.role);
  if (!isAuthor && !isMod && req.user.role !== 'admin') throw ApiError.forbidden('You can’t delete this comment');

  let removed = 1;
  if (!comment.parentComment) {
    const result = await CommunityComment.deleteMany({ parentComment: comment._id });
    removed += result.deletedCount || 0;
  } else {
    await CommunityComment.updateOne({ _id: comment.parentComment, replyCount: { $gt: 0 } }, { $inc: { replyCount: -1 } });
  }
  await comment.deleteOne();
  await CommunityPost.updateOne({ _id: comment.post }, { $inc: { commentCount: -removed } });
  await CommunityPost.updateOne({ _id: comment.post, commentCount: { $lt: 0 } }, { commentCount: 0 });

  return new ApiResponse(200, { removed }, 'Comment deleted').send(res);
});

const toggleCommentLike = catchAsync(async (req, res) => {
  const comment = await CommunityComment.findById(req.params.commentId);
  if (!comment) throw ApiError.notFound('Comment not found');
  const membership = await cs.getMembership(comment.community, req.user._id);
  cs.assertMember(membership);

  const alreadyLiked = await CommunityComment.exists({ _id: comment._id, likedBy: req.user._id });
  const update = alreadyLiked
    ? { $pull: { likedBy: req.user._id }, $inc: { likeCount: -1 } }
    : { $addToSet: { likedBy: req.user._id }, $inc: { likeCount: 1 } };
  const updated = await CommunityComment.findByIdAndUpdate(comment._id, update, { new: true });
  return new ApiResponse(200, { liked: !alreadyLiked, likeCount: Math.max(0, updated.likeCount) }, 'Updated').send(res);
});

// --- chat ----------------------------------------------------------------

const getChat = catchAsync(async (req, res) => {
  const community = await cs.findCommunity(req.params.id);
  const membership = await cs.getMembership(community._id, req.user._id);
  cs.assertMember(membership);
  if (!community.chatEnabled) throw ApiError.forbidden('Chat is turned off in this community');

  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const filter = { community: community._id };
  if (req.query.before) {
    const before = new Date(req.query.before);
    if (!Number.isNaN(before.getTime())) filter.createdAt = { $lt: before };
  }

  const messages = await CommunityMessage.find(filter)
    .populate('sender', cs.AUTHOR_FIELDS)
    .sort({ createdAt: -1 })
    .limit(limit + 1);
  const hasMore = messages.length > limit;
  const page = messages.slice(0, limit).reverse().map(serializeMessage);

  return new ApiResponse(200, { messages: page, hasMore }, 'Messages fetched').send(res);
});

const sendChat = catchAsync(async (req, res) => {
  const message = await cs.createChatMessage(req.params.id, req.user._id, req.body.text);
  return new ApiResponse(201, message, 'Message sent').send(res);
});

const markChatRead = catchAsync(async (req, res) => {
  const community = await cs.findCommunity(req.params.id);
  const membership = await cs.getMembership(community._id, req.user._id);
  cs.assertMember(membership);
  membership.lastReadChatAt = new Date();
  await membership.save();
  return new ApiResponse(200, null, 'Marked as read').send(res);
});

const deleteChatMessage = catchAsync(async (req, res) => {
  const community = await cs.findCommunity(req.params.id);
  const membership = await cs.getMembership(community._id, req.user._id);
  const message = await CommunityMessage.findOne({ _id: req.params.messageId, community: community._id });
  if (!message) throw ApiError.notFound('Message not found');
  const isSender = String(message.sender) === String(req.user._id);
  const isMod = cs.isActive(membership) && cs.isModRole(membership.role);
  if (!isSender && !isMod && req.user.role !== 'admin') throw ApiError.forbidden('You can’t delete this message');

  message.isRemoved = true;
  await message.save();
  cs.emitToCommunity(community._id, 'community_message_removed', {
    communityId: String(community._id),
    messageId: String(message._id),
  });
  return new ApiResponse(200, null, 'Message removed').send(res);
});

// --- platform admin --------------------------------------------------------

const adminListCommunities = catchAsync(async (req, res) => {
  const { page, limit, skip } = pageParams(req.query, 30, 100);
  const filter = {};
  if (req.query.search) filter.name = new RegExp(escapeRegex(req.query.search), 'i');
  const [communities, total] = await Promise.all([
    Community.find(filter)
      .populate('createdBy', 'name email avatarUrl')
      .populate('category', 'label')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Community.countDocuments(filter),
  ]);
  return new ApiResponse(200, { communities, total, page, pages: Math.ceil(total / limit) }, 'Communities fetched').send(res);
});

const adminUpdateCommunity = catchAsync(async (req, res) => {
  const community = await Community.findById(req.params.id);
  if (!community) throw ApiError.notFound('Community not found');
  if (req.body.isVerified !== undefined) community.isVerified = toBool(req.body.isVerified);
  if (req.body.isFeatured !== undefined) community.isFeatured = toBool(req.body.isFeatured);
  await community.save();
  return new ApiResponse(200, community, 'Community updated').send(res);
});

module.exports = {
  listCommunities,
  getMyCommunities,
  getCommunity,
  createCommunity,
  updateCommunity,
  deleteCommunity,
  toggleMembership,
  updateMySettings,
  listMembers,
  manageMember,
  listPosts,
  createPost,
  getPost,
  updatePost,
  deletePost,
  togglePostLike,
  togglePin,
  votePoll,
  listComments,
  addComment,
  deleteComment,
  toggleCommentLike,
  getChat,
  sendChat,
  markChatRead,
  deleteChatMessage,
  adminListCommunities,
  adminUpdateCommunity,
};