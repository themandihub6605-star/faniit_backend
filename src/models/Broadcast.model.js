const mongoose = require('mongoose');

// Admin broadcast notifications: sent now or at a scheduled time. The
// scheduler (services/broadcast.service.js) picks up due ones every 30s,
// so scheduled sends survive server restarts.
const STATUSES = ['scheduled', 'sending', 'sent', 'failed', 'cancelled'];
const AUDIENCE_ROLES = ['fan', 'creator', 'brand', 'agency'];

const broadcastSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 100 },
    message: { type: String, required: true, trim: true, maxlength: 500 },
    imageUrl: { type: String, default: '' },
    // Optional link opened when the notification is tapped: a full https URL
    // or a website path like /communities.
    link: { type: String, default: '', maxlength: 500 },

    // Empty roles = everyone. testEmail = send only to that one account.
    roles: { type: [{ type: String, enum: AUDIENCE_ROLES }], default: [] },
    testEmail: { type: String, default: '', lowercase: true, trim: true },

    status: { type: String, enum: STATUSES, default: 'scheduled', index: true },
    scheduledAt: { type: Date, default: Date.now, index: true },
    sentAt: { type: Date, default: null },
    error: { type: String, default: '' },

    stats: {
      targeted: { type: Number, default: 0 },
      inApp: { type: Number, default: 0 },
      devices: { type: Number, default: 0 },
      pushSent: { type: Number, default: 0 },
      pushFailed: { type: Number, default: 0 },
    },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

broadcastSchema.index({ status: 1, scheduledAt: 1 });

broadcastSchema.statics.STATUSES = STATUSES;
broadcastSchema.statics.AUDIENCE_ROLES = AUDIENCE_ROLES;

module.exports = mongoose.model('Broadcast', broadcastSchema);