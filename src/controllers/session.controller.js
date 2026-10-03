const { Session, CreatorProfile, Booking, User } = require('../models');
const zoomService = require('../services/zoom.service');
const env = require('../config/env');
const { sendSessionCancelledEmail } = require('../services/email.service');
const notificationService = require('../services/notification.service');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');
const { ROLES, SESSION_TYPES, BOOKING_STATUS } = require('../constants/enums');

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
  // Keep meetings that already started (live or within their time) in the list.
  if (upcoming === 'true') {
    filter.isCompleted = { $ne: true };
    filter.scheduledAt = { $gte: new Date(Date.now() - 6 * 60 * 60 * 1000) };
  }

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

  // Meetings run in-app on LiveKit (src/FanittStore/services/meetRoom.service.js),
  // so no Zoom meeting is created any more.
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
  });

  return new ApiResponse(201, session, 'Session created').send(res);
});

// Edit a session: title, description, cover, length, seats — or postpone it
// with a new date/time. Everyone who booked is told about a new time.
const updateSession = catchAsync(async (req, res) => {
  const session = await Session.findById(req.params.id).populate({ path: 'creator', populate: { path: 'user', select: 'name' } });
  if (!session) throw ApiError.notFound('Session not found');
  if (!session.creator.user._id.equals(req.user._id)) throw ApiError.forbidden('You do not own this session');
  if (session.isCancelled || session.isCompleted) throw ApiError.badRequest('This session can’t be edited any more');

  const { title, description, scheduledAt, durationMinutes, maxParticipants, coverImageUrl, rescheduleNote } = req.body;

  let rescheduled = false;
  if (scheduledAt !== undefined) {
    const when = new Date(scheduledAt);
    if (Number.isNaN(when.getTime()) || when.getTime() < Date.now() + 5 * 60 * 1000) {
      throw ApiError.badRequest('Pick a new time at least 5 minutes from now');
    }
    if (session.isLive) throw ApiError.badRequest('End the live session before moving it');
    rescheduled = when.getTime() !== new Date(session.scheduledAt).getTime();
    session.scheduledAt = when;
  }
  if (maxParticipants !== undefined && maxParticipants < (session.bookedCount || 0)) {
    throw ApiError.badRequest(`${session.bookedCount} people already booked — seats can’t go below that`);
  }
  if (title !== undefined) session.title = title;
  if (description !== undefined) session.description = description;
  if (durationMinutes !== undefined) session.durationMinutes = durationMinutes;
  if (maxParticipants !== undefined) session.maxParticipants = maxParticipants;
  if (coverImageUrl !== undefined) session.coverImageUrl = coverImageUrl;
  await session.save();

  if (rescheduled) {
    try {
      const bookings = await Booking.find({ session: session._id, status: BOOKING_STATUS.CONFIRMED }).select('user');
      const when = session.scheduledAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
      await Promise.all(
        bookings.map((b) =>
          notificationService
            .notify({
              userId: b.user,
              fromUser: req.user._id,
              type: 'session_reminder',
              title: 'Meeting moved to a new time',
              message: `"${session.title}" by ${session.creator.user.name} is now on ${when}.${rescheduleNote ? ` ${rescheduleNote}` : ''}`,
              relatedModel: 'Session',
              relatedId: session._id,
            })
            .catch(() => {})
        )
      );
    } catch (err) {
      console.error('[session.controller] Failed to notify about new time:', err.message);
    }
  }

  return new ApiResponse(200, session, rescheduled ? 'Session moved — attendees notified' : 'Session updated').send(res);
});

// Point-Fix: cancelling a session now emails everyone who'd booked it —
// previously this only flipped the isCancelled flag with no notice to
// attendees at all. Looked up via Booking (not stored on Session), and
// only CONFIRMED bookings are notified — a booking someone already
// cancelled themselves doesn't need a "this was cancelled" email.
// Emails are sent best-effort (fire-and-forget per recipient) so one bad
// address can't block the others or the cancellation itself.
const cancelSession = catchAsync(async (req, res) => {
  const session = await Session.findById(req.params.id).populate({ path: 'creator', populate: { path: 'user', select: 'name' } });
  if (!session) throw ApiError.notFound('Session not found');
  if (!session.creator.user._id.equals(req.user._id)) throw ApiError.forbidden('You do not own this session');

  session.isCancelled = true;
  await session.save();

  try {
    const bookings = await Booking.find({ session: session._id, status: BOOKING_STATUS.CONFIRMED }).populate('user', 'name email');
    bookings.forEach((booking) => {
      if (booking.user?.email) {
        sendSessionCancelledEmail({
          to: booking.user.email,
          name: booking.user.name,
          sessionTitle: session.title,
          scheduledAt: session.scheduledAt,
          otherPartyName: session.creator.user.name,
        });
      }
    });
  } catch (err) {
    console.error('[session.controller] Failed to send cancellation emails:', err.message);
  }

  return new ApiResponse(200, null, 'Session cancelled').send(res);
});

const getJoinToken = catchAsync(async (req, res) => {
  const session = await Session.findById(req.params.id).select('+zoomPassword').populate('creator');
  if (!session) throw ApiError.notFound('Session not found');
  if (!session.zoomMeetingId) throw ApiError.badRequest('This session has no live meeting provisioned yet');

  const isHost = session.creator.user.equals(req.user._id);

  // Only the host and people with a confirmed booking may join.
  if (!isHost) {
    const { Booking } = require('../models');
    const booked = await Booking.exists({
      session: session._id,
      user: req.user._id,
      status: { $in: ['confirmed', 'completed'] },
    });
    if (!booked) throw ApiError.forbidden('Book this session to join it');
  }
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