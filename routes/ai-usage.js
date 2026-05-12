/**
 * Deep Feed AI Admin — GET /api/ai-usage
 * Dashboard API for AI credit and token usage tracking.
 * All endpoints require admin auth.
 */
const express = require('express');
const router  = express.Router();
const elevenlabs = require('../lib/providers/elevenlabs');
const db      = require('../db');
const { getPool } = require('../db');
const { requirePermission } = require('../middleware/permissions');
const { asyncHandler } = require('../lib/utils');
const { getTodaySpend, getMonthlySpend, getTodayCredits, getMonthlyCredits } = require('../lib/ai-usage');
const { getAppConfig } = require('../lib/app-config');
const { getBonusCredits } = require('../lib/promo');
const { getPurchasedCreditsBalance } = require('../lib/credits');
const { getPlanInfo } = require('../lib/plan-limits');

// GET /api/ai-usage/summary?range=7d|30d|90d
router.get('/summary', requirePermission('analytics.read'), asyncHandler(async (req, res) => {
  const pool = getPool();
  const range = req.query.range || '30d';
  const days = parseInt(range) || 30;
  const interval = `${days} days`;

  const tenantId = req.tenantId;
  const [
    totals,
    byProvider,
    byModel,
    byOperation,
    byType,
    byDay,
    byokSplit,
    cacheStats,
    recentErrors,
    budgetSettings,
    efficiency,
  ] = await Promise.all([

    // ── Totals ───────────────────────────────────────────────────────────
    pool.query(`
      SELECT
        COALESCE(SUM(estimated_cost), 0)::NUMERIC(10,6) AS estimated_cost,
        COALESCE(SUM(credits_used), 0)::INTEGER AS total_credits,
        COUNT(*)::INTEGER AS api_calls,
        COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) AS total_tokens,
        CASE WHEN COUNT(*) > 0
          THEN ROUND(COUNT(*) FILTER (WHERE success = true)::NUMERIC / COUNT(*) * 100, 1)
          ELSE 100 END AS success_rate
      FROM ai_usage WHERE tenant_id = $1 AND created_at > NOW() - $2::INTERVAL
    `, [tenantId, interval]),

    // ── By provider (top-level) ──────────────────────────────────────────
    pool.query(`
      SELECT provider,
        COALESCE(SUM(estimated_cost), 0)::NUMERIC(10,6) AS cost,
        COALESCE(SUM(credits_used), 0)::INTEGER AS credits,
        COUNT(*)::INTEGER AS calls
      FROM ai_usage WHERE tenant_id = $1 AND created_at > NOW() - $2::INTERVAL
      GROUP BY provider ORDER BY cost DESC
    `, [tenantId, interval]),

    // ── By provider + model ──────────────────────────────────────────────
    pool.query(`
      SELECT provider,
        COALESCE(model, 'unknown') AS model,
        COALESCE(SUM(estimated_cost), 0)::NUMERIC(10,6) AS cost,
        COALESCE(SUM(credits_used), 0)::INTEGER AS credits,
        COUNT(*)::INTEGER AS calls,
        COALESCE(SUM(input_tokens), 0)::INTEGER AS input_tokens,
        COALESCE(SUM(input_tokens_cached), 0)::INTEGER AS cached_tokens,
        COALESCE(SUM(output_tokens), 0)::INTEGER AS output_tokens
      FROM ai_usage WHERE tenant_id = $1 AND created_at > NOW() - $2::INTERVAL
      GROUP BY provider, model ORDER BY cost DESC
    `, [tenantId, interval]),

    // ── By operation ────────────────────────────────────────────────────
    pool.query(`
      SELECT operation,
        COALESCE(SUM(estimated_cost), 0)::NUMERIC(10,6) AS cost,
        COALESCE(SUM(credits_used), 0)::INTEGER AS credits,
        COUNT(*)::INTEGER AS calls
      FROM ai_usage WHERE tenant_id = $1 AND created_at > NOW() - $2::INTERVAL
      GROUP BY operation ORDER BY cost DESC
    `, [tenantId, interval]),

    // ── By media type (text / image / voice / search / email) ───────────
    pool.query(`
      SELECT
        CASE
          WHEN image_count > 0                          THEN 'image'
          WHEN characters  > 0                          THEN 'voice'
          WHEN email_count > 0                          THEN 'email'
          WHEN provider IN ('newsapi', 'brave')         THEN 'search'
          ELSE 'text'
        END AS media_type,
        COALESCE(SUM(estimated_cost), 0)::NUMERIC(10,6) AS cost,
        COALESCE(SUM(credits_used), 0)::INTEGER AS credits,
        COUNT(*)::INTEGER AS calls
      FROM ai_usage WHERE tenant_id = $1 AND created_at > NOW() - $2::INTERVAL
      GROUP BY 1 ORDER BY cost DESC
    `, [tenantId, interval]),

    // ── By day ──────────────────────────────────────────────────────────
    pool.query(`
      SELECT DATE(created_at) AS day,
        COALESCE(SUM(estimated_cost), 0)::NUMERIC(10,6) AS cost,
        COALESCE(SUM(credits_used), 0)::INTEGER AS credits,
        COUNT(*)::INTEGER AS calls
      FROM ai_usage WHERE tenant_id = $1 AND created_at > NOW() - $2::INTERVAL
      GROUP BY DATE(created_at) ORDER BY day
    `, [tenantId, interval]),

    // ── BYOK vs platform split ───────────────────────────────────────────
    pool.query(`
      SELECT
        COALESCE(SUM(estimated_cost) FILTER (WHERE is_byai = true),  0)::NUMERIC(10,6) AS byok_cost,
        COALESCE(SUM(estimated_cost) FILTER (WHERE is_byai IS NOT true), 0)::NUMERIC(10,6) AS platform_cost,
        COUNT(*) FILTER (WHERE is_byai = true)::INTEGER  AS byok_calls,
        COUNT(*) FILTER (WHERE is_byai IS NOT true)::INTEGER AS platform_calls,
        COALESCE(SUM(credits_used) FILTER (WHERE is_byai IS NOT true), 0)::INTEGER AS platform_credits
      FROM ai_usage WHERE tenant_id = $1 AND created_at > NOW() - $2::INTERVAL
    `, [tenantId, interval]),

    // ── Cache efficiency ─────────────────────────────────────────────────
    pool.query(`
      SELECT
        COALESCE(SUM(input_tokens_cached), 0)::INTEGER AS cached_tokens,
        COALESCE(SUM(input_tokens_fresh),  0)::INTEGER AS fresh_tokens,
        COALESCE(SUM(input_tokens),        0)::INTEGER AS total_input_tokens,
        COALESCE(SUM(output_tokens),       0)::INTEGER AS total_output_tokens
      FROM ai_usage WHERE tenant_id = $1 AND created_at > NOW() - $2::INTERVAL
    `, [tenantId, interval]),

    // ── Recent errors ────────────────────────────────────────────────────
    pool.query(`
      SELECT operation, error_message AS error, created_at
      FROM ai_usage
      WHERE tenant_id = $1 AND success = false AND created_at > NOW() - $2::INTERVAL
      ORDER BY created_at DESC LIMIT 20
    `, [tenantId, interval]),

    // ── Budget settings ──────────────────────────────────────────────────
    pool.query(`
      SELECT key, value FROM settings
      WHERE tenant_id = $1 AND key IN ('ai_daily_budget', 'ai_monthly_budget', 'ai_budget_warn_pct')
    `, [tenantId]),

    // ── Credit efficiency: credits per article, top expensive articles ───
    (async () => {
      const [articleCount, viewCount, topExpensive] = await Promise.all([
        pool.query(`
          SELECT COUNT(*)::INTEGER AS total FROM articles
          WHERE tenant_id = $1 AND status = 'published'
            AND created_at > NOW() - $2::INTERVAL
        `, [tenantId, interval]),
        pool.query(`
          SELECT COUNT(*)::INTEGER AS total FROM analytics_events
          WHERE tenant_id = $1 AND event_type = 'view'
            AND created_at > NOW() - $2::INTERVAL
        `, [tenantId, interval]).catch(() => ({ rows: [{ total: 0 }] })),
        pool.query(`
          SELECT article_slug AS slug,
            COALESCE(SUM(estimated_cost), 0)::NUMERIC(10,6) AS cost,
            COALESCE(SUM(credits_used), 0)::INTEGER AS credits,
            COUNT(*)::INTEGER AS calls
          FROM ai_usage
          WHERE tenant_id = $1 AND article_slug IS NOT NULL
            AND created_at > NOW() - $2::INTERVAL
          GROUP BY article_slug ORDER BY cost DESC LIMIT 5
        `, [tenantId, interval]),
      ]);
      return {
        published_articles: parseInt(articleCount.rows[0].total) || 0,
        total_views: parseInt(viewCount.rows[0].total) || 0,
        top_expensive_articles: topExpensive.rows,
      };
    })(),
  ]);

  // Parse budget settings
  const settings = {};
  for (const row of budgetSettings.rows) settings[row.key] = row.value;
  const monthlyBudget = parseFloat(settings.ai_monthly_budget) || 50;
  const monthlySpend = await getMonthlySpend(tenantId);
  const todaySpend = await getTodaySpend(tenantId);

  // Credit data
  const [creditsUsedToday, creditsUsedMonth, bonusCredits, purchasedBalance, planInfo] = await Promise.all([
    getTodayCredits(tenantId),
    getMonthlyCredits(tenantId),
    getBonusCredits(tenantId),
    getPurchasedCreditsBalance(tenantId),
    getPlanInfo(tenantId),
  ]);
  const planCreditsMonth = planInfo?.limits?.max_credits_month || 0;
  const planCreditsDay   = planInfo?.limits?.max_credits_day   || 0;
  const effectiveCreditsLimit = planCreditsMonth + bonusCredits;

  // Project monthly spend based on daily average
  const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  const dayOfMonth  = new Date().getDate();
  const projectedMonthly = dayOfMonth > 0 ? (monthlySpend / dayOfMonth) * daysInMonth : 0;

  // Cost & credit efficiency
  const totalCost    = parseFloat(totals.rows[0].estimated_cost) || 0;
  const totalCredits = parseInt(totals.rows[0].total_credits) || 0;
  const costPerArticle    = efficiency.published_articles > 0
    ? Math.round((totalCost / efficiency.published_articles) * 10000) / 10000 : 0;
  const creditsPerArticle = efficiency.published_articles > 0
    ? Math.round(totalCredits / efficiency.published_articles) : 0;

  // Cache efficiency — estimate cost saved
  const cs = cacheStats.rows[0] || {};
  const cachedTok  = parseInt(cs.cached_tokens)       || 0;
  const freshTok   = parseInt(cs.fresh_tokens)        || 0;
  const totalInput = parseInt(cs.total_input_tokens)  || 0;
  const cacheRate  = totalInput > 0 ? Math.round((cachedTok / totalInput) * 1000) / 10 : 0;
  // Rough cost-saved estimate: cached tokens cost ~25–50% less than fresh; use 60% discount as conservative avg
  const avgCostPerToken = totalInput > 0 && totalCost > 0
    ? totalCost / (totalInput + (parseInt(cs.total_output_tokens) || 0)) : 0;
  const costSavedEstimate = Math.round(cachedTok * avgCostPerToken * 0.6 * 1000000) / 1000000;

  // Anomaly: compare today's spend against the daily average of prior days in the
  // selected range (today excluded from the baseline to avoid self-reinforcing ratios).
  // Use total calendar days in the range minus 1 as the denominator so zero-spend days
  // are smoothed in — this prevents a spike on the first day of real usage triggering
  // a false anomaly by comparing against an artificially tiny average.
  const todayKey   = new Date().toISOString().slice(0, 10);
  const prevDayRows = byDay.rows.filter(r => r.day && String(r.day).slice(0, 10) !== todayKey);
  const prevSpend  = prevDayRows.reduce((sum, r) => sum + (parseFloat(r.cost) || 0), 0);
  const prevDaysCount = Math.max(1, days - 1); // calendar days before today in range
  const avgDailySpend = prevSpend / prevDaysCount;
  const anomalyFactor = avgDailySpend > 0 ? todaySpend / avgDailySpend : 0;

  const bk = byokSplit.rows[0] || {};

  res.json({
    period: {
      start: new Date(Date.now() - days * 86400000).toISOString().slice(0, 10),
      end:   new Date().toISOString().slice(0, 10),
      range,
    },
    totals: totals.rows[0],
    by_provider: byProvider.rows,
    by_model:    byModel.rows,
    by_operation: byOperation.rows,
    by_type:     byType.rows,
    by_day:      byDay.rows,
    byok: {
      byok_cost:        parseFloat(bk.byok_cost)      || 0,
      platform_cost:    parseFloat(bk.platform_cost)  || 0,
      byok_calls:       parseInt(bk.byok_calls)        || 0,
      platform_calls:   parseInt(bk.platform_calls)   || 0,
      platform_credits: parseInt(bk.platform_credits) || 0,
    },
    cache: {
      cached_tokens:  cachedTok,
      fresh_tokens:   freshTok,
      total_input:    totalInput,
      cache_rate:     cacheRate,
      cost_saved:     costSavedEstimate,
    },
    anomaly: {
      today_spend:    todaySpend,
      avg_daily:      Math.round(avgDailySpend * 10000) / 10000,
      factor:         Math.round(anomalyFactor * 10) / 10,
      is_anomaly:     anomalyFactor >= 2,
    },
    recent_errors: recentErrors.rows,
    budget: {
      daily_limit:              parseFloat(settings.ai_daily_budget) || 5,
      monthly_limit:            monthlyBudget,
      today_spend:              todaySpend,
      current_spend:            monthlySpend,
      percent_used:             monthlyBudget > 0 ? Math.round((monthlySpend / monthlyBudget) * 1000) / 10 : 0,
      projected_monthly:        Math.round(projectedMonthly * 100) / 100,
      credits_used_today:       creditsUsedToday,
      credits_used_month:       creditsUsedMonth,
      credits_limit_day:        planCreditsDay,
      credits_limit_month:      effectiveCreditsLimit,
      credits_bonus:            bonusCredits,
      credits_purchased_balance: purchasedBalance,
      credits_percent_used:     effectiveCreditsLimit > 0
        ? Math.round((creditsUsedMonth / effectiveCreditsLimit) * 1000) / 10 : 0,
    },
    efficiency: {
      cost_per_article:      costPerArticle,
      credits_per_article:   creditsPerArticle,
      published_articles:    efficiency.published_articles,
      total_views:           efficiency.total_views,
      top_expensive_articles: efficiency.top_expensive_articles,
    },
  });
}));

// GET /api/ai-usage/by-writer?range=7d|30d|90d
router.get('/by-writer', requirePermission('analytics.read'), asyncHandler(async (req, res) => {
  const pool = getPool();
  const range = req.query.range || '30d';
  const days = parseInt(range) || 30;

  const rows = await pool.query(`
    SELECT
      u.writer_id,
      w.name          AS writer_name,
      w.avatar_url,
      COALESCE(SUM(u.estimated_cost), 0)::NUMERIC(10,6)    AS cost,
      COALESCE(SUM(u.credits_used), 0)::INTEGER             AS credits,
      COUNT(*)::INTEGER                                     AS calls,
      COALESCE(SUM(u.input_tokens), 0)::INTEGER             AS input_tokens,
      COALESCE(SUM(u.input_tokens_cached), 0)::INTEGER      AS cached_tokens,
      COALESCE(SUM(u.output_tokens), 0)::INTEGER            AS output_tokens,
      COUNT(*) FILTER (WHERE u.is_byai = true)::INTEGER     AS byok_calls,
      COALESCE(SUM(u.estimated_cost) FILTER (WHERE u.is_byai = true), 0)::NUMERIC(10,6) AS byok_cost
    FROM ai_usage u
    LEFT JOIN writers w ON w.id = u.writer_id AND w.tenant_id = $1
    WHERE u.tenant_id = $1
      AND u.writer_id IS NOT NULL
      AND u.created_at > NOW() - $2::INTERVAL
    GROUP BY u.writer_id, w.name, w.avatar_url
    ORDER BY cost DESC
  `, [req.tenantId, `${days} days`]);

  res.json({ writers: rows.rows });
}));

// GET /api/ai-usage/by-article?slug=<slug>
router.get('/by-article', requirePermission('analytics.read'), asyncHandler(async (req, res) => {
  const { slug } = req.query;
  if (!slug) return res.status(400).json({ error: 'slug param required' });

  const pool = getPool();
  const rows = await pool.query(`
    SELECT provider, model, operation, trigger,
      input_tokens, input_tokens_cached, input_tokens_fresh, output_tokens,
      characters, image_count, email_count,
      estimated_cost, duration_ms, success, error_message, created_at, is_byai
    FROM ai_usage WHERE tenant_id = $1 AND article_slug = $2
    ORDER BY created_at DESC
  `, [req.tenantId, slug]);

  const total = await pool.query(`
    SELECT COALESCE(SUM(estimated_cost), 0)::NUMERIC(10,6) AS total_cost,
      COUNT(*)::INTEGER AS total_calls
    FROM ai_usage WHERE tenant_id = $1 AND article_slug = $2
  `, [req.tenantId, slug]);

  res.json({ slug, ...total.rows[0], calls: rows.rows });
}));

// GET /api/ai-usage/recent?limit=50&provider=&model=&operation=&is_byai=
router.get('/recent', requirePermission('analytics.read'), asyncHandler(async (req, res) => {
  const pool   = getPool();
  const limit  = Math.min(parseInt(req.query.limit) || 100, 500);
  const params = [req.tenantId];
  let where    = 'WHERE tenant_id = $1';

  if (req.query.provider) {
    params.push(req.query.provider);
    where += ` AND provider = $${params.length}`;
  }
  if (req.query.model) {
    params.push(req.query.model);
    where += ` AND model = $${params.length}`;
  }
  if (req.query.operation) {
    params.push(req.query.operation);
    where += ` AND operation = $${params.length}`;
  }
  if (req.query.is_byai === 'true') {
    where += ' AND is_byai = true';
  } else if (req.query.is_byai === 'false') {
    where += ' AND (is_byai IS NULL OR is_byai = false)';
  }

  params.push(limit);
  const rows = await pool.query(`
    SELECT id, provider, model, operation, article_slug, writer_id, trigger,
      input_tokens, input_tokens_cached, output_tokens, characters, image_count, email_count,
      estimated_cost, credits_used, duration_ms, success, error_message, is_byai, created_at
    FROM ai_usage ${where} ORDER BY created_at DESC LIMIT $${params.length}
  `, params);

  res.json(rows.rows);
}));

// GET /api/ai-usage/elevenlabs — proxy ElevenLabs subscription usage
router.get('/elevenlabs', requirePermission('analytics.read'), asyncHandler(async (req, res) => {
  const appCfg = await getAppConfig(req.tenantId);
  const apiKey = appCfg.elevenlabs_api_key;
  if (!apiKey) return res.json({ configured: false });

  const data = await elevenlabs.getSubscription({ apiKey });
  res.json({
    configured:      true,
    tier:            data.tier,
    status:          data.status,
    character_count: data.character_count,
    character_limit: data.character_limit,
    next_reset_unix: data.next_character_count_reset_unix,
    voice_slots_used: data.voice_slots_used,
    voice_limit:     data.voice_limit,
    billing_period:  data.character_refresh_period,
  });
}));

// GET /api/ai-usage/sessions?range=7d|30d|90d&limit=50&writerId=
router.get('/sessions', requirePermission('analytics.read'), asyncHandler(async (req, res) => {
  const pool = getPool();
  const days  = parseInt(req.query.range) || 30;
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const writerId = req.query.writerId ? parseInt(req.query.writerId) : null;

  const params = [req.tenantId, `${days} days`, limit];
  let writerFilter = '';
  if (writerId) {
    writerFilter = ` AND writer_id = $${params.length + 1}`;
    params.push(writerId);
  }

  const rows = await pool.query(`
    WITH sess AS (
      SELECT agent_session_id,
             MIN(created_at) AS started_at,
             MAX(created_at) AS ended_at,
             EXTRACT(EPOCH FROM (MAX(created_at) - MIN(created_at))) * 1000 AS duration_ms,
             COUNT(*)::int AS iterations,
             MAX(writer_id) AS writer_id,
             (array_agg(provider ORDER BY created_at))[1] AS first_provider,
             (array_agg(model    ORDER BY created_at))[1] AS first_model,
             array_agg(operation ORDER BY created_at) AS operations,
             COALESCE(SUM(input_tokens), 0)::int          AS total_input_tokens,
             COALESCE(SUM(input_tokens_cached), 0)::int   AS total_cached_tokens,
             COALESCE(SUM(output_tokens), 0)::int         AS total_output_tokens,
             COALESCE(SUM(estimated_cost), 0)::numeric(10,6) AS estimated_cost,
             COALESCE(SUM(credits_used), 0)::int          AS credits_used,
             BOOL_AND(success) AS all_success
      FROM ai_usage
      WHERE tenant_id = $1
        AND agent_session_id IS NOT NULL
        AND created_at > NOW() - $2::INTERVAL
        ${writerFilter}
      GROUP BY agent_session_id
      ORDER BY MIN(created_at) DESC
      LIMIT $3
    )
    SELECT s.*, w.name AS writer_name, w.avatar_url AS writer_avatar
    FROM sess s
    LEFT JOIN writers w ON w.id = s.writer_id AND w.tenant_id = $1
  `, params);

  res.json({ sessions: rows.rows });
}));

// GET /api/ai-usage/sessions/:id — per-iteration breakdown
router.get('/sessions/:id', requirePermission('analytics.read'), asyncHandler(async (req, res) => {
  const pool = getPool();
  const rows = await pool.query(`
    SELECT id, provider, model, operation, trigger,
           input_tokens, input_tokens_cached, input_tokens_fresh, output_tokens,
           estimated_cost, credits_used, duration_ms, success, error_message,
           created_at, writer_id, article_slug, is_byai
    FROM ai_usage
    WHERE tenant_id = $1 AND agent_session_id = $2
    ORDER BY created_at ASC
  `, [req.tenantId, req.params.id]);

  res.json({ iterations: rows.rows });
}));

module.exports = router;
