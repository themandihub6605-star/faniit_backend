const mongoose = require('mongoose');
const catchAsync = require('../../utils/catchAsync');
const ApiResponse = require('../../utils/apiResponse');
const ApiError = require('../../utils/apiError');
const meetRoom = require('../services/meetRoom.service');
const livekit = require('../services/livekit.service');
const { safeNotify } = require('../services/notify.service');
const { sendSessionCancelledEmail } = require('../../services/email.service');
const { pageParams, escapeRegex } = require('../utils/text');
const log = require('../utils/logger');

// Admin panel: Live Sessions (Virtual Meets).
// See every meet, who booked it, who is in the room now — and join any
// running meet, either silently (hidden, no mic/camera) or as a visible
// "Fanitt Admin" who can talk. Admin can also remove someone from the
// room, end a running meet, or cancel an upcoming one.

const models = () => ({
  Session: mongoose.models.Session,
  Booking: mongoose.models.Booking,
  User: mongoose.models.User,
  CreatorProfile: mongoose.models.CreatorProfile,
});

const CREATOR_POPULATE = { path: 'creator', select: 'user slug', populate: { path: 'user', select: 'name email avatarUrl' } };
const PAST_AFTER_MS = 3 * 60 * 60 * 1000; // a meet that never started counts as "past" 3 h after its time

function assertObjectId(id) {
  if (!mongoose.isValidObjectId(id)) throw ApiError.notFound('Meeting not found');
}

/** One clear status for the admin list. */
function statusOf(s) {
  if (s.isCancelled) return 'cancelled';
  if (s.isCompleted) return 'completed';
  if (s.isLive) return 'live';
  const now = Date.now();
  if (now > meetRoom.endsAt(s).getTime() + meetRoom.GRACE_AFTER_MS) return 'missed';
  if (now >= new Date(s.scheduledAt).getTime()) return 'late';
  return 'upcoming';
}

function row(s) {
  const user = s.creator?.user || {};
  return {
    _id: s._id,
    title: s.title,
    description: s.description || '',
    coverImageUrl: s.coverImageUrl || '',
    type: s.type,
    price: s.price || 0,
    scheduledAt: s.scheduledAt,
    endsAt: meetRoom.endsAt(s),
    durationMinutes: s.durationMinutes,
    maxParticipants: s.maxParticipants,
    bookedCount: s.bookedCount || 0,
    status: statusOf(s),
    host: { _id: user._id || null, name: user.name || '', email: user.email || '', avatarUrl: user.avatarUrl || '', slug: s.creator?.slug || '' },
    createdAt: s.createdAt,
  };
}

function filterFor(status) {
  const now = new Date();
  const open = { isCancelled: { $ne: true }, isCompleted: { $ne: true } };
  switch (status) {
    case 'live':
      return { ...open, isLive: true };
    case 'upcoming':
      return { ...open, isLive: { $ne: true }, scheduledAt: { $gte: new Date(now.getTime() - PAST_AFTER_MS) } };
    case 'past':
      return {
        isCancelled: { $ne: true },
        $or: [{ isCompleted: true }, { isLive: { $ne: true }, scheduledAt: { $lt: new Date(now.getTime() - PAST_AFTER_MS) } }],
      };
    case 'cancelled':
      return { isCancelled: true };
    default:
      return {};
  }
}

async function creatorIdsMatching(search) {
  const { User, CreatorProfile } = models();
  const pattern = new RegExp(escapeRegex(search), 'i');
  const users = await User.find({ $or: [{ name: pattern }, { email: pattern }] }).select('_id').limit(300);
  if (!users.length) return [];
  return CreatorProfile.find({ user: { $in: users.map((u) => u._id) } }).distinct('_id');
}

/** GET /api/store/admin/meets?status=live|upcoming|past|cancelled|all&search=&page= */
const listMeets = catchAsync(async (req, res) => {
  const { Session } = models();
  const { page, limit, skip } = pageParams(req.query);
  const status = String(req.query.status || 'all');
  const filter = filterFor(status);

  const search = String(req.query.search || '').trim();
  if (search) {
    const creatorIds = await creatorIdsMatching(search);
    const match = [{ title: new RegExp(escapeRegex(search), 'i') }, { creator: { $in: creatorIds } }];
    if (filter.$or) {
      filter.$and = [{ $or: filter.$or }, { $or: match }];
      delete filter.$or;
    } else {
      filter.$or = match;
    }
  }

  const sort = status === 'upcoming' ? { scheduledAt: 1 } : status === 'live' ? { updatedAt: -1 } : { scheduledAt: -1 };
  const [sessions, total, liveNow] = await Promise.all([
    Session.find(filter).populate(CREATOR_POPULATE).sort(sort).skip(skip).limit(limit),
    Session.countDocuments(filter),
    Session.countDocuments(filterFor('live')),
  ]);

  return new ApiResponse(200, { meets: sessions.map(row), total, page, pages: Math.ceil(total / limit), liveNow }, 'Meets fetched').send(res);
});

/** GET /api/store/admin/meets/:id — details, bookings, and who is in the room. */
const getMeet = catchAsync(async (req, res) => {
  assertObjectId(req.params.id);
  const { Session, Booking } = models();
  const session = await Session.findById(req.params.id).populate(CREATOR_POPULATE);
  if (!session) throw ApiError.notFound('Meeting not found');

  const bookings = await Booking.find({ session: session._id }).populate('user', 'name email avatarUrl phone').sort({ createdAt: -1 }).limit(500);
  const confirmed = bookings.filter((b) => b.status === 'confirmed' || b.status === 'completed');
  const participants = session.isLive ? await livekit.listParticipants(meetRoom.roomName(session._id)) : [];

  return new ApiResponse(
    200,
    {
      meet: row(session),
      stats: {
        booked: confirmed.length,
        pending: bookings.filter((b) => b.status === 'pending').length,
        revenue: confirmed.reduce((sum, b) => sum + (b.amountPaid || 0), 0),
        inRoom: participants.filter((p) => !p.hidden).length,
      },
      bookings: bookings.map((b) => ({
        _id: b._id,
        status: b.status,
        amountPaid: b.amountPaid || 0,
        joinedAt: b.joinedAt,
        createdAt: b.createdAt,
        user: b.user ? { _id: b.user._id, name: b.user.name, email: b.user.email, avatarUrl: b.user.avatarUrl || '', phone: b.user.phone || '' } : null,
      })),
      participants,
    },
    'Meet fetched'
  ).send(res);
});

/** GET /api/store/admin/meets/:id/participants — live room list (polled while watching). */
const listParticipants = catchAsync(async (req, res) => {
  assertObjectId(req.params.id);
  const participants = await livekit.listParticipants(meetRoom.roomName(req.params.id));
  return new ApiResponse(200, participants, 'Participants').send(res);
});

/**
 * POST /api/store/admin/meets/:id/join { mode: 'silent' | 'speak' }
 * silent → hidden from everyone, can't talk or chat.
 * speak  → shows as "Fanitt Admin", can use mic/camera and chat.
 */
const joinMeet = catchAsync(async (req, res) => {
  assertObjectId(req.params.id);
  const session = await meetRoom.loadSession(req.params.id);
  if (session.isCancelled) throw ApiError.badRequest('This meeting was cancelled');
  if (session.isCompleted) throw ApiError.badRequest('This meeting has ended');
  if (!session.isLive) throw ApiError.badRequest('The host hasn’t started this meeting yet');

  const silent = req.body?.mode !== 'speak';
  const connection = await livekit.createToken({
    roomName: meetRoom.roomName(session._id),
    identity: `admin-${req.user._id}`,
    name: 'Fanitt Admin',
    canPublish: !silent,
    canChat: !silent,
    hidden: silent,
    ttl: '3h',
    metadata: { role: 'admin' },
  });
  log.info('admin.meet_joined', { sessionId: String(session._id), adminId: String(req.user._id), mode: silent ? 'silent' : 'speak' });
  return new ApiResponse(200, { meet: row(session), connection, mode: silent ? 'silent' : 'speak' }, 'Joined').send(res);
});

/** POST /api/store/admin/meets/:id/participants/:identity/remove */
const removeParticipant = catchAsync(async (req, res) => {
  assertObjectId(req.params.id);
  const session = await meetRoom.loadSession(req.params.id);
  if (!session.isLive) throw ApiError.badRequest('This meeting is not live');
  const identity = String(req.params.identity);
  if (identity === String(session.creator?.user?._id)) throw ApiError.badRequest('End the meeting instead of removing the host');
  try {
    await livekit.removeParticipant(meetRoom.roomName(session._id), identity);
  } catch (err) {
    throw ApiError.badRequest('This person is no longer in the meeting');
  }
  log.info('admin.meet_participant_removed', { sessionId: String(session._id), identity, adminId: String(req.user._id) });
  return new ApiResponse(200, null, 'Removed from the meeting').send(res);
});

/** POST /api/store/admin/meets/:id/end { reason } — ends a running meet for everyone. */
const endMeet = catchAsync(async (req, res) => {
  assertObjectId(req.params.id);
  const session = await meetRoom.loadSession(req.params.id);
  if (!session.isLive) throw ApiError.badRequest('This meeting is not live');

  session.isLive = false;
  session.isCompleted = true;
  await session.save();
  await livekit.closeRoom(meetRoom.roomName(session._id));
  log.info('admin.meet_ended', { sessionId: String(session._id), adminId: String(req.user._id) });

  await safeNotify({
    userId: session.creator?.user?._id,
    fromUser: req.user._id,
    type: 'general',
    title: 'Your meeting was ended by Fanitt',
    message: `"${session.title}": ${req.body.reason}`,
    relatedModel: 'Session',
    relatedId: session._id,
  });
  return new ApiResponse(200, row(session), 'Meeting ended').send(res);
});

/** POST /api/store/admin/meets/:id/cancel { reason } — cancels an upcoming meet; host + bookers are told. */
const cancelMeet = catchAsync(async (req, res) => {
  assertObjectId(req.params.id);
  const { Booking } = models();
  const session = await meetRoom.loadSession(req.params.id);
  if (session.isCancelled) throw ApiError.badRequest('This meeting is already cancelled');
  if (session.isCompleted) throw ApiError.badRequest('This meeting has already ended');

  const wasLive = session.isLive;
  session.isLive = false;
  session.isCancelled = true;
  await session.save();
  if (wasLive) await livekit.closeRoom(meetRoom.roomName(session._id));
  log.info('admin.meet_cancelled', { sessionId: String(session._id), adminId: String(req.user._id) });

  const hostName = session.creator?.user?.name || 'the creator';
  await safeNotify({
    userId: session.creator?.user?._id,
    fromUser: req.user._id,
    type: 'general',
    title: 'Your meeting was cancelled by Fanitt',
    message: `"${session.title}": ${req.body.reason}`,
    relatedModel: 'Session',
    relatedId: session._id,
  });

  const bookings = await Booking.find({ session: session._id, status: 'confirmed' }).populate('user', 'name email');
  await Promise.all(
    bookings.map(async (b) => {
      if (!b.user) return;
      await safeNotify({
        userId: b.user._id,
        type: 'general',
        title: 'Meeting cancelled',
        message: `"${session.title}" with ${hostName} was cancelled.`,
        relatedModel: 'Session',
        relatedId: session._id,
      });
      if (b.user.email) {
        sendSessionCancelledEmail({
          to: b.user.email,
          name: b.user.name,
          sessionTitle: session.title,
          scheduledAt: session.scheduledAt,
          otherPartyName: hostName,
        }).catch((err) => log.warn('admin.meet_cancel_email_failed', { message: err?.message }));
      }
    })
  );

  return new ApiResponse(200, row(session), 'Meeting cancelled').send(res);
});

module.exports = { listMeets, getMeet, listParticipants, joinMeet, removeParticipant, endMeet, cancelMeet };