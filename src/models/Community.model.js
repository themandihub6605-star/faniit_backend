const mongoose = require('mongoose');

const VISIBILITY = ['public', 'private'];
// Who may create posts: every member, or only the owner + moderators.
const POST_PERMISSION = ['all', 'moderators'];

const communitySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    slug: { type: String, required: true, unique: true, index: true },
    description: { type: String, maxlength: 1000, default: '' },
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category' },
    coverImageUrl: { type: String, default: '' },
    iconUrl: { type: String, default: '' },

    // Community guidelines shown on the About tab (max 10).
    rules: {
      type: [{ type: String, trim: true, maxlength: 300 }],
      default: [],
      validate: { validator: (arr) => arr.length <= 10, message: 'A community can have up to 10 rules' },
    },

    // Private: anyone can find it, but only approved members see posts,
    // members and chat. Joining creates a request moderators approve.
    visibility: { type: String, enum: VISIBILITY, default: 'public' },
    postPermission: { type: String, enum: POST_PERMISSION, default: 'all' },
    chatEnabled: { type: Boolean, default: true },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    isVerified: { type: Boolean, default: false },
    isFeatured: { type: Boolean, default: false },

    memberCount: { type: Number, default: 0 },
    discussionCount: { type: Number, default: 0 },
    pendingRequestCount: { type: Number, default: 0 },

    // Bumped by posts, comments and chat — drives "Trending".
    lastActivityAt: { type: Date, default: Date.now },

    // ---- Paid community ----
    // Members pay to join: monthly, yearly and/or one-time (lifetime).
    // Prices are in paise. Renewals are manual (pay again when it ends).
    isPaid: { type: Boolean, default: false },
    plans: {
      monthly: { enabled: { type: Boolean, default: false }, price: { type: Number, default: 0, min: 0 } },
      yearly: { enabled: { type: Boolean, default: false }, price: { type: Number, default: 0, min: 0 } },
      lifetime: { enabled: { type: Boolean, default: false }, price: { type: Number, default: 0, min: 0 } },
    },
    // When it last became paid — people who joined before keep free access.
    paidSince: { type: Date, default: null },
    paidStats: {
      revenue: { type: Number, default: 0 }, // gross paise paid by members
      payments: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

communitySchema.index({ category: 1 });
communitySchema.index({ isFeatured: -1, memberCount: -1 });
communitySchema.index({ lastActivityAt: -1 });
communitySchema.index({ name: 'text', description: 'text' });
communitySchema.index({ isPaid: 1 });

communitySchema.statics.VISIBILITY = VISIBILITY;
communitySchema.statics.POST_PERMISSION = POST_PERMISSION;
communitySchema.statics.PLAN_KEYS = ['monthly', 'yearly', 'lifetime'];

module.exports = mongoose.model('Community', communitySchema);