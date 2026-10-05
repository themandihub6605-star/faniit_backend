const mongoose = require('mongoose');
const catchAsync = require('../../utils/catchAsync');
const ApiResponse = require('../../utils/apiResponse');
const ApiError = require('../../utils/apiError');
const storeService = require('../services/store.service');
const meetRoom = require('../services/meetRoom.service');
const { pageParams } = require('../utils/text');
const { pinnedIds } = require('../../utils/pinnedIds');

// Virtual Meet = the existing Live Sessions feature. Booking and payment
// keep using /api/bookings; the meeting itself runs in-app on LiveKit
// (services/meetRoom.service.js) — no Zoom, no passcodes.

function sessionModel() {
  return mongoose.models.Session;
}

const UPCOMING = () => ({ isCancelled: { $ne: true }, isCompleted: { $ne: true }, scheduledAt: { $gte: new Date(Date.now() - 2 * 60 * 60 * 1000) } });

function shape(s) {
  return {
    _id: s._id,
    title: s.title,
    description: s.description,
    coverImageUrl: s.coverImageUrl,
    type: s.type,
    price: s.price,
    scheduledAt: s.scheduledAt,
    durationMinutes: s.durationMinutes,
    maxParticipants: s.maxParticipants,
    bookedCount: s.bookedCount,
    isLive: s.isLive,
    isCompleted: s.isCompleted,
    isCancelled: s.isCancelled,
  };
}

/** Upcoming meets of a creator (used on the public store page). */
async function upcomingMeetsFor(creatorProfileId, limit = 10) {
  const Session = sessionModel();
  if (!Session) return [];
  const sessions = await Session.find({ creator: creatorProfileId, ...UPCOMING() }).sort({ scheduledAt: 1 }).limit(limit);
  return sessions.map(shape);
}

/** GET /api/store/me/meets?tab=upcoming|past — the creator's own meets. */
const listMyMeets = catchAsync(async (req, res) => {
  const store = await storeService.requireMyStore(req.user._id);
  const Session = sessionModel();
  if (!Session) return new ApiResponse(200, [], 'Meets fetched').send(res);
  const past = req.query.tab === 'past';
  const filter = past
    ? { creator: store.creator, $or: [{ isCompleted: true }, { isCancelled: true }, { scheduledAt: { $lt: new Date(Date.now() - 2 * 60 * 60 * 1000) } }] }
    : { creator: store.creator, ...UPCOMING() };
  const sessions = await Session.find(filter).sort({ scheduledAt: past ? -1 : 1 }).limit(100);
  return new ApiResponse(200, sessions.map(shape), 'Meets fetched').send(res);
});

// ---------- public: discover, details, join, end ----------

function publicShape(s, extra = {}) {
  const creator = s.creator || {};
  const user = creator.user || {};
  return {
    ...shape(s),
    endsAt: meetRoom.endsAt(s),
    host: { name: user.name || '', avatarUrl: user.avatarUrl || '', slug: creator.slug || '' },
    ...extra,
  };
}

/** GET /api/store/meets?tab=live|upcoming|booked&page= — meets anyone can find. */
const listMeets = catchAsync(async (req, res) => {
  const Session = sessionModel();
  const { page, limit, skip } = pageParams(req.query);
  const now = Date.now();
  const base = { isCancelled: { $ne: true }, isCompleted: { $ne: true } };
  let filter;
  const ids = pinnedIds(req.query);
  if (ids) {
    // Pinned meets (app home) — still only ones that aren't over.
    filter = { ...base, _id: { $in: ids } };
  } else if (req.query.tab === 'live') {
    filter = { ...base, isLive: true };
  } else if (req.query.tab === 'booked') {
    if (!req.user) throw ApiError.unauthorized('Log in to see your meetings');
    const ids = await mongoose.models.Booking.find({ user: req.user._id, status: { $in: ['confirmed', 'completed'] } }).distinct('session');
    filter = { ...base, _id: { $in: ids }, scheduledAt: { $gte: new Date(now - meetRoom.GRACE_AFTER_MS - 6 * 60 * 60 * 1000) } };
  } else {
    // Upcoming and still running (started, but not past its end).
    filter = { ...base, scheduledAt: { $gte: new Date(now - 6 * 60 * 60 * 1000) } };
  }
  const [rows, total] = await Promise.all([
    Session.find(filter)
      .populate({ path: 'creator', select: 'user slug', populate: { path: 'user', select: 'name avatarUrl' } })
      .sort({ isLive: -1, scheduledAt: 1 })
      .skip(skip)
      .limit(limit),
    Session.countDocuments(filter),
  ]);
  // Drop meets whose time has fully passed and never went live.
  const visible = rows.filter((s) => s.isLive || meetRoom.endsAt(s).getTime() > now);

  let bookedIds = new Set();
  if (req.user && visible.length) {
    const booked = await mongoose.models.Booking.find({ user: req.user._id, session: { $in: visible.map((s) => s._id) }, status: { $in: ['confirmed', 'completed'] } }).select('session');
    bookedIds = new Set(booked.map((b) => String(b.session)));
  }
  const meets = visible.map((s) =>
    publicShape(s, {
      booked: bookedIds.has(String(s._id)),
      isHost: Boolean(req.user) && String(s.creator?.user?._id) === String(req.user._id),
    })
  );
  return new ApiResponse(200, { meets, total, page, pages: Math.ceil(total / limit) }, 'Meets').send(res);
});

/** GET /api/store/meets/:id — details + what this user can do. */
const getMeet = catchAsync(async (req, res) => {
  const session = await meetRoom.loadSession(req.params.id);
  const access = await meetRoom.access(session, req.user);
  return new ApiResponse(200, { meet: publicShape(session, { booked: access.booked, isHost: access.isHost }), access }, 'Meet').send(res);
});

/** POST /api/store/meets/:id/join — LiveKit connection (host starts the meeting). */
const joinMeet = catchAsync(async (req, res) => {
  const { session, connection, isHost } = await meetRoom.join(req.user, req.params.id);
  return new ApiResponse(200, { meet: publicShape(session, { booked: true, isHost }), connection, role: isHost ? 'host' : 'guest' }, 'Joined').send(res);
});

/** POST /api/store/meets/:id/end — host ends it for everyone. */
const endMeet = catchAsync(async (req, res) => {
  const session = await meetRoom.end(req.user, req.params.id);
  return new ApiResponse(200, shape(session), 'Meeting ended').send(res);
});

module.exports = { upcomingMeetsFor, listMyMeets, listMeets, getMeet, joinMeet, endMeet };