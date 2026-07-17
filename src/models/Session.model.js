const mongoose = require('mongoose');
const { SESSION_TYPES } = require('../constants/enums');

const sessionSchema = new mongoose.Schema(
  {
    creator: { type: mongoose.Schema.Types.ObjectId, ref: 'CreatorProfile', required: true, index: true },

    title: { type: String, required: true, trim: true },
    description: { type: String, maxlength: 1000, default: '' },
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category' },
    coverImageUrl: { type: String, default: '' },

    type: { type: String, enum: Object.values(SESSION_TYPES), required: true },
    price: { type: Number, default: 0 },

    scheduledAt: { type: Date, required: true },
    durationMinutes: { type: Number, required: true },
    maxParticipants: { type: Number, default: 100 },

    zoomMeetingId: { type: String, default: '' },
    zoomJoinUrl: { type: String, default: '' },
    zoomStartUrl: { type: String, default: '' },
    zoomPassword: { type: String, default: '', select: false },

    isLive: { type: Boolean, default: false },
    isCompleted: { type: Boolean, default: false },
    isCancelled: { type: Boolean, default: false },

    recordingUrl: { type: String, default: '' },
    recordingAvailable: { type: Boolean, default: false },

    bookedCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

sessionSchema.index({ scheduledAt: 1 });
sessionSchema.index({ category: 1 });
sessionSchema.index({ type: 1 });

module.exports = mongoose.model('Session', sessionSchema);