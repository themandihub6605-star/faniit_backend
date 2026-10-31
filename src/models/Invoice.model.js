const mongoose = require('mongoose');

// A tax invoice Fanitt issues to a user:
//   brand_payment   — a brand paid for a campaign / milestone (amount + GST)
//   withdrawal_fee  — Fanitt's platform fee (+ GST) on a creator's withdrawal
// Shown in the app (Wallet → Invoices) and emailed when issued.

const KINDS = ['brand_payment', 'withdrawal_fee'];

const lineSchema = new mongoose.Schema(
  {
    label: { type: String, required: true, maxlength: 300 },
    amount: { type: Number, required: true }, // paise
  },
  { _id: false }
);

const invoiceSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    kind: { type: String, enum: KINDS, required: true },
    title: { type: String, required: true, maxlength: 200 },

    billedTo: {
      name: { type: String, default: '' },
      email: { type: String, default: '' },
      gstin: { type: String, default: '' },
    },
    seller: {
      name: { type: String, default: 'Fanitt' },
      gstin: { type: String, default: '' },
      address: { type: String, default: '' },
      email: { type: String, default: '' },
    },

    lines: { type: [lineSchema], default: [] },
    subtotal: { type: Number, required: true }, // paise, before GST
    gstPercent: { type: Number, default: 0 },
    gstAmount: { type: Number, default: 0 }, // paise
    total: { type: Number, required: true }, // paise, subtotal + GST

    // withdrawal_fee only: what was withdrawn and what was paid out.
    withdrawalAmount: { type: Number, default: null },
    payoutAmount: { type: Number, default: null },

    status: { type: String, enum: ['issued', 'cancelled'], default: 'issued' },
    relatedModel: { type: String, enum: ['Campaign', 'Milestone', 'Withdrawal'], required: true },
    relatedId: { type: mongoose.Schema.Types.ObjectId, required: true },
    razorpayPaymentId: { type: String, default: '' },
    emailedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// One invoice per paid thing.
invoiceSchema.index({ relatedModel: 1, relatedId: 1, kind: 1 }, { unique: true });
invoiceSchema.index({ user: 1, createdAt: -1 });

invoiceSchema.statics.KINDS = KINDS;

module.exports = mongoose.models.Invoice || mongoose.model('Invoice', invoiceSchema);
