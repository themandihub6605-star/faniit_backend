const mongoose = require('mongoose');
const { VERIFICATION_STATUS } = require('../constants/enums');

const brandProfileSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    slug: { type: String, required: true, unique: true, index: true },

    companyName: { type: String, required: true, trim: true },
    tagline: { type: String, maxlength: 120, default: '' }, // e.g. "Clean Beauty • Skin Care • Self Care"
    logoUrl: { type: String, default: '' },
    coverImageUrl: { type: String, default: '' },
    website: { type: String, default: '' },
    industry: { type: String, default: '' },
    about: { type: String, maxlength: 500, default: '' },
    location: { type: String, default: '' }, // headquarters

    foundedYear: { type: Number, default: null },
    companySize: { type: String, default: '' }, // e.g. "51-200"
    whatWeOffer: { type: [String], default: [] }, // e.g. ["Brand Collaborations", "Product Reviews"]

    socials: {
      instagram: { type: String, default: '' },
      facebook: { type: String, default: '' },
      linkedin: { type: String, default: '' },
      youtube: { type: String, default: '' },
    },

    followerCount: { type: Number, default: 0 },
    followers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    profileViews: { type: Number, default: 0 },

    isTopBrand: { type: Boolean, default: false }, // admin-curated trust badge
    onTimePaymentsPercent: { type: Number, default: 100, min: 0, max: 100 },

    verificationStatus: {
      type: String,
      enum: Object.values(VERIFICATION_STATUS),
      default: VERIFICATION_STATUS.UNVERIFIED,
    },

    totalCampaigns: { type: Number, default: 0 },
    totalSpent: { type: Number, default: 0 },

    averageRating: { type: Number, default: 0, min: 0, max: 5 },
    reviewCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('BrandProfile', brandProfileSchema);
