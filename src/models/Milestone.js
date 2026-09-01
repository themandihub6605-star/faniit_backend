const mongoose = require('mongoose');
const { MILESTONE_STATUS } = require('../constants/enums');

/** One payment chunk within a campaign's overall budget. Point 12: every
 * accepted campaign starts with exactly two milestones — an advance
 * (percentage set by SiteSettings.campaignAdvancePercent, e.g. 20%) and
 * one final-delivery milestone for the rest — created together by
 * milestone.service.js's createInitialMilestones() the moment a brand
 * accepts a creator's application (see campaign.controller.js
 * decideApplication). Each milestone is funded, submitted, and released
 * independently — the creator can start on the advance the moment it's
 * funded, without the brand having committed the full budget up front. */
const milestoneSchema = new mongoose.Schema(
  {
    campaign: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', required: true, index: true },
    creator: { type: mongoose.Schema.Types.ObjectId, ref: 'CreatorProfile', required: true, index: true },

    title: { type: String, required: true, trim: true }, // e.g. "Advance (20%)", "Final delivery"
    amount: { type: Number, required: true }, // in paise
    order: { type: Number, required: true }, // 1 = advance, 2 = final — display/processing order
    isAdvance: { type: Boolean, default: false },

    status: { type: String, enum: Object.values(MILESTONE_STATUS), default: MILESTONE_STATUS.PENDING, index: true },

    escrowTransaction: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', default: null },
    payoutTransaction: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', default: null },

    submittedWorkUrl: { type: String, default: '' },
    submittedAt: { type: Date, default: null },
    fundedAt: { type: Date, default: null },
    releasedAt: { type: Date, default: null },

    // Set when the creator submits work (submittedAt + SiteSettings.
    // milestoneAutoReleaseDays). Cleared once released. A scheduled sweep
    // (scripts/autoReleaseMilestones.js) releases any milestone whose
    // autoReleaseAt has passed and is still SUBMITTED.
    autoReleaseAt: { type: Date, default: null },
  },
  { timestamps: true }
);

milestoneSchema.index({ campaign: 1, order: 1 });
milestoneSchema.index({ status: 1, autoReleaseAt: 1 }); // for the auto-release sweep query

module.exports = mongoose.model('Milestone', milestoneSchema);