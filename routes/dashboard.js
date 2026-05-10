/**
 * Deep Feed AI — /api/dashboard
 * Single-query dashboard stats endpoint for the admin dashboard.
 * Replaces the client-side article-fetching loop with server-side aggregation.
 */
const express  = require('express');
const router   = express.Router();
const { getPool } = require('../db');
const { asyncHandler } = require('../lib/utils');
const { auth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { getAppConfig } = require('../lib/app-config');

router.use(auth);

// GET /api/dashboard/stats — all counts, deltas, sparklines, writers, pitches
router.get('/stats', requirePermission('articles.read'), asyncHandler(async (req, res) => {
  const pool = getPool();
  const tid  = req.tenantId;

  const appCfg = await getAppConfig(tid).catch(() => ({}));

  const [
    articleRow,
    feedRow,
    sourcesRow,
    pitchRow,
    commissionRow,
    writerRows,
    aiSpendRows,
    sparklineRows,
    commentsRow,
    synthRow,
    recentRows,
    catRows,
    queueRow,
    scheduledRow,
    feedBacklogRow,
    topStoryRow,
    engagementRow,
  ] = await Promise.all([

    // ── Article stats (editorial: original/deep-dive) ────────────────────
    pool.query(`
      SELECT
        COUNT(*)                                                            AS total,
        COUNT(*) FILTER (WHERE is_published = 1)                           AS published,
        COUNT(*) FILTER (WHERE is_published = 0 AND (status IS NULL OR status NOT IN ('review'))) AS drafts,
        COUNT(*) FILTER (WHERE status = 'review')                          AS in_review,
        COUNT(*) FILTER (WHERE is_published = 1
          AND published_at >= NOW() - INTERVAL '1 day')                    AS today,
        COUNT(*) FILTER (WHERE is_published = 1
          AND published_at >= NOW() - INTERVAL '2 days'
          AND published_at <  NOW() - INTERVAL '1 day')                    AS yesterday,
        COUNT(*) FILTER (WHERE is_published = 1
          AND published_at >= NOW() - INTERVAL '7 days')                   AS this_week,
        COUNT(*) FILTER (WHERE is_published = 1
          AND published_at >= NOW() - INTERVAL '14 days'
          AND published_at <  NOW() - INTERVAL '7 days')                   AS last_week,
        COUNT(*) FILTER (WHERE audio_status = 'ready' AND audio_url IS NOT NULL)           AS audio_ready,
        COUNT(*) FILTER (WHERE audio_status = 'ready' AND audio_url IS NOT NULL AND media_enabled = 1) AS audio_live,
        COUNT(*) FILTER (WHERE is_published = 1
          AND (audio_status IS NULL OR audio_status = 'error'))             AS no_audio_published,
        COUNT(*) FILTER (WHERE image_url IS NOT NULL)                      AS has_image,
        COUNT(*) FILTER (WHERE is_published = 1 AND image_url IS NULL)     AS missing_image_published,
        COUNT(*) FILTER (WHERE is_featured = 1)                            AS featured
      FROM articles
      WHERE tenant_id = $1
        AND is_archived = 0
        AND content_type IN ('original', 'deep-dive')
    `, [tid]),

    // ── Feed stats (curated) ─────────────────────────────────────────────
    pool.query(`
      SELECT
        COUNT(*)                                                            AS total,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '1 day')    AS today,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')   AS this_week
      FROM articles
      WHERE tenant_id = $1
        AND is_archived = 0
        AND (content_type IS NULL OR content_type = 'curated')
    `, [tid]),

    // ── Sources ──────────────────────────────────────────────────────────
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE is_active = 1) AS active,
        COUNT(*) FILTER (WHERE is_active = 0) AS inactive
      FROM sources WHERE tenant_id = $1
    `, [tid]),

    // ── Pending story pitches (writer agent → editor) ────────────────────
    pool.query(`
      SELECT COUNT(*)::int AS pending
      FROM story_pitches
      WHERE tenant_id = $1 AND status = 'pending'
    `, [tid]),

    // ── Proposed commissions (article_pitches awaiting action) ───────────
    pool.query(`
      SELECT COUNT(*)::int AS proposed
      FROM article_pitches
      WHERE tenant_id = $1 AND status = 'proposed'
    `, [tid]).catch(() => ({ rows: [{ proposed: 0 }] })),

    // ── Writers with 7-day article count + today count + budget ─────────
    pool.query(`
      SELECT
        w.id, w.name, w.avatar_url, w.beat, w.is_auto,
        w.daily_article_budget,
        (SELECT COUNT(*) FROM articles
         WHERE writer_id = w.id AND tenant_id = $1
           AND is_published = 1
           AND content_type IN ('original', 'deep-dive')
           AND published_at >= NOW() - INTERVAL '7 days'
        )::int AS article_count_7d,
        (SELECT COUNT(*) FROM articles
         WHERE writer_id = w.id AND tenant_id = $1
           AND content_type IN ('original', 'deep-dive')
           AND (is_published = 1 OR status = 'scheduled')
           AND created_at >= CURRENT_DATE
           AND created_at < CURRENT_DATE + INTERVAL '1 day'
        )::int AS article_count_today
      FROM writers w
      WHERE w.tenant_id = $1
      ORDER BY w.name ASC
    `, [tid]),

    // ── AI spend last 7 days (by day) ────────────────────────────────────
    pool.query(`
      SELECT
        date_trunc('day', created_at AT TIME ZONE 'UTC')::date AS day,
        COALESCE(SUM(estimated_cost), 0)::float                AS cost
      FROM ai_usage
      WHERE tenant_id = $1
        AND created_at >= NOW() - INTERVAL '7 days'
      GROUP BY day ORDER BY day ASC
    `, [tid]),

    // ── Published articles sparkline (7 days, editorial) ─────────────────
    pool.query(`
      SELECT
        date_trunc('day', published_at AT TIME ZONE 'UTC')::date AS day,
        COUNT(*)::int AS count
      FROM articles
      WHERE tenant_id = $1
        AND is_published = 1
        AND is_archived = 0
        AND content_type IN ('original', 'deep-dive')
        AND published_at >= NOW() - INTERVAL '7 days'
      GROUP BY day ORDER BY day ASC
    `, [tid]),

    // ── Comments ─────────────────────────────────────────────────────────
    pool.query(`
      SELECT
        COUNT(DISTINCT c.id)          AS total,
        COUNT(DISTINCT cr.comment_id) AS flagged,
        COUNT(DISTINCT c.user_id)     AS unique_users
      FROM comments c
      LEFT JOIN comment_reports cr ON cr.comment_id = c.id AND cr.tenant_id = $1
      WHERE c.tenant_id = $1 AND c.is_deleted = 0
    `, [tid]),

    // ── Synthesis last run ────────────────────────────────────────────────
    pool.query(`
      SELECT started_at, finished_at, status, summary
      FROM cron_runs
      WHERE tenant_id = $1
        AND job_name IN ('synthesis', 'auto-synthesis', 'daily-synthesis')
      ORDER BY started_at DESC
      LIMIT 1
    `, [tid]),

    // ── Recent articles (12, editorial) ──────────────────────────────────
    pool.query(`
      SELECT
        a.id, a.title, a.category, a.status, a.is_published, a.is_featured,
        a.image_url, a.audio_url, a.audio_status, a.media_enabled,
        a.created_at, a.published_at, a.content_type,
        w.name AS writer_name, w.avatar_url AS writer_avatar
      FROM articles a
      LEFT JOIN writers w ON w.id = a.writer_id
      WHERE a.tenant_id = $1
        AND a.is_archived = 0
        AND a.content_type IN ('original', 'deep-dive')
      ORDER BY a.created_at DESC
      LIMIT 12
    `, [tid]),

    // ── Category breakdown ────────────────────────────────────────────────
    pool.query(`
      SELECT category, COUNT(*)::int AS count
      FROM articles
      WHERE tenant_id = $1
        AND is_archived = 0
        AND content_type IN ('original', 'deep-dive')
      GROUP BY category
      ORDER BY count DESC
    `, [tid]),

    // ── Comment moderation queue (unapproved, not deleted) ───────────────
    pool.query(`
      SELECT COUNT(*)::int AS pending
      FROM comments
      WHERE tenant_id = $1
        AND is_deleted = 0
        AND (is_approved IS NULL OR is_approved = 0)
    `, [tid]).catch(() => ({ rows: [{ pending: 0 }] })),

    // ── Scheduled queue (articles queued for future drop) ────────────────
    pool.query(`
      SELECT
        COUNT(*)::int          AS count,
        MIN(publish_at)        AS next_at
      FROM articles
      WHERE tenant_id = $1
        AND status = 'scheduled'
        AND is_archived = 0
    `, [tid]).catch(() => ({ rows: [{ count: 0, next_at: null }] })),

    // ── Feed inbox backlog (raw unprocessed feed articles) ───────────────
    pool.query(`
      SELECT COUNT(*)::int AS count
      FROM articles
      WHERE tenant_id = $1
        AND is_archived = 0
        AND (content_type IS NULL OR content_type = 'curated')
        AND status = 'source'
    `, [tid]).catch(() => ({ rows: [{ count: 0 }] })),

    // ── Top story this week (by views + reactions) ───────────────────────
    pool.query(`
      SELECT
        a.id, a.title, a.slug, a.image_url, a.published_at,
        w.name AS writer_name,
        COALESCE(v.views, 0)      AS views,
        COALESCE(r.reactions, 0)  AS reactions
      FROM articles a
      LEFT JOIN writers w ON w.id = a.writer_id AND w.tenant_id = $1
      LEFT JOIN (
        SELECT article_slug, COUNT(*)::int AS views
        FROM analytics_events
        WHERE event_type = 'view' AND tenant_id = $1
          AND created_at >= NOW() - INTERVAL '7 days'
        GROUP BY article_slug
      ) v ON v.article_slug = a.slug
      LEFT JOIN (
        SELECT article_slug, COUNT(*)::int AS reactions
        FROM article_reactions
        WHERE tenant_id = $1
          AND created_at >= NOW() - INTERVAL '7 days'
        GROUP BY article_slug
      ) r ON r.article_slug = a.slug
      WHERE a.tenant_id = $1
        AND a.is_published = 1
        AND a.is_archived = 0
        AND a.content_type IN ('original', 'deep-dive')
        AND a.published_at >= NOW() - INTERVAL '7 days'
      ORDER BY (COALESCE(v.views, 0) + COALESCE(r.reactions, 0) * 3) DESC
      LIMIT 1
    `, [tid]).catch(() => ({ rows: [] })),

    // ── Engagement snapshot (reactions + comments today & this week) ─────
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE r.created_at >= NOW() - INTERVAL '1 day')  AS reactions_today,
        COUNT(*) FILTER (WHERE r.created_at >= NOW() - INTERVAL '7 days') AS reactions_week
      FROM article_reactions r
      WHERE r.tenant_id = $1
    `, [tid]).catch(() => ({ rows: [{ reactions_today: 0, reactions_week: 0 }] })),
  ]);

  const a = articleRow.rows[0];
  const f = feedRow.rows[0];
  const s = sourcesRow.rows[0];

  // Fill 7-day sparkline gaps so client always gets 7 entries
  function fillDays(rows, field, days = 7) {
    const map = {};
    rows.forEach(r => { map[r.day] = Number(r[field]); });
    const result = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setUTCHours(0, 0, 0, 0);
      d.setUTCDate(d.getUTCDate() - i);
      const key = d.toISOString().slice(0, 10);
      result.push({ day: key, value: map[key] || 0 });
    }
    return result;
  }

  res.json({
    articles: {
      total:                   Number(a.total),
      published:               Number(a.published),
      drafts:                  Number(a.drafts),
      in_review:               Number(a.in_review),
      today:                   Number(a.today),
      yesterday:               Number(a.yesterday),
      this_week:               Number(a.this_week),
      last_week:               Number(a.last_week),
      audio_ready:             Number(a.audio_ready),
      audio_live:              Number(a.audio_live),
      no_audio_published:      Number(a.no_audio_published),
      has_image:               Number(a.has_image),
      missing_image_published: Number(a.missing_image_published),
      featured:                Number(a.featured),
    },
    feed: {
      total:     Number(f.total),
      today:     Number(f.today),
      this_week: Number(f.this_week),
    },
    sources: {
      active:   Number(s.active),
      inactive: Number(s.inactive),
    },
    pitches: {
      pending:  Number(pitchRow.rows[0]?.pending  || 0),
      proposed: Number(commissionRow.rows[0]?.proposed || 0),
    },
    writers: writerRows.rows.map(w => ({
      id:                  w.id,
      name:                w.name,
      avatar_url:          w.avatar_url,
      beat:                w.beat,
      is_auto:             w.is_auto,
      article_count_7d:    w.article_count_7d,
      article_count_today: w.article_count_today,
      daily_article_budget: w.daily_article_budget,
    })),
    ai_spend: {
      week_total: aiSpendRows.rows.reduce((sum, r) => sum + Number(r.cost), 0),
      by_day:     fillDays(aiSpendRows.rows, 'cost'),
    },
    sparkline: fillDays(sparklineRows.rows, 'count'),
    comments: {
      total:        Number(commentsRow.rows[0]?.total || 0),
      flagged:      Number(commentsRow.rows[0]?.flagged || 0),
      unique_users: Number(commentsRow.rows[0]?.unique_users || 0),
      queue:        Number(queueRow.rows[0]?.pending || 0),
    },
    synthesis: synthRow.rows[0]
      ? {
          last_run_at:     synthRow.rows[0].started_at,
          last_finished_at: synthRow.rows[0].finished_at,
          status:          synthRow.rows[0].status,
          summary:         synthRow.rows[0].summary,
        }
      : null,
    categories: catRows.rows,
    recent_articles: recentRows.rows,
    scheduled: {
      count:   Number(scheduledRow.rows[0]?.count  || 0),
      next_at: scheduledRow.rows[0]?.next_at || null,
    },
    feed_backlog: Number(feedBacklogRow.rows[0]?.count || 0),
    top_story: topStoryRow.rows[0] || null,
    engagement: {
      reactions_today: Number(engagementRow.rows[0]?.reactions_today || 0),
      reactions_week:  Number(engagementRow.rows[0]?.reactions_week  || 0),
    },
    publish_cap: {
      cap:       appCfg.daily_publish_cap != null ? (parseInt(appCfg.daily_publish_cap, 10) || 0) : 6,
      burst:     parseInt(appCfg.daily_publish_burst, 10) || 0,
      today:     Number(a.today),
    },
    settings_incomplete: false,
  });
}));

module.exports = router;
