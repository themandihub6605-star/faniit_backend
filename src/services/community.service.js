const { Community, CommunityMembership, User } = require('../models');
const ApiError = require('../utils/apiError');
const notificationService = require('./notification.service');

const MOD_ROLES = ['moderator', 'admin'];

function isModRole(role) {
  return MOD_ROLES.includes(role);
}

/** Membership of a user in a community, or null. A paid membership whose
 * time ran out is switched to `expired` here, so every access check below
 * sees the right status. */
async function getMembership(communityId, userId) {
  if (!userId) return null;
  const membership = await CommunityMembership.findOne({ community: communityId, user: userId });
  if (membership) {
    // Lazy — communityPaid.service requires this file's models too.
    const paid = require('./communityPaid.service');
    if (paid.isExpired(membership)) await paid.expireMembership(membership);
  }
  return membership;
}

async function findCommunity(idOrSlug) {
  const byId = /^[a-f\d]{24}$/i.test(String(idOrSlug));
  const community = byId ? await Community.findById(idOrSlug) : await Community.findOne({ slug: idOrSlug });
  if (!community) throw ApiError.notFound('Community not found');
  return community;
}

function isActive(membership) {
  return Boolean(membership && membership.status === 'active');
}

/** Public free communities are readable by anyone; private and paid ones by active members. */
function canView(community, membership) {
  return (community.visibility === 'public' && !community.isPaid) || isActive(membership);
}

function assertCanView(community, membership) {
  if (isActive(membership)) return;
  if (membership?.status === 'banned') throw ApiError.forbidden('You have been removed from this community');
  if (community.isPaid) {
    throw new ApiError(
      402,
      membership?.status === 'expired' ? 'Your membership ended — renew to see the posts' : 'This is a paid community — pick a plan to see the posts',
      [],
      'COMMUNITY_PAYMENT_REQUIRED'
    );
  }
  if (community.visibility !== 'public') {
    throw ApiError.forbidden('This community is private — join to see its posts', [], 'COMMUNITY_PRIVATE');
  }
}

/** Paid community, not a member (and not banned): may read the free posts only. */
function isPreviewOnly(community, membership) {
  return Boolean(community.isPaid) && !isActive(membership) && membership?.status !== 'banned';
}

/** Reading one post: free posts of a paid community are open to everyone. */
function assertCanViewPost(community, membership, post) {
  if (post?.isFree && isPreviewOnly(community, membership)) return;
  assertCanView(community, membership);
}

function assertMember(membership) {
  if (membership?.status === 'banned') throw ApiError.forbidden('You have been removed from this community');
  if (membership?.status === 'expired') throw new ApiError(402, 'Your membership ended — renew to take part', [], 'COMMUNITY_PAYMENT_REQUIRED');
  if (!isActive(membership)) throw ApiError.forbidden('Join this community to take part', [], 'COMMUNITY_JOIN_REQUIRED');
}

function assertModerator(membership) {
  if (!isActive(membership) || !isModRole(membership.role)) {
    throw ApiError.forbidden('Only the owner and moderators can do this');
  }
}

function assertOwner(membership) {
  if (!isActive(membership) || membership.role !== 'admin') {
    throw ApiError.forbidden('Only the community owner can do this');
  }
}

/** Keeps only mentioned users who are active members of the community. */
async function validMentions(communityId, userIds, excludeUserId) {
  const ids = [...new Set((Array.isArray(userIds) ? userIds : []).map(String))]
    .filter((id) => /^[a-f\d]{24}$/i.test(id) && id !== String(excludeUserId))
    .slice(0, 20);
  if (ids.length === 0) return [];
  const members = await CommunityMembership.find({ community: communityId, user: { $in: ids }, status: 'active' }).select('user');
  return members.map((m) => m.user);
}

/** Fire-and-forget notifications to many users (announcements). */
function notifyMany(userIds, payload) {
  (async () => {
    for (const userId of userIds) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await notificationService.notify({ userId, ...payload });
      } catch (err) {
        console.error('[community] notify failed:', err.message);
      }
    }
  })();
}

async function moderatorUserIds(communityId) {
  const mods = await CommunityMembership.find({ community: communityId, status: 'active', role: { $in: MOD_ROLES } }).select('user');
  return mods.map((m) => m.user);
}

async function touch(communityId) {
  await Community.updateOne({ _id: communityId }, { lastActivityAt: new Date() });
}

function communityRoom(communityId) {
  return `community:${communityId}`;
}

/** Broadcast to everyone with the community chat open. */
function emitToCommunity(communityId, event, payload) {
  try {
    // Lazy require — config/socket requires this service.
    const { getIO } = require('../config/socket');
    getIO().to(communityRoom(communityId)).emit(event, payload);
  } catch (err) {
    console.error('[community] socket emit failed:', err.message);
  }
}

/** Saves a chat message and pushes it live. Used by REST and Socket.IO. */
async function createChatMessage(communityIdOrSlug, userId, rawText) {
  const { CommunityMessage } = require('../models');
  const community = await findCommunity(communityIdOrSlug);
  const membership = await getMembership(community._id, userId);
  assertMember(membership);
  if (!community.chatEnabled) throw ApiError.forbidden('Chat is turned off in this community');

  const text = String(rawText || '').trim();
  if (!text) throw ApiError.badRequest('Message is empty');
  if (text.length > 2000) throw ApiError.badRequest('Messages can be up to 2000 characters');

  const message = await CommunityMessage.create({ community: community._id, sender: userId, text });
  await message.populate('sender', AUTHOR_FIELDS);
  membership.lastReadChatAt = new Date();
  await membership.save();
  touch(community._id).catch(() => {});

  const payload = message.toObject();
  emitToCommunity(community._id, 'community_message', { communityId: String(community._id), message: payload });
  return payload;
}

/** Public shape of an author. */
const AUTHOR_FIELDS = 'name avatarUrl role';

async function authorFor(userId) {
  return User.findById(userId).select(AUTHOR_FIELDS);
}

module.exports = {
  MOD_ROLES,
  AUTHOR_FIELDS,
  isModRole,
  isActive,
  canView,
  getMembership,
  findCommunity,
  assertCanView,
  isPreviewOnly,
  assertCanViewPost,
  assertMember,
  assertModerator,
  assertOwner,
  validMentions,
  notifyMany,
  moderatorUserIds,
  touch,
  authorFor,
  communityRoom,
  emitToCommunity,
  createChatMessage,
};