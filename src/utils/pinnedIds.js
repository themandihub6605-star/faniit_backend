const mongoose = require('mongoose');

/**
 * `?ids=a,b,c` → valid ObjectIds (max 30), or null when not sent.
 * Used by the app home to load the items admin pinned to a section.
 */
function pinnedIds(query) {
  if (!query || !query.ids) return null;
  const ids = String(query.ids)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => mongoose.isValidObjectId(s))
    .slice(0, 30);
  return ids;
}

module.exports = { pinnedIds };