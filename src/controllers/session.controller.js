const { Session, CreatorProfile } = require('../models');
const zoomService = require('../services/zoom.service');
const env = require('../config/env');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');
const { ROLES, SESSION_TYPES } = require('../constants/enums');

const uploadBanner = catchAsync(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('No file uploaded');

  const coverImageUrl = req.file.path;
  return new ApiResponse(200, { coverImageUrl }, 'Banner uploaded').send(res);
});

const listSessions = catchAsync(async (req, res) => {
  const { category, type, free, upcoming = 'true', page = 1, limit = 20 } = req.query;

  const filter = { isCancelled: false };
  if (category) filter.category = category;
  if (type) filter.type = type;
  if (free === 'true') filter.type = SESSION_TYPES.FREE;
  if (upcoming === 'true') filter.scheduledAt = { $gte: new Date() };

  const sessions = await Session.find(filter)
    .populate({ path: 'creator', populate: { path: 'user', select: 'name avatarUrl' } })
    .populate('category', 'label icon')
    .sort({ scheduledAt: 1 })
    .skip((page - 1) * limit)
    .limit(Number(limit));

  const total = await Session.countDocuments(filter);

  return new ApiResponse(200, { sessions, total, page: Number(page), pages: Math.ceil(total / limit) }, 'Sessions fetched').send(res);
});

const getSessionById = catchAsync(async (req, res) => {
  const session = await Session.findById(req.params.id)
    .populate({ path: 'creator', populate: { path: 'user', select: 'name avatarUrl' } })
    .populate('category', 'label icon');

  if (!session) throw ApiError.notFound('Session not found');
  return new ApiResponse(200, session, 'Session fetched').send(res);
});

const createSession = catchAsync(async (req, res) => {
  if (req.user.role !== ROLES.CREATOR) throw ApiError.forbidden('Only creators can create sessions');

  const creator = await CreatorProfile.findOne({ user: req.user._id });
  if (!creator) throw ApiError.notFound('Creator profile not found');

  const { title, description, category, type, price, scheduledAt, durationMinutes, maxParticipants, coverImageUrl } = req.body;

  let zoomDetails = { zoomMeetingId: '', zoomJoinUrl: '', zoomStartUrl: '', zoomPassword: '' };
  try {
    zoomDetails = await zoomService.createMeeting({
      topic: title,
      startTime: scheduledAt,
      durationMinutes,
      hostEmail: env.zoom.hostEmail,
    });
  } catch (err) {
    console.error('[zoom] meeting creation failed:', err.message);
    throw ApiError.internal(`Could not create the Zoom meeting: ${err.message}`);
  }

  const session = await Session.create({
    creator: creator._id,
    title,
    description,
    category,
    type,
    price: type === SESSION_TYPES.FREE ? 0 : price,
    scheduledAt,
    durationMinutes,
    maxParticipants,
    coverImageUrl: coverImageUrl || '',
    ...zoomDetails,
  });

  return new ApiResponse(201, session, 'Session created').send(res);
});

const updateSession = catchAsync(async (req, res) => {
  const session = await Session.findById(req.params.id).populate('creator');
  if (!session) throw ApiError.notFound('Session not found');
  if (!session.creator.user.equals(req.user._id)) throw ApiError.forbidden('You do not own this session');

  Object.assign(session, req.body);
  await session.save();

  return new ApiResponse(200, session, 'Session updated').send(res);
});

const cancelSession = catchAsync(async (req, res) => {
  const session = await Session.findById(req.params.id).populate('creator');
  if (!session) throw ApiError.notFound('Session not found');
  if (!session.creator.user.equals(req.user._id)) throw ApiError.forbidden('You do not own this session');

  session.isCancelled = true;
  await session.save();

  return new ApiResponse(200, null, 'Session cancelled').send(res);
});

const getJoinToken = catchAsync(async (req, res) => {
  const session = await Session.findById(req.params.id).select('+zoomPassword').populate('creator');
  if (!session) throw ApiError.notFound('Session not found');
  if (!session.zoomMeetingId) throw ApiError.badRequest('This session has no live meeting provisioned yet');

  const isHost = session.creator.user.equals(req.user._id);
  const signature = zoomService.generateSdkSignature(session.zoomMeetingId, isHost ? 1 : 0);

  return new ApiResponse(200, {
    signature,
    meetingNumber: session.zoomMeetingId,
    password: session.zoomPassword || '',
    role: isHost ? 1 : 0,
    sdkKey: process.env.ZOOM_SDK_KEY,
  }, 'Join token generated').send(res);
});

const goLive = catchAsync(async (req, res) => {
  const session = await Session.findById(req.params.id).populate('creator');
  if (!session) throw ApiError.notFound('Session not found');
  if (!session.creator.user.equals(req.user._id)) throw ApiError.forbidden('You do not own this session');
  if (!session.zoomMeetingId) throw ApiError.badRequest('This session has no live meeting provisioned yet');
  if (session.isCancelled) throw ApiError.badRequest('This session was cancelled');

  session.isLive = true;
  await session.save();

  return new ApiResponse(200, session, 'Session is now live').send(res);
});

const endLive = catchAsync(async (req, res) => {
  const session = await Session.findById(req.params.id).populate('creator');
  if (!session) throw ApiError.notFound('Session not found');
  if (!session.creator.user.equals(req.user._id)) throw ApiError.forbidden('You do not own this session');

  session.isLive = false;
  session.isCompleted = true;
  await session.save();

  return new ApiResponse(200, session, 'Session ended').send(res);
});

module.exports = { listSessions, getSessionById, createSession, updateSession, cancelSession, getJoinToken, goLive, endLive, uploadBanner };