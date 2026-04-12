/**
 * Deep Feed AI Admin — /api/synthesis
 * Routes for article synthesis (clustering + original content generation).
 */
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { requirePermission } = require('../middleware/permissions');
const { requireFeature } = require('../middleware/feature-gate');
const { asyncHandler } = require('../lib/utils');
const {
  clusterArticles, runSynthesisForWriter, generateDeepDive, runWeeklyDeepDives,
  getCooldownStatus, getArticlePool, evaluateClusters, generateForecast, getLatestForecast, loadWatchlist,
  getCategoryBreakdown,
} = require('../lib/synthesis');

// POST /api/synthesis/run/:writerId — run synthesis for a single writer
// ?force=true bypasses cooldown and dedup checks
// ?dryRun=true evaluates pipeline without generating
// Body: { clusterIndices: [0, 2] } — optional, only generate specific clusters
router.post('/run/:writerId', requirePermission('synthesis.execute'), requireFeature('auto_synthesis'), asyncHandler(async (req, res) => {
  const force = req.query.force === 'true';
  const dryRun = req.query.dryRun === 'true';
  const clusterIndices = req.body?.clusterIndices;
  const result = await runSynthesisForWriter(req.params.writerId, { force, tenantId: req.tenantId, dryRun, clusterIndices });
  res.json(result);
}));

// GET /api/synthesis/dry-run/:writerId — convenience alias for dry-run (read-only)
router.get('/dry-run/:writerId', requirePermission('synthesis.execute'), requireFeature('auto_synthesis'), asyncHandler(async (req, res) => {
  const force = req.query.force === 'true';
  const result = await runSynthesisForWriter(req.params.writerId, { force, tenantId: req.tenantId, dryRun: true });
  res.json(result);
}));

// GET /api/synthesis/dry-run-all — dry-run for all auto-writers
router.get('/dry-run-all', requirePermission('synthesis.execute'), requireFeature('auto_synthesis'), asyncHandler(async (req, res) => {
  const force = req.query.force === 'true';
  const writers = await db.prepare('SELECT * FROM writers WHERE tenant_id = $1 AND is_auto = true').all(req.tenantId);
  const results = [];
  for (const writer of writers) {
    const result = await runSynthesisForWriter(writer.id, { force, tenantId: req.tenantId, dryRun: true });
    results.push(result);
  }
  res.json(results);
}));

// POST /api/synthesis/run-all — run synthesis for all auto writers
// ?force=true bypasses cooldown and dedup checks
router.post('/run-all', requirePermission('synthesis.execute'), requireFeature('auto_synthesis'), asyncHandler(async (req, res) => {
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

  // Use the same writer-scoped article pool as actual synthesis
  const pool = await getArticlePool(writer.id, req.tenantId, lookbackHours, minSize);
  const clusters = clusterArticles(pool.articles, minSize);
  const cooldown = await getCooldownStatus(writer.id, req.tenantId);
  const evaluated = await evaluateClusters(clusters, req.tenantId, false);

  res.json({
    writer: { id: writer.id, name: writer.name, schedule: writer.synthesis_schedule || 'daily', lookbackHours, minClusterSize: minSize },
    cooldown,
    articlePool: { total: pool.articles.length, writerScoped: pool.writerScopedCount, beatFallback: pool.beatFallbackCount },
    clusters: evaluated,
  });
}));

// GET /api/synthesis/diagnose/:writerId — explain why synthesis has no results
router.get('/diagnose/:writerId', requirePermission('synthesis.execute'), asyncHandler(async (req, res) => {
  const writer = await db.prepare('SELECT * FROM writers WHERE id = $1 AND tenant_id = $2').get(req.params.writerId, req.tenantId);
  if (!writer) return res.status(404).json({ error: 'Writer not found' });

  const lookbackHours = parseInt(req.query.lookbackHours, 10) || writer.synthesis_lookback_hours || 168;
  const minSize = writer.min_cluster_size || 3;
  const tenantId = req.tenantId;

  // Beats
  const beats = await db.prepare(`
    SELECT c.id, c.name FROM writer_beats wb
    JOIN categories c ON c.id = wb.category_id AND c.tenant_id = $2
    WHERE wb.writer_id = $1 AND wb.tenant_id = $2
    ORDER BY c.name
  `).all(writer.id, tenantId);
  const beatNames = beats.map(b => b.name);

  // Sources health
  const sourcesAgg = await db.prepare(`
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE is_active = 1)::int AS active,
           COUNT(*) FILTER (WHERE is_active = 1 AND last_fetched IS NULL)::int AS never_fetched,
           COUNT(*) FILTER (WHERE is_active = 1 AND last_fetched IS NOT NULL AND last_fetched < NOW() - INTERVAL '24 hours')::int AS stale,
           MAX(last_fetched) AS last_fetch_at
    FROM sources WHERE tenant_id = $1
  `).get(tenantId);
  const sources = {
    total: sourcesAgg?.total || 0,
    active: sourcesAgg?.active || 0,
    inactive: (sourcesAgg?.total || 0) - (sourcesAgg?.active || 0),
    neverFetched: sourcesAgg?.never_fetched || 0,
    stale: sourcesAgg?.stale || 0,
    lastFetchAt: sourcesAgg?.last_fetch_at || null,
  };

  // Articles health
  const articlesAgg = await db.prepare(`
    SELECT COUNT(*) FILTER (WHERE content_type IS NULL OR content_type NOT IN ('original','deep-dive'))::int AS total_curated,
           COUNT(*) FILTER (WHERE (content_type IS NULL OR content_type NOT IN ('original','deep-dive'))
                              AND is_archived = 0
                              AND created_at > NOW() - make_interval(hours => $2))::int AS in_lookback,
           COUNT(*) FILTER (WHERE (content_type IS NULL OR content_type NOT IN ('original','deep-dive'))
                              AND is_archived = 0
                              AND writer_id = $3
                              AND created_at > NOW() - make_interval(hours => $2))::int AS assigned_to_writer,
           COUNT(*) FILTER (WHERE (content_type IS NULL OR content_type NOT IN ('original','deep-dive'))
                              AND is_archived = 0
                              AND (category IS NULL OR category = 'Uncategorized')
                              AND created_at > NOW() - make_interval(hours => $2))::int AS uncategorized
    FROM articles WHERE tenant_id = $1
  `).get(tenantId, lookbackHours, writer.id);

  const categoryBreakdown = await getCategoryBreakdown(tenantId, lookbackHours);
  const matchingBeats = categoryBreakdown
    .filter(c => beatNames.includes(c.category))
    .reduce((sum, c) => sum + c.count, 0);

  const articles = {
    totalCurated: articlesAgg?.total_curated || 0,
    inLookbackWindow: articlesAgg?.in_lookback || 0,
    assignedToThisWriter: articlesAgg?.assigned_to_writer || 0,
    matchingBeats,
    uncategorized: articlesAgg?.uncategorized || 0,
    byCategory: categoryBreakdown,
  };

  // Clustering preview
  const pool = await getArticlePool(writer.id, tenantId, lookbackHours, minSize);
  const clusters = clusterArticles(pool.articles, minSize);

  const beatCategories = categoryBreakdown.filter(c => beatNames.includes(c.category));
  const categoriesEligibleForOriginal = beatCategories.filter(c => c.distinctSources >= minSize).length;
  const categoriesEligibleForDeepDive = beatCategories.filter(c => c.count >= 5).length;
  const categoriesBelowThreshold = beatCategories
    .filter(c => c.distinctSources < minSize && c.count > 0)
    .map(c => ({ category: c.category, articles: c.count, distinctSources: c.distinctSources, needed: minSize }));

  const clustering = {
    pool: pool.articles.length,
    writerScoped: pool.writerScopedCount,
    beatFallback: pool.beatFallbackCount,
    categoriesEligibleForOriginal,
    categoriesEligibleForDeepDive,
    categoriesBelowThreshold,
    clustersFound: clusters.length,
  };

  const cooldown = await getCooldownStatus(writer.id, tenantId);

  // Compose reasons in priority order
  const reasons = [];
  if (!beats.length) {
    reasons.push({
      level: 'error',
      message: `Writer "${writer.name}" has no beats assigned. Synthesis looks for curated articles matching the writer's beat categories — with none, the pool stays empty. Assign beats on the writer's detail page.`,
    });
  }
  if (sources.total === 0) {
    reasons.push({ level: 'error', message: 'No RSS sources configured yet. Add sources on the Sources page.' });
  } else if (sources.active === 0) {
    reasons.push({ level: 'error', message: `All ${sources.total} sources are inactive. Activate them on the Sources page.` });
  } else if (!sources.lastFetchAt) {
    reasons.push({ level: 'error', message: `No sources have been fetched yet. Run Fetch on the Sources page to pull articles from the ${sources.active} active feeds.` });
  } else if (sources.neverFetched > 0) {
    reasons.push({ level: 'warn', message: `${sources.neverFetched} of ${sources.active} active sources have never been fetched.` });
  }
  if (articles.inLookbackWindow === 0 && sources.lastFetchAt) {
    reasons.push({ level: 'error', message: `No curated articles in the last ${lookbackHours}h window. Either fetch is not pulling articles, or they're older than the lookback window.` });
  }
  if (articles.uncategorized > 0 && articles.uncategorized === articles.inLookbackWindow) {
    reasons.push({ level: 'error', message: `All ${articles.uncategorized} articles in the lookback window are uncategorized. Check the categorization pipeline.` });
  }
  if (beats.length && articles.matchingBeats === 0 && articles.inLookbackWindow > 0) {
    reasons.push({ level: 'warn', message: `${articles.inLookbackWindow} articles exist in the lookback window, but none match this writer's beats (${beatNames.join(', ')}). Articles are landing in other categories.` });
  }
  for (const c of categoriesBelowThreshold) {
    reasons.push({
      level: 'warn',
      message: `"${c.category}" has ${c.articles} article${c.articles === 1 ? '' : 's'} but only ${c.distinctSources} distinct source${c.distinctSources === 1 ? '' : 's'} — need ${c.needed} for originals. Add more sources covering this topic.`,
    });
  }
  if (clustering.pool > 0 && clustering.clustersFound === 0 && categoriesBelowThreshold.length === 0) {
    reasons.push({ level: 'info', message: `Article pool has ${clustering.pool} items but no clusters formed. Articles in each category may not share enough keywords in titles/summaries to cluster.` });
  }
  if (cooldown.active) {
    reasons.push({ level: 'info', message: `Writer is in cooldown — last synthesis ran ${cooldown.hoursSinceLastRun}h ago (threshold ${cooldown.threshold}h). Use "force" to bypass.` });
  }
  if (!reasons.length) {
    reasons.push({ level: 'ok', message: `Ready: ${clustering.clustersFound} cluster${clustering.clustersFound === 1 ? '' : 's'} from ${clustering.pool} articles across ${categoriesEligibleForOriginal} eligible categor${categoriesEligibleForOriginal === 1 ? 'y' : 'ies'}.` });
  }

  res.json({
    writer: { id: writer.id, name: writer.name, schedule: writer.synthesis_schedule || 'daily', lookbackHours, minClusterSize: minSize },
    beats,
    sources,
    articles,
    clustering,
    cooldown,
    reasons,
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
router.post('/deep-dive/:category', requirePermission('synthesis.execute'), requireFeature('deep_dives'), asyncHandler(async (req, res) => {
  const force = req.query.force === 'true';
  const result = await generateDeepDive(req.params.category, req.tenantId, { force });
  res.json(result);
}));

// POST /api/synthesis/deep-dive-all — generate deep dives for all qualifying categories
router.post('/deep-dive-all', requirePermission('synthesis.execute'), requireFeature('deep_dives'), asyncHandler(async (req, res) => {
  const force = req.query.force === 'true';
  const result = await runWeeklyDeepDives(req.tenantId, { force });
  res.json(result);
}));

// GET /api/synthesis/pipeline-overview — all auto-writers with clusters, cooldown, schedule
const pipelineCache = { data: null, ts: 0 };
const PIPELINE_TTL = 5 * 60 * 1000; // 5 minutes

router.get('/pipeline-overview', requirePermission('synthesis.execute'), asyncHandler(async (req, res) => {
  const now = Date.now();
  if (pipelineCache.data && pipelineCache.tenantId === req.tenantId && (now - pipelineCache.ts) < PIPELINE_TTL) {
    return res.json(pipelineCache.data);
  }

  const writers = await db.prepare('SELECT * FROM writers WHERE tenant_id = $1 AND is_auto = true').all(req.tenantId);
  const results = [];

  for (const writer of writers) {
    const lookbackHours = writer.synthesis_lookback_hours || 168;
    const minSize = writer.min_cluster_size || 3;
    const cooldown = await getCooldownStatus(writer.id, req.tenantId);
    const pool = await getArticlePool(writer.id, req.tenantId, lookbackHours, minSize);
    const clusters = clusterArticles(pool.articles, minSize);
    const evaluated = await evaluateClusters(clusters, req.tenantId, false);

    // Last synthesis result from cron_runs
    const lastRun = await db.prepare(`
      SELECT started_at, status, summary FROM cron_runs
      WHERE tenant_id = $1 AND job_name = 'synthesis'
      ORDER BY started_at DESC LIMIT 1
    `).get(req.tenantId);

    results.push({
      writer: { id: writer.id, name: writer.name, schedule: writer.synthesis_schedule || 'daily', lookbackHours, minClusterSize: minSize },
      cooldown,
      articlePool: { total: pool.articles.length, writerScoped: pool.writerScopedCount, beatFallback: pool.beatFallbackCount },
      clusters: evaluated,
      lastRun: lastRun || null,
    });
  }

  const data = { writers: results, generatedAt: new Date().toISOString() };
  pipelineCache.data = data;
  pipelineCache.ts = now;
  pipelineCache.tenantId = req.tenantId;
  res.json(data);
}));

// GET /api/synthesis/history — recent synthesis runs and generated articles
router.get('/history', requirePermission('synthesis.execute'), asyncHandler(async (req, res) => {
  const runs = await db.prepare(`
    SELECT id, job_name, started_at, finished_at, status, summary FROM cron_runs
    WHERE tenant_id = $1 AND job_name IN ('synthesis', 'deep-dive')
    ORDER BY started_at DESC LIMIT 20
  `).all(req.tenantId);

  const recentArticles = await db.prepare(`
    SELECT id, title, slug, category, content_type, writer_id, status, editorial_score, created_at
    FROM articles
    WHERE tenant_id = $1 AND content_type IN ('original', 'deep-dive')
    ORDER BY created_at DESC LIMIT 30
  `).all(req.tenantId);

  res.json({ runs, recentArticles });
}));

// GET /api/synthesis/watchlist — list all watchlist entries for tenant
router.get('/watchlist', requirePermission('synthesis.execute'), asyncHandler(async (req, res) => {
  const entries = await db.prepare('SELECT * FROM synthesis_watchlist WHERE tenant_id = $1 ORDER BY type, keyword').all(req.tenantId);
  res.json(entries);
}));

// POST /api/synthesis/watchlist — add a watchlist entry
router.post('/watchlist', requirePermission('synthesis.execute'), asyncHandler(async (req, res) => {
  const { keyword, type } = req.body;
  if (!keyword || !keyword.trim()) return res.status(400).json({ error: 'keyword is required' });
  if (!['wanted', 'blocked'].includes(type)) return res.status(400).json({ error: 'type must be "wanted" or "blocked"' });

  const row = await db.prepare(
    `INSERT INTO synthesis_watchlist (tenant_id, keyword, type, created_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, keyword, type) DO NOTHING RETURNING *`
  ).get(req.tenantId, keyword.trim().toLowerCase(), type, req.userId);

  if (!row) return res.status(409).json({ error: 'Entry already exists' });
  res.json(row);
}));

// DELETE /api/synthesis/watchlist/:id — remove a watchlist entry
router.delete('/watchlist/:id', requirePermission('synthesis.execute'), asyncHandler(async (req, res) => {
  const deleted = await db.prepare(
    'DELETE FROM synthesis_watchlist WHERE id = $1 AND tenant_id = $2 RETURNING id'
  ).get(req.params.id, req.tenantId);
  if (!deleted) return res.status(404).json({ error: 'Not found' });
  res.json({ deleted: true });
}));

// GET /api/synthesis/forecasts — list recent forecasts for tenant
router.get('/forecasts', requirePermission('synthesis.execute'), asyncHandler(async (req, res) => {
  const forecasts = await db.prepare(`
    SELECT sf.*, w.name AS writer_name FROM synthesis_forecasts sf
    JOIN writers w ON w.id = sf.writer_id
    WHERE sf.tenant_id = $1
    ORDER BY sf.forecast_at DESC LIMIT 20
  `).all(req.tenantId);
  res.json(forecasts);
}));

// GET /api/synthesis/forecasts/:writerId — latest forecast for a specific writer
router.get('/forecasts/:writerId', requirePermission('synthesis.execute'), asyncHandler(async (req, res) => {
  const forecast = await getLatestForecast(req.params.writerId, req.tenantId);
  if (!forecast) return res.json(null);

  const writer = await db.prepare('SELECT name FROM writers WHERE id = $1 AND tenant_id = $2').get(req.params.writerId, req.tenantId);
  res.json({ ...forecast, writer_name: writer?.name });
}));

// POST /api/synthesis/forecasts/:writerId — manually trigger a forecast for a writer
router.post('/forecasts/:writerId', requirePermission('synthesis.execute'), asyncHandler(async (req, res) => {
  const forecast = await generateForecast(req.params.writerId, req.tenantId);
  if (!forecast) return res.status(404).json({ error: 'Writer not found' });
  res.json(forecast);
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
