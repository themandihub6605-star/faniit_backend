const { Conversation, Message } = require('../models');
const notificationService = require('../services/notification.service');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');

const listConversations = catchAsync(async (req, res) => {
  const conversations = await Conversation.find({ participants: req.user._id })
    .populate('participants', 'name avatarUrl role')
    .sort({ lastMessageAt: -1 });

  const withUnread = conversations.map((c) => ({
    ...c.toObject(),
    unreadCount: c.unreadCounts?.get(String(req.user._id)) || 0,
  }));

  return new ApiResponse(200, withUnread, 'Conversations fetched').send(res);
});

const startConversation = catchAsync(async (req, res) => {
  const { userId } = req.body;
  if (!userId) throw ApiError.badRequest('userId is required');
  if (userId === String(req.user._id)) throw ApiError.badRequest('You cannot message yourself');

  let conversation = await Conversation.findOne({
    participants: { $all: [req.user._id, userId], $size: 2 },
  });

  if (!conversation) {
    conversation = await Conversation.create({ participants: [req.user._id, userId] });
  }

  return new ApiResponse(200, conversation, 'Conversation ready').send(res);
});

const getMessages = catchAsync(async (req, res) => {
  const conversation = await Conversation.findById(req.params.id);
  if (!conversation) throw ApiError.notFound('Conversation not found');
  if (!conversation.participants.some((p) => p.equals(req.user._id))) {
    throw ApiError.forbidden('You are not part of this conversation');
  }

  const messages = await Message.find({ conversation: conversation._id }).sort({ createdAt: 1 }).limit(200);

  await Message.updateMany({ conversation: conversation._id, sender: { $ne: req.user._id }, isRead: false }, { isRead: true });
  conversation.unreadCounts.set(String(req.user._id), 0);
  await conversation.save();

  return new ApiResponse(200, messages, 'Messages fetched').send(res);
});

const sendMessage = catchAsync(async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) throw ApiError.badRequest('Message text is required');

  const conversation = await Conversation.findById(req.params.id);
  if (!conversation) throw ApiError.notFound('Conversation not found');
  if (!conversation.participants.some((p) => p.equals(req.user._id))) {
    throw ApiError.forbidden('You are not part of this conversation');
  }

  const message = await Message.create({ conversation: conversation._id, sender: req.user._id, text: text.trim() });

  conversation.lastMessage = text.trim();
  conversation.lastMessageAt = new Date();
  const otherParticipants = conversation.participants.filter((p) => !p.equals(req.user._id));
  otherParticipants.forEach((p) => {
    const key = String(p);
    conversation.unreadCounts.set(key, (conversation.unreadCounts.get(key) || 0) + 1);
  });
  await conversation.save();

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

  return new ApiResponse(201, message, 'Message sent').send(res);
});

module.exports = { listConversations, startConversation, getMessages, sendMessage };