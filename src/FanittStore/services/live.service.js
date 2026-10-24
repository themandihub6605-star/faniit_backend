// File: src/FanittStore/services/live.service.js
const crypto = require('crypto');
const ApiError = require('../../utils/apiError');
const { LiveStream, StoreOrder } = require('../models');
const mongoose = require('mongoose');
const { LIVE_STATUS, ORDER_STATUS, LIMITS, LIVE_VISIBILITY, LIVE_PRIVATE_MODE } = require('../constants');
const livekit = require('./livekit.service');
const orderService = require('./order.service');
const { safeNotify } = require('./notify.service');
const log = require('../utils/logger');

// Live stream lifecycle: scheduled → live → ended (or cancelled).

function newRoomName(prefix) {
  return `${prefix}_${crypto.randomBytes(9).toString('hex')}`;
}

function newInviteCode() {
  return crypto.randomBytes(6).toString('base64url');
}

/** Host token (can publish). */
async function hostToken(live, user) {
  return livekit.createToken({
    roomName: live.roomName,
    identity: user._id,
    name: user.name,
    canPublish: true,
    canChat: true,
    ttl: LIMITS.LIVE_TOKEN_TTL,
    metadata: { role: 'host', liveId: String(live._id) },
  });
}

/** Viewer token (watch + chat/reactions). */
async function viewerToken(live, user) {
  return livekit.createToken({
    roomName: live.roomName,
    identity: user._id,
    name: user.name,
    canPublish: false,
    canChat: live.chatEnabled,
    ttl: LIMITS.LIVE_TOKEN_TTL,
    metadata: { role: 'viewer', liveId: String(live._id) },
  });
}

async function paidTicketHolders(live) {
  return StoreOrder.find({ itemId: live._id, status: ORDER_STATUS.PAID }).select('buyer');
}

/**
 * Followers of the host who are allowed to watch this live.
 * Public → every follower. Private → only followers who are in the live's
 * audience (hand-picked users or members of its community). Invite-link
 * lives are skipped: the link itself is the way in.
 */
async function followersWhoCanWatch(live) {
  const CreatorProfile = mongoose.models.CreatorProfile;
  if (!CreatorProfile) return [];
  const profile = await CreatorProfile.findOne({ user: live.host }).select('followers').lean();
  const followers = (profile?.followers || []).map(String).filter((id) => id !== String(live.host));
  if (!followers.length) return [];
  if (live.visibility !== LIVE_VISIBILITY.PRIVATE) return followers;

  if (live.privateMode === LIVE_PRIVATE_MODE.SELECTED) {
    const allowed = new Set((live.allowedUsers || []).map(String));
    return followers.filter((id) => allowed.has(id));
  }
  if (live.privateMode === LIVE_PRIVATE_MODE.COMMUNITY && live.community) {
    const Membership = mongoose.models.CommunityMembership;
    if (!Membership) return [];
    const members = await Membership.find({ community: live.community, status: 'active', user: { $in: followers } }).distinct('user');
    return members.map(String);
  }
  return [];
}

/** "<host> is live" to followers. Runs in the background; never blocks going live. */
async function notifyFollowers(live, hostName, skip) {
  try {
    const ids = (await followersWhoCanWatch(live)).filter((id) => !skip.has(id));
    const name = hostName || 'A creator you follow';
    const BATCH = 50;
    for (let i = 0; i < ids.length; i += BATCH) {
      await Promise.all(
        ids.slice(i, i + BATCH).map((userId) =>
          safeNotify({
            userId,
            fromUser: live.host,
            type: 'store_live',
            title: `${name} is live now 🔴`,
            message: live.title ? `"${live.title}" — tap to join.` : 'Tap to join the live stream.',
            relatedModel: 'LiveStream',
            relatedId: live._id,
          })
        )
      );
    }
    log.info('live.followers_notified', { liveId: String(live._id), count: ids.length });
  } catch (err) {
    log.warn('live.followers_notify_failed', { liveId: String(live._id), message: err?.message });
  }
}

async function start(live, user) {
  if (live.status === LIVE_STATUS.LIVE) return hostToken(live, user);
  if (live.status !== LIVE_STATUS.SCHEDULED) throw ApiError.badRequest(`This live is ${live.status}`);

  // Only one live at a time per creator.
  const other = await LiveStream.exists({ host: live.host, status: LIVE_STATUS.LIVE, _id: { $ne: live._id } });
  if (other) throw ApiError.conflict('You are already live — end that live first', [], 'ALREADY_LIVE');

  const token = await hostToken(live, user); // fails early if LiveKit isn't configured
  await livekit.ensureRoom(live.roomName);

  const started = await LiveStream.findOneAndUpdate(
    { _id: live._id, status: LIVE_STATUS.SCHEDULED },
    { $set: { status: LIVE_STATUS.LIVE, startedAt: new Date(), 'stats.currentViewers': 0 } },
    { new: true }
  );
  if (!started) throw ApiError.conflict('This live was just changed — refresh and try again');
  log.info('live.started', { liveId: String(live._id) });

  // Tell ticket holders it's starting.
  const holders = await paidTicketHolders(started);
  await Promise.all(
    holders.map((o) =>
      safeNotify({
        userId: o.buyer,
        type: 'store_live',
        title: 'Live now 🔴',
        message: `"${started.title}" has started — join now.`,
        relatedModel: 'LiveStream',
        relatedId: started._id,
      })
    )
  );

  // Tell followers (ticket holders already got a message above).
  const skip = new Set(holders.map((o) => String(o.buyer)));
  notifyFollowers(started, user?.name, skip);

  return token;
}

async function end(live, { byAdmin = false } = {}) {
  if (live.status !== LIVE_STATUS.LIVE) throw ApiError.badRequest('This live is not running');
  const ended = await LiveStream.findOneAndUpdate(
    { _id: live._id, status: LIVE_STATUS.LIVE },
    { $set: { status: LIVE_STATUS.ENDED, endedAt: new Date(), endedByAdmin: byAdmin, 'stats.currentViewers': 0 } },
    { new: true }
  );
  if (!ended) return LiveStream.findById(live._id);
  await livekit.closeRoom(live.roomName);
  log.info('live.ended', { liveId: String(live._id), byAdmin });
  return ended;
}

/** Cancels a scheduled live and refunds every ticket in full. */
async function cancel(live, { byUserId, reason }) {
  if (live.status !== LIVE_STATUS.SCHEDULED) throw ApiError.badRequest('Only scheduled lives can be cancelled');
  const cancelled = await LiveStream.findOneAndUpdate(
    { _id: live._id, status: LIVE_STATUS.SCHEDULED },
    { $set: { status: LIVE_STATUS.CANCELLED, cancelledReason: reason } },
    { new: true }
  );
  if (!cancelled) throw ApiError.conflict('This live was just changed — refresh and try again');

  const tickets = await StoreOrder.find({ itemId: live._id, status: ORDER_STATUS.PAID });
  let refunded = 0;
  const failed = [];
  for (const ticket of tickets) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await orderService.refundOrder(ticket._id, { byUserId, reason: `Live cancelled: ${reason}` });
      refunded += 1;
    } catch (err) {
      failed.push(String(ticket._id));
      log.error('live.ticket_refund_failed', err, { liveId: String(live._id), orderId: String(ticket._id) });
    }
  }
  log.info('live.cancelled', { liveId: String(live._id), refunded, failed: failed.length });
  return { live: cancelled, refunded, failedOrderIds: failed };
}

module.exports = { newRoomName, newInviteCode, hostToken, viewerToken, start, end, cancel };