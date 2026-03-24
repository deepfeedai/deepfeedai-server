/**
 * Deep Feed AI Admin — GET /api/ai-usage
 * Dashboard API for AI credit and token usage tracking.
 * All endpoints require admin auth.
 */
const express = require('express');
const https   = require('https');
const router  = express.Router();
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
  const [totals, byProvider, byOperation, byDay, recentErrors, budgetSettings, efficiency] = await Promise.all([
    pool.query(`
      SELECT
        COALESCE(SUM(estimated_cost), 0)::NUMERIC(10,2) AS estimated_cost,
        COALESCE(SUM(credits_used), 0)::INTEGER AS total_credits,
        COUNT(*)::INTEGER AS api_calls,
        COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) AS total_tokens,
        CASE WHEN COUNT(*) > 0
          THEN ROUND(COUNT(*) FILTER (WHERE success = true)::NUMERIC / COUNT(*) * 100, 1)
          ELSE 100 END AS success_rate
      FROM ai_usage WHERE tenant_id = $1 AND created_at > NOW() - $2::INTERVAL
    `, [tenantId, interval]),

    pool.query(`
      SELECT provider,
        COALESCE(SUM(estimated_cost), 0)::NUMERIC(10,4) AS cost,
        COALESCE(SUM(credits_used), 0)::INTEGER AS credits,
        COUNT(*)::INTEGER AS calls
      FROM ai_usage WHERE tenant_id = $1 AND created_at > NOW() - $2::INTERVAL
      GROUP BY provider ORDER BY credits DESC
    `, [tenantId, interval]),

    pool.query(`
      SELECT operation,
        COALESCE(SUM(estimated_cost), 0)::NUMERIC(10,4) AS cost,
        COALESCE(SUM(credits_used), 0)::INTEGER AS credits,
        COUNT(*)::INTEGER AS calls
      FROM ai_usage WHERE tenant_id = $1 AND created_at > NOW() - $2::INTERVAL
      GROUP BY operation ORDER BY credits DESC
    `, [tenantId, interval]),

    pool.query(`
      SELECT DATE(created_at) AS day,
        COALESCE(SUM(estimated_cost), 0)::NUMERIC(10,4) AS cost,
        COALESCE(SUM(credits_used), 0)::INTEGER AS credits,
        COUNT(*)::INTEGER AS calls
      FROM ai_usage WHERE tenant_id = $1 AND created_at > NOW() - $2::INTERVAL
      GROUP BY DATE(created_at) ORDER BY day
    `, [tenantId, interval]),

    pool.query(`
      SELECT operation, error_message AS error, created_at
      FROM ai_usage
      WHERE tenant_id = $1 AND success = false AND created_at > NOW() - $2::INTERVAL
      ORDER BY created_at DESC LIMIT 20
    `, [tenantId, interval]),

    pool.query(`
      SELECT key, value FROM settings
      WHERE tenant_id = $1 AND key IN ('ai_daily_budget', 'ai_monthly_budget', 'ai_budget_warn_pct')
    `, [tenantId]),

    // Credit efficiency: credits per article, top articles by credit usage
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
        `, [tenantId, interval]),
        pool.query(`
          SELECT article_slug AS slug,
            COALESCE(SUM(estimated_cost), 0)::NUMERIC(10,4) AS cost,
            COALESCE(SUM(credits_used), 0)::INTEGER AS credits,
            COUNT(*)::INTEGER AS calls
          FROM ai_usage
          WHERE tenant_id = $1 AND article_slug IS NOT NULL
            AND created_at > NOW() - $2::INTERVAL
          GROUP BY article_slug ORDER BY credits DESC LIMIT 5
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
  const planCreditsDay = planInfo?.limits?.max_credits_day || 0;
  const effectiveCreditsLimit = planCreditsMonth + bonusCredits;

  // Project monthly spend based on daily average
  const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  const dayOfMonth = new Date().getDate();
  const projectedMonthly = dayOfMonth > 0 ? (monthlySpend / dayOfMonth) * daysInMonth : 0;

  // Cost & credit efficiency
  const totalCost = parseFloat(totals.rows[0].estimated_cost) || 0;
  const totalCredits = parseInt(totals.rows[0].total_credits) || 0;
  const costPerArticle = efficiency.published_articles > 0
    ? Math.round((totalCost / efficiency.published_articles) * 10000) / 10000 : 0;
  const creditsPerArticle = efficiency.published_articles > 0
    ? Math.round(totalCredits / efficiency.published_articles) : 0;

  res.json({
    period: {
      start: new Date(Date.now() - days * 86400000).toISOString().slice(0, 10),
      end: new Date().toISOString().slice(0, 10),
      range,
    },
    totals: totals.rows[0],
    by_provider: byProvider.rows,
    by_operation: byOperation.rows,
    by_day: byDay.rows,
    recent_errors: recentErrors.rows,
    budget: {
      daily_limit: parseFloat(settings.ai_daily_budget) || 5,
      monthly_limit: monthlyBudget,
      today_spend: todaySpend,
      current_spend: monthlySpend,
      percent_used: monthlyBudget > 0 ? Math.round((monthlySpend / monthlyBudget) * 1000) / 10 : 0,
      projected_monthly: Math.round(projectedMonthly * 100) / 100,
      credits_used_today: creditsUsedToday,
      credits_used_month: creditsUsedMonth,
      credits_limit_day: planCreditsDay,
      credits_limit_month: effectiveCreditsLimit,
      credits_bonus: bonusCredits,
      credits_purchased_balance: purchasedBalance,
      credits_percent_used: effectiveCreditsLimit > 0
        ? Math.round((creditsUsedMonth / effectiveCreditsLimit) * 1000) / 10 : 0,
    },
    efficiency: {
      cost_per_article: costPerArticle,
      credits_per_article: creditsPerArticle,
      published_articles: efficiency.published_articles,
      total_views: efficiency.total_views,
      top_expensive_articles: efficiency.top_expensive_articles,
    },
  });
}));

// GET /api/ai-usage/by-article?slug=<slug>
router.get('/by-article', requirePermission('analytics.read'), asyncHandler(async (req, res) => {
  const { slug } = req.query;
  if (!slug) return res.status(400).json({ error: 'slug param required' });

  const pool = getPool();
  const rows = await pool.query(`
    SELECT provider, model, operation, trigger,
      input_tokens, output_tokens, characters, image_count, email_count,
      estimated_cost, duration_ms, success, error_message, created_at
    FROM ai_usage WHERE tenant_id = $1 AND article_slug = $2
    ORDER BY created_at DESC
  `, [req.tenantId, slug]);

  const total = await pool.query(`
    SELECT COALESCE(SUM(estimated_cost), 0)::NUMERIC(10,4) AS total_cost,
      COUNT(*)::INTEGER AS total_calls
    FROM ai_usage WHERE tenant_id = $1 AND article_slug = $2
  `, [req.tenantId, slug]);

  res.json({ slug, ...total.rows[0], calls: rows.rows });
}));

// GET /api/ai-usage/recent?limit=50
router.get('/recent', requirePermission('analytics.read'), asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const pool = getPool();
  const rows = await pool.query(`
    SELECT id, provider, model, operation, article_slug, writer_id, trigger,
      input_tokens, output_tokens, characters, image_count, email_count,
      estimated_cost, duration_ms, success, error_message, created_at
    FROM ai_usage WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2
  `, [req.tenantId, limit]);
  res.json(rows.rows);
}));

// GET /api/ai-usage/elevenlabs — proxy ElevenLabs subscription usage
router.get('/elevenlabs', requirePermission('analytics.read'), asyncHandler(async (req, res) => {
  // Resolve API key via centralized config (settings table → env var)
  const appCfg = await getAppConfig(req.tenantId);
  const apiKey = appCfg.elevenlabs_api_key;

  if (!apiKey) return res.json({ configured: false });

  const data = await new Promise((resolve, reject) => {
    const req_ = https.request({
      hostname: 'api.elevenlabs.io',
      path: '/v1/user/subscription',
      method: 'GET',
      headers: { 'xi-api-key': apiKey },
    }, (resp) => {
      let raw = '';
      resp.on('data', c => raw += c);
      resp.on('end', () => {
        try {
          if (resp.statusCode >= 400) return reject(new Error(`ElevenLabs ${resp.statusCode}: ${raw.slice(0, 200)}`));
          resolve(JSON.parse(raw));
        } catch (e) { reject(e); }
      });
    });
    req_.on('error', reject);
    req_.setTimeout(8000, () => { req_.destroy(); reject(new Error('ElevenLabs timeout')); });
    req_.end();
  });

  res.json({
    configured: true,
    tier: data.tier,
    status: data.status,
    character_count: data.character_count,
    character_limit: data.character_limit,
    next_reset_unix: data.next_character_count_reset_unix,
    voice_slots_used: data.voice_slots_used,
    voice_limit: data.voice_limit,
    billing_period: data.character_refresh_period,
  });
}));

module.exports = router;
