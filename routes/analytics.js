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
    'INSERT INTO analytics_events (event_type, article_slug, category) VALUES ($1, $2, $3)',
    [type, slug || null, category || null]
  );

  res.json({ ok: true });
}));

// GET /api/analytics/summary
router.get('/summary', auth, asyncHandler(async (req, res) => {
  const pool = getPool();

  const [
    totals,
    byDay,
    topArticles,
    byCategory,
    audioPlays,
    shares,
  ] = await Promise.all([
    // All-time, 7d, 30d view counts
    pool.query(`
      SELECT
        COUNT(*)                                                          AS total_views,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')  AS views_7d,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') AS views_30d
      FROM analytics_events
      WHERE event_type = 'view'
    `),

    // Views per day for last 30 days
    pool.query(`
      SELECT
        DATE_TRUNC('day', created_at AT TIME ZONE 'UTC') AS day,
        COUNT(*) AS views
      FROM analytics_events
      WHERE event_type = 'view'
        AND created_at >= NOW() - INTERVAL '30 days'
      GROUP BY 1
      ORDER BY 1 ASC
    `),

    // Top 10 articles by views (all time)
    pool.query(`
      SELECT
        ae.article_slug                                           AS slug,
        ae.category,
        COUNT(*) FILTER (WHERE ae.event_type = 'view')           AS views,
        COUNT(*) FILTER (WHERE ae.event_type = 'audio_play')     AS audio_plays,
        COUNT(*) FILTER (WHERE ae.event_type = 'share')          AS shares,
        a.title
      FROM analytics_events ae
      LEFT JOIN articles a ON a.slug = ae.article_slug
      WHERE ae.article_slug IS NOT NULL
      GROUP BY ae.article_slug, ae.category, a.title
      ORDER BY views DESC
      LIMIT 10
    `),

    // Views by category (last 30 days)
    pool.query(`
      SELECT
        COALESCE(category, 'Unknown') AS category,
        COUNT(*) AS views
      FROM analytics_events
      WHERE event_type = 'view'
        AND created_at >= NOW() - INTERVAL '30 days'
      GROUP BY 1
      ORDER BY views DESC
    `),

    // Total audio plays
    pool.query(`
      SELECT COUNT(*) AS total FROM analytics_events WHERE event_type = 'audio_play'
    `),

    // Total shares
    pool.query(`
      SELECT COUNT(*) AS total FROM analytics_events WHERE event_type = 'share'
    `),
  ]);

  res.json({
    totals: {
      views:       parseInt(totals.rows[0].total_views)  || 0,
      views_7d:    parseInt(totals.rows[0].views_7d)     || 0,
      views_30d:   parseInt(totals.rows[0].views_30d)    || 0,
      audio_plays: parseInt(audioPlays.rows[0].total)    || 0,
      shares:      parseInt(shares.rows[0].total)        || 0,
    },
    by_day:       byDay.rows.map(r => ({ day: r.day, views: parseInt(r.views) })),
    top_articles: topArticles.rows.map(r => ({
      slug:        r.slug,
      title:       r.title || r.slug,
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
