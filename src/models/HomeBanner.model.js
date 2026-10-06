const mongoose = require('mongoose');

// Home-screen slider banners, managed from the admin panel.
// Tap → linkType/linkValue decides where the app (or website) goes.

const LINK_TYPES = ['none', 'screen', 'url', 'campaign', 'creator', 'brand', 'community', 'store', 'product', 'live', 'meet'];

// Screens a banner can open with linkType 'screen'.
const SCREENS = ['plans', 'wallet', 'referrals', 'store', 'products', 'stores', 'communities', 'meets', 'campaigns', 'creators', 'brands', 'notifications', 'library', 'feed', 'search', 'editProfile'];

const PLATFORMS = ['all', 'app', 'web'];
const AUDIENCES = ['creator', 'brand', 'fan', 'agency'];

const homeBannerSchema = new mongoose.Schema(
  {
    imageUrl: { type: String, required: true },
    // Optional text drawn on the banner (leave empty if the image has text).
    title: { type: String, trim: true, maxlength: 70, default: '' },
    subtitle: { type: String, trim: true, maxlength: 120, default: '' },
    ctaLabel: { type: String, trim: true, maxlength: 24, default: '' },

    linkType: { type: String, enum: LINK_TYPES, default: 'none' },
    linkValue: { type: String, trim: true, maxlength: 500, default: '' },

    platform: { type: String, enum: PLATFORMS, default: 'all' },
    // Empty = everyone.
    audience: { type: [String], enum: AUDIENCES, default: [] },

    isActive: { type: Boolean, default: true },
    order: { type: Number, default: 0, index: true },
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },

    views: { type: Number, default: 0 },
    clicks: { type: Number, default: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

homeBannerSchema.index({ isActive: 1, order: 1 });

const HomeBanner = mongoose.models.HomeBanner || mongoose.model('HomeBanner', homeBannerSchema);

module.exports = HomeBanner;
module.exports.LINK_TYPES = LINK_TYPES;
module.exports.SCREENS = SCREENS;
module.exports.PLATFORMS = PLATFORMS;
module.exports.AUDIENCES = AUDIENCES;