/**
 * Deep Feed AI — lib/promo.js
 * Promo code validation and redemption logic.
 */
'use strict';

const db = require('../db');
const { getPlanInfo } = require('./plan-limits');

/**
 * Validate a promo code — check it exists, is active, not expired, not maxed.
 * @param {string} code
 * @returns {Promise<object|null>} The promo_codes row or null
 */
async function validatePromoCode(code) {
  if (!code || typeof code !== 'string') return null;
  const row = await db.prepare(
    `SELECT * FROM promo_codes
     WHERE UPPER(code) = UPPER($1)
       AND is_active = true
       AND (expires_at IS NULL OR expires_at > NOW())
       AND (max_redemptions IS NULL OR redemption_count < max_redemptions)`
  ).get(code.trim());
  return row || null;
}

/**
 * Redeem a promo code for a tenant.
 * @param {string} code
 * @param {number} tenantId
 * @returns {Promise<{ success: boolean, error?: string, bonusCredits?: number }>}
 */
async function redeemPromoCode(code, tenantId) {
  const promo = await validatePromoCode(code);
  if (!promo) {
    return { success: false, error: 'Invalid or expired promo code' };
  }

  // Compute bonus credits based on type
  let bonusCredits = 0;
  const planInfo = await getPlanInfo(tenantId);
  const planCredits = planInfo?.limits?.max_credits_month || 0;

  switch (promo.type) {
    case 'flat':
      bonusCredits = Math.round(parseFloat(promo.value));
      break;
    case 'percentage':
      bonusCredits = Math.round(planCredits * (parseFloat(promo.value) / 100));
      break;
    case 'multiplier':
      bonusCredits = Math.round(planCredits * (parseFloat(promo.value) - 1));
      break;
    default:
      bonusCredits = Math.round(parseFloat(promo.value));
  }

  if (bonusCredits <= 0) {
    return { success: false, error: 'This promo code does not grant any credits for your plan' };
  }

  // Insert redemption — ON CONFLICT handles race condition (UNIQUE constraint)
  try {
    const inserted = await db.prepare(
      `INSERT INTO promo_redemptions (tenant_id, promo_code_id, bonus_credits, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, promo_code_id) DO NOTHING
       RETURNING id`
    ).get(tenantId, promo.id, bonusCredits, promo.expires_at || null);

    if (!inserted) {
      return { success: false, error: 'This promo code has already been redeemed' };
    }
  } catch (err) {
    return { success: false, error: 'This promo code has already been redeemed' };
  }

  // Increment redemption count
  await db.prepare(
    'UPDATE promo_codes SET redemption_count = redemption_count + 1 WHERE id = $1'
  ).run(promo.id);

  return { success: true, bonusCredits };
}

/**
 * Get active bonus credits for a tenant.
 * Returns sum of bonus credits from non-expired promo redemptions.
 * NULL expires_at = valid for the month it was redeemed in.
 */
async function getBonusCredits(tenantId) {
  const row = await db.prepare(`
    SELECT COALESCE(SUM(bonus_credits), 0) AS total
    FROM promo_redemptions
    WHERE tenant_id = $1
      AND (
        (expires_at IS NULL AND redeemed_at >= DATE_TRUNC('month', NOW() AT TIME ZONE 'UTC'))
        OR expires_at > NOW()
      )
  `).get(tenantId);
  return parseInt(row.total) || 0;
}

/**
 * Get active promo redemptions for a tenant (for display).
 */
async function getActiveRedemptions(tenantId) {
  const rows = await db.prepare(`
    SELECT pr.id, pr.bonus_credits, pr.redeemed_at, pr.expires_at,
           pc.code, pc.type, pc.description
    FROM promo_redemptions pr
    JOIN promo_codes pc ON pc.id = pr.promo_code_id
    WHERE pr.tenant_id = $1
      AND (
        (pr.expires_at IS NULL AND pr.redeemed_at >= DATE_TRUNC('month', NOW() AT TIME ZONE 'UTC'))
        OR pr.expires_at > NOW()
      )
    ORDER BY pr.redeemed_at DESC
  `).all(tenantId);
  return rows;
}

module.exports = { validatePromoCode, redeemPromoCode, getBonusCredits, getActiveRedemptions };
