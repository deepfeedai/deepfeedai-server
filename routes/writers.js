/**
 * Deep Feed AI Admin — /api/writers
 * Public read-only routes for writer personas.
 */
const express          = require('express');
const router           = express.Router();
const db               = require('../db');
const { asyncHandler } = require('../lib/utils');

// GET /api/writers — public list of writers
router.get('/', asyncHandler(async (req, res) => {
  const writers = await db.prepare(`
    SELECT v.id, v.name, v.slug, v.avatar_url, v.bio, v.beat,
           COUNT(a.id)::int AS article_count
    FROM voices v
    LEFT JOIN articles a ON a.writer_id = v.id
    GROUP BY v.id
    ORDER BY v.name ASC
  `).all();
  res.json(writers);
}));

// GET /api/writers/:slug — single writer by slug
router.get('/:slug', asyncHandler(async (req, res) => {
  const writer = await db.prepare(`
    SELECT v.id, v.name, v.slug, v.avatar_url, v.bio, v.beat,
           COUNT(a.id)::int AS article_count,
           COUNT(a.id) FILTER (WHERE a.content_type = 'original')::int AS original_count
    FROM voices v
    LEFT JOIN articles a ON a.writer_id = v.id
    WHERE v.slug = $1
    GROUP BY v.id
  `).get(req.params.slug);
  if (!writer) return res.status(404).json({ error: 'Writer not found' });
  res.json(writer);
}));

module.exports = router;
