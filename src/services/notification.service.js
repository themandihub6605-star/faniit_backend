const { Notification, User } = require('../models');
const { getFirebaseAdmin } = require('../config/firebase');

/** Tokens Firebase reports as dead — removed so we stop sending to them. */
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

/**
 * Sends a push notification to every device of a user. Never throws:
 * push is best-effort, the in-app notification is the source of truth.
 */
async function sendPush(userId, { title, message, data = {} }) {
  try {
    const user = await User.findById(userId).select('+pushTokens');
    const tokens = (user?.pushTokens || []).map((t) => t.token);
    if (tokens.length === 0) return;

    const admin = getFirebaseAdmin();
    const stringData = Object.fromEntries(
      Object.entries(data).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, String(v)])
    );

    const response = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title, body: message },
      data: stringData,
      android: { priority: 'high', notification: { channelId: 'fanitt_default', color: '#F4511E' } },
      apns: { payload: { aps: { sound: 'default' } } },
    });

    const dead = [];
    response.responses.forEach((r, i) => {
      if (!r.success && DEAD_TOKEN_CODES.has(r.error?.code)) dead.push(tokens[i]);
    });
    if (dead.length > 0) {
      await User.updateOne({ _id: userId }, { $pull: { pushTokens: { token: { $in: dead } } } });
    }
  } catch (err) {
    console.error('[push] failed:', err.message);
  }
}

async function notify({ userId, fromUser = null, type = 'general', title, message, relatedModel = null, relatedId = null }) {
  const notification = await Notification.create({
    user: userId,
    fromUser,
    type,
    title,
    message,
    relatedModel,
    relatedId,
  });

  // Fire and forget — the request doesn't wait for Firebase.
  sendPush(userId, {
    title,
    message,
    data: { notificationId: notification._id, type, relatedModel, relatedId },
  });

  return notification;
}

module.exports = { notify, sendPush };
