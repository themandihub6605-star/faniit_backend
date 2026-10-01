const log = require('../utils/logger');

// Pushes live events to a user's open app over Socket.IO (room "user:<id>",
// the same room the chat uses). If sockets aren't running it does nothing.
function emitToUser(userId, event, payload) {
  try {
    // Lazy require: the socket module loads the whole app model graph.
    const { getIO } = require('../../config/socket');
    getIO().to(`user:${userId}`).emit(event, payload);
  } catch (err) {
    log.warn('realtime.emit_skipped', { event, userId: String(userId), message: err?.message });
  }
}

module.exports = { emitToUser };
