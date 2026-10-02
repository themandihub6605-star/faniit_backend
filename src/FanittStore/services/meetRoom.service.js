const mongoose = require('mongoose');
const ApiError = require('../../utils/apiError');
const livekit = require('./livekit.service');
const log = require('../utils/logger');

// Virtual Meet rooms on LiveKit (in-app — no Zoom, no passcodes).
// A meet is an existing Live Session. The host (creator) starts it; people
// with a confirmed booking join once it's live. Everyone in a meet can talk
// and turn on their camera.

const HOST_EARLY_MS = 30 * 60 * 1000; // host can start 30 min early
const GRACE_AFTER_MS = 60 * 60 * 1000; // and keep it open 1 h past the planned end

const models = () => ({ Session: mongoose.models.Session, Booking: mongoose.models.Booking });

const roomName = (sessionId) => `meet-${sessionId}`;

function endsAt(session) {
  return new Date(new Date(session.scheduledAt).getTime() + (session.durationMinutes || 60) * 60 * 1000);
}

async function loadSession(sessionId) {
  if (!mongoose.isValidObjectId(sessionId)) throw ApiError.notFound('Meeting not found');
  const session = await models().Session.findById(sessionId).populate({ path: 'creator', select: 'user slug', populate: { path: 'user', select: 'name avatarUrl' } });
  if (!session) throw ApiError.notFound('Meeting not found');
  return session;
}

function hostUserId(session) {
  return String(session.creator?.user?._id || session.creator?.user || '');
}

async function isBooked(sessionId, userId) {
  if (!userId) return false;
  return Boolean(await models().Booking.exists({ session: sessionId, user: userId, status: { $in: ['confirmed', 'completed'] } }));
}

/** What this user can do with this meet. */
async function access(session, user) {
  const now = Date.now();
  const isHost = Boolean(user) && hostUserId(session) === String(user._id);
  const booked = isHost ? true : await isBooked(session._id, user?._id);
  const over = session.isCancelled || session.isCompleted || now > endsAt(session).getTime() + GRACE_AFTER_MS;

  let canJoin = false;
  let reason = null;
  if (session.isCancelled) reason = 'cancelled';
  else if (over) reason = 'ended';
  else if (!user) reason = 'login_required';
  else if (isHost) {
    canJoin = now >= new Date(session.scheduledAt).getTime() - HOST_EARLY_MS || session.isLive;
    if (!canJoin) reason = 'too_early';
  } else if (!booked) reason = 'not_booked';
  else if (!session.isLive) reason = 'not_started';
  else canJoin = true;

  return { isHost, booked, canJoin, reason };
}

/** Host starts (or rejoins); a booked user joins once it's live. */
async function join(user, sessionId) {
  const session = await loadSession(sessionId);
  const a = await access(session, user);
  if (!a.canJoin) {
    const messages = {
      cancelled: 'This meeting was cancelled',
      ended: 'This meeting has ended',
      too_early: 'You can start this meeting 30 minutes before its time',
      not_booked: 'Book this meeting to join it',
      not_started: 'The host hasn’t started the meeting yet',
    };
    throw ApiError.badRequest(messages[a.reason] || 'You can’t join this meeting');
  }

  if (a.isHost && !session.isLive) {
    session.isLive = true;
    await session.save();
    await livekit.ensureRoom(roomName(session._id), { maxParticipants: (session.maxParticipants || 100) + 1, emptyTimeout: 15 * 60 });
    log.info('meet.started', { sessionId: String(session._id) });
  }

  const connection = await livekit.createToken({
    roomName: roomName(session._id),
    identity: user._id,
    name: user.name,
    canPublish: true,
    ttl: '6h',
    metadata: { role: a.isHost ? 'host' : 'guest' },
  });
  return { session, connection, isHost: a.isHost };
}

/** Host ends the meeting for everyone. */
async function end(user, sessionId) {
  const session = await loadSession(sessionId);
  if (hostUserId(session) !== String(user._id)) throw ApiError.forbidden('Only the host can end this meeting');
  session.isLive = false;
  session.isCompleted = true;
  await session.save();
  await livekit.closeRoom(roomName(session._id));
  log.info('meet.ended', { sessionId: String(session._id) });
  return session;
}

module.exports = { access, join, end, loadSession, endsAt, roomName, GRACE_AFTER_MS };