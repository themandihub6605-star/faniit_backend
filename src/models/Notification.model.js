const mongoose = require('mongoose');

const NOTIFICATION_TYPES = [
  'session_booking',
  'session_reminder',
  'payment_success',
  'donation_received',
  'collaboration_invitation',
  'campaign_update',
  'feedback_received',
  'payout_released',
  'account_verified',
  'general',
];

const notificationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: NOTIFICATION_TYPES, default: 'general' },

    title: { type: String, required: true },
    message: { type: String, required: true },

    relatedModel: { type: String, default: null },
    relatedId: { type: mongoose.Schema.Types.ObjectId, default: null },

    isRead: { type: Boolean, default: false },
  },
  { timestamps: true }
);

notificationSchema.index({ user: 1, isRead: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
