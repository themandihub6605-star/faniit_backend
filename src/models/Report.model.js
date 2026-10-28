// File: src/models/Report.model.js
const mongoose = require('mongoose');

// A user reporting something they think breaks the rules. Admins review
// every report (App Store / Play Store require this for user content).

const TARGET_TYPES = Object.freeze(['post', 'story', 'user', 'community', 'community_post', 'community_comment', 'community_message', 'message']);

const REASONS = Object.freeze({
  spam: 'Spam',
  nudity: 'Nudity or sexual content',
  hate: 'Hate or harassment',
  violence: 'Violence or dangerous acts',
  scam: 'Scam or fraud',
  fake: 'Fake account or impersonation',
  copyright: 'Copyright',
  other: 'Something else',
});

const STATUSES = Object.freeze(['pending', 'removed', 'suspended', 'dismissed']);

const reportSchema = new mongoose.Schema(
  {
    reporter: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    targetType: { type: String, enum: TARGET_TYPES, required: true },
    targetId: { type: mongoose.Schema.Types.ObjectId, required: true },
    // Who made the reported thing (for "suspend user" and the admin list).
    targetOwner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },

    reason: { type: String, enum: Object.keys(REASONS), required: true },
    details: { type: String, trim: true, maxlength: 500, default: '' },

    // Copy of what was reported, so admins still see it if it's edited or deleted.
    snapshot: {
      text: { type: String, default: '' },
      mediaUrl: { type: String, default: '' },
      ownerName: { type: String, default: '' },
    },

    status: { type: String, enum: STATUSES, default: 'pending', index: true },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    adminNote: { type: String, trim: true, maxlength: 500, default: '' },
  },
  { timestamps: true },
);

// One report per user per item.
reportSchema.index({ reporter: 1, targetType: 1, targetId: 1 }, { unique: true });
reportSchema.index({ targetType: 1, targetId: 1 });

reportSchema.statics.TARGET_TYPES = TARGET_TYPES;
reportSchema.statics.REASONS = REASONS;
reportSchema.statics.STATUSES = STATUSES;

module.exports = mongoose.model('Report', reportSchema);