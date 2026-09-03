const mongoose = require('mongoose');
const { CAMPAIGN_STATUS, LOCATION_TYPE, CAMPAIGN_TYPE, GENDER_TARGET, CAMPAIGN_VISIBILITY_TIER } = require('../constants/enums');

const campaignProductSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    quantity: { type: Number, default: 1, min: 1 },
    price: { type: Number, required: true }, // in paise
    imageUrl: { type: String, default: '' },
  },
  { timestamps: true }
);

const campaignSchema = new mongoose.Schema(
  {
    brand: { type: mongoose.Schema.Types.ObjectId, ref: 'BrandProfile', required: true, index: true },

    title: { type: String, required: true, trim: true },
    description: { type: String, maxlength: 2000, default: '' },
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', default: null },

    campaignType: { type: String, enum: Object.values(CAMPAIGN_TYPE), default: CAMPAIGN_TYPE.PAID },

    costPerInfluencer: { type: Number, default: 0 }, // in paise
    budget: { type: Number, default: 0 }, // derived: costPerInfluencer x maxInfluencers, for paid campaigns
    products: { type: [campaignProductSchema], default: [] },

    durationLabel: { type: String, default: '' },

    location: { type: String, default: 'Remote' },
    locationType: { type: String, enum: Object.values(LOCATION_TYPE), default: LOCATION_TYPE.PAN_INDIA },
    locationValue: { type: String, default: '' },

    creatorRequirement: { type: String, default: '' },

    influencerCategories: { type: [String], default: [] },
    genderTarget: { type: [String], enum: Object.values(GENDER_TARGET), default: [] },
    ageRange: {
      min: { type: Number, default: 18 },
      max: { type: Number, default: 45 },
    },
    minFollowers: { type: Number, default: null },
    maxInfluencers: { type: Number, default: 1 },

    dos: { type: [String], default: [] },
    donts: { type: [String], default: [] },

    campaignImageUrl: { type: String, default: '' },
    sampleMedia: { type: [String], default: [] },

    deliverables: {
      reel: { type: Number, default: 0 },
      story: { type: Number, default: 0 },
      post: { type: Number, default: 0 },
    },

    status: { type: String, enum: Object.values(CAMPAIGN_STATUS), default: CAMPAIGN_STATUS.DRAFT },

    publishedAt: { type: Date, default: null },

    // --- Subscription-driven fields, set automatically at publish time
    // from the posting brand's active plan (see publishCampaign) ---
    visibilityTier: { type: String, enum: Object.values(CAMPAIGN_VISIBILITY_TIER), default: CAMPAIGN_VISIBILITY_TIER.LITE },
    isFeatured: { type: Boolean, default: false }, // Elite-brand perk — shown first, "Featured" badge
    // The moment non-early-access (Lite) creators are allowed to apply.
    // Pro creators can apply immediately regardless of this timestamp.
    publicVisibleAt: { type: Date, default: null },
    // Optional cap on total applicants — only settable by brands whose plan
    // allows it (SubscriptionPlan.canSetApplicantLimit).
    applicantLimit: { type: Number, default: null },
    // Point 11: optional cap on applicants PER CALENDAR DAY — same
    // canSetApplicantLimit gate as applicantLimit above (Pro/Exclusive
    // brands only). Lets a brand avoid a sudden flood of applications
    // overwhelming their ability to review profiles, independent of the
    // overall applicantLimit. Not a stored running counter — checked
    // dynamically against Application.createdAt in applyToCampaign, so
    // there's nothing here to drift out of sync.
    dailyApplicantLimit: { type: Number, default: null },

    // Upwork-style milestone flow: how many equal milestones the budget
    // splits into once a creator is accepted (1-4, brand's choice at
    // creation time — see PostCampaign.tsx). Replaces the earlier fixed
    // 20%-advance/80%-final split. Only meaningful for paid campaigns.
    milestoneCount: { type: Number, default: 2, min: 1, max: 4 },

    assignedCreator: { type: mongoose.Schema.Types.ObjectId, ref: 'CreatorProfile', default: null },

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