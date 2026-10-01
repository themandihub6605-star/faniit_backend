const { Broadcast, Notification, User } = require('../models');
const { getFirebaseAdmin } = require('../config/firebase');

const INSERT_BATCH = 1000;
const PUSH_BATCH = 500; // FCM multicast limit
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

function audienceFilter(broadcast) {
  if (broadcast.testEmail) return { email: broadcast.testEmail };
  const filter = { role: { $ne: 'admin' }, isActive: { $ne: false }, isSuspended: { $ne: true } };
  if (broadcast.roles && broadcast.roles.length) filter.role = { $in: broadcast.roles };
  return filter;
}

/** How many accounts a broadcast would reach (for the admin preview). */
async function countAudience({ roles = [], testEmail = '' }) {
  return User.countDocuments(audienceFilter({ roles, testEmail }));
}

function pushPayload(broadcast, tokens) {
  const data = {
    type: 'general',
    broadcastId: String(broadcast._id),
    ...(broadcast.link ? { link: broadcast.link } : {}),
    ...(broadcast.imageUrl ? { imageUrl: broadcast.imageUrl } : {}),
  };
  const image = broadcast.imageUrl || undefined;
  return {
    tokens,
    notification: { title: broadcast.title, body: broadcast.message, ...(image ? { imageUrl: image } : {}) },
    data,
    android: {
      priority: 'high',
      notification: { channelId: 'fanitt_default', color: '#F4511E', ...(image ? { imageUrl: image } : {}) },
    },
    apns: {
      payload: { aps: { sound: 'default', 'mutable-content': 1 } },
      ...(image ? { fcmOptions: { imageUrl: image } } : {}),
    },
  };
}

/**
 * Delivers a broadcast: one in-app notification per user plus a push to
 * every registered device. Updates the broadcast's stats and status.
 */
async function deliver(broadcast) {
  const stats = { targeted: 0, inApp: 0, devices: 0, pushSent: 0, pushFailed: 0 };
  try {
    const users = await User.find(audienceFilter(broadcast)).select('_id +pushTokens');
    stats.targeted = users.length;

    // In-app notifications (website + app notification lists)
    for (let i = 0; i < users.length; i += INSERT_BATCH) {
      const docs = users.slice(i, i + INSERT_BATCH).map((u) => ({
        user: u._id,
        type: 'general',
        title: broadcast.title,
        message: broadcast.message,
        imageUrl: broadcast.imageUrl || '',
        link: broadcast.link || '',
        relatedModel: 'Broadcast',
        relatedId: broadcast._id,
      }));
      // eslint-disable-next-line no-await-in-loop
      await Notification.insertMany(docs, { ordered: false });
      stats.inApp += docs.length;
    }

    // Push to phones
    const tokens = [];
    const ownerOf = new Map();
    for (const u of users) {
      for (const t of u.pushTokens || []) {
        if (t?.token && !ownerOf.has(t.token)) {
          tokens.push(t.token);
          ownerOf.set(t.token, u._id);
        }
      }
    }
    stats.devices = tokens.length;

    if (tokens.length) {
      let admin = null;
      try {
        admin = getFirebaseAdmin();
      } catch (err) {
        console.error('[broadcast] Firebase not configured:', err.message);
      }
      if (admin) {
        const dead = [];
        for (let i = 0; i < tokens.length; i += PUSH_BATCH) {
          const batch = tokens.slice(i, i + PUSH_BATCH);
          try {
            // eslint-disable-next-line no-await-in-loop
            const res = await admin.messaging().sendEachForMulticast(pushPayload(broadcast, batch));
            stats.pushSent += res.successCount;
            stats.pushFailed += res.failureCount;
            res.responses.forEach((r, idx) => {
              if (!r.success && DEAD_TOKEN_CODES.has(r.error?.code)) dead.push(batch[idx]);
            });
          } catch (err) {
            stats.pushFailed += batch.length;
            console.error('[broadcast] push batch failed:', err.message);
          }
        }
        if (dead.length) {
          await User.updateMany({ 'pushTokens.token': { $in: dead } }, { $pull: { pushTokens: { token: { $in: dead } } } });
        }
      }
    }

    broadcast.status = 'sent';
    broadcast.sentAt = new Date();
    broadcast.error = '';
  } catch (err) {
    console.error('[broadcast] delivery failed:', err);
    broadcast.status = 'failed';
    broadcast.error = err.message;
  }
  broadcast.stats = stats;
  await broadcast.save();
  return broadcast;
}

/** Runs every due scheduled broadcast. Each one is claimed atomically so
 * two server processes never send the same broadcast twice. */
async function runDueBroadcasts() {
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const due = await Broadcast.findOneAndUpdate(
      { status: 'scheduled', scheduledAt: { $lte: new Date() } },
      { status: 'sending' },
      { sort: { scheduledAt: 1 }, new: true }
    );
    if (!due) return;
    // eslint-disable-next-line no-await-in-loop
    await deliver(due);
  }
}

/** Broadcasts left in 'sending' by a crash/restart go back to the queue. */
async function recoverStuck() {
  const cutoff = new Date(Date.now() - 10 * 60 * 1000);
  await Broadcast.updateMany({ status: 'sending', updatedAt: { $lt: cutoff } }, { status: 'scheduled' });
}

let timer = null;
function startScheduler(intervalMs = 30 * 1000) {
  if (timer) return;
  const tick = () => runDueBroadcasts().catch((err) => console.error('[broadcast] scheduler failed:', err.message));
  recoverStuck().catch(() => {});
  setTimeout(tick, 10 * 1000);
  timer = setInterval(tick, intervalMs);
}

module.exports = { deliver, runDueBroadcasts, startScheduler, countAudience };