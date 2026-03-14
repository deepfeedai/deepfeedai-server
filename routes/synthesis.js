/**
 * Deep Feed AI Admin — /api/synthesis
 * Routes for article synthesis (clustering + original content generation).
 */
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { asyncHandler } = require('../lib/utils');
const { clusterArticles, runSynthesisForWriter } = require('../lib/synthesis');

// POST /api/synthesis/run/:writerId — run synthesis for a single writer
// ?force=true bypasses cooldown and dedup checks
router.post('/run/:writerId', asyncHandler(async (req, res) => {
  const force = req.query.force === 'true';
  const result = await runSynthesisForWriter(req.params.writerId, { force });
  res.json(result);
}));

// POST /api/synthesis/run-all — run synthesis for all auto writers
// ?force=true bypasses cooldown and dedup checks
router.post('/run-all', asyncHandler(async (req, res) => {
  const force = req.query.force === 'true';
  const writers = await db.prepare('SELECT * FROM writers WHERE is_auto = true').all();
  const results = [];
  for (const writer of writers) {
    const result = await runSynthesisForWriter(writer.id, { force });
    results.push({ writerId: writer.id, name: writer.name, ...result });
  }
  res.json(results);
}));

// GET /api/synthesis/preview/:writerId — preview clusters without generating
router.get('/preview/:writerId', asyncHandler(async (req, res) => {
  // Allow preview for any writer (not just is_auto) so admins can explore
  const writer = await db.prepare('SELECT * FROM writers WHERE id = $1').get(req.params.writerId);
  if (!writer) return res.status(404).json({ error: 'Writer not found' });

  const lookbackHours = writer.synthesis_lookback_hours || 168; // default 7 days
  const minSize = writer.min_cluster_size || 3;

  // Fetch all recent non-original articles — beat shapes voice, not article scope
  const articles = await db.prepare(`
    SELECT id, title, summary, category, source, source_url FROM articles
    WHERE (content_type IS NULL OR content_type != 'original')
      AND is_archived = 0
      AND created_at > NOW() - ($1 || ' hours')::INTERVAL
    ORDER BY created_at DESC LIMIT 200
  `).all(lookbackHours);

  const clusters = clusterArticles(articles, minSize);

  res.json({
    writer: { id: writer.id, name: writer.name },
    articleCount: articles.length,
    clusters: clusters.map(c => ({ topic: c.topic, articleCount: c.articles.length })),
  });
}));

// DELETE /api/synthesis/purge — delete all original synthesis articles (testing/reset)
// ?category=<name> — optional: purge only originals in a specific category
router.delete('/purge', asyncHandler(async (req, res) => {
  const { category } = req.query;
  let deleted;
  if (category) {
    deleted = await db.prepare(
      `DELETE FROM articles WHERE content_type = 'original' AND category = $1 RETURNING id`
    ).all(category);
  } else {
    deleted = await db.prepare(
      `DELETE FROM articles WHERE content_type = 'original' RETURNING id`
    ).all();
  }
  res.json({ deleted: deleted.length });
}));

module.exports = router;
