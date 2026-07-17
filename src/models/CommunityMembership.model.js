const mongoose = require('mongoose');

const communityMembershipSchema = new mongoose.Schema(
  {
    community: { type: mongoose.Schema.Types.ObjectId, ref: 'Community', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    role: { type: String, enum: ['member', 'moderator', 'admin'], default: 'member' },
  },
  { timestamps: true }
);

communityMembershipSchema.index({ community: 1, user: 1 }, { unique: true });

module.exports = mongoose.model('CommunityMembership', communityMembershipSchema);