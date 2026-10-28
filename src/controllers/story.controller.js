// File: src/controllers/story.controller.js
const mongoose = require('mongoose');
const { Story, User, CreatorProfile, BrandProfile } = require('../models');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');
const feed = require('../services/feed.service');
const blocks = require('../utils/blocks');

// 24-hour stories by creators and brands (one photo or video each).
//
//   POST   /stories            multipart `media` (1 file), caption, duration
//   GET    /stories            story rings for the feed: grouped by author,
//                              my own first, then unseen, then seen
//   GET    /stories/me         my active stories with view counts
//   GET    /stories/user/:id   one author's active stories (profile ring)
//   POST   /stories/:id/view   mark seen
//   GET    /stories/:id/viewers  who saw my story
//   DELETE /stories/:id

const MAX_ACTIVE = 30; // per account at once
const STORY_VIDEO_MAX_SECONDS = 60;
const AUTHORS_LIMIT = 40;

function active() {
  return { expiresAt: { $gt: new Date() } };
}

function storyView(s, userId) {
  return {
    _id: s._id,
    media: s.media,
    caption: s.caption || '',
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
    viewCount: s.viewCount || 0,
    seen: Boolean(userId && (s.viewers || []).some((v) => String(v) === String(userId))),
  };
}

/** Stories grouped into one ring per author. */
async function groupByAuthor(stories, userId) {
  const groups = new Map();
  for (const s of stories) {
    const key = String(s.author);
    if (!groups.has(key)) groups.set(key, { author: feed.authorOf(s, userId), stories: [] });
    groups.get(key).stories.push(storyView(s, userId));
  }
  return [...groups.values()]
    .filter((g) => g.author)
    .map((g) => ({
      ...g,
      stories: g.stories.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)), // oldest first, like Instagram
      hasUnseen: g.stories.some((s) => !s.seen),
      latestAt: g.stories.reduce((m, s) => (new Date(s.createdAt) > m ? new Date(s.createdAt) : m), new Date(0)),
      isMine: Boolean(userId && String(g.author._id) === String(userId)),
    }));
}

const createStory = catchAsync(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('Add a photo or video');
  const poster = await feed.resolvePoster(req.user);
  const count = await Story.countDocuments({ author: req.user._id, ...active() });
  if (count >= MAX_ACTIVE) throw ApiError.badRequest(`You can have up to ${MAX_ACTIVE} stories at a time`);

  const media = feed.mediaFromFile(req.file, req.body.duration);
  if (media.type === 'video' && media.duration > STORY_VIDEO_MAX_SECONDS) {
    throw ApiError.badRequest(`Story videos can be up to ${STORY_VIDEO_MAX_SECONDS} seconds`);
  }
  const story = await Story.create({
    author: req.user._id,
    ...poster,
    media,
    caption: String(req.body.caption || '').slice(0, 200),
  });
  const full = await Story.findById(story._id).populate(feed.POPULATE).lean();
  const [group] = await groupByAuthor([full], req.user._id);
  return new ApiResponse(201, group, 'Story added').send(res);
});

/** Rings for the feed. Mine first, then accounts I follow with unseen stories, then the rest. */
const getStoryFeed = catchAsync(async (req, res) => {
  const userId = req.user?._id;
  const hidden = await blocks.hiddenUserIds(userId);
  const stories = await Story.find(blocks.withoutAuthors(active(), hidden)).sort({ createdAt: -1 }).limit(600).populate(feed.POPULATE).lean();
  const groups = await groupByAuthor(stories, userId);
  const rank = (g) => (g.isMine ? 0 : g.author.isFollowing && g.hasUnseen ? 1 : g.hasUnseen ? 2 : g.author.isFollowing ? 3 : 4);
  groups.sort((a, b) => rank(a) - rank(b) || b.latestAt - a.latestAt);
  return new ApiResponse(200, groups.slice(0, AUTHORS_LIMIT), 'Stories fetched').send(res);
});

const getMyStories = catchAsync(async (req, res) => {
  const stories = await Story.find({ author: req.user._id, ...active() }).sort({ createdAt: 1 }).populate(feed.POPULATE).lean();
  const [group] = await groupByAuthor(stories, req.user._id);
  return new ApiResponse(200, group || null, 'Your stories fetched').send(res);
});

/** One author's active stories — `:id` is their user id. */
const getUserStories = catchAsync(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return new ApiResponse(200, null, 'Stories fetched').send(res);
  if (await blocks.isBlockedBetween(req.user?._id, req.params.id)) return new ApiResponse(200, null, 'Stories fetched').send(res);
  const stories = await Story.find({ author: req.params.id, ...active() }).sort({ createdAt: 1 }).populate(feed.POPULATE).lean();
  const [group] = await groupByAuthor(stories, req.user?._id);
  return new ApiResponse(200, group || null, 'Stories fetched').send(res);
});

const markViewed = catchAsync(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw ApiError.notFound('Story not found');
  const story = await Story.findOne({ _id: req.params.id, ...active() }).select('author');
  if (!story) throw ApiError.notFound('This story has expired');
  if (String(story.author) !== String(req.user._id)) {
    await Story.updateOne({ _id: story._id, viewers: { $ne: req.user._id } }, { $addToSet: { viewers: req.user._id }, $inc: { viewCount: 1 } });
  }
  return new ApiResponse(200, { seen: true }, 'Seen').send(res);
});

const getViewers = catchAsync(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw ApiError.notFound('Story not found');
  const story = await Story.findOne({ _id: req.params.id, author: req.user._id }).select('viewers');
  if (!story) throw ApiError.notFound('Story not found');
  const ids = story.viewers.slice(-200).reverse(); // latest first
  const [users, creators, brands] = await Promise.all([
    User.find({ _id: { $in: ids } }).select('name avatarUrl role').lean(),
    CreatorProfile.find({ user: { $in: ids } }).select('user slug followers').lean(),
    BrandProfile.find({ user: { $in: ids } }).select('user slug followers').lean(),
  ]);
  // Creators and brands get `profile` so the app can open it (fans have none).
  const me = String(req.user._id);
  const follows = (p) => (p.followers || []).some((f) => String(f) === me);
  const profiles = new Map([
    ...creators.map((c) => [String(c.user), { role: 'creator', profileId: c._id, slug: c.slug, isFollowing: follows(c) }]),
    ...brands.map((b) => [String(b.user), { role: 'brand', profileId: b._id, slug: b.slug, isFollowing: follows(b) }]),
  ]);
  const byId = new Map(users.map((u) => [String(u._id), u]));
  const list = ids
    .map((id) => byId.get(String(id)))
    .filter(Boolean)
    .map((u) => ({ ...u, profile: profiles.get(String(u._id)) || null }));
  return new ApiResponse(200, list, 'Viewers fetched').send(res);
});

const deleteStory = catchAsync(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw ApiError.notFound('Story not found');
  const story = await Story.findOneAndDelete({ _id: req.params.id, author: req.user._id });
  if (!story) throw ApiError.notFound('Story not found');
  return new ApiResponse(200, null, 'Story deleted').send(res);
});


module.exports = { createStory, getStoryFeed, getMyStories, getUserStories, markViewed, getViewers, deleteStory };