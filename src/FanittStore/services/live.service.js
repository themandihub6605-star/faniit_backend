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
// Scheduled lives the host never starts are cancelled (and refunded) an
// hour after their time; ticket holders get a reminder 15 minutes before.

const REMINDER_BEFORE_MS = 15 * 60 * 1000;
const MISSED_AFTER_MS = 60 * 60 * 1000;

function whenText(date) {
  return new Date(date).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
}

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
async function cancel(live, { byUserId, reason, missed = false }) {
  if (live.status !== LIVE_STATUS.SCHEDULED) throw ApiError.badRequest('Only scheduled lives can be cancelled');
  const cancelled = await LiveStream.findOneAndUpdate(
    { _id: live._id, status: LIVE_STATUS.SCHEDULED },
    { $set: { status: LIVE_STATUS.CANCELLED, cancelledReason: reason, missed } },
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

/** Buyers with a paid ticket (user ids). */
async function holderIds(liveId) {
  const ids = await StoreOrder.find({ itemId: liveId, status: ORDER_STATUS.PAID }).distinct('buyer');
  return ids.map(String);
}

async function notifyMany(userIds, payload) {
  const BATCH = 50;
  for (let i = 0; i < userIds.length; i += BATCH) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(userIds.slice(i, i + BATCH).map((userId) => safeNotify({ ...payload, userId })));
  }
}

/** A live was scheduled → followers who can watch it hear about it. Background. */
async function notifyScheduled(live, hostUser) {
  try {
    if (!live.scheduledAt) return;
    const ids = await followersWhoCanWatch(live);
    if (!ids.length) return;
    const name = hostUser?.name || 'A creator you follow';
    await notifyMany(ids, {
      fromUser: live.host,
      type: 'store_live',
      title: `${name} scheduled a live 📅`,
      message: `"${live.title}" · ${whenText(live.scheduledAt)}${live.price > 0 ? '' : ' · Free'} — tap to see it.`,
      relatedModel: 'LiveStream',
      relatedId: live._id,
    });
    log.info('live.scheduled_notified', { liveId: String(live._id), count: ids.length });
  } catch (err) {
    log.warn('live.scheduled_notify_failed', { liveId: String(live._id), message: err?.message });
  }
}

/** The time changed → ticket holders are told. Background. */
async function notifyRescheduled(live) {
  try {
    const ids = await holderIds(live._id);
    if (!ids.length) return;
    await notifyMany(ids, {
      fromUser: live.host,
      type: 'store_live',
      title: 'Live moved to a new time',
      message: `"${live.title}" is now on ${whenText(live.scheduledAt)}. Your ticket still works.`,
      relatedModel: 'LiveStream',
      relatedId: live._id,
    });
  } catch (err) {
    log.warn('live.reschedule_notify_failed', { liveId: String(live._id), message: err?.message });
  }
}

/** Job: "starts in 15 minutes" to ticket holders and the host. */
async function sendReminders() {
  const now = Date.now();
  const due = await LiveStream.find({
    status: LIVE_STATUS.SCHEDULED,
    reminderSentAt: null,
    scheduledAt: { $gt: new Date(now), $lte: new Date(now + REMINDER_BEFORE_MS) },
  })
    .select('_id host title scheduledAt')
    .limit(20);
  for (const live of due) {
    // eslint-disable-next-line no-await-in-loop
    const claim = await LiveStream.updateOne({ _id: live._id, reminderSentAt: null }, { $set: { reminderSentAt: new Date() } });
    if (!claim.modifiedCount) continue;
    const mins = Math.max(1, Math.round((new Date(live.scheduledAt).getTime() - now) / 60000));
    // eslint-disable-next-line no-await-in-loop
    const ids = await holderIds(live._id);
    // eslint-disable-next-line no-await-in-loop
    await notifyMany(ids, {
      fromUser: live.host,
      type: 'store_live',
      title: `Live starts in ${mins} min ⏰`,
      message: `"${live.title}" is about to start. Keep the app handy!`,
      relatedModel: 'LiveStream',
      relatedId: live._id,
    });
    // eslint-disable-next-line no-await-in-loop
    await safeNotify({
      userId: live.host,
      type: 'store_live',
      title: `Your live starts in ${mins} min`,
      message: `"${live.title}"${ids.length ? ` · ${ids.length} ticket${ids.length === 1 ? '' : 's'} sold` : ''} — open Stream Live to start.`,
      relatedModel: 'LiveStream',
      relatedId: live._id,
    });
    log.info('live.reminder_sent', { liveId: String(live._id), holders: ids.length });
  }
}

/**
 * Job: a scheduled live the host never started is cancelled an hour after
 * its time, every ticket is refunded and the host is told.
 */
async function expireMissed() {
  const overdue = await LiveStream.find({ status: LIVE_STATUS.SCHEDULED, scheduledAt: { $ne: null, $lt: new Date(Date.now() - MISSED_AFTER_MS) } }).limit(10);
  for (const live of overdue) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await cancel(live, { byUserId: live.host, reason: 'The creator didn’t start this live', missed: true });
      // eslint-disable-next-line no-await-in-loop
      await safeNotify({
        userId: live.host,
        type: 'store_live',
        title: 'Your live was cancelled',
        message: `"${live.title}" wasn’t started in time.${result.refunded ? ` ${result.refunded} ticket${result.refunded === 1 ? ' was' : 's were'} refunded.` : ''}`,
        relatedModel: 'LiveStream',
        relatedId: live._id,
      });
      log.info('live.missed_cancelled', { liveId: String(live._id), refunded: result.refunded });
    } catch (err) {
      log.warn('live.missed_cancel_failed', { liveId: String(live._id), message: err?.message });
    }
  }
}

module.exports = { newRoomName, newInviteCode, hostToken, viewerToken, start, end, cancel, notifyScheduled, notifyRescheduled, sendReminders, expireMissed, whenText };