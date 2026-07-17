const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema(
  {
    fromUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    toUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    // what this review is about
    relatedModel: { type: String, enum: ['Session', 'Campaign'], required: true },
    relatedId: { type: mongoose.Schema.Types.ObjectId, required: true },

    rating: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, maxlength: 500, default: '' },

    // sub-ratings shown in the UI (communication, quality of work, etc.)
    subRatings: {
      communication: { type: Number, min: 1, max: 5 },
      qualityOfWork: { type: Number, min: 1, max: 5 },
      paymentExperience: { type: Number, min: 1, max: 5 },
      professionalism: { type: Number, min: 1, max: 5 },
    },

    isFlagged: { type: Boolean, default: false },
    isHidden: { type: Boolean, default: false }, // admin moderation
  },
  { timestamps: true }
);

reviewSchema.index({ toUser: 1, createdAt: -1 });

module.exports = mongoose.model('Review', reviewSchema);
