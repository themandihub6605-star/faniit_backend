const mongoose = require('mongoose');
const { AFFILIATE_EARNING_STATUS } = require('../constants');

// Affiliate income the creator records from their merchant dashboards.
// Merchants pay the creator directly, so this is for tracking and
// analytics only — it never touches the Fanitt wallet.
const affiliateEarningSchema = new mongoose.Schema(
  {
    store: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', required: true, index: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'AffiliateProduct', default: null },
    merchant: { type: String, trim: true, maxlength: 60, default: '' },
    amount: { type: Number, required: true, min: 0 }, // paise
    orders: { type: Number, default: 1, min: 0 },
    status: { type: String, enum: Object.values(AFFILIATE_EARNING_STATUS), default: AFFILIATE_EARNING_STATUS.PENDING, index: true },
    earnedAt: { type: Date, default: Date.now, index: true },
    confirmedAt: { type: Date, default: null },
    note: { type: String, trim: true, maxlength: 300, default: '' },
  },
  { timestamps: true }
);

affiliateEarningSchema.index({ store: 1, earnedAt: -1 });

module.exports = mongoose.models.AffiliateEarning || mongoose.model('AffiliateEarning', affiliateEarningSchema);
