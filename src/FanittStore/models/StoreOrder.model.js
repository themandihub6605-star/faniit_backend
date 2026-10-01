const mongoose = require('mongoose');
const { ORDER_STATUS, ORDER_ITEM } = require('../constants');

// One purchase. Created as `pending` with a Razorpay order, flipped to
// `paid` exactly once after the payment is verified (see order.service).
// The money split is frozen on the order at payment time.

const storeOrderSchema = new mongoose.Schema(
  {
    buyer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // Empty only for FanBox tips to creators who haven't opened a store.
    store: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', default: null, index: true },
    seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    itemType: { type: String, enum: Object.values(ORDER_ITEM), required: true },
    itemId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    // Snapshot so the order still reads right if the product changes later.
    itemTitle: { type: String, required: true },
    itemCoverUrl: { type: String, default: '' },
    // FanBox: supporter's note and where it was sent from.
    message: { type: String, trim: true, maxlength: 200, default: '' },
    context: { type: String, default: '' },

    amount: { type: Number, required: true, min: 0 }, // paise the buyer paid
    paidWith: { type: String, enum: ['razorpay', 'wallet', 'free'], default: 'razorpay' },
    // Calls are billed by the minute: settledAmount is what was actually
    // charged, walletRefund is what went back to the buyer's wallet.
    settledAmount: { type: Number, default: null },
    walletRefund: { type: Number, default: 0 },
    feePercent: { type: Number, default: 0 },
    feeAmount: { type: Number, default: 0 },
    agencyCommission: { type: Number, default: 0 },
    referralCommission: { type: Number, default: 0 },
    creatorEarning: { type: Number, default: 0 }, // credited to the seller's wallet

    status: { type: String, enum: Object.values(ORDER_STATUS), default: ORDER_STATUS.PENDING, index: true },

    razorpayOrderId: { type: String, default: '' },
    razorpayPaymentId: { type: String, default: '' },
    razorpayRefundId: { type: String, default: '' },

    invoiceNumber: { type: String, default: '', index: true },
    paidAt: { type: Date, default: null },

    refundedAt: { type: Date, default: null },
    refundReason: { type: String, default: '' },
    refundedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    transaction: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', default: null },
    // Set once when the seller's wallet is credited — guards against paying twice.
    creditedAt: { type: Date, default: null },
    failureReason: { type: String, default: '' },
  },
  { timestamps: true }
);

storeOrderSchema.index({ buyer: 1, itemId: 1, status: 1 });
storeOrderSchema.index({ seller: 1, status: 1, createdAt: -1 });
// A Razorpay order id can back only one store order.
storeOrderSchema.index(
  { razorpayOrderId: 1 },
  { unique: true, partialFilterExpression: { razorpayOrderId: { $type: 'string', $gt: '' } } }
);

module.exports = mongoose.models.StoreOrder || mongoose.model('StoreOrder', storeOrderSchema);
