/**
 * Deep Feed AI — Budget-aware execution layer
 * Checks daily/monthly spend and credit limits against configured budgets
 * before allowing AI operations.
 */
const db = require('../db');
const { getTodaySpend, getMonthlySpend, getTodayCredits, getMonthlyCredits, getTodayTokensByok, getMonthlyTokensByok } = require('./ai-usage');
const { getPlanInfo } = require('./plan-limits');
const { getBonusCredits } = require('./promo');
const { getPurchasedCreditsBalance } = require('./credits');

// Cache budget settings per tenant for 60s to avoid hitting DB on every check
const _budgetCache = new Map(); // Map<tenantId, { settings, ts }>
const BUDGET_CACHE_TTL = 60 * 1000;

// Per-tenant Promise mutex — serializes canSpend() calls within a single process
// to prevent two concurrent AI jobs both passing the budget check before either
// has logged its usage. Not a perfect fix for multi-instance deployments, but
// eliminates the race for the common single-instance case.
const _budgetMutex = new Map(); // Map<tenantId, Promise>

async function _withTenantMutex(tenantId, fn) {
  const prev = _budgetMutex.get(tenantId) || Promise.resolve();
  let release;
  const done = new Promise(resolve => { release = resolve; });
  _budgetMutex.set(tenantId, done);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (_budgetMutex.get(tenantId) === done) _budgetMutex.delete(tenantId);
  }
}

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
      dailyBudget:          parseFloat(s.ai_daily_budget)          || 5.00,
      monthlyBudget:        parseFloat(s.ai_monthly_budget)         || 50.00,
      warnPct:              parseInt(s.ai_budget_warn_pct)          || 80,
      dailyCreditBudget:    s.ai_daily_credit_budget  ? parseInt(s.ai_daily_credit_budget)  : null,
      monthlyCreditBudget:  s.ai_monthly_credit_budget ? parseInt(s.ai_monthly_credit_budget) : null,
    };
  } catch {
    settings = {
      dailyBudget: 5.00, monthlyBudget: 50.00, warnPct: 80,
      dailyCreditBudget: null, monthlyCreditBudget: null,
    };
  }
  _budgetCache.set(tenantId, { settings, ts: now });
  return settings;
}

/**
 * Check if the system can afford to run an AI operation.
 * Free operations (writer assignment, categorization) always pass.
 *
 * @param {string} operation — e.g. 'synthesis', 'summary', 'thumbnail-render', 'audio'
 * @returns {{ allowed: boolean, reason?: string, dailySpend: number, monthlySpend: number, creditsUsedToday: number, creditsUsedMonth: number, creditsLimitDay: number, creditsLimitMonth: number, bonusCredits: number, purchasedCreditsBalance: number }}
 */
async function _canSpendInternal(operation, tenantId) {
  // Free operations always allowed
  const FREE_OPS = ['news-fetch', 'email', 'contact-email'];
  if (FREE_OPS.includes(operation)) {
    return { allowed: true, dailySpend: 0, monthlySpend: 0,
      creditsUsedToday: 0, creditsUsedMonth: 0, creditsLimitDay: 0,
      creditsLimitMonth: 0, bonusCredits: 0, purchasedCreditsBalance: 0 };
  }

  // Fetch all data upfront to avoid redundant DB calls
  const planInfo = await getPlanInfo(tenantId);
  const budget = await getBudgetSettings(tenantId);
  const [dailySpend, monthlySpend, creditsUsedToday, creditsUsedMonth, bonusCredits, purchasedCreditsBalance] = await Promise.all([
    getTodaySpend(tenantId),
    getMonthlySpend(tenantId),
    getTodayCredits(tenantId),
    getMonthlyCredits(tenantId),
    getBonusCredits(tenantId),
    getPurchasedCreditsBalance(tenantId),
  ]);

  // Check plan-level AI budget cap (e.g. free plan has $0)
  // But allow if tenant has plan credits, bonus credits (promo), or purchased credits
  if (planInfo && planInfo.limits) {
    const planCap = parseFloat(planInfo.limits.max_ai_cost_month);
    const planCredits = planInfo.limits.max_credits_month != null
      ? parseInt(planInfo.limits.max_credits_month) : null;
    if (planCap === 0 && planCredits !== null && planCredits <= 0 && bonusCredits <= 0 && purchasedCreditsBalance <= 0) {
      return {
        allowed: false,
        reason: 'AI operations are not available on the free plan. Upgrade to unlock AI features.',
        dailySpend: 0, monthlySpend: 0,
        creditsUsedToday: 0, creditsUsedMonth: 0, creditsLimitDay: 0,
        creditsLimitMonth: 0, bonusCredits, purchasedCreditsBalance,
      };
    }
  }

  // Dollar budget checks (platform safety net)
  if (dailySpend >= budget.dailyBudget) {
    return {
      allowed: false,
      reason: `Daily budget exhausted ($${dailySpend.toFixed(2)} / $${budget.dailyBudget.toFixed(2)})`,
      dailySpend, monthlySpend,
      creditsUsedToday, creditsUsedMonth, creditsLimitDay: 0, creditsLimitMonth: 0,
      bonusCredits, purchasedCreditsBalance,
    };
  }

  if (monthlySpend >= budget.monthlyBudget) {
    return {
      allowed: false,
      reason: `Monthly budget exhausted ($${monthlySpend.toFixed(2)} / $${budget.monthlyBudget.toFixed(2)})`,
      dailySpend, monthlySpend,
      creditsUsedToday, creditsUsedMonth, creditsLimitDay: 0, creditsLimitMonth: 0,
      bonusCredits, purchasedCreditsBalance,
    };
  }

  // Credit limit checks
  const planCreditsMonth = budget.monthlyCreditBudget
    ?? (planInfo?.limits?.max_credits_month != null ? parseInt(planInfo.limits.max_credits_month) : null);
  const planCreditsDay = budget.dailyCreditBudget
    ?? (planInfo?.limits?.max_credits_day != null ? parseInt(planInfo.limits.max_credits_day) : null);

  // Monthly credit check (plan + bonus, then purchased as overflow)
  if (planCreditsMonth != null && planCreditsMonth > 0) {
    const effectiveMonthlyLimit = planCreditsMonth + bonusCredits;
    if (creditsUsedMonth >= effectiveMonthlyLimit) {
      // Over plan+bonus — check purchased credits
      if (purchasedCreditsBalance <= 0) {
        return {
          allowed: false,
          reason: `Monthly credit limit reached (${creditsUsedMonth.toLocaleString()} / ${effectiveMonthlyLimit.toLocaleString()} credits)`,
          dailySpend, monthlySpend,
          creditsUsedToday, creditsUsedMonth,
          creditsLimitDay: planCreditsDay || 0, creditsLimitMonth: effectiveMonthlyLimit,
          bonusCredits, purchasedCreditsBalance,
        };
      }
      // Has purchased credits — allow (purchased balance will decrease)
    }
  }

  // Daily credit check
  if (planCreditsDay != null && planCreditsDay > 0) {
    if (creditsUsedToday >= planCreditsDay) {
      return {
        allowed: false,
        reason: `Daily credit limit reached (${creditsUsedToday.toLocaleString()} / ${planCreditsDay.toLocaleString()} credits)`,
        dailySpend, monthlySpend,
        creditsUsedToday, creditsUsedMonth,
        creditsLimitDay: planCreditsDay,
        creditsLimitMonth: (planCreditsMonth || 0) + bonusCredits,
        bonusCredits, purchasedCreditsBalance,
      };
    }
  }

  return {
    allowed: true,
    dailySpend, monthlySpend,
    creditsUsedToday, creditsUsedMonth,
    creditsLimitDay: planCreditsDay || 0,
    creditsLimitMonth: (planCreditsMonth || 0) + bonusCredits,
    bonusCredits, purchasedCreditsBalance,
  };
}

/**
 * Check budget alert thresholds.
 * Returns { warn: boolean, level: 'ok'|'warning'|'critical', pctUsed, monthlySpend, monthlyBudget, creditsPctUsed, creditsLevel }
 */
async function checkBudgetAlerts(tenantId) {
  const budget = await getBudgetSettings(tenantId);
  const [monthlySpend, creditsUsedMonth, bonusCredits] = await Promise.all([
    getMonthlySpend(tenantId),
    getMonthlyCredits(tenantId),
    getBonusCredits(tenantId),
  ]);

  const pctUsed = budget.monthlyBudget > 0
    ? Math.round((monthlySpend / budget.monthlyBudget) * 100)
    : 0;

  let level = 'ok';
  if (pctUsed >= 100)            level = 'critical';
  else if (pctUsed >= budget.warnPct) level = 'warning';

  // Credit alerts
  const planInfo = await getPlanInfo(tenantId);
  const planCreditsMonth = planInfo?.limits?.max_credits_month || 0;
  const effectiveCreditsLimit = planCreditsMonth + bonusCredits;
  const creditsPctUsed = effectiveCreditsLimit > 0
    ? Math.round((creditsUsedMonth / effectiveCreditsLimit) * 100)
    : 0;

  let creditsLevel = 'ok';
  if (creditsPctUsed >= 100)            creditsLevel = 'critical';
  else if (creditsPctUsed >= budget.warnPct) creditsLevel = 'warning';

  return {
    warn: level !== 'ok' || creditsLevel !== 'ok',
    level,
    pctUsed,
    monthlySpend,
    monthlyBudget: budget.monthlyBudget,
    creditsPctUsed,
    creditsLevel,
    creditsUsedMonth,
    creditsLimitMonth: effectiveCreditsLimit,
  };
}

async function canSpend(operation, tenantId) {
  return _withTenantMutex(tenantId, () => _canSpendInternal(operation, tenantId));
}

/**
 * Budget gate for BYOK tenants (who bypass the platform dollar budget).
 * Enforces optional tenant-configured daily/monthly token limits as a
 * runaway-protection ceiling. 0 = unlimited (default — preserves current behaviour).
 *
 * @param {string} operation
 * @param {number} tenantId
 * @returns {{ allowed: boolean, reason?: string, dailyTokens?: number, monthlyTokens?: number }}
 */
async function canSpendByok(operation, tenantId) {
  const FREE_OPS = ['news-fetch', 'email', 'contact-email'];
  if (FREE_OPS.includes(operation)) return { allowed: true };

  let dailyLimit = 0;
  let monthlyLimit = 0;
  try {
    const rows = await db.prepare(
      "SELECT key, value FROM settings WHERE tenant_id = $1 AND key IN ('byok_daily_token_limit', 'byok_monthly_token_limit')"
    ).all(tenantId);
    for (const r of rows) {
      if (r.key === 'byok_daily_token_limit')   dailyLimit   = parseInt(r.value) || 0;
      if (r.key === 'byok_monthly_token_limit')  monthlyLimit = parseInt(r.value) || 0;
    }
  } catch {
    return { allowed: true }; // DB failure → don't block
  }

  if (!dailyLimit && !monthlyLimit) return { allowed: true };

  const [dailyTokens, monthlyTokens] = await Promise.all([
    dailyLimit   ? getTodayTokensByok(tenantId)   : Promise.resolve(0),
    monthlyLimit ? getMonthlyTokensByok(tenantId) : Promise.resolve(0),
  ]);

  if (dailyLimit && dailyTokens >= dailyLimit) {
    return {
      allowed: false,
      reason: `Daily BYOK token limit reached (${dailyTokens.toLocaleString()} / ${dailyLimit.toLocaleString()} tokens)`,
      dailyTokens, monthlyTokens,
    };
  }
  if (monthlyLimit && monthlyTokens >= monthlyLimit) {
    return {
      allowed: false,
      reason: `Monthly BYOK token limit reached (${monthlyTokens.toLocaleString()} / ${monthlyLimit.toLocaleString()} tokens)`,
      dailyTokens, monthlyTokens,
    };
  }
  return { allowed: true, dailyTokens, monthlyTokens };
}

function purgeStaleEntries() {
  const cutoff = Date.now() - BUDGET_CACHE_TTL;
  for (const [k, v] of _budgetCache) {
    if (v.ts < cutoff) _budgetCache.delete(k);
  }
}

module.exports = { canSpend, canSpendByok, checkBudgetAlerts, getBudgetSettings, purgeStaleEntries };
