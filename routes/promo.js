/**
 * Deep Feed AI — /api/promo
 * Tenant-facing promo code endpoints.
 * Requires admin auth (tenant admin).
 */
const express = require('express');
const router  = express.Router();
const { asyncHandler } = require('../lib/utils');
const { redeemPromoCode, getActiveRedemptions } = require('../lib/promo');

// POST /api/promo/redeem — redeem a promo code
router.post('/redeem', asyncHandler(async (req, res) => {
  const { code } = req.body || {};
  if (!code || typeof code !== 'string' || !code.trim()) {
    return res.status(400).json({ error: 'Promo code is required' });
  }

  const result = await redeemPromoCode(code.trim(), req.tenantId);
  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }

  res.json({ success: true, bonus_credits: result.bonusCredits });
}));

// GET /api/promo/active — list active bonus credits for this tenant
router.get('/active', asyncHandler(async (req, res) => {
  const redemptions = await getActiveRedemptions(req.tenantId);
  const totalBonus = redemptions.reduce((sum, r) => sum + (parseInt(r.bonus_credits) || 0), 0);
  res.json({ total_bonus_credits: totalBonus, redemptions });
}));

module.exports = router;
