const mongoose = require('mongoose');

const withdrawalSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    amount: { type: Number, required: true }, // paise — held from wallet the moment this is created
    payoutMethod: { type: String, enum: ['upi', 'bank'], required: true },
    payoutDetails: { type: String, required: true }, // UPI ID, or "Bank: xxx, IFSC: xxx, Acc: xxx"
    status: { type: String, enum: ['pending', 'paid', 'rejected'], default: 'pending', index: true },
    adminNote: { type: String, default: '' },
    processedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    processedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Withdrawal', withdrawalSchema);