// File: src/FanittStore/services/meetRoom.service.js
const mongoose = require('mongoose');
const ApiError = require('../../utils/apiError');
const livekit = require('./livekit.service');
const attendance = require('./attendance.service');
const { safeNotify } = require('./notify.service');
const log = require('../utils/logger');

// Virtual Meet rooms on LiveKit (in-app — no Zoom, no passcodes).
// A meet is an existing Live Session. The host (creator) starts it; people
// with a confirmed booking join once it's live. Everyone in a meet can talk
// and turn on their camera; the host can mute people, turn their camera
// off, remove them and lock the meeting.

const HOST_EARLY_MS = 30 * 60 * 1000; // host can start 30 min early
const GRACE_AFTER_MS = 60 * 60 * 1000; // and keep it open 1 h past the planned end
const REMINDER_BEFORE_MS = 15 * 60 * 1000; // "starts in 15 minutes"

const models = () => ({ Session: mongoose.models.Session, Booking: mongoose.models.Booking, CreatorProfile: mongoose.models.CreatorProfile });

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

function hostName(session) {
  return session.creator?.user?.name || 'A creator you follow';
}

async function isBooked(sessionId, userId) {
  if (!userId) return false;
  return Boolean(await models().Booking.exists({ session: sessionId, user: userId, status: { $in: ['confirmed', 'completed'] } }));
}

async function bookedUserIds(sessionId) {
  const ids = await models().Booking.find({ session: sessionId, status: { $in: ['confirmed', 'completed'] } }).distinct('user');
  return ids.map(String);
}

/** Followers of the creator (a CreatorProfile id). */
async function followerIds(creatorProfileId) {
  const profile = await models().CreatorProfile.findById(creatorProfileId).select('followers user').lean();
  const hostId = String(profile?.user || '');
  return (profile?.followers || []).map(String).filter((id) => id && id !== hostId);
}

/** Sends one notification to many people, 50 at a time. Never throws. */
async function notifyMany(userIds, payload) {
  const BATCH = 50;
  for (let i = 0; i < userIds.length; i += BATCH) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(userIds.slice(i, i + BATCH).map((userId) => safeNotify({ ...payload, userId })));
  }
}

function whenText(date) {
  return new Date(date).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * A creator scheduled a new meet → their followers hear about it.
 * Runs in the background; never blocks creating the session.
 */
async function notifyScheduled(session, { hostUser } = {}) {
  try {
    const ids = await followerIds(session.creator?._id || session.creator);
    if (!ids.length) return;
    const name = hostUser?.name || hostName(session);
    await notifyMany(ids, {
      fromUser: hostUser?._id || null,
      type: 'session_booking',
      title: `${name} scheduled a live session`,
      message: `"${session.title}" · ${whenText(session.scheduledAt)}${session.price > 0 ? '' : ' · Free'} — tap to book your spot.`,
      relatedModel: 'Session',
      relatedId: session._id,
    });
    log.info('meet.scheduled_notified', { sessionId: String(session._id), count: ids.length });
  } catch (err) {
    log.warn('meet.scheduled_notify_failed', { sessionId: String(session._id), message: err?.message });
  }
}

/** The host started the meet → booked people (join now) and other followers (it's live). Once per meet. */
async function notifyStarted(session) {
  try {
    const claim = await models().Session.updateOne({ _id: session._id, startNotifiedAt: null }, { $set: { startNotifiedAt: new Date() } });
    if (!claim.modifiedCount) return; // already sent
    const name = hostName(session);
    const booked = await bookedUserIds(session._id);
    const bookedSet = new Set(booked);
    const followers = (await followerIds(session.creator?._id || session.creator)).filter((id) => !bookedSet.has(id));

    await notifyMany(booked, {
      fromUser: hostUserId(session) || null,
      type: 'session_reminder',
      title: 'Your live session has started 🔴',
      message: `${name} started "${session.title}" — join now.`,
      relatedModel: 'Session',
      relatedId: session._id,
    });
    await notifyMany(followers, {
      fromUser: hostUserId(session) || null,
      type: 'session_booking',
      title: `${name} is live in a session 🔴`,
      message: `"${session.title}" has started — tap to see if there are spots left.`,
      relatedModel: 'Session',
      relatedId: session._id,
    });
    log.info('meet.start_notified', { sessionId: String(session._id), booked: booked.length, followers: followers.length });
  } catch (err) {
    log.warn('meet.start_notify_failed', { sessionId: String(session._id), message: err?.message });
  }
}

/** Background job: "starts in 15 minutes" for everyone who booked. */
async function sendReminders() {
  const { Session } = models();
  if (!Session) return;
  const now = Date.now();
  const due = await Session.find({
    isCancelled: { $ne: true },
    isCompleted: { $ne: true },
    reminderSentAt: null,
    scheduledAt: { $gt: new Date(now), $lte: new Date(now + REMINDER_BEFORE_MS) },
  })
    .populate({ path: 'creator', select: 'user', populate: { path: 'user', select: 'name' } })
    .limit(20);
  for (const session of due) {
    // eslint-disable-next-line no-await-in-loop
    const claim = await Session.updateOne({ _id: session._id, reminderSentAt: null }, { $set: { reminderSentAt: new Date() } });
    if (!claim.modifiedCount) continue;
    // eslint-disable-next-line no-await-in-loop
    const booked = await bookedUserIds(session._id);
    const mins = Math.max(1, Math.round((new Date(session.scheduledAt).getTime() - now) / 60000));
    // eslint-disable-next-line no-await-in-loop
    await notifyMany(booked, {
      fromUser: hostUserId(session) || null,
      type: 'session_reminder',
      title: `Starts in ${mins} min ⏰`,
      message: `"${session.title}" with ${hostName(session)} starts soon. Join from the app.`,
      relatedModel: 'Session',
      relatedId: session._id,
    });
    log.info('meet.reminder_sent', { sessionId: String(session._id), count: booked.length });
  }
}

/**
 * Background job: a meet the host left without pressing End stays "live"
 * forever. Close any that are past their end + 1 h grace (and anything
 * live for over 6 hours) so they leave the Live lists.
 */
async function autoEndOverdue() {
  const { Session } = models();
  if (!Session) return;
  const now = Date.now();
  const candidates = await Session.find({ isLive: true, isCompleted: { $ne: true } })
    .select('scheduledAt durationMinutes')
    .limit(50)
    .lean();
  for (const s of candidates) {
    const overdue = now > endsAt(s).getTime() + GRACE_AFTER_MS;
    if (!overdue) continue;
    // eslint-disable-next-line no-await-in-loop
    const claim = await Session.updateOne({ _id: s._id, isLive: true }, { $set: { isLive: false, isCompleted: true, roomLocked: false } });
    if (!claim.modifiedCount) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      await livekit.closeRoom(roomName(s._id));
      // eslint-disable-next-line no-await-in-loop
      await attendance.closeAll({ kind: 'meet', ref: s._id });
    } catch (err) {
      log.warn('meet.auto_end_cleanup_failed', { sessionId: String(s._id), message: err?.message });
    }
    log.info('meet.auto_ended', { sessionId: String(s._id) });
  }
}

/**
 * Someone booked → tell the host: "Rahul booked your session".
 * Background, never throws.
 */
async function notifyHostBooked(session, bookerUser, { paid = 0 } = {}) {
  try {
    const hostId = hostUserId(session);
    if (!hostId || hostId === String(bookerUser?._id)) return;
    const booked = (await bookedUserIds(session._id)).length;
    const seats = session.maxParticipants ? `${booked}/${session.maxParticipants}` : `${booked}`;
    const money = paid > 0 ? ` · ₹${Math.round(paid / 100).toLocaleString('en-IN')} earned` : '';
    await safeNotify({
      userId: hostId,
      fromUser: bookerUser?._id || null,
      type: 'session_booking',
      title: `${bookerUser?.name || 'Someone'} booked your session 🎉`,
      message: `"${session.title}" · ${whenText(session.scheduledAt)} · ${seats} booked${money}`,
      relatedModel: 'Session',
      relatedId: session._id,
    });
  } catch (err) {
    log.warn('meet.host_booked_notify_failed', { sessionId: String(session?._id), message: err?.message });
  }
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
  else if (session.roomLocked) reason = 'locked';
  else canJoin = true;

  return { isHost, booked, canJoin, reason, locked: Boolean(session.roomLocked) };
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
      locked: 'The host has locked this meeting — new people can’t join right now',
    };
    throw ApiError.badRequest(messages[a.reason] || 'You can’t join this meeting');
  }

  if (a.isHost && !session.isLive) {
    session.isLive = true;
    session.roomLocked = false;
    await session.save();
    await livekit.ensureRoom(roomName(session._id), { maxParticipants: (session.maxParticipants || 100) + 1, emptyTimeout: 15 * 60 });
    log.info('meet.started', { sessionId: String(session._id) });
    notifyStarted(session); // background
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
  session.roomLocked = false;
  await session.save();
  await livekit.closeRoom(roomName(session._id));
  await attendance.closeAll({ kind: 'meet', ref: session._id });
  log.info('meet.ended', { sessionId: String(session._id) });
  return session;
}

// ---------- host controls ----------

async function loadOwnLiveMeet(user, sessionId) {
  const session = await loadSession(sessionId);
  if (hostUserId(session) !== String(user._id)) throw ApiError.forbidden('Only the host can do this');
  if (!session.isLive) throw ApiError.badRequest('The meeting isn’t running');
  return session;
}

/**
 * Mutes people's mic or turns their camera off.
 * identity = one person, or omitted for everyone except the host.
 * (LiveKit lets the host mute, not unmute — unmuting is a request the app sends.)
 */
async function hostMute(user, sessionId, { identity, kind = 'audio' }) {
  const session = await loadOwnLiveMeet(user, sessionId);
  const room = roomName(session._id);
  const host = hostUserId(session);
  if (identity && String(identity) === host) throw ApiError.badRequest('Use your own mic button');
  const targets = identity ? [String(identity)] : (await livekit.listParticipants(room)).filter((p) => p.identity !== host && !p.hidden).map((p) => p.identity);
  let count = 0;
  for (const id of targets) {
    // eslint-disable-next-line no-await-in-loop
    count += await livekit.muteTracks(room, id, kind === 'video' ? 'video' : 'audio');
  }
  log.info('meet.host_mute', { sessionId: String(session._id), kind, people: targets.length });
  return { people: targets.length, tracks: count };
}

/**
 * Removes one person from the meeting. They can rejoin with their booking
 * unless the host locks the meeting.
 */
async function hostRemove(user, sessionId, { identity }) {
  const session = await loadOwnLiveMeet(user, sessionId);
  if (!identity || String(identity) === hostUserId(session)) throw ApiError.badRequest('Pick someone to remove');
  try {
    await livekit.removeParticipant(roomName(session._id), identity);
  } catch {
    throw ApiError.notFound('This person has already left');
  }
  log.info('meet.host_remove', { sessionId: String(session._id), identity: String(identity) });
  return { removed: true };
}

/** Locks (no new guests) or unlocks the meeting. */
async function hostLock(user, sessionId, { locked }) {
  const session = await loadOwnLiveMeet(user, sessionId);
  session.roomLocked = Boolean(locked);
  await session.save();
  return { locked: session.roomLocked };
}

/** Who is in the room right now (host view). */
async function hostParticipants(user, sessionId) {
  const session = await loadOwnLiveMeet(user, sessionId);
  const people = (await livekit.listParticipants(roomName(session._id))).filter((p) => !p.hidden);
  return { locked: Boolean(session.roomLocked), people };
}

/** The attendance report — host only, during or after the meeting. */
async function attendanceReport(user, sessionId) {
  const session = await loadSession(sessionId);
  if (hostUserId(session) !== String(user._id)) throw ApiError.forbidden('Only the host can see who attended');
  const booked = await bookedUserIds(session._id);
  const report = await attendance.report({ kind: 'meet', ref: session._id });
  return { ...report, booked: booked.length };
}

module.exports = {
  access,
  join,
  end,
  loadSession,
  endsAt,
  roomName,
  GRACE_AFTER_MS,
  notifyScheduled,
  notifyStarted,
  sendReminders,
  autoEndOverdue,
  notifyHostBooked,
  whenText,
  hostMute,
  hostRemove,
  hostLock,
  hostParticipants,
  attendanceReport,
};