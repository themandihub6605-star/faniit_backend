const mongoose = require('mongoose');
const { PRODUCT_STATUS, PRODUCT_CATEGORIES } = require('../constants');

// A downloadable product. Files live in private storage; buyers get
// short-lived signed download links from their library.

const productFileSchema = new mongoose.Schema({
  // Private storage key. Never sent to clients (see utils/serialize.js).
  key: { type: String, required: true },
  name: { type: String, required: true, trim: true, maxlength: 200 },
  size: { type: Number, required: true }, // bytes
  mimeType: { type: String, required: true },
  addedAt: { type: Date, default: Date.now },
});

const digitalProductSchema = new mongoose.Schema(
  {
    store: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', required: true, index: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    title: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 5000, default: '' },
    category: { type: String, enum: PRODUCT_CATEGORIES, default: 'other' },
    coverUrl: { type: String, default: '' },
    price: { type: Number, required: true, min: 0 }, // paise, 0 = free

    files: { type: [productFileSchema], default: [] },

    status: { type: String, enum: Object.values(PRODUCT_STATUS), default: PRODUCT_STATUS.DRAFT, index: true },
    publishedAt: { type: Date, default: null },
    removedReason: { type: String, default: '' },
    removedAt: { type: Date, default: null },

    salesCount: { type: Number, default: 0 },
    revenue: { type: Number, default: 0 }, // gross paise
    views: { type: Number, default: 0 },
  },
  { timestamps: true }
);

digitalProductSchema.index({ store: 1, status: 1, createdAt: -1 });
digitalProductSchema.index({ title: 'text', description: 'text' });

digitalProductSchema.virtual('isFree').get(function isFree() {
  return this.price === 0;
});

module.exports = mongoose.models.DigitalProduct || mongoose.model('DigitalProduct', digitalProductSchema);
