const mongoose = require('mongoose');
const { APPLICATION_STATUS } = require('../constants/enums');

// What each side agreed to — the exact text and version, frozen at the moment
// they ticked the box (so later edits by the admin don't change it).
const agreementSchema = new mongoose.Schema(
  {
    acceptedAt: { type: Date, default: null },
    version: { type: Number, default: 0 },
    text: { type: String, default: '' },
  },
  { _id: false }
);

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

    // Creator ticks this when sending the proposal; brand when accepting it.
    // Each side can see the other's.
    creatorAgreement: { type: agreementSchema, default: null },
    brandAgreement: { type: agreementSchema, default: null },
  },
  { timestamps: true }
);

applicationSchema.index({ campaign: 1, creator: 1 }, { unique: true });

module.exports = mongoose.model('Application', applicationSchema);