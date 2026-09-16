const mongoose = require('mongoose');

// A post now holds 1-5 media items, each independently image or video —
// carousel-style, matching Threads/Instagram multi-media posts. Existing
// single mediaUrl/mediaType are gone; every post (even a single-photo one)
// is just a mediaItems array of length 1.
const mediaItemSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    type: { type: String, enum: ['image', 'video'], required: true },
  },
  { _id: false }
);

const postSchema = new mongoose.Schema(
  {
    creator: { type: mongoose.Schema.Types.ObjectId, ref: 'CreatorProfile', required: true, index: true },

    mediaItems: {
      type: [mediaItemSchema],
      required: true,
      validate: {
        validator: (arr) => arr.length >= 1 && arr.length <= 5,
        message: 'A post must have between 1 and 5 media items',
      },
    },
    caption: { type: String, maxlength: 500, default: '' },

    likedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    likeCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

postSchema.index({ creator: 1, createdAt: -1 });
postSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Post', postSchema);