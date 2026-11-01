// File: src/FanittStore/services/liveCollab.service.js
const ApiError = require('../../utils/apiError');
const { User, CreatorProfile } = require('../../models');
const { LiveStream } = require('../models');
const { LIVE_STATUS, LIMITS, LIVE_VISIBILITY } = require('../constants');
const livekit = require('./livekit.service');
const { safeNotify } = require('./notify.service');
const log = require('../utils/logger');

// Collab lives: the host invites other creators to go live together.
//
//   invite      host → creator: push "RK invited you to go live together"
//   respond     creator accepts / declines (from the live page)
//   join        an accepted co-host gets a token that can send camera + mic
//   remove      host takes a co-host off (or cancels the invite)
//
// When the live starts (or when a co-host accepts during it) the co-host's
// followers hear "RK and Priya are live together" — that's the point of a
// collab: both audiences.

const MAX_COHOSTS = 2; // host + 2 = 3 people on screen
const ACTIVE = ['invited', 'accepted'];

function entryFor(live, userId) {
  return (live.collaborators || []).find((c) => String(c.user) === String(userId)) || null;
}

function acceptedIds(live) {
  return (live.collaborators || []).filter((c) => c.status === 'accepted').map((c) => String(c.user));
}

/** True when this user is an accepted co-host of this live. */
function isCoHost(live, userId) {
  return Boolean(userId) && entryFor(live, userId)?.status === 'accepted';
}

/** Co-host token: can send camera + mic and chat. */
async function cohostToken(live, user) {
  return livekit.createToken({
    roomName: live.roomName,
    identity: user._id,
    name: user.name,
    canPublish: true,
    canChat: true,
    ttl: LIMITS.LIVE_TOKEN_TTL,
    metadata: { role: 'cohost', liveId: String(live._id) },
  });
}

/** Host's list: everyone invited, with name / photo / status. */
async function list(live) {
  const rows = (live.collaborators || []).filter((c) => c.status !== 'removed');
  if (!rows.length) return [];
  const users = await User.find({ _id: { $in: rows.map((r) => r.user) } }).select('name avatarUrl').lean();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  return rows.map((r) => ({
    userId: r.user,
    name: byId.get(String(r.user))?.name || 'Creator',
    avatarUrl: byId.get(String(r.user))?.avatarUrl || '',
    status: r.status,
    invitedAt: r.invitedAt,
    respondedAt: r.respondedAt,
  }));
}

async function invite(live, hostUser, targetUserId) {
  if (![LIVE_STATUS.SCHEDULED, LIVE_STATUS.LIVE].includes(live.status)) throw ApiError.badRequest('This live has finished');
  if (!targetUserId) throw ApiError.badRequest('Pick a creator to invite');
  if (String(targetUserId) === String(hostUser._id)) throw ApiError.badRequest('You’re already the host');

  const [target, profile] = await Promise.all([
    User.findById(targetUserId).select('name role isSuspended').lean(),
    CreatorProfile.findOne({ user: targetUserId }).select('_id').lean(),
  ]);
  if (!target || !profile || target.isSuspended) throw ApiError.notFound('Creator not found');

  const existing = entryFor(live, targetUserId);
  if (existing && ACTIVE.includes(existing.status)) {
    throw ApiError.conflict(existing.status === 'accepted' ? `${target.name} is already your co-host` : `${target.name} already has your invite`);
  }
  const active = (live.collaborators || []).filter((c) => ACTIVE.includes(c.status)).length;
  if (active >= MAX_COHOSTS) throw ApiError.badRequest(`You can go live with up to ${MAX_COHOSTS} creators at a time`);

  if (existing) {
    existing.status = 'invited';
    existing.invitedAt = new Date();
    existing.respondedAt = null;
  } else {
    live.collaborators.push({ user: targetUserId, status: 'invited', invitedAt: new Date() });
  }
  await live.save();

  const running = live.status === LIVE_STATUS.LIVE;
  await safeNotify({
    userId: targetUserId,
    fromUser: hostUser._id,
    type: 'store_live',
    title: `${hostUser.name || 'A creator'} invited you to go live together 🎥`,
    message: running
      ? `They’re live now with "${live.title}". Tap to join them on screen.`
      : `"${live.title}" — tap to accept. You’ll get a reminder when it starts.`,
    relatedModel: 'LiveStream',
    relatedId: live._id,
  });
  log.info('live.collab_invited', { liveId: String(live._id), userId: String(targetUserId) });
  return list(live);
}

/** "RK and Priya are live together" to a co-host's followers (public lives only). */
async function notifyCoHostFollowers(live, cohostUserId, hostName) {
  try {
    if (live.visibility !== LIVE_VISIBILITY.PUBLIC) return;
    const [profile, cohost, hostProfile] = await Promise.all([
      CreatorProfile.findOne({ user: cohostUserId }).select('followers').lean(),
      User.findById(cohostUserId).select('name').lean(),
      CreatorProfile.findOne({ user: live.host }).select('followers').lean(),
    ]);
    // People who follow both already got "<host> is live".
    const skip = new Set([...(hostProfile?.followers || []).map(String), String(live.host)]);
    const ids = (profile?.followers || []).map(String).filter((id) => !skip.has(id));
    const BATCH = 50;
    for (let i = 0; i < ids.length; i += BATCH) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(
        ids.slice(i, i + BATCH).map((userId) =>
          safeNotify({
            userId,
            fromUser: cohostUserId,
            type: 'store_live',
            title: `${cohost?.name || 'A creator you follow'} and ${hostName || 'a creator'} are live together 🔴`,
            message: live.title ? `"${live.title}" — tap to join.` : 'Tap to join the collab live.',
            relatedModel: 'LiveStream',
            relatedId: live._id,
          })
        )
      );
    }
    log.info('live.collab_followers_notified', { liveId: String(live._id), count: ids.length });
  } catch (err) {
    log.warn('live.collab_followers_notify_failed', { liveId: String(live._id), message: err?.message });
  }
}

/** Invited creator says yes / no. Yes during a running live → a token to join now. */
async function respond(live, user, accept) {
  const entry = entryFor(live, user._id);
  if (!entry || !ACTIVE.includes(entry.status)) throw ApiError.notFound('This invite is no longer open');
  if (![LIVE_STATUS.SCHEDULED, LIVE_STATUS.LIVE].includes(live.status)) throw ApiError.badRequest('This live has finished');

  const host = await User.findById(live.host).select('name').lean();
  if (!accept) {
    entry.status = 'declined';
    entry.respondedAt = new Date();
    await live.save();
    await safeNotify({
      userId: live.host,
      fromUser: user._id,
      type: 'store_live',
      title: `${user.name || 'A creator'} can’t join your live`,
      message: `They declined the invite for "${live.title}".`,
      relatedModel: 'LiveStream',
      relatedId: live._id,
    });
    return { status: 'declined', connection: null };
  }

  const wasAccepted = entry.status === 'accepted';
  entry.status = 'accepted';
  entry.respondedAt = entry.respondedAt || new Date();
  await live.save();

  const running = live.status === LIVE_STATUS.LIVE;
  if (!wasAccepted) {
    await safeNotify({
      userId: live.host,
      fromUser: user._id,
      type: 'store_live',
      title: `${user.name || 'A creator'} accepted your collab 🎉`,
      message: running ? 'They’re joining you on screen now.' : `They’ll go live with you in "${live.title}".`,
      relatedModel: 'LiveStream',
      relatedId: live._id,
    });
    if (running) notifyCoHostFollowers(live, user._id, host?.name);
  }
  return { status: 'accepted', connection: running ? await cohostToken(live, user) : null };
}

/** Host removes a co-host (or cancels an invite). A co-host on screen is taken off. */
async function remove(live, targetUserId) {
  const entry = entryFor(live, targetUserId);
  if (!entry || entry.status === 'removed') return list(live);
  const wasOn = entry.status === 'accepted';
  entry.status = 'removed';
  entry.respondedAt = new Date();
  await live.save();

  if (wasOn && live.status === LIVE_STATUS.LIVE) {
    // Tell their app first (so it can say why), then take them out.
    await livekit.sendData(live.roomName, { t: 'collab_end', i: String(targetUserId) });
    setTimeout(() => {
      livekit.removeParticipant(live.roomName, targetUserId).catch(() => {});
    }, 1500);
  }
  return list(live);
}

/** Live started: accepted co-hosts get "join now", their followers get "live together". */
async function notifyStarted(live, hostName) {
  try {
    const ids = acceptedIds(live);
    await Promise.all(
      ids.map((userId) =>
        safeNotify({
          userId,
          fromUser: live.host,
          type: 'store_live',
          title: `Your collab with ${hostName || 'the host'} is live 🔴`,
          message: `"${live.title}" has started — tap to join on screen.`,
          relatedModel: 'LiveStream',
          relatedId: live._id,
        })
      )
    );
    for (const id of ids) notifyCoHostFollowers(live, id, hostName);
  } catch (err) {
    log.warn('live.collab_start_notify_failed', { liveId: String(live._id), message: err?.message });
  }
}

/** What this user (if invited) sees on the live page. */
async function viewOf(live, userId) {
  const entry = userId ? entryFor(live, userId) : null;
  if (!entry || !ACTIVE.includes(entry.status)) return null;
  const host = await User.findById(live.host).select('name avatarUrl').lean();
  return { status: entry.status, hostName: host?.name || 'The host', hostAvatarUrl: host?.avatarUrl || '' };
}

module.exports = { MAX_COHOSTS, isCoHost, cohostToken, list, invite, respond, remove, notifyStarted, viewOf };