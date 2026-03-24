/**
 * Deep Feed AI — /api/admin/metrics
 * Cross-tenant aggregation endpoints for platform dashboard.
 * All routes require platform-admin JWT.
 */
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { asyncHandler } = require('../lib/utils');
const { auth } = require('../middleware/auth');
const { requirePlatformAdmin } = require('../middleware/permissions');

router.use(auth, requirePlatformAdmin);

function parseRange(range) {
  const days = range === '7d' ? 7 : range === '90d' ? 90 : 30;
  return { days, interval: `${days} days` };
}

// GET /dashboard — lightweight data for enhanced dashboard charts
router.get('/dashboard', asyncHandler(async (req, res) => {
  const { interval } = parseRange(req.query.range);

  const [dailyArticles, dailyAiSpend] = await Promise.all([
    db.prepare(`
      SELECT date_trunc('day', a.published_at)::date AS day, COUNT(*) AS count
      FROM articles a
      JOIN tenants t ON t.id = a.tenant_id
      WHERE t.status != 'deleted' AND a.published_at >= NOW() - $1::interval AND a.is_published = 1
      GROUP BY day ORDER BY day
    `).all(interval),
    db.prepare(`
      SELECT date_trunc('day', u.created_at)::date AS day, COALESCE(SUM(u.estimated_cost), 0) AS cost
      FROM ai_usage u
      JOIN tenants t ON t.id = u.tenant_id
      WHERE t.status != 'deleted' AND u.created_at >= NOW() - $1::interval
      GROUP BY day ORDER BY day
    `).all(interval),
  ]);

  res.json({
    daily_articles: dailyArticles.map(r => ({ day: r.day, count: parseInt(r.count) })),
    daily_ai_spend: dailyAiSpend.map(r => ({ day: r.day, cost: parseFloat(r.cost) })),
  });
}));

// GET /health — per-tenant health scores
router.get('/health', asyncHandler(async (req, res) => {
  const tenants = await db.prepare(`
    SELECT t.id, t.uuid, t.slug, t.display_name, t.plan, t.is_platform
    FROM tenants t WHERE t.status = 'active'
    ORDER BY t.display_name
  `).all();

  const planLimits = await db.prepare('SELECT * FROM plan_limits').all();
  const limitsMap = Object.fromEntries(planLimits.map(p => [p.plan, p]));

  const health = [];
  for (const t of tenants) {
    const limits = limitsMap[t.plan] || {};

    // Quota: articles this month, AI spend, credits, storage
    const [artCount, aiSpend, creditsRow, storage] = await Promise.all([
      db.prepare("SELECT COUNT(*) AS cnt FROM articles WHERE tenant_id = $1 AND published_at >= date_trunc('month', NOW())").get(t.id),
      db.prepare("SELECT COALESCE(SUM(estimated_cost), 0) AS cost FROM ai_usage WHERE tenant_id = $1 AND created_at >= date_trunc('month', NOW())").get(t.id),
      db.prepare("SELECT COALESCE(SUM(credits_used), 0) AS used FROM ai_usage WHERE tenant_id = $1 AND created_at >= date_trunc('month', NOW())").get(t.id),
      db.prepare("SELECT bytes_used FROM tenant_storage_usage WHERE tenant_id = $1").get(t.id),
    ]);

    const quotas = [];
    if (limits.max_ai_cost_month && parseFloat(limits.max_ai_cost_month) > 0) quotas.push(parseFloat(aiSpend.cost) / parseFloat(limits.max_ai_cost_month) * 100);
    if (limits.max_credits_month && parseInt(limits.max_credits_month) > 0) quotas.push(parseInt(creditsRow.used) / parseInt(limits.max_credits_month) * 100);
    if (limits.max_storage_mb) quotas.push((parseInt(storage?.bytes_used || 0) / (limits.max_storage_mb * 1024 * 1024)) * 100);
    const quotaPct = quotas.length > 0 ? Math.max(...quotas) : 0;

    // Last cron status
    const lastCron = await db.prepare(
      "SELECT status FROM cron_runs WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT 1"
    ).get(t.id);
    const cronOk = !lastCron || lastCron.status === 'success';

    // Last activity
    const lastEvent = await db.prepare(
      "SELECT created_at FROM analytics_events WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1"
    ).get(t.id);
    const lastActivity = lastEvent?.created_at || null;
    const hoursSinceActivity = lastActivity ? (Date.now() - new Date(lastActivity).getTime()) / 3600000 : 999;

    let status = 'green';
    if (quotaPct > 95 || !cronOk) status = 'red';
    else if (quotaPct > 80 || hoursSinceActivity > 48) status = 'yellow';

    health.push({
      uuid: t.uuid, slug: t.slug, display_name: t.display_name,
      plan: t.plan, is_platform: t.is_platform,
      quota_pct: Math.round(quotaPct),
      cron_ok: cronOk,
      last_activity: lastActivity,
      status,
    });
  }

  res.json({ tenants: health });
}));

// GET /analytics — cross-tenant content analytics
router.get('/analytics', asyncHandler(async (req, res) => {
  const { interval } = parseRange(req.query.range);

  const [totals, byDay, byCategory, topArticles, byTenant] = await Promise.all([
    db.prepare(`
      SELECT
        COUNT(*) FILTER (WHERE event_type = 'view') AS views,
        COUNT(*) FILTER (WHERE event_type = 'audio_play') AS audio_plays,
        COUNT(*) FILTER (WHERE event_type = 'share') AS shares
      FROM analytics_events e
      JOIN tenants t ON t.id = e.tenant_id
      WHERE t.status != 'deleted' AND e.created_at >= NOW() - $1::interval
    `).get(interval),
    db.prepare(`
      SELECT date_trunc('day', e.created_at)::date AS day, COUNT(*) AS views
      FROM analytics_events e
      JOIN tenants t ON t.id = e.tenant_id
      WHERE t.status != 'deleted' AND e.event_type = 'view' AND e.created_at >= NOW() - $1::interval
      GROUP BY day ORDER BY day
    `).all(interval),
    db.prepare(`
      SELECT e.category, COUNT(*) AS views
      FROM analytics_events e
      JOIN tenants t ON t.id = e.tenant_id
      WHERE t.status != 'deleted' AND e.event_type = 'view' AND e.category IS NOT NULL AND e.created_at >= NOW() - $1::interval
      GROUP BY e.category ORDER BY views DESC LIMIT 15
    `).all(interval),
    db.prepare(`
      SELECT e.article_slug AS slug,
             COUNT(*) FILTER (WHERE e.event_type = 'view') AS views,
             COUNT(*) FILTER (WHERE e.event_type = 'audio_play') AS audio_plays,
             COUNT(*) FILTER (WHERE e.event_type = 'share') AS shares
      FROM analytics_events e
      JOIN tenants t ON t.id = e.tenant_id
      WHERE t.status != 'deleted' AND e.article_slug IS NOT NULL AND e.created_at >= NOW() - $1::interval
      GROUP BY e.article_slug ORDER BY views DESC LIMIT 10
    `).all(interval),
    db.prepare(`
      SELECT t.uuid, t.slug, t.display_name, t.plan,
             COUNT(*) FILTER (WHERE e.event_type = 'view') AS views,
             COUNT(*) FILTER (WHERE e.event_type = 'share') AS shares
      FROM analytics_events e
      JOIN tenants t ON t.id = e.tenant_id
      WHERE t.status != 'deleted' AND e.created_at >= NOW() - $1::interval
      GROUP BY t.uuid, t.slug, t.display_name, t.plan
      ORDER BY views DESC
    `).all(interval),
  ]);

  res.json({
    totals: {
      views: parseInt(totals.views),
      audio_plays: parseInt(totals.audio_plays),
      shares: parseInt(totals.shares),
    },
    by_day: byDay.map(r => ({ day: r.day, views: parseInt(r.views) })),
    by_category: byCategory.map(r => ({ category: r.category, views: parseInt(r.views) })),
    top_articles: topArticles.map(r => ({
      slug: r.slug, views: parseInt(r.views),
      audio_plays: parseInt(r.audio_plays), shares: parseInt(r.shares),
    })),
    by_tenant: byTenant.map(r => ({
      uuid: r.uuid, slug: r.slug, display_name: r.display_name, plan: r.plan,
      views: parseInt(r.views), shares: parseInt(r.shares),
    })),
  });
}));

// GET /ai-costs — cross-tenant AI cost analytics
router.get('/ai-costs', asyncHandler(async (req, res) => {
  const { days, interval } = parseRange(req.query.range);

  const [totals, byProvider, byOperation, byDay, byTenant, recentErrors] = await Promise.all([
    db.prepare(`
      SELECT
        COALESCE(SUM(estimated_cost), 0) AS cost,
        COUNT(*) AS calls,
        COUNT(*) FILTER (WHERE success = true) AS successes,
        COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) AS total_tokens
      FROM ai_usage u
      JOIN tenants t ON t.id = u.tenant_id
      WHERE t.status != 'deleted' AND u.created_at >= NOW() - $1::interval
    `).get(interval),
    db.prepare(`
      SELECT provider, COALESCE(SUM(estimated_cost), 0) AS cost, COUNT(*) AS calls
      FROM ai_usage u
      JOIN tenants t ON t.id = u.tenant_id
      WHERE t.status != 'deleted' AND u.created_at >= NOW() - $1::interval
      GROUP BY provider ORDER BY cost DESC
    `).all(interval),
    db.prepare(`
      SELECT operation, COALESCE(SUM(estimated_cost), 0) AS cost, COUNT(*) AS calls
      FROM ai_usage u
      JOIN tenants t ON t.id = u.tenant_id
      WHERE t.status != 'deleted' AND u.created_at >= NOW() - $1::interval
      GROUP BY operation ORDER BY cost DESC
    `).all(interval),
    db.prepare(`
      SELECT date_trunc('day', u.created_at)::date AS day,
             COALESCE(SUM(estimated_cost), 0) AS cost, COUNT(*) AS calls
      FROM ai_usage u
      JOIN tenants t ON t.id = u.tenant_id
      WHERE t.status != 'deleted' AND u.created_at >= NOW() - $1::interval
      GROUP BY day ORDER BY day
    `).all(interval),
    db.prepare(`
      SELECT t.uuid, t.slug, t.display_name, t.plan,
             COALESCE(SUM(u.estimated_cost), 0) AS cost,
             COALESCE(SUM(u.credits_used), 0) AS credits_used,
             COUNT(*) AS calls,
             COUNT(*) FILTER (WHERE u.success = true) AS successes
      FROM ai_usage u
      JOIN tenants t ON t.id = u.tenant_id
      WHERE t.status != 'deleted' AND u.created_at >= NOW() - $1::interval
      GROUP BY t.uuid, t.slug, t.display_name, t.plan
      ORDER BY cost DESC
    `).all(interval),
    db.prepare(`
      SELECT u.operation, u.error_message, u.provider, u.created_at
      FROM ai_usage u
      JOIN tenants t ON t.id = u.tenant_id
      WHERE t.status != 'deleted' AND u.success = false AND u.created_at >= NOW() - $1::interval
      ORDER BY u.created_at DESC LIMIT 20
    `).all(interval),
  ]);

  const totalCost = parseFloat(totals.cost);
  const totalCalls = parseInt(totals.calls);
  const successRate = totalCalls > 0 ? (parseInt(totals.successes) / totalCalls * 100) : 100;
  const dailyAvg = days > 0 ? totalCost / days : 0;
  const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  const projected = dailyAvg * daysInMonth;

  res.json({
    totals: { cost: totalCost, calls: totalCalls, success_rate: Math.round(successRate * 10) / 10, projected: Math.round(projected * 100) / 100 },
    by_provider: byProvider.map(r => ({ provider: r.provider, cost: parseFloat(r.cost), calls: parseInt(r.calls) })),
    by_operation: byOperation.map(r => ({ operation: r.operation, cost: parseFloat(r.cost), calls: parseInt(r.calls) })),
    by_day: byDay.map(r => ({ day: r.day, cost: parseFloat(r.cost), calls: parseInt(r.calls) })),
    by_tenant: byTenant.map(r => ({
      uuid: r.uuid, slug: r.slug, display_name: r.display_name, plan: r.plan,
      cost: parseFloat(r.cost), credits_used: parseInt(r.credits_used) || 0,
      calls: parseInt(r.calls),
      success_rate: parseInt(r.calls) > 0 ? Math.round(parseInt(r.successes) / parseInt(r.calls) * 1000) / 10 : 100,
    })),
    recent_errors: recentErrors,
  });
}));

module.exports = router;
