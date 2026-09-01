const mongoose = require('mongoose');
const { SUBSCRIPTION_APPLIES_TO, BILLING_CYCLE, CAMPAIGN_VISIBILITY_TIER, CREATOR_CAMPAIGN_ACCESS } = require('../constants/enums');

/** Every plan (Creator Lite/Pro, Brand Lite/Pro/Elite) is a row here,
 * fully admin-managed — no plan numbers/limits are hardcoded in the app
 * logic, everything reads from this collection. `appliesTo` splits
 * creator-side fields from brand-side fields on the same schema for
 * simplicity; only the fields relevant to that role are meaningful. */
const subscriptionPlanSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true }, // e.g. "Lite", "Pro", "Elite"
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true }, // e.g. "creator-lite"
    appliesTo: { type: String, enum: Object.values(SUBSCRIPTION_APPLIES_TO), required: true },

    price: { type: Number, required: true, default: 0 }, // in paise; 0 = free plan
    billingCycle: { type: String, enum: Object.values(BILLING_CYCLE), required: true },

    // Links this plan to its monthly/yearly sibling so the pricing page
    // can offer a single Monthly/Yearly toggle per tier instead of
    // listing every billing cycle as its own card. Two plan rows with
    // the same billingGroupSlug (and different billingCycle) are treated
    // as the same tier at two price points — e.g. "creator-pro" for both
    // "Creator Pro Monthly" and "Creator Pro Yearly". Leave blank for a
    // plan that only ever has one cycle (e.g. the free default) — it
    // then falls back to its own slug and always shows regardless of
    // the toggle.
    billingGroupSlug: { type: String, default: '', trim: true, lowercase: true },

    isDefault: { type: Boolean, default: false }, // exactly one default plan per appliesTo — new signups start here
    isActive: { type: Boolean, default: true }, // admin can retire a plan without deleting it
    sortOrder: { type: Number, default: 0 }, // display order on the pricing page

    // Razorpay's own Plan object id — created/kept in sync automatically
    // whenever an admin creates or edits a paid plan (see subscription.service.js).
    razorpayPlanId: { type: String, default: '' },

    // --- Creator-side fields (ignored when appliesTo === 'brand') ---
    proposalLimit: { type: Number, default: null }, // null = unlimited
    extraProposalCost: { type: Number, default: 300 }, // paise (₹3) — charged per proposal past the limit
    platformFeePercent: { type: Number, default: 9, min: 0, max: 100 },
    campaignAccessTier: { type: String, enum: Object.values(CREATOR_CAMPAIGN_ACCESS), default: CREATOR_CAMPAIGN_ACCESS.LITE_ONLY },
    hasEarlyAccess: { type: Boolean, default: false }, // sees campaigns before SiteSettings.creatorEarlyAccessHours elapses

    // --- Brand-side fields (ignored when appliesTo === 'creator') ---
    campaignPostLimit: { type: Number, default: null }, // null = unlimited, per billing cycle
    campaignVisibilityTier: { type: String, enum: Object.values(CAMPAIGN_VISIBILITY_TIER), default: CAMPAIGN_VISIBILITY_TIER.LITE },
    canSetApplicantLimit: { type: Boolean, default: false },
    isFeaturedListing: { type: Boolean, default: false }, // Elite perk — campaign shows a "Featured" badge and sorts first

    description: { type: String, default: '' }, // optional marketing blurb for the pricing page
    perks: { type: [String], default: [] }, // free-text bullet list shown on the pricing card
  },
  { timestamps: true }
);

subscriptionPlanSchema.index({ appliesTo: 1, isActive: 1 });
subscriptionPlanSchema.index({ billingGroupSlug: 1 });

module.exports = mongoose.model('SubscriptionPlan', subscriptionPlanSchema);