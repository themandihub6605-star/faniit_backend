const mongoose = require('mongoose');
const { LIVE_STATUS, LIVE_VISIBILITY, LIVE_PRIVATE_MODE } = require('../constants');

// A live stream (LiveKit room). Viewers join with a short-lived token from
// /lives/:id/join after the access check (see services/liveAccess.service.js).

const liveStreamSchema = new mongoose.Schema(
  {
    store: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', required: true, index: true },
    host: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    title: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 2000, default: '' },
    coverUrl: { type: String, default: '' },

    visibility: { type: String, enum: Object.values(LIVE_VISIBILITY), default: LIVE_VISIBILITY.PUBLIC },
    privateMode: { type: String, enum: [...Object.values(LIVE_PRIVATE_MODE), null], default: null },
    community: { type: mongoose.Schema.Types.ObjectId, ref: 'Community', default: null },
    allowedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    // People who opened a valid invite link — they don't need the code again.
    invitedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    inviteCode: { type: String, default: '', index: true },

    price: { type: Number, default: 0, min: 0 }, // ticket price in paise, 0 = free
    chatEnabled: { type: Boolean, default: true },
    fanboxEnabled: { type: Boolean, default: true },

    status: { type: String, enum: Object.values(LIVE_STATUS), default: LIVE_STATUS.SCHEDULED, index: true },
    scheduledAt: { type: Date, default: null, index: true },
    startedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    cancelledReason: { type: String, default: '' },
    endedByAdmin: { type: Boolean, default: false },

    roomName: { type: String, required: true, unique: true },

    stats: {
      currentViewers: { type: Number, default: 0 },
      peakViewers: { type: Number, default: 0 },
      totalJoins: { type: Number, default: 0 },
      ticketsSold: { type: Number, default: 0 },
      revenue: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

liveStreamSchema.index({ status: 1, visibility: 1, scheduledAt: 1 });
liveStreamSchema.index({ store: 1, status: 1, createdAt: -1 });

module.exports = mongoose.models.LiveStream || mongoose.model('LiveStream', liveStreamSchema);
