const { Notification } = require('../models');

/**
 * Creates a notification for a user. Kept as a single function so it's easy
 * to later fan this out to email/push/SMS without touching every call site.
 */
async function notify({ userId, type = 'general', title, message, relatedModel = null, relatedId = null }) {
  return Notification.create({
    user: userId,
    type,
    title,
    message,
    relatedModel,
    relatedId,
  });
}

module.exports = { notify };
