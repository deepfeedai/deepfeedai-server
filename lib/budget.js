/**
 * Deep Feed AI — Budget-aware execution layer
 * Checks daily/monthly spend against configured budgets before allowing AI operations.
 */
const db = require('../db');
const { getTodaySpend, getMonthlySpend } = require('./ai-usage');
const { getPlanInfo } = require('./plan-limits');

// Cache budget settings per tenant for 60s to avoid hitting DB on every check
const _budgetCache = new Map(); // Map<tenantId, { settings, ts }>
const BUDGET_CACHE_TTL = 60 * 1000;

/**
 * Load budget settings from DB (cached per tenant).
 */
async function getBudgetSettings(tenantId) {
  const now = Date.now();
  const cached = _budgetCache.get(tenantId);
  if (cached && (now - cached.ts) < BUDGET_CACHE_TTL) {
    return cached.settings;
  }
  let settings;
  try {
    const rows = await db.prepare("SELECT key, value FROM settings WHERE tenant_id = $1 AND key LIKE 'ai_%'").all(tenantId);
    const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
    settings = {
      dailyBudget:   parseFloat(s.ai_daily_budget)   || 5.00,
      monthlyBudget: parseFloat(s.ai_monthly_budget)  || 50.00,
      warnPct:       parseInt(s.ai_budget_warn_pct)   || 80,
    };
  } catch {
    settings = { dailyBudget: 5.00, monthlyBudget: 50.00, warnPct: 80 };
  }
  _budgetCache.set(tenantId, { settings, ts: now });
  return settings;
}

/**
 * Check if the system can afford to run an AI operation.
 * Free operations (writer assignment, categorization) always pass.
 *
 * @param {string} operation — e.g. 'synthesis', 'summary', 'thumbnail-render', 'audio'
 * @returns {{ allowed: boolean, reason?: string, dailySpend: number, monthlySpend: number }}
 */
async function canSpend(operation, tenantId) {
  // Free operations always allowed
  const FREE_OPS = ['news-fetch', 'email', 'contact-email'];
  if (FREE_OPS.includes(operation)) {
    return { allowed: true, dailySpend: 0, monthlySpend: 0 };
  }

  // Check plan-level AI budget cap (e.g. free plan has $0)
  const planInfo = await getPlanInfo(tenantId);
  if (planInfo && planInfo.limits) {
    const planCap = parseFloat(planInfo.limits.max_ai_cost_month);
    if (planCap === 0) {
      return {
        allowed: false,
        reason: 'AI operations are not available on the free plan. Upgrade to unlock AI features.',
        dailySpend: 0,
        monthlySpend: 0,
      };
    }
  }

  const budget = await getBudgetSettings(tenantId);
  const [dailySpend, monthlySpend] = await Promise.all([
    getTodaySpend(tenantId),
    getMonthlySpend(tenantId),
  ]);

  if (dailySpend >= budget.dailyBudget) {
    return {
      allowed: false,
      reason: `Daily budget exhausted ($${dailySpend.toFixed(2)} / $${budget.dailyBudget.toFixed(2)})`,
      dailySpend,
      monthlySpend,
    };
  }

  if (monthlySpend >= budget.monthlyBudget) {
    return {
      allowed: false,
      reason: `Monthly budget exhausted ($${monthlySpend.toFixed(2)} / $${budget.monthlyBudget.toFixed(2)})`,
      dailySpend,
      monthlySpend,
    };
  }

  return { allowed: true, dailySpend, monthlySpend };
}

/**
 * Check budget alert thresholds.
 * Returns { warn: boolean, level: 'ok'|'warning'|'critical', pctUsed, monthlySpend, monthlyBudget }
 */
async function checkBudgetAlerts(tenantId) {
  const budget = await getBudgetSettings(tenantId);
  const monthlySpend = await getMonthlySpend(tenantId);
  const pctUsed = budget.monthlyBudget > 0
    ? Math.round((monthlySpend / budget.monthlyBudget) * 100)
    : 0;

  let level = 'ok';
  if (pctUsed >= 100)            level = 'critical';
  else if (pctUsed >= budget.warnPct) level = 'warning';

  return {
    warn: level !== 'ok',
    level,
    pctUsed,
    monthlySpend,
    monthlyBudget: budget.monthlyBudget,
  };
}

module.exports = { canSpend, checkBudgetAlerts, getBudgetSettings };
