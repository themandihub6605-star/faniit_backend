const mongoose = require('mongoose');

// Live group chat inside a community.
const communityMessageSchema = new mongoose.Schema(
  {
    community: { type: mongoose.Schema.Types.ObjectId, ref: 'Community', required: true },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    text: { type: String, required: true, trim: true, maxlength: 2000 },
    isRemoved: { type: Boolean, default: false },
  },
  { timestamps: true }
);

communityMessageSchema.index({ community: 1, createdAt: -1 });

module.exports = mongoose.model('CommunityMessage', communityMessageSchema);