/**
 * Deep Feed AI Admin — GET /api/ai-usage
 * Dashboard API for AI cost tracking and budget monitoring.
 * All endpoints require admin auth.
 */
const express = require('express');
const router  = express.Router();
const { getPool } = require('../db');
const { asyncHandler } = require('../lib/utils');
const { getTodaySpend, getMonthlySpend } = require('../lib/ai-usage');

// GET /api/ai-usage/summary?range=7d|30d|90d
router.get('/summary', asyncHandler(async (req, res) => {
  const pool = getPool();
  const range = req.query.range || '30d';
  const days = parseInt(range) || 30;
  const interval = `${days} days`;

  const [totals, byProvider, byOperation, byDay, recentErrors, budgetSettings] = await Promise.all([
    pool.query(`
      SELECT
        COALESCE(SUM(estimated_cost), 0)::NUMERIC(10,2) AS estimated_cost,
        COUNT(*)::INTEGER AS api_calls,
        COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) AS total_tokens,
        CASE WHEN COUNT(*) > 0
          THEN ROUND(COUNT(*) FILTER (WHERE success = true)::NUMERIC / COUNT(*) * 100, 1)
          ELSE 100 END AS success_rate
      FROM ai_usage WHERE created_at > NOW() - $1::INTERVAL
    `, [interval]),

    pool.query(`
      SELECT provider,
        COALESCE(SUM(estimated_cost), 0)::NUMERIC(10,4) AS cost,
        COUNT(*)::INTEGER AS calls
      FROM ai_usage WHERE created_at > NOW() - $1::INTERVAL
      GROUP BY provider ORDER BY cost DESC
    `, [interval]),

    pool.query(`
      SELECT operation,
        COALESCE(SUM(estimated_cost), 0)::NUMERIC(10,4) AS cost,
        COUNT(*)::INTEGER AS calls
      FROM ai_usage WHERE created_at > NOW() - $1::INTERVAL
      GROUP BY operation ORDER BY cost DESC
    `, [interval]),

    pool.query(`
      SELECT DATE(created_at) AS day,
        COALESCE(SUM(estimated_cost), 0)::NUMERIC(10,4) AS cost,
        COUNT(*)::INTEGER AS calls
      FROM ai_usage WHERE created_at > NOW() - $1::INTERVAL
      GROUP BY DATE(created_at) ORDER BY day
    `, [interval]),

    pool.query(`
      SELECT operation, error_message AS error, created_at
      FROM ai_usage
      WHERE success = false AND created_at > NOW() - $1::INTERVAL
      ORDER BY created_at DESC LIMIT 20
    `, [interval]),

    pool.query(`
      SELECT key, value FROM settings
      WHERE key IN ('ai_daily_budget', 'ai_monthly_budget', 'ai_budget_warn_pct')
    `),
  ]);

  // Parse budget settings
  const settings = {};
  for (const row of budgetSettings.rows) settings[row.key] = row.value;
  const monthlyBudget = parseFloat(settings.ai_monthly_budget) || 50;
  const monthlySpend = await getMonthlySpend();
  const todaySpend = await getTodaySpend();

  // Project monthly spend based on daily average
  const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  const dayOfMonth = new Date().getDate();
  const projectedMonthly = dayOfMonth > 0 ? (monthlySpend / dayOfMonth) * daysInMonth : 0;

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
    },
  });
}));

// GET /api/ai-usage/by-article?slug=<slug>
router.get('/by-article', asyncHandler(async (req, res) => {
  const { slug } = req.query;
  if (!slug) return res.status(400).json({ error: 'slug param required' });

  const pool = getPool();
  const rows = await pool.query(`
    SELECT provider, model, operation, trigger,
      input_tokens, output_tokens, characters, image_count, email_count,
      estimated_cost, duration_ms, success, error_message, created_at
    FROM ai_usage WHERE article_slug = $1
    ORDER BY created_at DESC
  `, [slug]);

  const total = await pool.query(`
    SELECT COALESCE(SUM(estimated_cost), 0)::NUMERIC(10,4) AS total_cost,
      COUNT(*)::INTEGER AS total_calls
    FROM ai_usage WHERE article_slug = $1
  `, [slug]);

  res.json({ slug, ...total.rows[0], calls: rows.rows });
}));

// GET /api/ai-usage/recent?limit=50
router.get('/recent', asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const pool = getPool();
  const rows = await pool.query(`
    SELECT id, provider, model, operation, article_slug, writer_id, trigger,
      input_tokens, output_tokens, characters, image_count, email_count,
      estimated_cost, duration_ms, success, error_message, created_at
    FROM ai_usage ORDER BY created_at DESC LIMIT $1
  `, [limit]);
  res.json(rows.rows);
}));

module.exports = router;
