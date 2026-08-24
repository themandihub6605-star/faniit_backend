const { Conversation, Message, BrandProfile } = require('../models');
const notificationService = require('../services/notification.service');
const { getIO } = require('../config/socket');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');

/** Chat should always show a *public identity* — a brand's company name and
 * logo, never the personal name/photo they signed up with (which is often
 * just whatever they typed at signup, sometimes email-derived). Creators
 * already show their own typed name/uploaded photo correctly, so only
 * brand-role participants need their display fields swapped here. */
async function withBrandDisplayIdentity(participants) {
  const brandUserIds = participants.filter((p) => p.role === 'brand').map((p) => p._id);
  if (brandUserIds.length === 0) return participants;

  const brandProfiles = await BrandProfile.find({ user: { $in: brandUserIds } }).select('user companyName logoUrl');
  const brandByUserId = new Map(brandProfiles.map((b) => [String(b.user), b]));

  return participants.map((p) => {
    if (p.role !== 'brand') return p;
    const brand = brandByUserId.get(String(p._id));
    if (!brand) return p;
    const obj = p.toObject ? p.toObject() : p;
    return { ...obj, name: brand.companyName, avatarUrl: brand.logoUrl || obj.avatarUrl };
  });
}

const listConversations = catchAsync(async (req, res) => {
  const conversations = await Conversation.find({ participants: req.user._id })
    .populate('participants', 'name avatarUrl role')
    .sort({ lastMessageAt: -1 });

  const withUnread = await Promise.all(
    conversations.map(async (c) => ({
      ...c.toObject(),
      participants: await withBrandDisplayIdentity(c.participants),
      unreadCount: c.unreadCounts?.get(String(req.user._id)) || 0,
    }))
  );

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

  try {
    const io = getIO();
    conversation.participants
      .filter((p) => !p.equals(req.user._id))
      .forEach((p) => io.to(`user:${p}`).emit('messages_read', { conversationId: String(conversation._id), readBy: String(req.user._id) }));
  } catch {
    // socket layer not up yet — safe to skip
  }

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

  try {
    const io = getIO();
    conversation.participants.forEach((p) => {
      io.to(`user:${p}`).emit('new_message', { conversationId: String(conversation._id), message });
    });
  } catch {
    // socket layer not up — REST caller still gets the message in the response
  }

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