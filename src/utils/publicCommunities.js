// File: src/utils/publicCommunities.js
// A creator's communities for public pages (website profile / store page).
const Community = require('../models/Community.model');

const FIELDS = 'name slug description iconUrl coverImageUrl visibility isPaid pricing memberCount';

/** Lowest enabled plan price (paise), or 0 when free. */
function startingPrice(c) {
  if (!c.isPaid || !c.pricing) return 0;
  const prices = ['monthly', 'yearly', 'lifetime']
    .map((k) => c.pricing[k])
    .filter((p) => p && p.enabled && p.price > 0)
    .map((p) => p.price);
  return prices.length ? Math.min(...prices) : 0;
}

/** Communities created by [userId], biggest first. */
async function communitiesOf(userId, limit = 20) {
  if (!userId) return [];
  const list = await Community.find({ createdBy: userId }).select(FIELDS).sort({ memberCount: -1 }).limit(limit).lean();
  return list.map((c) => ({
    _id: c._id,
    name: c.name,
    slug: c.slug,
    description: c.description || '',
    iconUrl: c.iconUrl || '',
    coverImageUrl: c.coverImageUrl || '',
    visibility: c.visibility,
    isPaid: !!c.isPaid,
    startingPrice: startingPrice(c),
    memberCount: c.memberCount || 0,
  }));
}

module.exports = { communitiesOf };