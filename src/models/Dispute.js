const mongoose = require('mongoose');
const { DISPUTE_STATUS, DISPUTE_OUTCOME } = require('../constants/enums');

const attachmentSchema = new mongoose.Schema(
  { name: { type: String, default: '' }, url: { type: String, required: true } },
  { _id: false }
);

/** One dispute raised by a brand against a submitted milestone (8C in the
 * flow) — holds the brand's reason + evidence while open, and the admin's
 * decision once resolved. A milestone can have at most one *open* dispute
 * at a time (enforced in milestone.service.js's raiseDispute — the
 * milestone is only DISPUTED while this is open). */
const disputeSchema = new mongoose.Schema(
  {
    campaign: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', required: true, index: true },
    milestone: { type: mongoose.Schema.Types.ObjectId, ref: 'Milestone', required: true, index: true },
    raisedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, // the brand's user id

    reason: { type: String, required: true },
    attachments: { type: [attachmentSchema], default: [] },

    status: { type: String, enum: Object.values(DISPUTE_STATUS), default: DISPUTE_STATUS.OPEN, index: true },

    // Populated once an admin resolves this (see dispute.service.js's
    // resolveDispute). creatorAmount/brandRefundAmount are only set for
    // outcomes that actually moved money (not revision_required).
    resolution: {
      outcome: { type: String, enum: Object.values(DISPUTE_OUTCOME), default: null },
      creatorAmount: { type: Number, default: null }, // paise paid to the creator
      brandRefundAmount: { type: Number, default: null }, // paise refunded to the brand
      adminNotes: { type: String, default: '' },
      resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      resolvedAt: { type: Date, default: null },
    },
  },
  { timestamps: true }
);

disputeSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('Dispute', disputeSchema);