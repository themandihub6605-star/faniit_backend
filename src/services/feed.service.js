const { CreatorProfile, BrandProfile, User } = require('../models');
const { ROLES, VERIFICATION_STATUS } = require('../constants/enums');
const ApiError = require('../utils/apiError');

// Shared by posts, reels and stories: who is posting, and the one "author"
// shape every screen shows (creator or brand).
//
//   author: { _id (user id), name, avatarUrl, role, profileId, slug, verified, isFollowing }
//
// Posts also keep the old `creator: { _id, slug, user: { name, avatarUrl }, isFollowing }`
// field so app versions released before brand posts keep working.

/** The profile the logged-in user posts as. Creators and brands only. */
async function resolvePoster(user) {
  if (user.role === ROLES.CREATOR) {
    const creator = await CreatorProfile.findOne({ user: user._id }).select('_id');
    if (!creator) throw ApiError.notFound('Creator profile not found');
    return { authorRole: 'creator', creator: creator._id, brand: null };
  }
  if (user.role === ROLES.BRAND) {
    const brand = await BrandProfile.findOne({ user: user._id }).select('_id');
    if (!brand) throw ApiError.notFound('Brand profile not found');
    return { authorRole: 'brand', creator: null, brand: brand._id };
  }
  throw ApiError.forbidden('Only creators and brands can post');
}

/** Profile filter for "this account's posts" ({ creator } or { brand }). */
function ownerFilter(poster) {
  return poster.creator ? { creator: poster.creator } : { brand: poster.brand };
}

/** One media item from an uploaded file (duration and width ÷ height come from the app). */
function mediaFromFile(file, duration = 0, aspectRatio = null) {
  const isVideo = file.mimetype.startsWith('video');
  const ratio = Number(aspectRatio);
  return {
    url: file.path,
    type: isVideo ? 'video' : 'image',
    thumbnailUrl: isVideo ? file.thumbnailUrl || '' : '',
    duration: isVideo ? Math.max(0, Math.round(Number(duration) || 0)) : 0,
    aspectRatio: aspectRatio != null && Number.isFinite(ratio) && ratio >= 0.2 && ratio <= 5 ? Math.round(ratio * 1000) / 1000 : null,
  };
}

/** Parses `durations` sent as a JSON array or comma list in multipart forms. */
function parseDurations(raw) {
  if (Array.isArray(raw)) return raw.map(Number);
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(Number);
    } catch {
      return raw.split(',').map(Number);
    }
  }
  return [];
}

// Populate specs: creator → user, brand → user.
const POPULATE = [
  { path: 'creator', select: 'slug user followers verificationStatus', populate: { path: 'user', select: 'name avatarUrl' } },
  { path: 'brand', select: 'slug user followers verificationStatus companyName logoUrl', populate: { path: 'user', select: 'name avatarUrl' } },
];

function followsProfile(profile, userId) {
  return Boolean(userId && profile?.followers?.some((f) => String(f) === String(userId)));
}

/** Unified author for a populated post/story. */
function authorOf(doc, userId) {
  if (doc.brand && doc.brand.slug) {
    const b = doc.brand;
    return {
      _id: b.user?._id || doc.author,
      name: b.companyName || b.user?.name || 'Brand',
      avatarUrl: b.logoUrl || b.user?.avatarUrl || '',
      role: 'brand',
      profileId: b._id,
      slug: b.slug,
      verified: b.verificationStatus === VERIFICATION_STATUS.VERIFIED,
      isFollowing: followsProfile(b, userId),
    };
  }
  const c = doc.creator;
  if (!c) return null;
  return {
    _id: c.user?._id || doc.author,
    name: c.user?.name || 'Creator',
    avatarUrl: c.user?.avatarUrl || '',
    role: 'creator',
    profileId: c._id,
    slug: c.slug,
    verified: c.verificationStatus === VERIFICATION_STATUS.VERIFIED,
    isFollowing: followsProfile(c, userId),
  };
}

/** Attaches likePreview (first 3 likers) with one User query per page. */
async function withLikePreview(posts) {
  const ids = new Set();
  posts.forEach((p) => (p.likedBy || []).slice(0, 3).forEach((id) => ids.add(String(id))));
  if (!ids.size) return posts.map((p) => ({ ...p, likePreview: [] }));
  const users = await User.find({ _id: { $in: [...ids] } }).select('name avatarUrl').lean();
  const map = new Map(users.map((u) => [String(u._id), u]));
  return posts.map((p) => ({ ...p, likePreview: (p.likedBy || []).slice(0, 3).map((id) => map.get(String(id))).filter(Boolean) }));
}

/** Lean posts (populated with POPULATE) → API shape. */
async function serializePosts(posts, userId) {
  const shaped = posts.map((p) => {
    const author = authorOf(p, userId);
    const liked = Boolean(userId && (p.likedBy || []).some((id) => String(id) === String(userId)));
    return {
      _id: p._id,
      kind: p.kind || 'post',
      mediaItems: p.mediaItems || [],
      caption: p.caption || '',
      likeCount: p.likeCount || 0,
      viewCount: p.viewCount || 0,
      likedBy: p.likedBy || [],
      isLiked: liked,
      isSaved: Boolean(userId && (p.savedBy || []).some((id) => String(id) === String(userId))),
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      author,
      // Old app versions read `creator` — kept with the same shape.
      creator: author ? { _id: author.profileId, slug: author.slug, user: { _id: author._id, name: author.name, avatarUrl: author.avatarUrl }, isFollowing: author.isFollowing } : null,
    };
  });
  const withLikes = await withLikePreview(shaped);
  // likedBy can be thousands of ids. Send only the viewer's own id (when they
  // liked it) — old app versions check likedBy.contains(me), new ones use isLiked.
  return withLikes.map((p) => ({ ...p, likedBy: p.isLiked ? [String(userId)] : [] }));
}

module.exports = { resolvePoster, ownerFilter, mediaFromFile, parseDurations, POPULATE, authorOf, serializePosts };