const mongoose = require('mongoose');
const { CAMPAIGN_STATUS, LOCATION_TYPE, CAMPAIGN_TYPE, GENDER_TARGET } = require('../constants/enums');

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
    // description becomes required only at publish time (see controller) —
    // kept optional at schema level so a draft can be created with just a
    // title on step 1.
    description: { type: String, maxlength: 2000, default: '' },
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', default: null },

    campaignType: { type: String, enum: Object.values(CAMPAIGN_TYPE), default: CAMPAIGN_TYPE.PAID },

    // budget only applies to paid campaigns; barter campaigns use `products`
    // instead. Not schema-required — enforced conditionally in publishCampaign.
    budget: { type: Number, default: 0 }, // total campaign budget, in paise
    products: { type: [campaignProductSchema], default: [] },

    durationLabel: { type: String, default: '' }, // e.g. "2-week campaign"

    // legacy free-text location, kept so existing frontend cards/detail pages
    // that read `campaign.location` keep working unchanged. Derived from
    // locationType/locationValue whenever those are set.
    location: { type: String, default: 'Remote' },
    locationType: { type: String, enum: Object.values(LOCATION_TYPE), default: LOCATION_TYPE.PAN_INDIA },
    locationValue: { type: String, default: '' }, // state or city name, when not Pan India

    creatorRequirement: { type: String, default: '' }, // free-text fallback

    influencerCategories: { type: [String], default: [] }, // tags e.g. "Content Creator"
    genderTarget: { type: [String], enum: Object.values(GENDER_TARGET), default: [] },
    ageRange: {
      min: { type: Number, default: 18 },
      max: { type: Number, default: 45 },
    },
    minFollowers: { type: Number, default: null },
    maxInfluencers: { type: Number, default: 1 }, // informational only — single-creator accept flow is still what's wired up

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

    // publish-time fee tracking
    isFeePaid: { type: Boolean, default: false },
    feeAmount: { type: Number, default: 0 }, // in paise, whatever was actually charged (0 if waived)
    publishedAt: { type: Date, default: null },

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