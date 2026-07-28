const mongoose = require('mongoose');

/**
 * Singleton document (always _id: 'default') holding the admin-configured
 * commission percentages for the referral system. Four relationship types,
 * as specced:
 *   agentToAgent     — an Agency onboards another Agency
 *   agentToBrandOrCreator — an Agency onboards a Brand or Creator
 *   creatorToCreator — a Creator onboards another Creator
 *   creatorToBrand   — a Creator onboards a Brand
 */
const referralConfigSchema = new mongoose.Schema(
  {
    _id: { type: String, default: 'default' },
    agentToAgentPercent: { type: Number, default: 5, min: 0, max: 100 },
    agentToBrandOrCreatorPercent: { type: Number, default: 5, min: 0, max: 100 },
    creatorToCreatorPercent: { type: Number, default: 3, min: 0, max: 100 },
    creatorToBrandPercent: { type: Number, default: 3, min: 0, max: 100 },
  },
  { timestamps: true, _id: false }
);

referralConfigSchema.statics.getSingleton = async function getSingleton() {
  let config = await this.findById('default');
  if (!config) config = await this.create({ _id: 'default' });
  return config;
};

module.exports = mongoose.model('ReferralConfig', referralConfigSchema);