/**
 * Deep Feed AI — lib/credits.js
 * Purchased credit balance and available credits calculation.
 */
'use strict';

const db = require('../db');
const { getMonthlyCredits, CREDIT_RATE } = require('./ai-usage');
const { getBonusCredits } = require('./promo');
const { getPlanInfo } = require('./plan-limits');

/**
 * Get total purchased credits (completed, non-refunded).
 */
async function getTotalPurchasedCredits(tenantId) {
  const row = await db.prepare(`
    SELECT COALESCE(SUM(credits), 0) AS total
    FROM credit_purchases
    WHERE tenant_id = $1 AND status = 'completed'
  `).get(tenantId);
  return parseInt(row.total) || 0;
}

/**
 * Get all-time credits used by this tenant (for purchased credit draw-down).
 */
async function getAllTimeCreditsUsed(tenantId) {
  const row = await db.prepare(`
    SELECT COALESCE(SUM(credits_used), 0) AS total
    FROM ai_usage
    WHERE tenant_id = $1
  `).get(tenantId);
  return parseInt(row.total) || 0;
}

/**
 * Get remaining purchased credits balance for a tenant.
 * Purchased credits never expire. They are consumed only when monthly usage
 * exceeds plan + bonus allocation (overflow). Balance = total_purchased - SUM(monthly_overflows).
 */
async function getPurchasedCreditsBalance(tenantId) {
  const totalPurchased = await getTotalPurchasedCredits(tenantId);
  if (totalPurchased === 0) return 0;

  // Calculate overflow: credits used beyond plan+bonus allocation across all months
  // We query per-month usage and compare against plan allocation
  const planInfo = await getPlanInfo(tenantId);
  const planMonthly = planInfo?.limits?.max_credits_month || 0;

  // Get usage per month
  const monthlyUsages = await db.prepare(`
    SELECT DATE_TRUNC('month', created_at) AS month,
           COALESCE(SUM(credits_used), 0)::INTEGER AS used
    FROM ai_usage
    WHERE tenant_id = $1 AND credits_used > 0
    GROUP BY DATE_TRUNC('month', created_at)
    ORDER BY month
  `).all(tenantId);

  // For each month, compute overflow (usage beyond plan+bonus allocation).
  // Bonus credits only apply to current month; past months use plan allocation only.
  let totalOverflow = 0;
  const currentMonth = new Date().toISOString().slice(0, 7);
  const currentBonus = await getBonusCredits(tenantId);

  for (const row of monthlyUsages) {
    const monthStr = new Date(row.month).toISOString().slice(0, 7);
    const monthUsed = parseInt(row.used) || 0;
    const monthBonus = monthStr === currentMonth ? currentBonus : 0;
    const monthAllocation = planMonthly + monthBonus;
    const overflow = Math.max(0, monthUsed - monthAllocation);
    totalOverflow += overflow;
  }

  return Math.max(0, totalPurchased - totalOverflow);
}

/**
 * Get full credit balance breakdown for a tenant.
 */
async function getAvailableCredits(tenantId) {
  const planInfo = await getPlanInfo(tenantId);
  const planCredits = planInfo?.limits?.max_credits_month || 0;
  const planCreditsDay = planInfo?.limits?.max_credits_day || 0;

  const [bonusCredits, purchasedBalance, usedThisMonth] = await Promise.all([
    getBonusCredits(tenantId),
    getPurchasedCreditsBalance(tenantId),
    getMonthlyCredits(tenantId),
  ]);

  const monthlyAllocation = planCredits + bonusCredits;
  const planRemaining = Math.max(0, monthlyAllocation - usedThisMonth);
  const totalAvailable = planRemaining + purchasedBalance;

  return {
    planCredits,
    planCreditsDay,
    bonusCredits,
    purchasedBalance,
    usedThisMonth,
    monthlyAllocation,
    totalAvailable,
  };
}

module.exports = {
  getTotalPurchasedCredits,
  getPurchasedCreditsBalance,
  getAvailableCredits,
};
