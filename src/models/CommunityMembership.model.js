const mongoose = require('mongoose');

// role 'admin' is the community owner (the creator).
const ROLES = ['member', 'moderator', 'admin'];
// pending = join request on a private community; banned = removed and
// blocked from re-joining; expired = paid access ran out (renew to return).
const STATUSES = ['active', 'pending', 'banned', 'expired'];
const ACCESS = ['free', 'paid'];
const PLANS = ['monthly', 'yearly', 'lifetime'];

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

    // ---- Paid communities ----
    // free = joined while it was free (keeps access); paid = bought a plan.
    access: { type: String, enum: ACCESS, default: 'free' },
    plan: { type: String, enum: [...PLANS, null], default: null },
    // End of the paid period; null for lifetime / free access.
    paidUntil: { type: Date, default: null },
    lastOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'StoreOrder', default: null },
    renewReminderAt: { type: Date, default: null },
  },
  { timestamps: true }
);

communityMembershipSchema.index({ community: 1, user: 1 }, { unique: true });
communityMembershipSchema.index({ community: 1, status: 1, role: 1 });
communityMembershipSchema.index({ access: 1, status: 1, paidUntil: 1 });

communityMembershipSchema.statics.ROLES = ROLES;
communityMembershipSchema.statics.STATUSES = STATUSES;
communityMembershipSchema.statics.ACCESS = ACCESS;
communityMembershipSchema.statics.PLANS = PLANS;

module.exports = mongoose.model('CommunityMembership', communityMembershipSchema);