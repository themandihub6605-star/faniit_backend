const mongoose = require('mongoose');

// Platform-wide community rules, set from the admin panel (one document).

const communitySettingsSchema = new mongoose.Schema(
  {
    singleton: { type: String, default: 'community', unique: true },
    // On → only users with a paid Fanitt plan (monthly/yearly) can create a community.
    requireSubscription: { type: Boolean, default: false },
    // Paid communities on/off for the whole app.
    paidCommunitiesEnabled: { type: Boolean, default: true },
  },
  { timestamps: true }
);

communitySettingsSchema.statics.get = async function get() {
  let doc = await this.findOne({ singleton: 'community' });
  if (!doc) doc = await this.create({ singleton: 'community' });
  return doc;
};

module.exports = mongoose.models.CommunitySettings || mongoose.model('CommunitySettings', communitySettingsSchema);