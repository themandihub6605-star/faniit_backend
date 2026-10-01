const slugify = require('slugify');

function toSlug(value) {
  return slugify(String(value || ''), { lower: true, strict: true, trim: true }).slice(0, 60);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Shows only the last 4 characters: ••••••1234 */
function mask(value) {
  const v = String(value || '');
  if (v.length <= 4) return v;
  return `${'•'.repeat(Math.min(8, v.length - 4))}${v.slice(-4)}`;
}

function pageParams(query, defaultLimit = 20, maxLimit = 50) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
}

module.exports = { toSlug, escapeRegex, mask, pageParams };
