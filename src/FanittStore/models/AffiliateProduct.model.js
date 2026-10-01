const mongoose = require('mongoose');
const { AFFILIATE_STATUS } = require('../constants');

// A product from another shop (Amazon, Nykaa…) that the creator recommends.
// Buyers go to the merchant through /go/:id, which counts the click.

const affiliateProductSchema = new mongoose.Schema(
  {
    store: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', required: true, index: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    title: { type: String, required: true, trim: true, maxlength: 150 },
    description: { type: String, trim: true, maxlength: 1000, default: '' },
    imageUrl: { type: String, default: '' },
    price: { type: Number, default: null, min: 0 }, // paise, shown only — the merchant sets the real price
    merchant: { type: String, trim: true, maxlength: 60, default: '' },
    category: { type: String, trim: true, maxlength: 40, default: '' },
    url: { type: String, required: true, trim: true, maxlength: 2000 }, // the creator's affiliate link

    status: { type: String, enum: Object.values(AFFILIATE_STATUS), default: AFFILIATE_STATUS.ACTIVE, index: true },
    removedReason: { type: String, default: '' },
    sortOrder: { type: Number, default: 0 },

    clicks: { type: Number, default: 0 },
    lastClickedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

affiliateProductSchema.index({ store: 1, status: 1, sortOrder: 1, createdAt: -1 });

module.exports = mongoose.models.AffiliateProduct || mongoose.model('AffiliateProduct', affiliateProductSchema);
