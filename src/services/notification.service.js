const { Notification } = require('../models');

async function notify({ userId, fromUser = null, type = 'general', title, message, relatedModel = null, relatedId = null }) {
  return Notification.create({
    user: userId,
    fromUser,
    type,
    title,
    message,
    relatedModel,
    relatedId,
  });
}

module.exports = { notify };