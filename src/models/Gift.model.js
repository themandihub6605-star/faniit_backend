const mongoose = require('mongoose');

const giftSchema = new mongoose.Schema(
  {
    fromUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    toCreator: { type: mongoose.Schema.Types.ObjectId, ref: 'CreatorProfile', required: true, index: true },
    amount: { type: Number, required: true },
    message: { type: String, maxlength: 200, default: '' },
    transaction: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', required: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Gift', giftSchema);