const ApiError = require('../../utils/apiError');
const { Store, CallSession, StoreOrder } = require('../models');
const { CALL_STATUS, CALL_TYPE, STORE_STATUS, ORDER_ITEM, ORDER_STATUS, LIMITS } = require('../constants');
const livekit = require('./livekit.service');
const settingsService = require('./settings.service');
const earningsService = require('./earnings.service');
const { safeNotify } = require('./notify.service');
const { emitToUser } = require('./realtime.service');
const { formatRupees } = require('../utils/money');
const { newRoomName } = require('./live.service');
const log = require('../utils/logger');

// 1-to-1 paid/free calls.
//
//   request  → (paid: checkout; wallet or Razorpay) → REQUESTED → creator is rung
//   accept   → ACTIVE → both fetch a join token; billing starts when BOTH joined
//   end      → COMPLETED → billed per started minute (max = prepaid minutes)
//   settle   → creator credited for billed minutes, the rest back to the
//              caller's wallet. Declined / missed / cancelled = full refund.
//   jobs     → ring timeout, connect timeout, auto-end when prepaid time is up

const OPEN_STATUSES = [CALL_STATUS.AWAITING_PAYMENT, CALL_STATUS.REQUESTED, CALL_STATUS.ACTIVE];

function rateFor(store, type) {
  return type === CALL_TYPE.VIDEO ? store.calls.videoRate : store.calls.audioRate;
}

async function isHostBusy(hostId) {
  return Boolean(await CallSession.exists({ host: hostId, status: CALL_STATUS.ACTIVE }));
}

/** What a visitor sees on the store page. */
async function publicCallInfo(store) {
  const c = store.calls || {};
  return {
    enabled: Boolean(c.enabled),
    online: Boolean(c.enabled && c.online),
    busy: c.enabled && c.online ? await isHostBusy(store.user) : false,
    audio: { enabled: Boolean(c.audioEnabled), ratePerMinute: c.audioRate || 0 },
    video: { enabled: Boolean(c.videoEnabled), ratePerMinute: c.videoRate || 0 },
    minMinutes: LIMITS.CALL_MIN_MINUTES,
    maxMinutes: LIMITS.CALL_MAX_MINUTES,
  };
}

function ringHost(call, store) {
  const minutes = `${call.prepaidMinutes} min`;
  const priceText = call.prepaidAmount > 0 ? ` · ${formatRupees(call.prepaidAmount)}` : ' · free';
  emitToUser(call.host, 'store_call_request', { callId: String(call._id), type: call.type, minutes: call.prepaidMinutes });
  return safeNotify({
    userId: call.host,
    fromUser: call.caller,
    type: 'store_call',
    title: `Incoming ${call.type} call request`,
    message: `${minutes}${priceText}${call.note ? ` — "${call.note}"` : ''}. Answer within 2 minutes.`,
    relatedModel: 'CallSession',
    relatedId: call._id,
  }).then(() => log.info('call.requested', { callId: String(call._id), storeId: String(store?._id || call.store) }));
}

/** Called by order.service once a paid call's checkout is paid. */
async function onCallPaid(order) {
  const call = await CallSession.findOneAndUpdate(
    { _id: order.itemId, status: CALL_STATUS.AWAITING_PAYMENT },
    { $set: { status: CALL_STATUS.REQUESTED, requestedAt: new Date(), order: order._id } },
    { new: true }
  );
  if (!call) {
    // The request timed out/cancelled before payment landed — give it all back.
    log.warn('call.paid_after_close', { orderId: String(order._id), callId: String(order.itemId) });
    await refundWholeOrder(order, 'Call request had already closed');
    return;
  }
  await ringHost(call);
}

async function refundWholeOrder(order, reason) {
  const fresh = await StoreOrder.findOneAndUpdate(
    { _id: order._id, status: ORDER_STATUS.PAID, creditedAt: null },
    { $set: { status: ORDER_STATUS.REFUNDED, refundedAt: new Date(), refundReason: reason, creditedAt: new Date(), settledAmount: 0 } },
    { new: true }
  );
  if (fresh) await earningsService.refundToWallet(fresh, fresh.amount, reason);
  return fresh;
}

/**
 * Buyer asks for a call. Paid calls return a checkout the app completes
 * (Razorpay) or are paid at once from the wallet.
 */
async function requestCall(caller, storeId, { type, minutes, note = '', payWith }) {
  const store = await Store.findById(storeId);
  if (!store || store.status !== STORE_STATUS.ACTIVE || !store.isOpen) throw ApiError.notFound('This store is not available');
  if (String(store.user) === String(caller._id)) throw ApiError.badRequest("You can't call yourself");
  const c = store.calls || {};
  if (!c.enabled) throw ApiError.badRequest('This creator is not taking calls');
  if (!c.online) throw ApiError.badRequest('This creator is offline right now — try again later', [], 'CREATOR_OFFLINE');
  if ((type === CALL_TYPE.AUDIO && !c.audioEnabled) || (type === CALL_TYPE.VIDEO && !c.videoEnabled)) {
    throw ApiError.badRequest(`This creator is not taking ${type} calls`);
  }
  if (await isHostBusy(store.user)) throw ApiError.conflict('This creator is on another call — try again in a bit', [], 'CREATOR_BUSY');
  if (await CallSession.exists({ caller: caller._id, host: store.user, status: { $in: [CALL_STATUS.REQUESTED, CALL_STATUS.ACTIVE] } })) {
    throw ApiError.conflict('You already have a call request with this creator', [], 'CALL_ALREADY_OPEN');
  }

  const ratePerMinute = rateFor(store, type);
  const amount = ratePerMinute * minutes;
  const call = await CallSession.create({
    store: store._id,
    host: store.user,
    caller: caller._id,
    type,
    ratePerMinute,
    prepaidMinutes: minutes,
    prepaidAmount: amount,
    note,
    status: amount > 0 ? CALL_STATUS.AWAITING_PAYMENT : CALL_STATUS.REQUESTED,
    requestedAt: amount > 0 ? null : new Date(),
    roomName: newRoomName('call'),
  });

  if (amount === 0) {
    await ringHost(call, store);
    return { call: await CallSession.findById(call._id), paid: true, order: null, razorpay: null };
  }

  // Lazy require: order.service lazily requires this module too.
  const orderService = require('./order.service');
  try {
    const result = await orderService.startCheckout(
      caller,
      {
        store,
        itemType: ORDER_ITEM.CALL,
        itemId: call._id,
        itemTitle: `${type === CALL_TYPE.VIDEO ? 'Video' : 'Audio'} call with ${store.name} · ${minutes} min`,
        itemCoverUrl: store.logoUrl,
        amount,
        reusePending: false,
      },
      { payWith }
    );
    await CallSession.updateOne({ _id: call._id }, { $set: { order: result.order._id } });
    return { call: await CallSession.findById(call._id), paid: result.paid, order: result.order, razorpay: result.razorpay };
  } catch (err) {
    await CallSession.updateOne({ _id: call._id, status: CALL_STATUS.AWAITING_PAYMENT }, { $set: { status: CALL_STATUS.CANCELLED, endReason: 'payment_failed', endedAt: new Date() } });
    throw err;
  }
}

async function loadCallFor(userId, callId) {
  const call = await CallSession.findById(callId);
  if (!call) throw ApiError.notFound('Call not found');
  const isHost = String(call.host) === String(userId);
  const isCaller = String(call.caller) === String(userId);
  if (!isHost && !isCaller) throw ApiError.notFound('Call not found');
  return { call, isHost, isCaller };
}

/**
 * Money for a finished call. Runs once per call (settledAt claim).
 * Billed = started minutes after both joined, capped at the prepaid minutes.
 */
async function settle(callId) {
  const call = await CallSession.findOneAndUpdate({ _id: callId, settledAt: null }, { $set: { settledAt: new Date() } }, { new: true });
  if (!call) return null;

  let billedMinutes = 0;
  if (call.status === CALL_STATUS.COMPLETED && call.connectedAt && call.endedAt) {
    const seconds = (call.endedAt.getTime() - call.connectedAt.getTime()) / 1000;
    // A few seconds of connection (e.g. an instant drop) isn't charged.
    billedMinutes = seconds < 10 ? 0 : Math.min(call.prepaidMinutes, Math.ceil(seconds / 60));
  }
  const billedAmount = billedMinutes * call.ratePerMinute;
  let refunded = 0;
  let creatorEarning = 0;

  const order = call.order ? await StoreOrder.findById(call.order) : null;
  if (order && order.status === ORDER_STATUS.PAID) {
    if (billedAmount > 0) {
      const settings = await settingsService.getSettings();
      const credited = await earningsService.creditSale(order._id, { feePercent: settings.storeFeePercent, grossAmount: billedAmount });
      if (!credited) log.warn('call.credit_skipped', { callId: String(call._id), orderId: String(call.order) });
      creatorEarning = credited?.creatorEarning || 0;
      refunded = await earningsService.refundToWallet(order, order.amount - billedAmount, 'Unused call minutes');
    } else {
      const done = await refundWholeOrder(order, call.status === CALL_STATUS.COMPLETED ? 'Call did not connect' : `Call ${call.status}`);
      refunded = done ? done.amount : 0;
    }
  }

  await CallSession.updateOne({ _id: call._id }, { $set: { billedMinutes, billedAmount, refundedAmount: refunded, creatorEarning } });
  log.info('call.settled', { callId: String(call._id), status: call.status, billedMinutes, billedAmount, refunded, creatorEarning });

  if (refunded > 0) {
    await safeNotify({
      userId: call.caller,
      type: 'store_call',
      title: 'Money back in your wallet',
      message: `${formatRupees(refunded)} for unused call time is back in your Fanitt wallet.`,
      relatedModel: 'CallSession',
      relatedId: call._id,
    });
  }
  return CallSession.findById(call._id);
}

async function closeCall(call, status, { endedBy, reason }) {
  const closed = await CallSession.findOneAndUpdate(
    { _id: call._id, status: call.status },
    { $set: { status, endedAt: new Date(), endedBy, endReason: reason } },
    { new: true }
  );
  if (!closed) return null; // someone else closed it first
  await livekit.closeRoom(closed.roomName);
  const payload = { callId: String(closed._id), status, reason };
  emitToUser(closed.host, 'store_call_ended', payload);
  emitToUser(closed.caller, 'store_call_ended', payload);
  log.info('call.closed', { callId: String(closed._id), status, endedBy, reason });
  return settle(closed._id);
}

async function accept(userId, callId) {
  const { call, isHost } = await loadCallFor(userId, callId);
  if (!isHost) throw ApiError.forbidden('Only the creator can accept');
  if (call.status !== CALL_STATUS.REQUESTED) throw ApiError.badRequest(`This call is ${call.status}`);
  if (await isHostBusy(call.host)) throw ApiError.conflict('Finish your current call first', [], 'CREATOR_BUSY');

  const accepted = await CallSession.findOneAndUpdate(
    { _id: call._id, status: CALL_STATUS.REQUESTED },
    { $set: { status: CALL_STATUS.ACTIVE, acceptedAt: new Date() } },
    { new: true }
  );
  if (!accepted) throw ApiError.conflict('This call request just closed');
  await livekit.ensureRoom(accepted.roomName, { maxParticipants: 2, emptyTimeout: 60 });
  emitToUser(accepted.caller, 'store_call_accepted', { callId: String(accepted._id) });
  await safeNotify({
    userId: accepted.caller,
    type: 'store_call',
    title: 'Your call was accepted',
    message: 'Join now — the creator is waiting.',
    relatedModel: 'CallSession',
    relatedId: accepted._id,
  });
  log.info('call.accepted', { callId: String(accepted._id) });
  return accepted;
}

async function decline(userId, callId) {
  const { call, isHost } = await loadCallFor(userId, callId);
  if (!isHost) throw ApiError.forbidden('Only the creator can decline');
  if (call.status !== CALL_STATUS.REQUESTED) throw ApiError.badRequest(`This call is ${call.status}`);
  const result = await closeCall(call, CALL_STATUS.DECLINED, { endedBy: 'host', reason: 'declined' });
  await safeNotify({
    userId: call.caller,
    type: 'store_call',
    title: 'Call request declined',
    message: call.prepaidAmount > 0 ? 'The creator could not take your call. Your money is back in your Fanitt wallet.' : 'The creator could not take your call right now.',
    relatedModel: 'CallSession',
    relatedId: call._id,
  });
  return result;
}

async function cancelByCaller(userId, callId) {
  const { call, isCaller } = await loadCallFor(userId, callId);
  if (!isCaller) throw ApiError.forbidden('Only the caller can cancel the request');
  if (![CALL_STATUS.AWAITING_PAYMENT, CALL_STATUS.REQUESTED].includes(call.status)) {
    throw ApiError.badRequest('This call has already started — end it instead');
  }
  return closeCall(call, CALL_STATUS.CANCELLED, { endedBy: 'caller', reason: 'cancelled_by_caller' });
}

/** Join token for either side of an ACTIVE call. Billing starts when both joined. */
async function joinToken(user, callId) {
  const { call, isHost } = await loadCallFor(user._id, callId);
  if (call.status !== CALL_STATUS.ACTIVE) throw ApiError.badRequest(`This call is ${call.status}`);

  const token = await livekit.createToken({
    roomName: call.roomName,
    identity: user._id,
    name: user.name,
    canPublish: true,
    canChat: true,
    ttl: LIMITS.CALL_TOKEN_TTL,
    metadata: { role: isHost ? 'host' : 'caller', callId: String(call._id), type: call.type },
  });

  const field = isHost ? 'hostJoinedAt' : 'callerJoinedAt';
  await CallSession.updateOne({ _id: call._id, [field]: null }, { $set: { [field]: new Date() } });
  // First moment both have joined = billing start (set once).
  const both = await CallSession.findOneAndUpdate(
    { _id: call._id, connectedAt: null, hostJoinedAt: { $ne: null }, callerJoinedAt: { $ne: null } },
    { $set: { connectedAt: new Date() } },
    { new: true }
  );
  if (both) log.info('call.connected', { callId: String(call._id) });

  const fresh = both || (await CallSession.findById(call._id));
  const endsAt = fresh.connectedAt ? new Date(fresh.connectedAt.getTime() + fresh.prepaidMinutes * 60 * 1000) : null;
  return { ...token, call: fresh, endsAt, type: fresh.type };
}

async function endByUser(userId, callId) {
  const { call, isHost } = await loadCallFor(userId, callId);
  if (call.status !== CALL_STATUS.ACTIVE) throw ApiError.badRequest(`This call is ${call.status}`);
  return closeCall(call, CALL_STATUS.COMPLETED, { endedBy: isHost ? 'host' : 'caller', reason: 'ended' });
}

async function endByAdmin(callId) {
  const call = await CallSession.findById(callId);
  if (!call) throw ApiError.notFound('Call not found');
  if (!OPEN_STATUSES.includes(call.status)) throw ApiError.badRequest(`This call is ${call.status}`);
  const status = call.status === CALL_STATUS.ACTIVE ? CALL_STATUS.COMPLETED : CALL_STATUS.CANCELLED;
  return closeCall(call, status, { endedBy: 'admin', reason: 'ended_by_admin' });
}

/** Background job: timeouts and auto-end. Safe to run on every server. */
async function runTimeouts(now = new Date()) {
  const ringCutoff = new Date(now.getTime() - LIMITS.CALL_RING_TIMEOUT_MS);
  const connectCutoff = new Date(now.getTime() - LIMITS.CALL_CONNECT_TIMEOUT_MS);
  const paymentCutoff = new Date(now.getTime() - 30 * 60 * 1000);

  const missed = await CallSession.find({ status: CALL_STATUS.REQUESTED, requestedAt: { $lt: ringCutoff } }).limit(50);
  for (const call of missed) {
    // eslint-disable-next-line no-await-in-loop
    await closeCall(call, CALL_STATUS.MISSED, { endedBy: 'system', reason: 'not_answered' });
  }

  const neverConnected = await CallSession.find({ status: CALL_STATUS.ACTIVE, connectedAt: null, acceptedAt: { $lt: connectCutoff } }).limit(50);
  for (const call of neverConnected) {
    // eslint-disable-next-line no-await-in-loop
    await closeCall(call, CALL_STATUS.COMPLETED, { endedBy: 'system', reason: 'not_connected' });
  }

  const running = await CallSession.find({ status: CALL_STATUS.ACTIVE, connectedAt: { $ne: null } }).limit(200);
  for (const call of running) {
    const limitAt = call.connectedAt.getTime() + call.prepaidMinutes * 60 * 1000 + LIMITS.CALL_GRACE_MS;
    if (now.getTime() >= limitAt) {
      // eslint-disable-next-line no-await-in-loop
      await closeCall(call, CALL_STATUS.COMPLETED, { endedBy: 'system', reason: 'time_up' });
    }
  }

  await CallSession.updateMany(
    { status: CALL_STATUS.AWAITING_PAYMENT, createdAt: { $lt: paymentCutoff } },
    { $set: { status: CALL_STATUS.CANCELLED, endReason: 'payment_not_completed', endedAt: now, settledAt: now } }
  );
}

/** LiveKit says the call room closed (everyone left). */
async function onRoomFinished(roomName) {
  const call = await CallSession.findOne({ roomName, status: CALL_STATUS.ACTIVE });
  if (call) await closeCall(call, CALL_STATUS.COMPLETED, { endedBy: 'system', reason: 'room_closed' });
}

module.exports = {
  publicCallInfo,
  requestCall,
  onCallPaid,
  accept,
  decline,
  cancelByCaller,
  joinToken,
  endByUser,
  endByAdmin,
  runTimeouts,
  onRoomFinished,
  settle,
};
