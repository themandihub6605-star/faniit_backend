const mongoose = require('mongoose');

// The app home's discover sections, managed from the admin panel:
// which sections show, in what order, their titles, and which items are
// pinned first in each. One document (singleton).

const SECTION_KEYS = ['live', 'creators', 'campaigns', 'meets', 'brands', 'communities', 'products', 'stores'];

const DEFAULT_SECTIONS = [
  { key: 'live', title: 'Live now', subtitle: 'Join creators streaming right now' },
  { key: 'creators', title: 'Top creators', subtitle: 'Discover creators to work with' },
  { key: 'campaigns', title: 'Open campaigns', subtitle: 'Paid & barter collaborations' },
  { key: 'meets', title: 'Virtual Meets', subtitle: 'Webinars & 1:1 sessions — join in the app' },
  { key: 'brands', title: 'Brands on Fanitt', subtitle: 'Companies hiring creators' },
  { key: 'communities', title: 'Trending communities', subtitle: 'Join the conversation' },
  { key: 'products', title: 'Digital products', subtitle: 'Courses, ebooks, templates — instant download' },
  { key: 'stores', title: 'Creator stores', subtitle: 'Courses, ebooks, templates & more' },
];

const sectionSchema = new mongoose.Schema(
  {
    key: { type: String, enum: SECTION_KEYS, required: true },
    title: { type: String, trim: true, maxlength: 60, default: '' },
    subtitle: { type: String, trim: true, maxlength: 120, default: '' },
    enabled: { type: Boolean, default: true },
    // Items shown first, in this order (ids of creators, campaigns, …).
    pinned: { type: [String], default: [] },
  },
  { _id: false }
);

const homeLayoutSchema = new mongoose.Schema(
  {
    singleton: { type: String, default: 'home', unique: true },
    sections: { type: [sectionSchema], default: () => DEFAULT_SECTIONS.map((s) => ({ ...s, enabled: true, pinned: [] })) },
  },
  { timestamps: true }
);

/** The layout, with any section added since it was saved appended at the end. */
homeLayoutSchema.statics.get = async function get() {
  let doc = await this.findOne({ singleton: 'home' });
  if (!doc) doc = await this.create({ singleton: 'home' });
  const have = new Set(doc.sections.map((s) => s.key));
  const missing = DEFAULT_SECTIONS.filter((s) => !have.has(s.key));
  if (missing.length) {
    doc.sections.push(...missing.map((s) => ({ ...s, enabled: true, pinned: [] })));
    await doc.save();
  }
  return doc;
};

const HomeLayout = mongoose.models.HomeLayout || mongoose.model('HomeLayout', homeLayoutSchema);

module.exports = HomeLayout;
module.exports.SECTION_KEYS = SECTION_KEYS;
module.exports.DEFAULT_SECTIONS = DEFAULT_SECTIONS;