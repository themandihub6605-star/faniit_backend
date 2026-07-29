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
  },
  { timestamps: true, _id: false }
);

siteSettingsSchema.statics.getSingleton = async function getSingleton() {
  let settings = await this.findById('default');
  if (!settings) settings = await this.create({ _id: 'default' });
  return settings;
};

module.exports = mongoose.model('SiteSettings', siteSettingsSchema);