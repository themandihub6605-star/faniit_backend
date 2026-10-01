const mongoose = require('mongoose');

// A curated list of affiliate products, e.g. "My skincare picks".
const affiliateCollectionSchema = new mongoose.Schema(
  {
    store: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', required: true, index: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true, trim: true, maxlength: 80 },
    description: { type: String, trim: true, maxlength: 500, default: '' },
    coverUrl: { type: String, default: '' },
    products: [{ type: mongoose.Schema.Types.ObjectId, ref: 'AffiliateProduct' }], // in display order
    isPublic: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.models.AffiliateCollection || mongoose.model('AffiliateCollection', affiliateCollectionSchema);
