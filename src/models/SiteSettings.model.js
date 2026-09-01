const mongoose = require('mongoose');

/** Singleton (always _id: 'default') for platform-wide settings an admin
 * can change without a code deploy or server restart. wallet.service.js
 * reads platformCommissionPercent from here (falling back to the env var
 * only if this document somehow doesn't exist yet). */
const siteSettingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: 'default' },
    platformCommissionPercent: { type: Number, default: 18, min: 0, max: 100 },
    supportEmail: { type: String, default: 'support@fanitt.com' },
    maintenanceMode: { type: Boolean, default: false },
    maintenanceMessage: { type: String, default: '' },
    homepageBannerText: { type: String, default: '' },

    // Campaign publishing fee — currently unused (publishing is free), kept
    // in case a posting fee is re-enabled later.
    campaignPostingFee: { type: Number, default: 50000, min: 0 },
    campaignPostingFeeTaxPercent: { type: Number, default: 18, min: 0, max: 100 },
    allowFreeCampaignPublish: { type: Boolean, default: false },

    // Subscriptions: how many hours a non-early-access creator (Lite) must
    // wait after a campaign is published before they're allowed to apply.
    // Pro creators (plan.hasEarlyAccess) skip this wait entirely.
    creatorEarlyAccessHours: { type: Number, default: 6, min: 0 },

    // --- Milestone-based campaign escrow (Point 12) ---
    // What percentage of a campaign's budget becomes the advance milestone
    // the moment a brand accepts a creator (milestone.service.js
    // createInitialMilestones). The remaining (100 - this)% becomes the
    // single final-delivery milestone.
    campaignAdvancePercent: { type: Number, default: 20, min: 0, max: 100 },
    // How many days after a creator submits a milestone before it
    // auto-releases if the brand never reviews it. 0 disables auto-release
    // entirely (a submitted milestone then waits indefinitely for the
    // brand, same as the original single-escrow flow's behavior).
    milestoneAutoReleaseDays: { type: Number, default: 7, min: 0 },
  },
  { timestamps: true, _id: false }
);

siteSettingsSchema.statics.getSingleton = async function getSingleton() {
  let settings = await this.findById('default');
  if (!settings) settings = await this.create({ _id: 'default' });
  return settings;
};

module.exports = mongoose.model('SiteSettings', siteSettingsSchema);