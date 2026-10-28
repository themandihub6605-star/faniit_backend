// File: src/controllers/session.controller.js
const { Session, CreatorProfile, Booking, User } = require('../models');
const zoomService = require('../services/zoom.service');
const env = require('../config/env');
const { sendSessionCancelledEmail } = require('../services/email.service');
const notificationService = require('../services/notification.service');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');
const { ROLES, SESSION_TYPES, BOOKING_STATUS } = require('../constants/enums');

// A session that never started is "over" once its planned end + 1 h has
// passed (the same window the meeting room allows the host to start in).
const GRACE_MS = 60 * 60 * 1000;
const MIN_OVER_MS = 15 * 60 * 1000 + GRACE_MS; // shortest session + grace
const endsAtMs = (s) => new Date(s.scheduledAt).getTime() + (s.durationMinutes || 60) * 60 * 1000;
const isOver = (s) => Date.now() > endsAtMs(s) + GRACE_MS;
const istText = (d) => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
const BOOKED = [BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.COMPLETED];

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

  // Followers hear about the new live session (in the background).
  require('../FanittStore/services/meetRoom.service').notifyScheduled(session, { hostUser: req.user });

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
      const when = istText(session.scheduledAt);
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
  if (session.isCompleted) throw ApiError.badRequest('This session is already over');
  if (session.isCancelled) return new ApiResponse(200, null, 'Session cancelled').send(res);
  if (session.isLive) throw ApiError.badRequest('End the live session first');

  session.isCancelled = true;
  await session.save();

  try {
    const bookings = await Booking.find({ session: session._id, status: BOOKING_STATUS.CONFIRMED }).populate('user', 'name email');
    // In-app + push for everyone who booked (best-effort).
    await Promise.all(
      bookings.map((b) =>
        notificationService
          .notify({
            userId: b.user?._id || b.user,
            fromUser: req.user._id,
            type: 'session_reminder',
            title: 'Session cancelled',
            message: `"${session.title}" by ${session.creator.user.name} on ${istText(session.scheduledAt)} was cancelled.`,
            relatedModel: 'Session',
            relatedId: session._id,
          })
          .catch(() => {})
      )
    );
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
  // Same as ending from the meeting room: closes the LiveKit room and the
  // attendance log, not just the flag.
  const session = await require('../FanittStore/services/meetRoom.service').end(req.user, req.params.id);
  return new ApiResponse(200, session, 'Session ended').send(res);
});

// Host's past meetings: ended, cancelled, or the time passed without starting.
// Each row carries how many people came and the total time they stayed.
const mySessionHistory = catchAsync(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));

  const creator = await CreatorProfile.findOne({ user: req.user._id }).select('_id');
  if (!creator) throw ApiError.notFound('Creator profile not found');

  // "Over" = ended, cancelled, or never started and past its end + 1 h
  // grace (the same rule the upcoming list uses, so nothing falls between).
  const filter = {
    creator: creator._id,
    $or: [{ isCompleted: true }, { isCancelled: true }, { isLive: { $ne: true }, scheduledAt: { $lt: new Date(Date.now() - MIN_OVER_MS) } }],
  };

  const [found, total] = await Promise.all([
    Session.find(filter).sort({ scheduledAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Session.countDocuments(filter),
  ]);
  const sessions = found.filter((x) => x.isCompleted || x.isCancelled || isOver(x));

  const { Attendance } = require('../FanittStore/services/attendance.service');
  const rows = sessions.length
    ? await Attendance.find({ kind: 'meet', ref: { $in: sessions.map((x) => x._id) }, isHost: false }).select('ref totalSeconds').lean()
    : [];
  const byRef = new Map();
  for (const r of rows) {
    const st = byRef.get(String(r.ref)) || { attended: 0, seconds: 0 };
    st.attended += 1;
    st.seconds += r.totalSeconds || 0;
    byRef.set(String(r.ref), st);
  }

  const items = sessions.map((x) => {
    const st = byRef.get(String(x._id));
    const started = Boolean(x.isCompleted || x.startNotifiedAt || st);
    return {
      _id: x._id,
      title: x.title,
      coverImageUrl: x.coverImageUrl || '',
      type: x.type,
      price: x.price || 0,
      scheduledAt: x.scheduledAt,
      durationMinutes: x.durationMinutes,
      bookedCount: x.bookedCount || 0,
      attended: st?.attended || 0,
      watchedSeconds: st?.seconds || 0,
      status: x.isCancelled ? 'cancelled' : started ? 'ended' : 'missed',
    };
  });

  return new ApiResponse(200, { sessions: items, total, page, pages: Math.ceil(total / limit) }, 'Session history fetched').send(res);
});

// GET /api/sessions/mine/upcoming — the host's sessions that are live or can
// still start, with how many booked, what they earned and the latest bookers.
const myUpcomingSessions = catchAsync(async (req, res) => {
  const creator = await CreatorProfile.findOne({ user: req.user._id }).select('_id');
  if (!creator) throw ApiError.notFound('Creator profile not found');

  const found = await Session.find({
    creator: creator._id,
    isCancelled: { $ne: true },
    isCompleted: { $ne: true },
    $or: [{ isLive: true }, { scheduledAt: { $gte: new Date(Date.now() - 4 * 60 * 60 * 1000) } }],
  })
    .populate('category', 'label icon')
    .sort({ scheduledAt: 1 })
    .limit(100)
    .lean();
  const sessions = found.filter((s) => s.isLive || !isOver(s));
  sessions.sort((a, b) => Number(Boolean(b.isLive)) - Number(Boolean(a.isLive)));

  const ids = sessions.map((s) => s._id);
  const bookings = ids.length
    ? await Booking.find({ session: { $in: ids }, status: { $in: BOOKED } }).select('session user amountPaid createdAt').sort({ createdAt: -1 }).lean()
    : [];

  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const stats = new Map();
  const wanted = new Set();
  for (const b of bookings) {
    const key = String(b.session);
    const st = stats.get(key) || { count: 0, earned: 0, today: 0, recent: [] };
    st.count += 1;
    st.earned += b.amountPaid || 0;
    if (new Date(b.createdAt).getTime() > dayAgo) st.today += 1;
    if (st.recent.length < 4) {
      st.recent.push(String(b.user));
      wanted.add(String(b.user));
    }
    stats.set(key, st);
  }
  const users = wanted.size ? await User.find({ _id: { $in: [...wanted] } }).select('name avatarUrl').lean() : [];
  const byId = new Map(users.map((u) => [String(u._id), u]));

  const items = sessions.map((s) => {
    const st = stats.get(String(s._id)) || { count: 0, earned: 0, today: 0, recent: [] };
    return {
      ...s,
      bookedCount: st.count,
      earned: st.earned,
      bookedToday: st.today,
      recentBookers: st.recent.map((id) => ({ name: byId.get(id)?.name || 'Fanitt user', avatarUrl: byId.get(id)?.avatarUrl || '' })),
    };
  });

  return new ApiResponse(200, items, 'Upcoming sessions fetched').send(res);
});

// GET /api/sessions/:id/bookings — host only: everyone who booked, newest first.
const sessionBookings = catchAsync(async (req, res) => {
  const session = await Session.findById(req.params.id).populate('creator', 'user');
  if (!session) throw ApiError.notFound('Session not found');
  if (String(session.creator?.user) !== String(req.user._id)) throw ApiError.forbidden('Only the host can see who booked');

  const bookings = await Booking.find({ session: session._id, status: { $in: BOOKED } })
    .populate('user', 'name avatarUrl')
    .sort({ createdAt: -1 })
    .lean();

  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const people = bookings.map((b) => ({
    bookingId: b._id,
    userId: b.user?._id || null,
    name: b.user?.name || 'Fanitt user',
    avatarUrl: b.user?.avatarUrl || '',
    bookedAt: b.createdAt,
    paid: b.amountPaid || 0,
    attended: Boolean(b.attended),
  }));
  const max = session.maxParticipants || 0;

  return new ApiResponse(
    200,
    {
      sessionId: session._id,
      title: session.title,
      scheduledAt: session.scheduledAt,
      type: session.type,
      price: session.price || 0,
      isLive: Boolean(session.isLive),
      maxParticipants: max,
      booked: people.length,
      seatsLeft: Math.max(0, max - people.length),
      earned: people.reduce((sum, p) => sum + p.paid, 0),
      bookedToday: people.filter((p) => new Date(p.bookedAt).getTime() > dayAgo).length,
      people,
    },
    'Bookings fetched'
  ).send(res);
});

module.exports = { listSessions, getSessionById, createSession, updateSession, cancelSession, getJoinToken, goLive, endLive, uploadBanner, mySessionHistory, myUpcomingSessions, sessionBookings };