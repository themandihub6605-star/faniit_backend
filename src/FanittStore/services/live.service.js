const crypto = require('crypto');
const ApiError = require('../../utils/apiError');
const { LiveStream, StoreOrder } = require('../models');
const { LIVE_STATUS, ORDER_STATUS, LIMITS } = require('../constants');
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
