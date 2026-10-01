const mongoose = require('mongoose');
const catchAsync = require('../../utils/catchAsync');
const ApiResponse = require('../../utils/apiResponse');
const ApiError = require('../../utils/apiError');
const { CallSession } = require('../models');
const { CALL_STATUS } = require('../constants');
const storeService = require('../services/store.service');
const callService = require('../services/call.service');
const { order: serializeOrder } = require('../utils/serialize');
const { pageParams } = require('../utils/text');

// 1-to-1 calls — creator settings (/me/calls) and both sides of a call (/calls).

function assertObjectId(id) {
  if (!mongoose.isValidObjectId(id)) throw ApiError.notFound('Call not found');
}

function serializeCall(call, viewerId) {
  const isHost = String(call.host?._id || call.host) === String(viewerId);
  return {
    _id: call._id,
    role: isHost ? 'host' : 'caller',
    store: call.store,
    host: call.host,
    caller: call.caller,
    type: call.type,
    ratePerMinute: call.ratePerMinute,
    prepaidMinutes: call.prepaidMinutes,
    prepaidAmount: call.prepaidAmount,
    note: call.note,
    status: call.status,
    requestedAt: call.requestedAt,
    acceptedAt: call.acceptedAt,
    connectedAt: call.connectedAt,
    endedAt: call.endedAt,
    endedBy: call.endedBy,
    endReason: call.endReason,
    billedMinutes: call.billedMinutes,
    billedAmount: call.billedAmount,
    refundedAmount: call.refundedAmount,
    // Only the creator sees what they earned.
    creatorEarning: isHost ? call.creatorEarning : undefined,
    createdAt: call.createdAt,
  };
}

// ---------- creator ----------

/** GET /api/store/me/calls/settings */
const getSettings = catchAsync(async (req, res) => {
  const store = await storeService.requireMyStore(req.user._id);
  return new ApiResponse(200, store.calls, 'Call settings').send(res);
});

/** PATCH /api/store/me/calls/settings */
const updateSettings = catchAsync(async (req, res) => {
  const store = await storeService.requireActiveStore(req.user._id);
  ['enabled', 'audioEnabled', 'videoEnabled', 'audioRate', 'videoRate'].forEach((f) => {
    if (req.body[f] !== undefined) store.calls[f] = req.body[f];
  });
  if (!store.calls.audioEnabled && !store.calls.videoEnabled) throw ApiError.badRequest('Turn on audio or video calls (or both)');
  if (!store.calls.enabled) store.calls.online = false;
  await store.save();
  return new ApiResponse(200, store.calls, 'Call settings saved').send(res);
});

/** POST /api/store/me/calls/online { online } */
const setOnline = catchAsync(async (req, res) => {
  const store = await storeService.requireActiveStore(req.user._id);
  if (req.body.online && !store.calls.enabled) throw ApiError.badRequest('Turn on calls in your call settings first');
  store.calls.online = req.body.online;
  if (req.body.online) store.calls.lastOnlineAt = new Date();
  await store.save();
  return new ApiResponse(200, store.calls, req.body.online ? 'You are online for calls' : 'You are offline').send(res);
});

/** GET /api/store/calls?role=host|caller&status=&page= — my calls. */
const listMyCalls = catchAsync(async (req, res) => {
  const { page, limit, skip } = pageParams(req.query);
  const filter = req.query.role === 'host' ? { host: req.user._id } : req.query.role === 'caller' ? { caller: req.user._id } : { $or: [{ host: req.user._id }, { caller: req.user._id }] };
  if (Object.values(CALL_STATUS).includes(req.query.status)) filter.status = req.query.status;
  else filter.status = { $ne: CALL_STATUS.AWAITING_PAYMENT };
  const [calls, total] = await Promise.all([
    CallSession.find(filter)
      .populate('host', 'name avatarUrl')
      .populate('caller', 'name avatarUrl')
      .populate('store', 'name slug logoUrl')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    CallSession.countDocuments(filter),
  ]);
  return new ApiResponse(
    200,
    { calls: calls.map((c) => serializeCall(c, req.user._id)), total, page, pages: Math.ceil(total / limit) },
    'Calls fetched'
  ).send(res);
});

/** GET /api/store/calls/:id */
const getCall = catchAsync(async (req, res) => {
  assertObjectId(req.params.id);
  const call = await CallSession.findById(req.params.id)
    .populate('host', 'name avatarUrl')
    .populate('caller', 'name avatarUrl')
    .populate('store', 'name slug logoUrl');
  if (!call || ![String(call.host._id), String(call.caller._id)].includes(String(req.user._id))) throw ApiError.notFound('Call not found');
  return new ApiResponse(200, serializeCall(call, req.user._id), 'Call fetched').send(res);
});

/** POST /api/store/stores/:storeId/calls { type, minutes, note?, payWith? } */
const requestCall = catchAsync(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.storeId)) throw ApiError.notFound('Store not found');
  const result = await callService.requestCall(req.user, req.params.storeId, req.body);
  return new ApiResponse(
    result.paid ? 201 : 200,
    {
      call: serializeCall(result.call, req.user._id),
      paid: result.paid,
      order: result.order ? serializeOrder(result.order) : null,
      razorpay: result.razorpay,
    },
    result.paid ? 'Calling… the creator has 2 minutes to answer' : 'Complete the payment to send your call request'
  ).send(res);
});

const action = (fn, message) =>
  catchAsync(async (req, res) => {
    assertObjectId(req.params.id);
    const call = await fn(req.user._id, req.params.id);
    return new ApiResponse(200, call ? serializeCall(call, req.user._id) : null, message).send(res);
  });

/** POST /api/store/calls/:id/join — LiveKit token for host or caller. */
const joinCall = catchAsync(async (req, res) => {
  assertObjectId(req.params.id);
  const result = await callService.joinToken(req.user, req.params.id);
  return new ApiResponse(
    200,
    { connection: { url: result.url, token: result.token, roomName: result.roomName }, call: serializeCall(result.call, req.user._id), endsAt: result.endsAt },
    'Joining call'
  ).send(res);
});

module.exports = {
  getSettings,
  updateSettings,
  setOnline,
  listMyCalls,
  getCall,
  requestCall,
  joinCall,
  accept: action(callService.accept, 'Call accepted'),
  decline: action(callService.decline, 'Call declined'),
  cancel: action(callService.cancelByCaller, 'Call request cancelled'),
  end: action(callService.endByUser, 'Call ended'),
};
