/**
 * Deep Feed AI Admin — lib/categorize.js
 * Data-driven category detection using keywords from site_categories setting.
 * Single source of truth — imported by routes/fetch.js (server-side RSS ingestion).
 */
'use strict';

const { getCategories } = require('./categories');

/**
 * Detect the most likely category for an RSS feed item.
 * Scores each category by matching its keywords against article text.
 * Title matches score +2, summary/content matches score +1.
 * @param {object} item - RSS item with title, categories, contentSnippet, content fields.
 * @returns {Promise<string>} Category name.
 */
async function detectCategory(item) {
  const title   = (item.title || '').toLowerCase();
  const body    = [
    (item.categories || []).join(' '),
    item.contentSnippet || '',
    item.content        || '',
  ].join(' ').toLowerCase();

  const categories = await getCategories();
  if (!categories.length) return 'Industry';

  let best = null;
  let bestScore = 0;

  for (const cat of categories) {
    if (!cat.keywords || !cat.keywords.length) continue;

    let score = 0;
    for (const kw of cat.keywords) {
      const kwLower = kw.toLowerCase();
      if (title.includes(kwLower)) score += 2;
      if (body.includes(kwLower))  score += 1;
    }

    if (score > bestScore) {
      bestScore = score;
      best = cat.name;
    }
  }

  // Fall back to the last category (typically "Industry") or literal 'Industry'
  return best || categories[categories.length - 1]?.name || 'Industry';
}

module.exports = { detectCategory };
