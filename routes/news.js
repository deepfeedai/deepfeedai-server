/**
 * Deep Feed AI Admin — GET /api/news
 * Public endpoint — returns all published, non-archived articles.
 * Used by the main site to populate the news feed.
 */
const express                        = require('express');
const router                         = express.Router();
const { getPool }                    = require('../db');
const { serializeRow, asyncHandler } = require('../lib/utils');

// GET /api/news
router.get('/', asyncHandler(async (req, res) => {
  const { category, limit: lim, featured } = req.query;
  let query = 'SELECT * FROM articles WHERE is_published = 1 AND (is_archived = 0 OR is_archived IS NULL)';
  const params = [];

  if (category) {
    params.push(category);
    query += ` AND category = $${params.length}`;
  }
  if (featured !== undefined) {
    params.push(parseInt(featured));
    query += ` AND is_featured = $${params.length}`;
  }

  query += ' ORDER BY is_featured DESC, published_at DESC';

  if (lim) {
    params.push(parseInt(lim));
    query += ` LIMIT $${params.length}`;
  }

  const result = await getPool().query(query, params.length ? params : undefined);
  const items  = result.rows.map(serializeRow);
  res.json({ status: 'ok', items, count: items.length });
}));

// GET /api/news/updated-at — lightweight cache-bust timestamp for the main site
router.get('/updated-at', asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const result = await getPool().query(
    'SELECT MAX(COALESCE(updated_at, created_at, published_at)) AS ts FROM articles'
  );
  res.json({ updatedAt: result.rows[0]?.ts || null });
}));

module.exports = router;
