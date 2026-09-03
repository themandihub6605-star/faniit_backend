const mongoose = require('mongoose');
const { MILESTONE_STATUS } = require('../constants/enums');

const attachmentSchema = new mongoose.Schema(
  { name: { type: String, default: '' }, url: { type: String, required: true } },
  { _id: false }
);

/** One payment chunk within a campaign's overall budget. Upwork-style flow:
 * the brand chooses how many milestones (1-4, Campaign.milestoneCount) the
 * moment they accept a creator's application — the budget splits equally,
 * created together by milestone.service.js's createInitialMilestones()
 * (see campaign.controller.js decideApplication). Milestones fund/unlock
 * strictly in order: milestone N+1 can't be funded until milestone N is
 * RELEASED (see milestone.service.js's fundMilestone). */
const milestoneSchema = new mongoose.Schema(
  {
    campaign: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', required: true, index: true },
    creator: { type: mongoose.Schema.Types.ObjectId, ref: 'CreatorProfile', required: true, index: true },

    title: { type: String, required: true, trim: true }, // e.g. "Milestone 1"
    amount: { type: Number, required: true }, // in paise
    order: { type: Number, required: true }, // 1-based — display/unlock order
    isAdvance: { type: Boolean, default: false }, // true only for order 1 — kept for the wallet icon in the UI

    status: { type: String, enum: Object.values(MILESTONE_STATUS), default: MILESTONE_STATUS.PENDING, index: true },

    escrowTransaction: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', default: null },
    payoutTransaction: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', default: null },

    // --- Creator's submission (what the "Creator Submits Work" step captures) ---
    submissionDescription: { type: String, default: '' },
    submissionLinks: { type: [String], default: [] }, // Drive/Figma/etc URLs
    submissionAttachments: { type: [attachmentSchema], default: [] }, // uploaded files
    submittedAt: { type: Date, default: null },

    // --- Brand's "Request Changes" response (8B in the flow) ---
    changeDescription: { type: String, default: '' },
    changeReferenceLinks: { type: [String], default: [] },
    changeAttachments: { type: [attachmentSchema], default: [] },
    changesRequestedAt: { type: Date, default: null },

    // --- Dispute link (8C in the flow) — the Dispute document holds the
    // brand's reason/evidence and the admin's eventual resolution ---
    dispute: { type: mongoose.Schema.Types.ObjectId, ref: 'Dispute', default: null },

    fundedAt: { type: Date, default: null },
    releasedAt: { type: Date, default: null },

    // Set when the creator submits work (submittedAt + SiteSettings.
    // milestoneAutoReleaseDays). Cleared on release, and paused (set back
    // to null) whenever the milestone leaves SUBMITTED for any reason
    // (changes requested, disputed) — auto-release should only fire on
    // work the brand hasn't reacted to at all, never mid-conversation.
    autoReleaseAt: { type: Date, default: null },
  },
  { timestamps: true }
);

milestoneSchema.index({ campaign: 1, order: 1 });
milestoneSchema.index({ status: 1, autoReleaseAt: 1 }); // for the auto-release sweep query

module.exports = mongoose.model('Milestone', milestoneSchema);