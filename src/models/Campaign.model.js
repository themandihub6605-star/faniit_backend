const mongoose = require('mongoose');
const { CAMPAIGN_STATUS } = require('../constants/enums');

const campaignSchema = new mongoose.Schema(
  {
    brand: { type: mongoose.Schema.Types.ObjectId, ref: 'BrandProfile', required: true, index: true },

    title: { type: String, required: true, trim: true },
    description: { type: String, required: true, maxlength: 2000 },
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category' },

    budget: { type: Number, required: true }, // total campaign budget, in paise
    durationLabel: { type: String, default: '' }, // e.g. "2-week campaign"
    location: { type: String, default: 'Remote' },
    creatorRequirement: { type: String, default: '' }, // free-text: "Fitness creators, 20K+ followers"

    status: { type: String, enum: Object.values(CAMPAIGN_STATUS), default: CAMPAIGN_STATUS.OPEN },

    assignedCreator: { type: mongoose.Schema.Types.ObjectId, ref: 'CreatorProfile', default: null },

    // escrow tracking
    escrowTransaction: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', default: null },
    isEscrowFunded: { type: Boolean, default: false },
    isEscrowReleased: { type: Boolean, default: false },

    submittedWorkUrl: { type: String, default: '' },
    submittedAt: { type: Date, default: null },
    approvedAt: { type: Date, default: null },

    applicantCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

campaignSchema.index({ category: 1 });
campaignSchema.index({ status: 1 });

module.exports = mongoose.model('Campaign', campaignSchema);
