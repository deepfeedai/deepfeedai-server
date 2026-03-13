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
router.post('/run/:writerId', asyncHandler(async (req, res) => {
  const result = await runSynthesisForWriter(req.params.writerId);
  res.json(result);
}));

// POST /api/synthesis/run-all — run synthesis for all auto writers
router.post('/run-all', asyncHandler(async (req, res) => {
  const writers = await db.prepare('SELECT * FROM voices WHERE is_auto = true').all();
  const results = [];
  for (const writer of writers) {
    const result = await runSynthesisForWriter(writer.id);
    results.push({ writerId: writer.id, name: writer.name, ...result });
  }
  res.json(results);
}));

// GET /api/synthesis/preview/:writerId — preview clusters without generating
router.get('/preview/:writerId', asyncHandler(async (req, res) => {
  // Allow preview for any writer (not just is_auto) so admins can explore
  const writer = await db.prepare('SELECT * FROM voices WHERE id = $1').get(req.params.writerId);
  if (!writer) return res.status(404).json({ error: 'Writer not found' });

  const lookbackHours = writer.synthesis_lookback_hours || 168; // default 7 days
  const minSize = writer.min_cluster_size || 3;

  // Fetch articles — LIKE beat filter if beat is set, otherwise all recent
  let articles = [];
  if (writer.beat) {
    articles = await db.prepare(`
      SELECT id, title, summary, category, source, source_url FROM articles
      WHERE (content_type IS NULL OR content_type != 'original')
        AND is_archived = 0
        AND created_at > NOW() - ($1 || ' hours')::INTERVAL
        AND LOWER(category) LIKE LOWER($2)
      ORDER BY created_at DESC LIMIT 200
    `).all(lookbackHours, `%${writer.beat}%`);
  } else {
    articles = await db.prepare(`
      SELECT id, title, summary, category, source, source_url FROM articles
      WHERE (content_type IS NULL OR content_type != 'original')
        AND is_archived = 0
        AND created_at > NOW() - ($1 || ' hours')::INTERVAL
      ORDER BY created_at DESC LIMIT 200
    `).all(lookbackHours);
  }

  const clusters = clusterArticles(articles, minSize);

  res.json({
    writer: { id: writer.id, name: writer.name, beat: writer.beat },
    articleCount: articles.length,
    clusters: clusters.map(c => ({ topic: c.topic, articleCount: c.articles.length })),
  });
}));

module.exports = router;
