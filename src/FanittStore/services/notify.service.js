const notificationService = require('../../services/notification.service');
const log = require('../utils/logger');

// Notifications must never break a purchase or an admin action, so every
// Store notification goes through here and failures are only logged.
async function safeNotify(payload) {
  try {
    await notificationService.notify(payload);
  } catch (err) {
    log.warn('notify.failed', { type: payload?.type, userId: String(payload?.userId || ''), message: err?.message });
  }
}

module.exports = { safeNotify };
