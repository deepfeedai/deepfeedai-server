/**
 * Deep Feed AI Admin — /api/writers
 * Public read-only routes for writer personas.
 */
const express          = require('express');
const router           = express.Router();
const db               = require('../db');
const { asyncHandler } = require('../lib/utils');
const { auth }         = require('../middleware/auth');
const { findBestWriter } = require('../lib/writer-assign');

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

// POST /api/writers/:id/assign-articles — bulk auto-assign unassigned articles to this writer's beat
router.post('/:id/assign-articles', auth, asyncHandler(async (req, res) => {
  const days = parseInt(req.body.days) || 7;
  const articles = await db.prepare(
    `SELECT id, title, summary, category FROM articles
     WHERE writer_id IS NULL AND is_published = 1 AND is_archived = 0
       AND created_at > NOW() - INTERVAL '${days} days'`
  ).all();

  let assigned = 0;
  for (const article of articles) {
    const writer = await findBestWriter(article);
    if (writer) {
      await db.prepare('UPDATE articles SET writer_id = $1 WHERE id = $2').run(writer.id, article.id);
      assigned++;
    }
  }

  res.json({ assigned });
}));

module.exports = router;
