const mongoose = require('mongoose');

const NOTIFICATION_TYPES = [
  'session_booking',
  'session_reminder',
  'payment_success',
  'donation_received',
  'collaboration_invitation',
  'campaign_update',
  'proposal_received',
  'proposal_status_update',
  'new_message',
  'feedback_received',
  'payout_released',
  'account_verified',
  'general',
  'milestone_funded',
  'milestone_submitted',
  'milestone_changes_requested',
  'dispute_raised',
  'dispute_refund',
  'gift_received',
  'like',
  'follow',
  'community_mention',
  'community_reply',
  'community_join_request',
  'community_join_approved',
  'community_announcement',
  // Fanitt Store
  'store_order',
  'store_sale',
  'store_update',
  'store_live',
  'store_call',
];

const RELATED_MODELS = ['Post', 'User', 'Session', 'Milestone', 'Dispute', 'Gift', 'Proposal', 'Campaign', 'Collaboration', 'Conversation', 'Community', 'CommunityPost', 'Broadcast', 'Store', 'StoreOrder', 'DigitalProduct', 'LiveStream', 'CallSession'];

const notificationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: NOTIFICATION_TYPES, default: 'general' },
    fromUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    title: { type: String, required: true },
    message: { type: String, required: true },
    relatedModel: { type: String, enum: RELATED_MODELS, default: null },
    relatedId: { type: mongoose.Schema.Types.ObjectId, refPath: 'relatedModel', default: null },
    // Optional picture and tap-through link (admin broadcasts).
    imageUrl: { type: String, default: '' },
    link: { type: String, default: '' },
    isRead: { type: Boolean, default: false },
  },
  { timestamps: true }
);

notificationSchema.index({ user: 1, isRead: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);