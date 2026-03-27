/**
 * Deep Feed AI — lib/chat-system-prompt.js
 * System prompt and data query handlers for the AI chatbot.
 * Supports two contexts:
 *   - "platform" — platform admin managing all tenants
 *   - "portal"   — tenant admin managing their own site
 * The chatbot can fetch live data by including [QUERY:type] tags
 * in its response — the server resolves them and injects data back.
 */
'use strict';

const db = require('../db');
const { getTodaySpend, getMonthlySpend } = require('./ai-usage');

// ── System Prompt Builder ────────────────────────────────────────────

const SHARED_RULES = `## Rules
- Be concise and direct. Admins are technical users.
- Format numbers and currency clearly.
- Use markdown formatting for readability (bold, lists, code blocks).
- If you need data to answer accurately, use a query tag. Never fabricate statistics.
- If you don't know something or can't query it, say so honestly.
- Keep responses focused — don't over-explain obvious things.`;

/**
 * Build context-aware system prompt.
 * @param {'portal'|'platform'} source
 * @param {{ tenantName?: string, tenantSlug?: string, tenantPlan?: string }} tenantContext
 */
function buildSystemPrompt(source, tenantContext = {}) {
  if (source === 'portal') {
    return buildPortalPrompt(tenantContext);
  }
  return buildPlatformPrompt();
}

function buildPlatformPrompt() {
  return `You are the DeepFeedAI Platform Assistant, an AI helper for platform administrators managing DeepFeedAI — a live AI news aggregator platform.

You help admins understand and manage their platform: tenants, AI costs, system health, articles, and configuration.

## Available Data Queries
When you need live data to answer a question, include a query tag in your response. The system will resolve it and provide the data before your response is sent.

Available queries:
- [QUERY:tenant_stats] — Total tenants, active count, breakdown by plan
- [QUERY:tenant_detail:SLUG] — Details for a specific tenant (replace SLUG with tenant slug)
- [QUERY:ai_costs] — AI spend summary (today + this month)
- [QUERY:article_stats] — Article counts and recent publishing activity
- [QUERY:system_health] — Cron job health, recent errors
- [QUERY:recent_signups] — Last 10 tenant signups
- [QUERY:top_tenants] — Top tenants by article count

${SHARED_RULES}`;
}

function buildPortalPrompt(ctx) {
  const tenantLine = ctx.tenantName
    ? `You are currently assisting an admin for **${ctx.tenantName}** (slug: \`${ctx.tenantSlug}\`, plan: ${ctx.tenantPlan}).`
    : 'You are assisting a tenant admin on their portal.';

  return `You are the DeepFeedAI Assistant, an AI helper for tenant administrators managing their DeepFeedAI news site.

${tenantLine}

All data queries are automatically scoped to this tenant — you do not need to ask which tenant the user is referring to. When the user says "my site", "this tenant", "our articles", etc., they mean this tenant.

You help admins understand and manage their site: articles, writers, sources, AI costs, system health, and configuration.

## Available Data Queries
When you need live data to answer a question, include a query tag in your response. The system will resolve it and provide the data before your response is sent.

Available queries:
- [QUERY:my_tenant] — Details about this tenant (articles, writers, sources)
- [QUERY:ai_costs] — AI spend summary (today + this month)
- [QUERY:article_stats] — Article counts and recent publishing activity
- [QUERY:system_health] — Cron job health, recent errors

${SHARED_RULES}`;
}

// Static export for backwards compatibility
const SYSTEM_PROMPT = buildPlatformPrompt();

// ── Query Handlers ──────────────────────────────────────────────────
// Each handler returns a string of data to inject into the conversation.

const QUERY_HANDLERS = {
  async tenant_stats() {
    const stats = await db.prepare(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'active') AS active,
        COUNT(*) FILTER (WHERE status = 'suspended') AS suspended
      FROM tenants
    `).get();
    const byPlan = await db.prepare(`
      SELECT plan, COUNT(*) AS count
      FROM tenants WHERE status = 'active'
      GROUP BY plan ORDER BY count DESC
    `).all();
    return `Tenant Stats:\n- Total: ${stats.total}\n- Active: ${stats.active}\n- Suspended: ${stats.suspended}\nBy plan: ${byPlan.map(r => `${r.plan}: ${r.count}`).join(', ')}`;
  },

  async tenant_detail(_tenantId, slug) {
    if (!slug) return 'Error: tenant slug required. Use [QUERY:tenant_detail:SLUG]';
    const tenant = await db.prepare(
      "SELECT id, slug, display_name, plan, status, created_at FROM tenants WHERE slug = $1"
    ).get(slug);
    if (!tenant) return `No tenant found with slug "${slug}"`;
    const articleCount = await db.prepare(
      'SELECT COUNT(*) AS count FROM articles WHERE tenant_id = $1'
    ).get(tenant.id);
    const writerCount = await db.prepare(
      'SELECT COUNT(*) AS count FROM writers WHERE tenant_id = $1'
    ).get(tenant.id);
    const sourceCount = await db.prepare(
      'SELECT COUNT(*) AS count FROM sources WHERE tenant_id = $1 AND is_active = 1'
    ).get(tenant.id);
    return [
      `Tenant: ${tenant.display_name} (${tenant.slug})`,
      `Plan: ${tenant.plan} | Status: ${tenant.status}`,
      `Created: ${tenant.created_at}`,
      `Articles: ${articleCount.count} | Writers: ${writerCount.count} | Active Sources: ${sourceCount.count}`,
    ].join('\n');
  },

  // Portal-only: auto-scoped tenant details (no slug needed)
  async my_tenant(tenantId) {
    const tenant = await db.prepare(
      "SELECT id, slug, display_name, plan, status, created_at FROM tenants WHERE id = $1"
    ).get(tenantId);
    if (!tenant) return 'Tenant not found.';
    const articleCount = await db.prepare(
      'SELECT COUNT(*) AS count FROM articles WHERE tenant_id = $1'
    ).get(tenantId);
    const writerCount = await db.prepare(
      'SELECT COUNT(*) AS count FROM writers WHERE tenant_id = $1'
    ).get(tenantId);
    const sourceCount = await db.prepare(
      'SELECT COUNT(*) AS count FROM sources WHERE tenant_id = $1 AND is_active = 1'
    ).get(tenantId);
    return [
      `Tenant: ${tenant.display_name} (${tenant.slug})`,
      `Plan: ${tenant.plan} | Status: ${tenant.status}`,
      `Created: ${tenant.created_at}`,
      `Articles: ${articleCount.count} | Writers: ${writerCount.count} | Active Sources: ${sourceCount.count}`,
    ].join('\n');
  },

  async ai_costs(tenantId) {
    // tenantId=null means platform-wide (all tenants)
    if (tenantId) {
      const todaySpend = await getTodaySpend(tenantId);
      const monthlySpend = await getMonthlySpend(tenantId);
      const topOps = await db.prepare(`
        SELECT operation, COUNT(*) AS calls, COALESCE(SUM(estimated_cost), 0) AS cost
        FROM ai_usage
        WHERE tenant_id = $1 AND created_at >= DATE_TRUNC('month', NOW() AT TIME ZONE 'UTC')
        GROUP BY operation ORDER BY cost DESC LIMIT 5
      `).all(tenantId);
      const opsStr = topOps.map(r => `  ${r.operation}: ${r.calls} calls, $${Number(r.cost).toFixed(4)}`).join('\n');
      return `AI Costs:\n- Today: $${todaySpend.toFixed(4)}\n- This month: $${monthlySpend.toFixed(4)}\nTop operations this month:\n${opsStr}`;
    }
    // Platform-wide aggregation
    const today = await db.prepare(`
      SELECT COALESCE(SUM(estimated_cost), 0) AS cost FROM ai_usage
      WHERE created_at >= DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC')
    `).get();
    const monthly = await db.prepare(`
      SELECT COALESCE(SUM(estimated_cost), 0) AS cost FROM ai_usage
      WHERE created_at >= DATE_TRUNC('month', NOW() AT TIME ZONE 'UTC')
    `).get();
    const topOps = await db.prepare(`
      SELECT operation, COUNT(*) AS calls, COALESCE(SUM(estimated_cost), 0) AS cost
      FROM ai_usage
      WHERE created_at >= DATE_TRUNC('month', NOW() AT TIME ZONE 'UTC')
      GROUP BY operation ORDER BY cost DESC LIMIT 5
    `).all();
    const opsStr = topOps.map(r => `  ${r.operation}: ${r.calls} calls, $${Number(r.cost).toFixed(4)}`).join('\n');
    return `AI Costs (all tenants):\n- Today: $${Number(today.cost).toFixed(4)}\n- This month: $${Number(monthly.cost).toFixed(4)}\nTop operations this month:\n${opsStr}`;
  },

  async article_stats(tenantId) {
    const tenantFilter = tenantId ? 'WHERE tenant_id = $1' : '';
    const params = tenantId ? [tenantId] : [];
    const total = await db.prepare(
      `SELECT COUNT(*) AS count FROM articles ${tenantFilter}`
    ).get(...params);
    const published = await db.prepare(
      `SELECT COUNT(*) AS count FROM articles ${tenantFilter ? tenantFilter + ' AND' : 'WHERE'} is_published = 1`
    ).get(...params);
    const today = await db.prepare(`
      SELECT COUNT(*) AS count FROM articles
      ${tenantFilter ? tenantFilter + ' AND' : 'WHERE'} created_at >= DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC')
    `).get(...params);
    const thisWeek = await db.prepare(`
      SELECT COUNT(*) AS count FROM articles
      ${tenantFilter ? tenantFilter + ' AND' : 'WHERE'} created_at >= DATE_TRUNC('week', NOW() AT TIME ZONE 'UTC')
    `).get(...params);
    const label = tenantId ? 'Article Stats' : 'Article Stats (all tenants)';
    return `${label}:\n- Total: ${total.count}\n- Published: ${published.count}\n- Today: ${today.count}\n- This week: ${thisWeek.count}`;
  },

  async system_health(tenantId) {
    const tenantFilter = tenantId ? 'WHERE tenant_id = $1' : '';
    const params = tenantId ? [tenantId] : [];
    const recentCrons = await db.prepare(`
      SELECT job_name, status, started_at, duration_ms, error
      FROM cron_runs
      ${tenantFilter}
      ORDER BY started_at DESC LIMIT 10
    `).all(...params);
    if (recentCrons.length === 0) return 'System Health: No recent cron runs found.';
    const failed = recentCrons.filter(r => r.status === 'error');
    const lines = [
      `System Health: ${recentCrons.length} recent cron runs, ${failed.length} errors`,
    ];
    for (const run of recentCrons.slice(0, 5)) {
      const status = run.status === 'error' ? 'FAIL' : 'OK';
      lines.push(`  [${status}] ${run.job_name} — ${run.started_at} (${run.duration_ms}ms)${run.error ? ` Error: ${run.error}` : ''}`);
    }
    return lines.join('\n');
  },

  async recent_signups() {
    const recent = await db.prepare(`
      SELECT slug, display_name, plan, status, created_at
      FROM tenants ORDER BY created_at DESC LIMIT 10
    `).all();
    if (recent.length === 0) return 'No tenants found.';
    const lines = ['Recent Signups (last 10):'];
    for (const t of recent) {
      lines.push(`  ${t.display_name} (${t.slug}) — ${t.plan}, ${t.status}, created ${t.created_at}`);
    }
    return lines.join('\n');
  },

  async top_tenants() {
    const top = await db.prepare(`
      SELECT t.slug, t.display_name, t.plan, COUNT(a.id) AS article_count
      FROM tenants t
      LEFT JOIN articles a ON a.tenant_id = t.id
      WHERE t.status = 'active'
      GROUP BY t.id, t.slug, t.display_name, t.plan
      ORDER BY article_count DESC
      LIMIT 10
    `).all();
    if (top.length === 0) return 'No active tenants with articles.';
    const lines = ['Top Tenants by Articles:'];
    for (const t of top) {
      lines.push(`  ${t.display_name} (${t.slug}) — ${t.plan}, ${t.article_count} articles`);
    }
    return lines.join('\n');
  },
};

// Queries allowed per source — portal users cannot run cross-tenant queries
const PORTAL_ALLOWED_QUERIES = new Set([
  'my_tenant', 'ai_costs', 'article_stats', 'system_health',
]);

// Query tag pattern: [QUERY:type] or [QUERY:type:arg]
const QUERY_TAG_RE = /\[QUERY:(\w+)(?::([^\]]+))?\]/g;

/**
 * Resolve all [QUERY:...] tags in text by running the matching handler.
 * Returns the resolved data as a combined string, or null if no queries found.
 * @param {string} text
 * @param {number} tenantId
 * @param {'portal'|'platform'} [source='platform']
 */
async function resolveQueries(text, tenantId, source = 'platform') {
  const matches = [...text.matchAll(QUERY_TAG_RE)];
  if (matches.length === 0) return null;

  // Portal: always scope to tenant. Platform: pass null for platform-wide aggregation
  // (handlers that need a specific tenant like tenant_detail use the arg, not tenantId)
  const PLATFORM_WIDE_QUERIES = new Set(['ai_costs', 'article_stats', 'system_health']);

  const results = [];
  for (const match of matches) {
    const [, queryType, queryArg] = match;

    // Block cross-tenant queries from portal context
    if (source === 'portal' && !PORTAL_ALLOWED_QUERIES.has(queryType)) {
      results.push(`Query "${queryType}" is not available in portal context.`);
      continue;
    }

    // Block portal-only queries from platform context
    if (source === 'platform' && queryType === 'my_tenant') {
      results.push(`Query "my_tenant" is only available in portal context. Use [QUERY:tenant_detail:SLUG] instead.`);
      continue;
    }

    const handler = QUERY_HANDLERS[queryType];
    if (!handler) {
      results.push(`Unknown query: ${queryType}`);
      continue;
    }
    try {
      // Platform: use null for queries that should aggregate across all tenants
      const effectiveTenantId = (source === 'platform' && PLATFORM_WIDE_QUERIES.has(queryType))
        ? null : tenantId;
      const data = await handler(effectiveTenantId, queryArg);
      results.push(data);
    } catch (err) {
      results.push(`Query error (${queryType}): ${err.message}`);
    }
  }
  return results.join('\n\n');
}

module.exports = { SYSTEM_PROMPT, buildSystemPrompt, resolveQueries, QUERY_HANDLERS };
