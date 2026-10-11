const mongoose = require('mongoose');

// 24-hour stories by creators and brands: one photo or video each.
// MongoDB deletes them automatically after `expiresAt` (TTL index).

const STORY_HOURS = 24;

const storySchema = new mongoose.Schema(
  {
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    authorRole: { type: String, enum: ['creator', 'brand'], required: true },
    creator: { type: mongoose.Schema.Types.ObjectId, ref: 'CreatorProfile', default: null },
    brand: { type: mongoose.Schema.Types.ObjectId, ref: 'BrandProfile', default: null },

    media: {
      url: { type: String, required: true },
      type: { type: String, enum: ['image', 'video'], required: true },
      thumbnailUrl: { type: String, default: '' },
      duration: { type: Number, default: 0 }, // seconds (videos)
    },
    caption: { type: String, trim: true, maxlength: 200, default: '' },

    viewers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    viewCount: { type: Number, default: 0 },

    expiresAt: { type: Date, required: true, default: () => new Date(Date.now() + STORY_HOURS * 60 * 60 * 1000) },
  },
  { timestamps: true }
);

storySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
storySchema.index({ author: 1, createdAt: 1 });

storySchema.statics.HOURS = STORY_HOURS;

module.exports = mongoose.models.Story || mongoose.model('Story', storySchema);