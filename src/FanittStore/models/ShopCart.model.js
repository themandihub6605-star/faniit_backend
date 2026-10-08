const mongoose = require('mongoose');

// One cart per user. Prices are NOT stored — they're read fresh from the
// products every time, so the cart never shows an old price.

const cartItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'ShopProduct', required: true },
    variant: { type: mongoose.Schema.Types.ObjectId, default: null }, // ShopProduct.variants._id
    qty: { type: Number, default: 1, min: 1, max: 10 },
    addedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const shopCartSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    items: { type: [cartItemSchema], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.models.ShopCart || mongoose.model('ShopCart', shopCartSchema);