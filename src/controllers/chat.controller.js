const { Conversation, Message, BrandProfile, User, Application } = require('../models');
const notificationService = require('../services/notification.service');
const { getIO } = require('../config/socket');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');
const { ROLES } = require('../constants/enums');

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

/** POST /chat/conversations { userId } — generic conversation start, for
 * any pair EXCEPT creator<->brand. That specific pair can now ONLY talk
 * through a campaign proposal (see startConversationForApplication
 * below) — this function explicitly rejects it, so fan<->creator,
 * fan<->brand, agency<->anyone, etc. all keep working exactly as before,
 * while the one pair that used to bypass proposals entirely no longer can. */
const startConversation = catchAsync(async (req, res) => {
  const { userId } = req.body;
  if (!userId) throw ApiError.badRequest('userId is required');
  if (userId === String(req.user._id)) throw ApiError.badRequest('You cannot message yourself');

  const otherUser = await User.findById(userId).select('role');
  if (!otherUser) throw ApiError.notFound('User not found');

  const pairRoles = [req.user.role, otherUser.role].sort();
  const isCreatorBrandPair = pairRoles[0] === ROLES.BRAND && pairRoles[1] === ROLES.CREATOR;
  if (isCreatorBrandPair) {
    throw ApiError.forbidden(
      'Creators and brands can only message each other through a campaign proposal — apply to a campaign, or reply to an applicant, to start that conversation.',
      [],
      'PROPOSAL_ONLY_MESSAGING'
    );
  }

  let conversation = await Conversation.findOne({
    participants: { $all: [req.user._id, userId], $size: 2 },
    application: null,
  });

  if (!conversation) {
    conversation = await Conversation.create({ participants: [req.user._id, userId] });
  }

  return new ApiResponse(200, conversation, 'Conversation ready').send(res);
});

/** POST /chat/applications/:applicationId/start — the ONLY way a creator
 * and brand can start messaging each other. Only the campaign's brand
 * owner may call this (the creator gets a 403 if they try) — matches the
 * flow: creator sends a proposal, the brand may respond to it, and only
 * then can the creator reply back, all within this one thread. Idempotent
 * — calling it again just returns the same conversation. */
const startConversationForApplication = catchAsync(async (req, res) => {
  const application = await Application.findById(req.params.applicationId)
    .populate({ path: 'campaign', populate: { path: 'brand' } })
    .populate('creator');
  if (!application) throw ApiError.notFound('Proposal not found');
  if (!application.campaign) throw ApiError.notFound('Campaign for this proposal no longer exists');

  const brandUserId = application.campaign.brand.user;
  const creatorUserId = application.creator.user;

  if (!brandUserId.equals(req.user._id)) {
    throw ApiError.forbidden('Only the brand can start this conversation — the creator can reply once the brand has responded.');
  }

  let conversation = await Conversation.findOne({ application: application._id });
  if (!conversation) {
    conversation = await Conversation.create({
      participants: [brandUserId, creatorUserId],
      application: application._id,
      campaign: application.campaign._id,
    });
  }

  return new ApiResponse(200, conversation, 'Conversation ready').send(res);
});

/** GET /chat/applications/:applicationId — lets the creator (or brand)
 * check whether a conversation already exists for one of their
 * proposals, WITHOUT creating one. A creator calling this before the
 * brand has replied just gets `null` back — that's the frontend's signal
 * to show "waiting for the brand to reply" instead of opening a chat. */
const getConversationForApplication = catchAsync(async (req, res) => {
  const conversation = await Conversation.findOne({ application: req.params.applicationId });
  if (!conversation) return new ApiResponse(200, null, 'No conversation yet').send(res);
  if (!conversation.participants.some((p) => p.equals(req.user._id))) {
    throw ApiError.forbidden('You are not part of this conversation');
  }
  return new ApiResponse(200, conversation, 'Conversation fetched').send(res);
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

// Point-Fix: the Pro-only plan gate (assertCanMessage) that used to run
// here has been removed. Creator<->brand messaging is now gated
// STRUCTURALLY — a conversation between them literally cannot exist
// without going through startConversationForApplication above — so the
// plan check is redundant for that pair, and other pairs (fan<->creator
// etc.) were never plan-gated to begin with.
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

module.exports = {
  listConversations,
  startConversation,
  startConversationForApplication,
  getConversationForApplication,
  getMessages,
  sendMessage,
};