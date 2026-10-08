const mongoose = require('mongoose');

// A physical product a creator sells from their Fanitt Store (clothes,
// merch, accessories…). Bought through the cart with Cash on Delivery or
// online payment, shipped by the creator. See services/shop.service.js.

const { SHOP_CATEGORIES, SHOP_PRODUCT_STATUS } = require('../shop.constants');

const variantSchema = new mongoose.Schema(
  {
    label: { type: String, required: true, trim: true, maxlength: 30 }, // e.g. "M", "Red", "500 ml"
    stock: { type: Number, default: 0, min: 0 },
  },
  { _id: true }
);

const shopProductSchema = new mongoose.Schema(
  {
    store: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', required: true, index: true },
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    title: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 5000, default: '' },
    highlights: { type: [String], default: [] }, // short bullet points
    category: { type: String, enum: SHOP_CATEGORIES, default: 'other', index: true },
    images: { type: [String], default: [] }, // 1–4 photos, first = cover

    mrp: { type: Number, default: 0, min: 0 }, // paise, crossed-out price (0 = none)
    price: { type: Number, required: true, min: 100 }, // paise, selling price

    // Either one stock number, or options (sizes / colours) with their own stock.
    stock: { type: Number, default: 0, min: 0 },
    variantName: { type: String, trim: true, maxlength: 20, default: '' }, // e.g. "Size"
    variants: { type: [variantSchema], default: [] },

    deliveryCharge: { type: Number, default: 0, min: 0 }, // paise, 0 = free delivery
    deliveryDays: { type: String, trim: true, maxlength: 30, default: '3–7 days' },
    codAvailable: { type: Boolean, default: true },
    returnPolicy: { type: String, trim: true, maxlength: 300, default: '' },

    status: { type: String, enum: Object.values(SHOP_PRODUCT_STATUS), default: SHOP_PRODUCT_STATUS.DRAFT, index: true },
    removedReason: { type: String, default: '' },
    publishedAt: { type: Date, default: null },

    salesCount: { type: Number, default: 0 },
    views: { type: Number, default: 0 },
  },
  { timestamps: true }
);

shopProductSchema.index({ status: 1, createdAt: -1 });
shopProductSchema.index({ status: 1, salesCount: -1 });
shopProductSchema.index({ title: 'text', description: 'text' });

/** Units left for one option (or the whole product when it has none). */
shopProductSchema.methods.stockFor = function stockFor(variantId) {
  if (!this.variants.length) return this.stock;
  const v = this.variants.id(variantId);
  return v ? v.stock : 0;
};

shopProductSchema.virtual('totalStock').get(function totalStock() {
  return this.variants.length ? this.variants.reduce((sum, v) => sum + (v.stock || 0), 0) : this.stock;
});

shopProductSchema.statics.CATEGORIES = SHOP_CATEGORIES;
shopProductSchema.statics.STATUS = SHOP_PRODUCT_STATUS;

module.exports = mongoose.models.ShopProduct || mongoose.model('ShopProduct', shopProductSchema);