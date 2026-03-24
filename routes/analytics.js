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
  ]);

  res.json({
    range: req.query.range || '30d',
    totals: {
      views:           parseInt(totals.rows[0].total_views)   || 0,
      views_period:    parseInt(totals.rows[0].views_period)  || 0,
      audio_plays:     parseInt(periodAudio.rows[0].total)    || 0,
      shares:          parseInt(periodShares.rows[0].total)   || 0,
      views_prev:      parseInt(prevViews.rows[0].total)      || 0,
      audio_plays_prev: parseInt(prevAudio.rows[0].total)     || 0,
      shares_prev:     parseInt(prevShares.rows[0].total)     || 0,
    },
    by_day:       byDay.rows.map(r => ({ day: r.day, views: parseInt(r.views) })),
    top_articles: topArticles.rows.map(r => ({
      slug:        r.slug,
      title:       r.slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      category:    r.category || 'Unknown',
      views:       parseInt(r.views)       || 0,
      audio_plays: parseInt(r.audio_plays) || 0,
      shares:      parseInt(r.shares)      || 0,
    })),
    by_category: byCategory.rows.map(r => ({
      category: r.category,
      views:    parseInt(r.views) || 0,
    })),
  });
}));

module.exports = router;
