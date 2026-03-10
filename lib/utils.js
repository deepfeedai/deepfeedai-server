/**
 * Deep Feed AI Admin — lib/utils.js
 * Shared utility functions used across routes and DB layer.
 */

/**
 * Convert a title string into a URL-safe slug.
 * e.g. "Hello World! (2025)" → "hello-world-2025"
 */
function toSlug(title) {
  return (title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

/**
 * Serialize a Postgres row, converting Date objects to ISO strings.
 * Ensures consistent string values for all callers.
 */
function serializeRow(row) {
  if (!row) return null;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = v instanceof Date ? v.toISOString() : v;
  }
  return out;
}

/**
 * Wrap an async Express route handler to catch unhandled rejections
 * and forward them to Express's error handler via next().
 */
function asyncHandler(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

module.exports = { toSlug, serializeRow, asyncHandler };
