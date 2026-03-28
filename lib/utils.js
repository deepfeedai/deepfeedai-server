/**
 * Deep Feed AI Admin — lib/utils.js
 * Shared utility functions used across routes and DB layer.
 */

/**
 * Decode common HTML entities (numeric + named) to plain text.
 * Covers all entities typically found in RSS feed titles.
 */
function decodeEntities(str) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return (str || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&(amp|lt|gt|quot|apos);/gi, (_, name) => named[name.toLowerCase()] || _);
}

/**
 * Convert a title string into a URL-safe slug.
 * e.g. "Hello World! (2025)" → "hello-world-2025"
 */
function toSlug(title) {
  return decodeEntities(title || '')
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

/**
 * Sanitize external content before embedding in LLM prompts.
 * Strips control characters, collapses whitespace, and truncates.
 */
function sanitizeForPrompt(text, maxLen = 500) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/<[^>]+>/g, '')           // strip HTML tags
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // strip control chars
    .replace(/\s+/g, ' ')             // collapse whitespace
    .trim()
    .slice(0, maxLen);
}

const STOP_WORDS = new Set([
  'the','a','an','is','are','was','were','in','on','at','to','for','of',
  'and','or','but','with','from','this','that','it','its','be','has','have','had',
  'you','your','we','our','my','i','he','she','they','them','their',
  'new','now','just','more','will','can','get','use','let','make','how',
  'what','when','who','which','about','says','say','said','also','like',
  'one','two','three','us','up','out','over','after','into',
]);

/**
 * Extract significant words from a title string.
 * @param {string} title
 * @param {Set} [nicheStopWords] — additional niche-specific words to filter
 * @returns {string[]}
 */
function significantWords(title, nicheStopWords) {
  return (title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w) && (!nicheStopWords || !nicheStopWords.has(w)));
}

module.exports = { decodeEntities, toSlug, serializeRow, asyncHandler, sanitizeForPrompt, significantWords, STOP_WORDS };
