const { Server } = require('socket.io');
const { verifyAccessToken } = require('../utils/generateToken');
const env = require('./env');
const { User, Conversation, Message } = require('../models');
const notificationService = require('../services/notification.service');

let io = null;

function getIO() {
  if (!io) throw new Error('Socket.IO has not been initialized yet');
  return io;
}

function userRoom(userId) {
  return `user:${userId}`;
}

/** Initializes Socket.IO on the same HTTP server as the REST API. Every
 * connecting socket must present the same JWT access token used for REST
 * requests (sent as `auth.token` on the client) — unauthenticated sockets
 * are rejected in the `io.use` middleware before any event handler runs. */
function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: env.clientUrls,
      credentials: true,
    },
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('Authentication required'));

      const decoded = verifyAccessToken(token);
      const user = await User.findById(decoded.id);
      if (!user) return next(new Error('User no longer exists'));
      if (user.isSuspended) return next(new Error('Account suspended'));

      socket.userId = String(user._id);
      next();
    } catch (err) {
      next(new Error('Invalid or expired token'));
    }
  });

  io.on('connection', (socket) => {
    socket.join(userRoom(socket.userId));

    socket.on('send_message', async ({ conversationId, text }, ack) => {
      try {
        if (!text?.trim()) throw new Error('Message text is required');

        const conversation = await Conversation.findById(conversationId);
        if (!conversation) throw new Error('Conversation not found');
        if (!conversation.participants.some((p) => String(p) === socket.userId)) {
          throw new Error('You are not part of this conversation');
        }

        const message = await Message.create({
          conversation: conversation._id,
          sender: socket.userId,
          text: text.trim(),
        });

        conversation.lastMessage = text.trim();
        conversation.lastMessageAt = new Date();
        const otherParticipants = conversation.participants.filter((p) => String(p) !== socket.userId);
        otherParticipants.forEach((p) => {
          const key = String(p);
          conversation.unreadCounts.set(key, (conversation.unreadCounts.get(key) || 0) + 1);
        });
        await conversation.save();

        // Push to every participant's personal room — covers the sender's
        // other open tabs/devices too, so we never need a manual "append
        // locally" on the sending side; the event is the single source.
        conversation.participants.forEach((p) => {
          io.to(userRoom(String(p))).emit('new_message', { conversationId: String(conversation._id), message });
        });

        for (const participantId of otherParticipants) {
          await notificationService.notify({
            userId: participantId,
            type: 'new_message',
            title: 'New message',
            message: text.trim().slice(0, 80),
            relatedModel: 'Conversation',
            relatedId: conversation._id,
          });
        }

        ack?.({ success: true, message });
      } catch (err) {
        ack?.({ success: false, error: err.message });
      }
    });

    socket.on('typing_start', async ({ conversationId }) => {
      const conversation = await Conversation.findById(conversationId);
      if (!conversation) return;
      conversation.participants
        .filter((p) => String(p) !== socket.userId)
        .forEach((p) => io.to(userRoom(String(p))).emit('typing', { conversationId, userId: socket.userId }));
    });

    socket.on('typing_stop', async ({ conversationId }) => {
      const conversation = await Conversation.findById(conversationId);
      if (!conversation) return;
      conversation.participants
        .filter((p) => String(p) !== socket.userId)
        .forEach((p) => io.to(userRoom(String(p))).emit('typing_stop', { conversationId, userId: socket.userId }));
    });
  });

  return io;
}

module.exports = { initSocket, getIO };