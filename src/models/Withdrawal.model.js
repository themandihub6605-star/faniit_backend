const mongoose = require('mongoose');

/** status flow: initiated -> processing -> completed
 *                                        -> rejected (from either initiated or processing, refunds `amount` in full) */
const withdrawalSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    // Requested (gross) amount — held from the wallet the moment this is
    // created, and refunded in full (this exact figure) if rejected.
    amount: { type: Number, required: true },

    // Platform fee, calculated once at request time from the creator's
    // CURRENT plan (not whatever plan they were on when they earned the
    // money) — see wallet.controller.js's requestWithdrawal. Frozen here
    // once set so it doesn't silently change if the creator's plan
    // changes later while this withdrawal is still pending.
    platformFeePercent: { type: Number, default: 0 },
    platformFee: { type: Number, default: 0 }, // paise — Math.round(amount * platformFeePercent / 100)
    netPayoutAmount: { type: Number, default: 0 }, // paise — amount - platformFee, what's actually sent to UPI/bank

    payoutMethod: { type: String, enum: ['upi', 'bank'], required: true },
    payoutDetails: { type: String, required: true }, // UPI ID, or "Bank: xxx, IFSC: xxx, Acc: xxx"

    status: { type: String, enum: ['initiated', 'processing', 'completed', 'rejected'], default: 'initiated', index: true },
    adminNote: { type: String, default: '' },
    processedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    processedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Withdrawal', withdrawalSchema);