/**
 * Deep Feed AI Admin — /api/synthesis
 * Routes for article synthesis (clustering + original content generation).
 */
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { requirePermission } = require('../middleware/permissions');
const { asyncHandler } = require('../lib/utils');
const { clusterArticles, runSynthesisForWriter, generateDeepDive, runWeeklyDeepDives } = require('../lib/synthesis');

// POST /api/synthesis/run/:writerId — run synthesis for a single writer
// ?force=true bypasses cooldown and dedup checks
router.post('/run/:writerId', requirePermission('synthesis.execute'), asyncHandler(async (req, res) => {
  const force = req.query.force === 'true';
  const result = await runSynthesisForWriter(req.params.writerId, { force, tenantId: req.tenantId });
  res.json(result);
}));

// POST /api/synthesis/run-all — run synthesis for all auto writers
// ?force=true bypasses cooldown and dedup checks
router.post('/run-all', requirePermission('synthesis.execute'), asyncHandler(async (req, res) => {
  const force = req.query.force === 'true';
  const writers = await db.prepare('SELECT * FROM writers WHERE tenant_id = $1 AND is_auto = true').all(req.tenantId);
  const results = [];
  for (const writer of writers) {
    const result = await runSynthesisForWriter(writer.id, { force, tenantId: req.tenantId });
    results.push({ writerId: writer.id, name: writer.name, ...result });
  }
  res.json(results);
}));

// GET /api/synthesis/preview/:writerId — preview clusters without generating
router.get('/preview/:writerId', requirePermission('synthesis.execute'), asyncHandler(async (req, res) => {
  // Allow preview for any writer (not just is_auto) so admins can explore
  const writer = await db.prepare('SELECT * FROM writers WHERE id = $1 AND tenant_id = $2').get(req.params.writerId, req.tenantId);
  if (!writer) return res.status(404).json({ error: 'Writer not found' });

  const lookbackHours = writer.synthesis_lookback_hours || 168; // default 7 days
  const minSize = writer.min_cluster_size || 3;

  // Fetch all recent non-original articles — beat shapes voice, not article scope
  const articles = await db.prepare(`
    SELECT id, title, summary, category, source, source_url FROM articles
    WHERE tenant_id = $2
      AND (content_type IS NULL OR content_type != 'original')
      AND is_archived = 0
      AND created_at > NOW() - make_interval(hours => $1)
    ORDER BY created_at DESC LIMIT 200
  `).all(lookbackHours, req.tenantId);

  const clusters = clusterArticles(articles, minSize);

  res.json({
    writer: { id: writer.id, name: writer.name },
    articleCount: articles.length,
    clusters: clusters.map(c => ({ topic: c.topic, articleCount: c.articles.length })),
  });
}));

// DELETE /api/synthesis/purge — delete all original synthesis articles (testing/reset)
// ?category=<name> — optional: purge only originals in a specific category
router.delete('/purge', requirePermission('synthesis.execute'), asyncHandler(async (req, res) => {
  const { category } = req.query;
  let deleted;
  if (category) {
    deleted = await db.prepare(
      `DELETE FROM articles WHERE tenant_id = $1 AND content_type = 'original' AND category = $2 RETURNING id`
    ).all(req.tenantId, category);
  } else {
    deleted = await db.prepare(
      `DELETE FROM articles WHERE tenant_id = $1 AND content_type = 'original' RETURNING id`
    ).all(req.tenantId);
  }
  res.json({ deleted: deleted.length });
}));

// POST /api/synthesis/deep-dive/:category — generate deep dive for one category
router.post('/deep-dive/:category', requirePermission('synthesis.execute'), asyncHandler(async (req, res) => {
  const force = req.query.force === 'true';
  const result = await generateDeepDive(req.params.category, req.tenantId, { force });
  res.json(result);
}));

// POST /api/synthesis/deep-dive-all — generate deep dives for all qualifying categories
router.post('/deep-dive-all', requirePermission('synthesis.execute'), asyncHandler(async (req, res) => {
  const force = req.query.force === 'true';
  const result = await runWeeklyDeepDives(req.tenantId, { force });
  res.json(result);
}));

// GET /api/synthesis/deep-dive-preview/:category — preview what a deep dive would cover
router.get('/deep-dive-preview/:category', requirePermission('synthesis.execute'), asyncHandler(async (req, res) => {
  const articles = await db.prepare(`
    SELECT id, title, source, category, created_at FROM articles
    WHERE tenant_id = $1 AND (content_type IS NULL OR content_type = 'curated')
      AND is_archived = 0 AND category = $2
      AND created_at > NOW() - INTERVAL '7 days'
    ORDER BY created_at DESC LIMIT 500
  `).all(req.tenantId, req.params.category);

  const clusters = clusterArticles(articles, 2);
  res.json({
    category: req.params.category,
    totalArticles: articles.length,
    clusters: clusters.map(c => ({ topic: c.topic, articleCount: c.articles.length })),
    clusterCount: clusters.length,
  });
}));

module.exports = router;
