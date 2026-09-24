const mongoose = require('mongoose');
const { APPLICATION_STATUS } = require('../constants/enums');

const applicationSchema = new mongoose.Schema(
  {
    campaign: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', required: true, index: true },
    creator: { type: mongoose.Schema.Types.ObjectId, ref: 'CreatorProfile', required: true, index: true },

    pitch: { type: String, maxlength: 1000, default: '' },
    quotedAmount: { type: Number, default: null }, // in paise, null = accepts posted budget
    portfolioLinks: { type: [String], default: [] }, // up to 3 links to relevant past work
    deliveryTimeline: { type: String, default: '' }, // e.g. "3 days", "1 week" — creator's estimated turnaround

    status: { type: String, enum: Object.values(APPLICATION_STATUS), default: APPLICATION_STATUS.PENDING },

    // Set when the brand decides (were written by the controller but missing
    // from the schema, so mongoose silently dropped them).
    feedback: { type: String, default: '' },
    rejectionReason: { type: String, default: '' },
    respondedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

applicationSchema.index({ campaign: 1, creator: 1 }, { unique: true });

module.exports = mongoose.model('Application', applicationSchema);