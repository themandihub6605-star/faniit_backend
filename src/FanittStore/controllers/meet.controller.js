const mongoose = require('mongoose');
const catchAsync = require('../../utils/catchAsync');
const ApiResponse = require('../../utils/apiResponse');
const storeService = require('../services/store.service');

// Virtual Meet = the existing Live Sessions feature (Zoom), shown inside
// the store. Booking, payment and joining keep using /api/sessions and
// /api/bookings exactly as before — this only lists them for the store.

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

module.exports = { upcomingMeetsFor, listMyMeets };
