const mongoose = require('mongoose');

// Per-store, per-day counters (day = India date "YYYY-MM-DD").
const storeDailyStatSchema = new mongoose.Schema({
  store: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', required: true },
  day: { type: String, required: true },
  views: { type: Number, default: 0 },
  productViews: { type: Number, default: 0 },
  affiliateClicks: { type: Number, default: 0 },
});
storeDailyStatSchema.index({ store: 1, day: 1 }, { unique: true });

// One row per visitor per store per day — counts unique visitors.
// Kept for ~400 days.
const storeVisitSchema = new mongoose.Schema({
  store: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', required: true },
  day: { type: String, required: true },
  visitor: { type: String, required: true }, // user id, or a hash of ip + device
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 400 },
});
storeVisitSchema.index({ store: 1, day: 1, visitor: 1 }, { unique: true });

// Individual affiliate clicks (who/when), kept ~400 days.
const affiliateClickSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'AffiliateProduct', required: true, index: true },
  store: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', required: true, index: true },
  visitor: { type: String, default: '' },
  day: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 400 },
});

module.exports = {
  StoreDailyStat: mongoose.models.StoreDailyStat || mongoose.model('StoreDailyStat', storeDailyStatSchema),
  StoreVisit: mongoose.models.StoreVisit || mongoose.model('StoreVisit', storeVisitSchema),
  AffiliateClick: mongoose.models.AffiliateClick || mongoose.model('AffiliateClick', affiliateClickSchema),
};
