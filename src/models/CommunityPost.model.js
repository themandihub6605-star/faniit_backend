const mongoose = require('mongoose');

const mediaItemSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    type: { type: String, enum: ['image', 'video'], required: true },
  },
  { _id: false }
);

const pollOptionSchema = new mongoose.Schema(
  {
    text: { type: String, required: true, trim: true, maxlength: 80 },
    votes: { type: Number, default: 0 },
  },
  { _id: false }
);

const pollSchema = new mongoose.Schema(
  {
    question: { type: String, trim: true, maxlength: 200, default: '' },
    options: { type: [pollOptionSchema], default: [] },
    // One vote per user; optionIndex points into options.
    voters: {
      type: [
        {
          _id: false,
          user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
          optionIndex: Number,
        },
      ],
      default: [],
      select: false,
    },
    totalVotes: { type: Number, default: 0 },
    endsAt: { type: Date, default: null },
  },
  { _id: false }
);

const communityPostSchema = new mongoose.Schema(
  {
    community: { type: mongoose.Schema.Types.ObjectId, ref: 'Community', required: true, index: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    text: { type: String, trim: true, maxlength: 3000, default: '' },
    mediaItems: {
      type: [mediaItemSchema],
      default: [],
      validate: { validator: (arr) => arr.length <= 5, message: 'Up to 5 photos/videos per post' },
    },
    poll: { type: pollSchema, default: null },

    // Announcements are posted by owner/moderators and notify every member.
    isAnnouncement: { type: Boolean, default: false },
    isPinned: { type: Boolean, default: false },
    pinnedAt: { type: Date, default: null },

    likedBy: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], default: [], select: false },
    likeCount: { type: Number, default: 0 },
    commentCount: { type: Number, default: 0 },

    mentions: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], default: [] },
    editedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

communityPostSchema.index({ community: 1, isPinned: -1, createdAt: -1 });
communityPostSchema.index({ community: 1, likeCount: -1 });

module.exports = mongoose.model('CommunityPost', communityPostSchema);