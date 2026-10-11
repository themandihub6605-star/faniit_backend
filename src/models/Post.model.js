const mongoose = require('mongoose');

// Feed content by creators AND brands.
//
//   kind 'post' — 1-10 photos/videos shown together in one card (grid
//                 layout in the apps), like an Instagram carousel post.
//   kind 'reel' — exactly one short vertical video. Shown in the "Reels"
//                 row in the feed and in the full-screen Reels player.
//
// The author is always `author` (User). `creator` or `brand` points to the
// profile it was posted as. Old posts only have `creator`; the API fills
// the rest in when reading them (see services/feed.service.js).

const POST_KINDS = Object.freeze({ POST: 'post', REEL: 'reel' });
const LIMITS = Object.freeze({ MEDIA_PER_POST: 10, REEL_MAX_SECONDS: 90 });

const mediaItemSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    type: { type: String, enum: ['image', 'video'], required: true },
    thumbnailUrl: { type: String, default: '' }, // video poster frame
    duration: { type: Number, default: 0 }, // seconds (videos, sent by the app)
    width: { type: Number, default: 0 },
    height: { type: Number, default: 0 },
    // Width ÷ height, so the feed can show each item in its real shape.
    aspectRatio: { type: Number, default: null, min: 0.2, max: 5 },
  },
  { _id: false }
);

const postSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: Object.values(POST_KINDS), default: POST_KINDS.POST, index: true },

    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    authorRole: { type: String, enum: ['creator', 'brand'], default: 'creator' },
    creator: { type: mongoose.Schema.Types.ObjectId, ref: 'CreatorProfile', default: null, index: true },
    brand: { type: mongoose.Schema.Types.ObjectId, ref: 'BrandProfile', default: null, index: true },

    mediaItems: {
      type: [mediaItemSchema],
      required: true,
      validate: {
        validator: (arr) => arr.length >= 1 && arr.length <= LIMITS.MEDIA_PER_POST,
        message: `A post must have between 1 and ${LIMITS.MEDIA_PER_POST} photos or videos`,
      },
    },
    caption: { type: String, maxlength: 500, default: '' },

    likedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    likeCount: { type: Number, default: 0 },
    viewCount: { type: Number, default: 0 }, // reels
    // People who saved the post (private — only used to show "Saved" to each user).
    savedBy: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], default: [] },
  },
  { timestamps: true }
);

postSchema.pre('validate', function checkShape(next) {
  if (!this.creator && !this.brand) return next(new Error('A post needs a creator or a brand'));
  if (this.kind === POST_KINDS.REEL && (this.mediaItems.length !== 1 || this.mediaItems[0].type !== 'video')) {
    return next(new Error('A reel must be exactly one video'));
  }
  return next();
});

postSchema.index({ creator: 1, createdAt: -1 });
postSchema.index({ brand: 1, createdAt: -1 });
postSchema.index({ kind: 1, createdAt: -1 });
postSchema.index({ createdAt: -1 });
postSchema.index({ savedBy: 1, createdAt: -1 });

postSchema.statics.KINDS = POST_KINDS;
postSchema.statics.LIMITS = LIMITS;

module.exports = mongoose.models.Post || mongoose.model('Post', postSchema);