const mongoose = require('mongoose');
const { TOOL_KEYS, DEFAULT_FEES } = require('../constants');

// Singleton document with every admin-controlled Store setting: fees,
// terms, the Store Home tool cards and the website banner.

const DEFAULT_TOOL_CARDS = [
  { key: 'virtual_meet', title: 'Virtual Meet', description: 'Webinars, meetings and one-to-one consultations.' },
  { key: 'stream_live', title: 'Stream Live', description: 'Go live with your audience — public or private.' },
  { key: 'chat_calls', title: 'Live Chat & Calls', description: 'Private 1-to-1 chat, audio and video calls.' },
  { key: 'digital_products', title: 'Your Store', description: 'Sell courses, ebooks, templates and more.' },
  { key: 'community', title: 'Community', description: 'Build your community and talk with members.' },
  { key: 'affiliate', title: 'Affiliate Store', description: 'Share products you love and earn commissions.' },
  { key: 'fanbox', title: 'FanBox', description: 'Let your audience support you with a tip.' },
];

const toolCardSchema = new mongoose.Schema(
  {
    key: { type: String, enum: TOOL_KEYS, required: true },
    title: { type: String, trim: true, maxlength: 40, required: true },
    description: { type: String, trim: true, maxlength: 160, default: '' },
    imageUrl: { type: String, default: '' },
    enabled: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
  },
  { _id: false }
);

const storeSettingsSchema = new mongoose.Schema(
  {
    _singleton: { type: String, default: 'store', unique: true },

    storeFeePercent: { type: Number, default: DEFAULT_FEES.STORE_FEE_PERCENT, min: 0, max: 50 },
    fanboxFeePercent: { type: Number, default: DEFAULT_FEES.FANBOX_FEE_PERCENT, min: 0, max: 50 },

    // On: a creator needs a paid Fanitt plan (monthly or yearly) to open
    // a new store. Off: anyone can open one. Existing stores aren't affected.
    requireSubscription: { type: Boolean, default: false },

    termsVersion: { type: String, default: '1.0' },
    termsText: {
      type: String,
      default:
        'By activating your Fanitt Store you confirm that you own or have the rights to everything you sell, that your products are digital and delivered as described, and that the details you provided are true. Fanitt deducts its service fee from each sale and pays the rest to your Fanitt wallet. Fanitt may suspend stores that break these terms or the law.',
    },

    toolCards: { type: [toolCardSchema], default: () => DEFAULT_TOOL_CARDS.map((c, i) => ({ ...c, order: i })) },

    webBanner: {
      enabled: { type: Boolean, default: false },
      imageUrl: { type: String, default: '' },
      title: { type: String, trim: true, maxlength: 80, default: 'Open your Fanitt Store' },
      subtitle: { type: String, trim: true, maxlength: 160, default: 'Sell, stream and earn — only on the Fanitt app.' },
      buttonText: { type: String, trim: true, maxlength: 30, default: 'Get the app' },
      playStoreUrl: { type: String, default: '' },
      appDeepLink: { type: String, default: 'fanitt://open/store' },
    },

    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

storeSettingsSchema.statics.DEFAULT_TOOL_CARDS = DEFAULT_TOOL_CARDS;

module.exports = mongoose.models.StoreSettings || mongoose.model('StoreSettings', storeSettingsSchema);