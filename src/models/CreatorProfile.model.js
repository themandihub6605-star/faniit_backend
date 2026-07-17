const mongoose = require('mongoose');
const { VERIFICATION_STATUS } = require('../constants/enums');

const creatorProfileSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    slug: { type: String, required: true, unique: true, index: true },

    bio: { type: String, maxlength: 500, default: '' },
    title: { type: String, maxlength: 80, default: '' }, // short tagline, e.g. "Photographer & Cinematographer"
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category' },
    skills: { type: [String], default: [] },
    location: { type: String, default: '' },

    isAvailableForWork: { type: Boolean, default: true },
    isTopCreator: { type: Boolean, default: false }, // admin-curated trust badge
    responseTime: { type: String, default: '' }, // e.g. "Within 2 hours"
    languages: { type: [String], default: [] },
    onTimeDeliveryPercent: { type: Number, default: 100, min: 0, max: 100 },

    coverImageUrl: { type: String, default: '' },
    portfolioImages: { type: [String], default: [] },
    portfolioVideos: { type: [String], default: [] },

    socials: {
      instagram: { type: String, default: '' },
      facebook: { type: String, default: '' },
      linkedin: { type: String, default: '' },
      youtube: { type: String, default: '' },
      behance: { type: String, default: '' },
      website: { type: String, default: '' },
    },

    followerCount: { type: Number, default: 0 },
    followers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    profileViews: { type: Number, default: 0 },

    averageRating: { type: Number, default: 0, min: 0, max: 5 },
    reviewCount: { type: Number, default: 0 },

    verificationStatus: {
      type: String,
      enum: Object.values(VERIFICATION_STATUS),
      default: VERIFICATION_STATUS.UNVERIFIED,
    },

    // earnings snapshot, recalculated by walletService on each transaction
    totalEarnings: { type: Number, default: 0 },
    thisMonthEarnings: { type: Number, default: 0 },

    agency: { type: mongoose.Schema.Types.ObjectId, ref: 'AgencyProfile', default: null },
  },
  { timestamps: true }
);

creatorProfileSchema.index({ category: 1 });
creatorProfileSchema.index({ verificationStatus: 1 });

module.exports = mongoose.model('CreatorProfile', creatorProfileSchema);
