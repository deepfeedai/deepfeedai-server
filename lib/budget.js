/**
 * Deep Feed AI — Budget-aware execution layer
 * Checks daily/monthly spend against configured budgets before allowing AI operations.
 */
const db = require('../db');
const { getTodaySpend, getMonthlySpend } = require('./ai-usage');

// Cache budget settings for 60s to avoid hitting DB on every check
let budgetCache = null;
let budgetCacheTime = 0;
const BUDGET_CACHE_TTL = 60 * 1000;

/**
 * Load budget settings from DB (cached).
 */
async function getBudgetSettings() {
  const now = Date.now();
  if (budgetCache && (now - budgetCacheTime) < BUDGET_CACHE_TTL) {
    return budgetCache;
  }
  try {
    const rows = await db.prepare("SELECT key, value FROM settings WHERE key LIKE 'ai_%'").all();
    const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
    budgetCache = {
      dailyBudget:   parseFloat(s.ai_daily_budget)   || 5.00,
      monthlyBudget: parseFloat(s.ai_monthly_budget)  || 50.00,
      warnPct:       parseInt(s.ai_budget_warn_pct)   || 80,
    };
  } catch {
    budgetCache = { dailyBudget: 5.00, monthlyBudget: 50.00, warnPct: 80 };
  }
  budgetCacheTime = now;
  return budgetCache;
}

/**
 * Check if the system can afford to run an AI operation.
 * Free operations (writer assignment, categorization) always pass.
 *
 * @param {string} operation — e.g. 'synthesis', 'summary', 'thumbnail-render', 'audio'
 * @returns {{ allowed: boolean, reason?: string, dailySpend: number, monthlySpend: number }}
 */
async function canSpend(operation) {
  // Free operations always allowed
  const FREE_OPS = ['news-fetch', 'email', 'contact-email'];
  if (FREE_OPS.includes(operation)) {
    return { allowed: true, dailySpend: 0, monthlySpend: 0 };
  }

  const budget = await getBudgetSettings();
  const [dailySpend, monthlySpend] = await Promise.all([
    getTodaySpend(),
    getMonthlySpend(),
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
async function checkBudgetAlerts() {
  const budget = await getBudgetSettings();
  const monthlySpend = await getMonthlySpend();
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
