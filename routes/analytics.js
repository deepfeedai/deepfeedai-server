/**
 * Deep Feed AI Admin — Analytics routes
 *
 * POST /api/analytics/event  — public; records view/audio_play/share events
 * GET  /api/analytics/summary — auth required; returns dashboard aggregates
 */
const express                        = require('express');
const router                         = express.Router();
const { getPool }                    = require('../db');
const { auth }                       = require('../middleware/auth');
const { requirePermission }          = require('../middleware/permissions');
const { asyncHandler }               = require('../lib/utils');
const { getMonthlyCredits }         = require('../lib/ai-usage');
const { getBonusCredits }            = require('../lib/promo');
const { getPurchasedCreditsBalance } = require('../lib/credits');
const { getPlanInfo }                = require('../lib/plan-limits');

const VALID_TYPES   = new Set(['view', 'audio_play', 'share']);
const RATE_LIMIT_MS = 60 * 60 * 1000; // 1 hour per slug+type

// In-memory rate limit: "ip:type:slug" → timestamp
const _rl = new Map();
function isRateLimited(key) {
  const last = _rl.get(key);
  if (!last) return false;
  return (Date.now() - last) < RATE_LIMIT_MS;
}
function markSeen(key) {
  _rl.set(key, Date.now());
  // Prune old entries to avoid unbounded growth
  if (_rl.size > 50000) {
    const cutoff = Date.now() - RATE_LIMIT_MS;
    for (const [k, v] of _rl) { if (v < cutoff) _rl.delete(k); }
  }
}

// POST /api/analytics/event
router.post('/event', asyncHandler(async (req, res) => {
  const { type, slug, category } = req.body || {};

  if (!type || !VALID_TYPES.has(type)) {
    return res.status(400).json({ error: 'Invalid event type' });
  }

  const ip  = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
  const key = `${ip}:${type}:${slug || ''}`;

  if (isRateLimited(key)) {
    return res.status(429).json({ ok: false, reason: 'rate_limited' });
  }
  markSeen(key);

  await getPool().query(
    'INSERT INTO analytics_events (tenant_id, event_type, article_slug, category) VALUES ($1, $2, $3, $4)',
    [req.tenantId, type, slug || null, category || null]
  );

  // Broadcast to live feed SSE clients
  broadcastEvent(req.tenantId, {
    event_type: type,
    article_slug: slug || null,
    category: category || null,
    created_at: new Date().toISOString(),
  });

  res.json({ ok: true });
}));

// GET /api/analytics/summary
const VALID_RANGES = { '7d': 7, '30d': 30, '90d': 90 };

router.get('/summary', auth, requirePermission('analytics.read'), asyncHandler(async (req, res) => {
  const pool = getPool();
  const tenantId = req.tenantId;

  const rangeDays = VALID_RANGES[req.query.range] || 30;
  const rangeInterval = `${rangeDays} days`;
  const prevInterval = `${rangeDays * 2} days`;

  const [
    totals,
    byDay,
    topArticles,
    byCategory,
    periodAudio,
    periodShares,
    prevViews,
    prevAudio,
    prevShares,
    quotaData,
    heatmapData,
  ] = await Promise.all([
    // Views for current range
    pool.query(`
      SELECT
        COUNT(*)                                                                    AS total_views,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '${rangeInterval}')  AS views_period
      FROM analytics_events
      WHERE tenant_id = $1 AND event_type = 'view'
    `, [tenantId]),

    // Views per day for selected range
    pool.query(`
      SELECT
        DATE_TRUNC('day', created_at AT TIME ZONE 'UTC') AS day,
        COUNT(*) AS views
      FROM analytics_events
      WHERE tenant_id = $1 AND event_type = 'view'
        AND created_at >= NOW() - INTERVAL '${rangeInterval}'
      GROUP BY 1
      ORDER BY 1 ASC
    `, [tenantId]),

    // Top 10 articles by views within range
    pool.query(`
      SELECT
        ae.article_slug                                           AS slug,
        ae.category,
        COUNT(*) FILTER (WHERE ae.event_type = 'view')           AS views,
        COUNT(*) FILTER (WHERE ae.event_type = 'audio_play')     AS audio_plays,
        COUNT(*) FILTER (WHERE ae.event_type = 'share')          AS shares
      FROM analytics_events ae
      WHERE ae.tenant_id = $1 AND ae.article_slug IS NOT NULL
        AND ae.created_at >= NOW() - INTERVAL '${rangeInterval}'
      GROUP BY ae.article_slug, ae.category
      ORDER BY views DESC
      LIMIT 10
    `, [tenantId]),

    // Views by category within range
    pool.query(`
      SELECT
        COALESCE(category, 'Unknown') AS category,
        COUNT(*) AS views
      FROM analytics_events
      WHERE tenant_id = $1 AND event_type = 'view'
        AND created_at >= NOW() - INTERVAL '${rangeInterval}'
      GROUP BY 1
      ORDER BY views DESC
    `, [tenantId]),

    // Audio plays in current range
    pool.query(`
      SELECT COUNT(*) AS total FROM analytics_events
      WHERE tenant_id = $1 AND event_type = 'audio_play'
        AND created_at >= NOW() - INTERVAL '${rangeInterval}'
    `, [tenantId]),

    // Shares in current range
    pool.query(`
      SELECT COUNT(*) AS total FROM analytics_events
      WHERE tenant_id = $1 AND event_type = 'share'
        AND created_at >= NOW() - INTERVAL '${rangeInterval}'
    `, [tenantId]),

    // Previous period views (for delta)
    pool.query(`
      SELECT COUNT(*) AS total FROM analytics_events
      WHERE tenant_id = $1 AND event_type = 'view'
        AND created_at >= NOW() - INTERVAL '${prevInterval}'
        AND created_at < NOW() - INTERVAL '${rangeInterval}'
    `, [tenantId]),

    // Previous period audio plays (for delta)
    pool.query(`
      SELECT COUNT(*) AS total FROM analytics_events
      WHERE tenant_id = $1 AND event_type = 'audio_play'
        AND created_at >= NOW() - INTERVAL '${prevInterval}'
        AND created_at < NOW() - INTERVAL '${rangeInterval}'
    `, [tenantId]),

    // Previous period shares (for delta)
    pool.query(`
      SELECT COUNT(*) AS total FROM analytics_events
      WHERE tenant_id = $1 AND event_type = 'share'
        AND created_at >= NOW() - INTERVAL '${prevInterval}'
        AND created_at < NOW() - INTERVAL '${rangeInterval}'
    `, [tenantId]),

    // Quota usage: articles this month, plan limits, storage
    pool.query(`
      SELECT
        (SELECT COUNT(*) FROM articles WHERE tenant_id = $1
          AND created_at >= DATE_TRUNC('month', NOW())) AS articles_this_month,
        (SELECT pl.max_ai_cost_month FROM tenants t
          JOIN plan_limits pl ON pl.plan = t.plan WHERE t.id = $1) AS max_ai_cost,
        (SELECT pl.max_storage_mb FROM tenants t
          JOIN plan_limits pl ON pl.plan = t.plan WHERE t.id = $1) AS max_storage_mb,
        (SELECT COALESCE(SUM(estimated_cost), 0) FROM ai_usage WHERE tenant_id = $1
          AND created_at >= DATE_TRUNC('month', NOW())) AS ai_spend_this_month,
        (SELECT COALESCE(bytes_used, 0) FROM tenant_storage_usage WHERE tenant_id = $1) AS storage_bytes
    `, [tenantId]),

    // Heatmap: views by day-of-week × hour (last 30 days)
    pool.query(`
      SELECT
        EXTRACT(DOW FROM created_at AT TIME ZONE 'UTC')::int  AS dow,
        EXTRACT(HOUR FROM created_at AT TIME ZONE 'UTC')::int AS hour,
        COUNT(*)::int AS views
      FROM analytics_events
      WHERE tenant_id = $1 AND event_type = 'view'
        AND created_at >= NOW() - INTERVAL '30 days'
      GROUP BY 1, 2
    `, [tenantId]),
  ]);

  // Fetch 7-day mini trends for top articles
  const topSlugs = topArticles.rows.map(r => r.slug).filter(Boolean);
  let miniTrends = {};
  if (topSlugs.length) {
    const trendRows = await pool.query(`
      SELECT article_slug AS slug,
        DATE_TRUNC('day', created_at AT TIME ZONE 'UTC') AS day,
        COUNT(*) AS views
      FROM analytics_events
      WHERE tenant_id = $1 AND event_type = 'view'
        AND article_slug = ANY($2)
        AND created_at >= NOW() - INTERVAL '7 days'
      GROUP BY article_slug, DATE_TRUNC('day', created_at AT TIME ZONE 'UTC')
      ORDER BY 1, 2
    `, [tenantId, topSlugs]);
    for (const r of trendRows.rows) {
      if (!miniTrends[r.slug]) miniTrends[r.slug] = [];
      miniTrends[r.slug].push({ day: r.day, views: parseInt(r.views) });
    }
  }

  const viewsPeriod = parseInt(totals.rows[0].views_period) || 0;
  const audioPeriod = parseInt(periodAudio.rows[0].total)   || 0;
  const sharesPeriod = parseInt(periodShares.rows[0].total) || 0;

  // Quota
  const q = quotaData.rows[0] || {};
  const articlesUsed   = parseInt(q.articles_this_month) || 0;
  const aiSpendUsed    = parseFloat(q.ai_spend_this_month) || 0;
  const aiSpendLimit   = parseFloat(q.max_ai_cost) || 0;
  const storageMbUsed  = (parseInt(q.storage_bytes) || 0) / (1024 * 1024);
  const storageMbLimit = parseInt(q.max_storage_mb) || 0;

  // Credit quota
  const [creditsUsed, bonus, purchased, planInfo] = await Promise.all([
    getMonthlyCredits(tenantId),
    getBonusCredits(tenantId),
    getPurchasedCreditsBalance(tenantId),
    getPlanInfo(tenantId),
  ]);
  const planCredits = planInfo?.limits?.max_credits_month || 0;
  const creditsLimit = planCredits + bonus;
  const creditsPct = creditsLimit > 0 ? Math.round((creditsUsed / creditsLimit) * 1000) / 10 : 0;

  res.json({
    range: req.query.range || '30d',
    totals: {
      views:           parseInt(totals.rows[0].total_views) || 0,
      views_period:    viewsPeriod,
      audio_plays:     audioPeriod,
      shares:          sharesPeriod,
      views_prev:      parseInt(prevViews.rows[0].total)  || 0,
      audio_plays_prev: parseInt(prevAudio.rows[0].total) || 0,
      shares_prev:     parseInt(prevShares.rows[0].total) || 0,
    },
    engagement: {
      listen_rate: viewsPeriod > 0 ? Math.round((audioPeriod / viewsPeriod) * 1000) / 10 : 0,
      share_rate:  viewsPeriod > 0 ? Math.round((sharesPeriod / viewsPeriod) * 1000) / 10 : 0,
    },
    quota: {
      articles:    { used: articlesUsed },  // no limit enforced — credits are the throttle
      ai_spend:    { used: Math.round(aiSpendUsed * 100) / 100, limit: aiSpendLimit, pct: aiSpendLimit  > 0 ? Math.round((aiSpendUsed / aiSpendLimit) * 1000) / 10 : 0 },
      ai_credits:  { used: creditsUsed, limit: creditsLimit, bonus: bonus, purchased: purchased, pct: creditsPct },
      storage:     { used: Math.round(storageMbUsed * 10) / 10, limit: storageMbLimit, pct: storageMbLimit > 0 ? Math.round((storageMbUsed / storageMbLimit) * 1000) / 10 : 0 },
    },
    by_day:       byDay.rows.map(r => ({ day: r.day, views: parseInt(r.views) })),
    top_articles: topArticles.rows.map(r => ({
      slug:        r.slug,
      title:       r.slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      category:    r.category || 'Unknown',
      views:       parseInt(r.views)       || 0,
      audio_plays: parseInt(r.audio_plays) || 0,
      shares:      parseInt(r.shares)      || 0,
      mini_trend:  miniTrends[r.slug] || [],
    })),
    by_category: byCategory.rows.map(r => ({
      category: r.category,
      views:    parseInt(r.views) || 0,
    })),
    heatmap: heatmapData.rows.map(r => ({
      dow:   r.dow,
      hour:  r.hour,
      views: r.views,
    })),
  });
}));

// GET /api/analytics/live — SSE stream of recent events
// Supports ?token= query param for EventSource (no header support)
const _sseClients = new Map(); // tenantId → Set<res>

router.get('/live', (req, res, next) => {
  // Allow token via query param for SSE
  if (req.query.token && !req.headers.authorization) {
    req.headers.authorization = 'Bearer ' + req.query.token;
  }
  next();
}, auth, requirePermission('analytics.read'), (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write(':\n\n'); // SSE comment to establish connection

  const tenantId = req.tenantId;
  if (!_sseClients.has(tenantId)) _sseClients.set(tenantId, new Set());
  _sseClients.get(tenantId).add(res);

  req.on('close', () => {
    const clients = _sseClients.get(tenantId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) _sseClients.delete(tenantId);
    }
  });
});

// Broadcast new events to SSE clients (called from POST /event)
function broadcastEvent(tenantId, event) {
  const clients = _sseClients.get(tenantId);
  if (!clients || clients.size === 0) return;
  const data = JSON.stringify(event);
  for (const client of clients) {
    client.write(`data: ${data}\n\n`);
  }
}

// GET /api/analytics/recent — recent events for initial feed load
router.get('/recent', auth, requirePermission('analytics.read'), asyncHandler(async (req, res) => {
  const pool = getPool();
  const rows = await pool.query(`
    SELECT event_type, article_slug, category, created_at
    FROM analytics_events
    WHERE tenant_id = $1
    ORDER BY created_at DESC
    LIMIT 15
  `, [req.tenantId]);
  res.json(rows.rows);
}));

module.exports = router;
module.exports._broadcastEvent = broadcastEvent;
