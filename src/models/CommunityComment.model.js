const mongoose = require('mongoose');

// Two levels: top-level comments and replies (parentComment set).
// Replies to a reply attach to the same top-level comment.
const communityCommentSchema = new mongoose.Schema(
  {
    post: { type: mongoose.Schema.Types.ObjectId, ref: 'CommunityPost', required: true, index: true },
    community: { type: mongoose.Schema.Types.ObjectId, ref: 'Community', required: true, index: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    parentComment: { type: mongoose.Schema.Types.ObjectId, ref: 'CommunityComment', default: null, index: true },

    text: { type: String, required: true, trim: true, maxlength: 1000 },
    mentions: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], default: [] },

    likedBy: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], default: [], select: false },
    likeCount: { type: Number, default: 0 },
    replyCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

communityCommentSchema.index({ post: 1, parentComment: 1, createdAt: 1 });

module.exports = mongoose.model('CommunityComment', communityCommentSchema);