const mongoose = require('mongoose');
const { TRANSACTION_TYPE, TRANSACTION_STATUS } = require('../constants/enums');

const transactionSchema = new mongoose.Schema(
  {
    type: { type: String, enum: Object.values(TRANSACTION_TYPE), required: true, index: true },
    status: { type: String, enum: Object.values(TRANSACTION_STATUS), default: TRANSACTION_STATUS.PENDING, index: true },

    // who paid, who receives (either can be null depending on type, e.g. platform commission has no "to")
    from: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    to: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    amount: { type: Number, required: true }, // gross amount, in paise
    platformCommission: { type: Number, default: 0 },
    agencyCommission: { type: Number, default: 0 },
    netAmount: { type: Number, default: 0 }, // amount actually credited to `to`

    // polymorphic reference to whatever this transaction is for
    relatedModel: { type: String, enum: ['Booking', 'Campaign', 'Session'], default: null },
    relatedId: { type: mongoose.Schema.Types.ObjectId, default: null },

    // Razorpay references
    razorpayOrderId: { type: String, default: '' },
    razorpayPaymentId: { type: String, default: '' },
    razorpaySignature: { type: String, default: '' },
    razorpayPayoutId: { type: String, default: '' },

    escrowReleasedAt: { type: Date, default: null },
    escrowReleasedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // admin, if manually released

    failureReason: { type: String, default: '' },
    notes: { type: String, default: '' },
  },
  { timestamps: true }
);

transactionSchema.index({ from: 1 });
transactionSchema.index({ to: 1 });
transactionSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Transaction', transactionSchema);
