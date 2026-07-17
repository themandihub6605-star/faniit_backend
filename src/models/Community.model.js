const mongoose = require('mongoose');

const communitySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, index: true },
    description: { type: String, maxlength: 500, default: '' },
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category' },
    coverImageUrl: { type: String, default: '' },
    iconUrl: { type: String, default: '' },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    isVerified: { type: Boolean, default: false },
    isFeatured: { type: Boolean, default: false },

    memberCount: { type: Number, default: 0 },
    discussionCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

communitySchema.index({ category: 1 });
communitySchema.index({ isFeatured: -1, memberCount: -1 });

module.exports = mongoose.model('Community', communitySchema);