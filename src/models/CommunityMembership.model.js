const mongoose = require('mongoose');

// role 'admin' is the community owner (the creator).
const ROLES = ['member', 'moderator', 'admin'];
// pending = join request on a private community; banned = removed and
// blocked from re-joining.
const STATUSES = ['active', 'pending', 'banned'];

const communityMembershipSchema = new mongoose.Schema(
  {
    community: { type: mongoose.Schema.Types.ObjectId, ref: 'Community', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    role: { type: String, enum: ROLES, default: 'member' },
    status: { type: String, enum: STATUSES, default: 'active' },

    // Announcements only — muted members don't get notified.
    notificationsMuted: { type: Boolean, default: false },
    // For the unread badge on the community chat.
    lastReadChatAt: { type: Date, default: null },
  },
  { timestamps: true }
);

communityMembershipSchema.index({ community: 1, user: 1 }, { unique: true });
communityMembershipSchema.index({ community: 1, status: 1, role: 1 });

communityMembershipSchema.statics.ROLES = ROLES;
communityMembershipSchema.statics.STATUSES = STATUSES;

module.exports = mongoose.model('CommunityMembership', communityMembershipSchema);