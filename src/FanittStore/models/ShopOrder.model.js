const mongoose = require('mongoose');

// One order per seller. A cart with products from 2 creators becomes 2
// orders sharing one `checkoutId` (and one online payment, if paid online).
//
// Status flow:
//   awaiting_payment (online only) → placed → confirmed → shipped → delivered
//   placed / confirmed → cancelled (buyer, seller or admin)
//   awaiting_payment → payment_failed (not paid in 30 minutes)

const { SHOP_ORDER_STATUS, SHOP_PAYMENT_METHOD: PAYMENT_METHOD, SHOP_PAYMENT_STATUS: PAYMENT_STATUS } = require('../shop.constants');

const orderItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'ShopProduct', required: true },
    title: { type: String, required: true },
    imageUrl: { type: String, default: '' },
    variant: { type: mongoose.Schema.Types.ObjectId, default: null },
    variantLabel: { type: String, default: '' },
    variantName: { type: String, default: '' },
    price: { type: Number, required: true }, // paise per unit
    mrp: { type: Number, default: 0 },
    qty: { type: Number, required: true, min: 1 },
  },
  { _id: false }
);

const addressSnapshotSchema = new mongoose.Schema(
  {
    name: String,
    phone: String,
    line1: String,
    line2: String,
    landmark: String,
    city: String,
    state: String,
    pincode: String,
  },
  { _id: false }
);

const timelineSchema = new mongoose.Schema(
  {
    status: { type: String, required: true },
    at: { type: Date, default: Date.now },
    note: { type: String, default: '' },
    by: { type: String, enum: ['buyer', 'seller', 'admin', 'system'], default: 'system' },
  },
  { _id: false }
);

const shopOrderSchema = new mongoose.Schema(
  {
    orderNumber: { type: String, required: true, unique: true },
    checkoutId: { type: String, required: true, index: true },
    fromCart: { type: Boolean, default: false }, // bought from the cart → those cart lines are removed once placed

    buyer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    store: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', required: true, index: true },

    items: { type: [orderItemSchema], required: true },
    itemsTotal: { type: Number, required: true },
    deliveryCharge: { type: Number, default: 0 },
    total: { type: Number, required: true }, // what the buyer pays

    address: { type: addressSnapshotSchema, required: true },

    paymentMethod: { type: String, enum: Object.values(PAYMENT_METHOD), required: true },
    paymentStatus: { type: String, enum: Object.values(PAYMENT_STATUS), default: PAYMENT_STATUS.PENDING },
    razorpayOrderId: { type: String, default: '', index: true },
    razorpayPaymentId: { type: String, default: '' },
    razorpayRefundId: { type: String, default: '' },
    paidAt: { type: Date, default: null },

    status: { type: String, enum: Object.values(SHOP_ORDER_STATUS), required: true, index: true },
    timeline: { type: [timelineSchema], default: [] },

    courier: { type: String, trim: true, maxlength: 60, default: '' },
    trackingId: { type: String, trim: true, maxlength: 80, default: '' },
    trackingUrl: { type: String, trim: true, maxlength: 500, default: '' },
    sellerNote: { type: String, trim: true, maxlength: 300, default: '' },

    cancelReason: { type: String, default: '' },
    cancelledBy: { type: String, enum: ['', 'buyer', 'seller', 'admin', 'system'], default: '' },

    // Money, frozen when the order is delivered.
    feePercent: { type: Number, default: 0 },
    feeAmount: { type: Number, default: 0 },
    creatorEarning: { type: Number, default: 0 },
    settledAt: { type: Date, default: null }, // seller wallet credited / COD fee taken — exactly once

    placedAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
  },
  { timestamps: true }
);

shopOrderSchema.index({ seller: 1, status: 1, createdAt: -1 });
shopOrderSchema.index({ buyer: 1, createdAt: -1 });
shopOrderSchema.index({ status: 1, createdAt: 1 });

shopOrderSchema.statics.STATUS = SHOP_ORDER_STATUS;
shopOrderSchema.statics.PAYMENT_METHOD = PAYMENT_METHOD;
shopOrderSchema.statics.PAYMENT_STATUS = PAYMENT_STATUS;

module.exports = mongoose.models.ShopOrder || mongoose.model('ShopOrder', shopOrderSchema);