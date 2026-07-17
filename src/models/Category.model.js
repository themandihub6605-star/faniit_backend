const mongoose = require('mongoose');

const categorySchema = new mongoose.Schema(
  {
    label: { type: String, required: true, unique: true, trim: true },
    slug: { type: String, required: true, unique: true, index: true },
    icon: { type: String, default: '' }, // lucide-react icon name, matches frontend
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Category', categorySchema);
