const slugify = require('slugify');

/**
 * Generates a URL-safe slug from a string, with a short random suffix so
 * two people with the same name (e.g. two "Rhea Kapoor"s) don't collide.
 */
function generateSlug(text) {
  const base = slugify(text, { lower: true, strict: true });
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${base}-${suffix}`;
}

module.exports = generateSlug;
