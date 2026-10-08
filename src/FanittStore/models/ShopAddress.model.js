const mongoose = require('mongoose');

// Saved delivery addresses of a buyer.
const shopAddressSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    phone: { type: String, required: true, trim: true, maxlength: 15 },
    line1: { type: String, required: true, trim: true, maxlength: 200 }, // house / flat / street
    line2: { type: String, trim: true, maxlength: 200, default: '' }, // area / locality
    landmark: { type: String, trim: true, maxlength: 100, default: '' },
    city: { type: String, required: true, trim: true, maxlength: 60 },
    state: { type: String, required: true, trim: true, maxlength: 60 },
    pincode: { type: String, required: true, trim: true, maxlength: 6 },
    label: { type: String, enum: ['home', 'work', 'other'], default: 'home' },
    isDefault: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.models.ShopAddress || mongoose.model('ShopAddress', shopAddressSchema);