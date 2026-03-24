/**
 * Deep Feed AI — /api/credits
 * Tenant-facing credit pack purchase and balance endpoints.
 * Requires admin auth (tenant admin).
 */
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { asyncHandler } = require('../lib/utils');
const { getAvailableCredits } = require('../lib/credits');

// GET /api/credits/packs — list available credit packs
router.get('/packs', asyncHandler(async (req, res) => {
  const packs = await db.prepare(
    'SELECT id, name, credits, price_cents FROM credit_packs WHERE is_active = true ORDER BY sort_order, id'
  ).all();
  res.json({ packs });
}));

// GET /api/credits/balance — credit balance breakdown
router.get('/balance', asyncHandler(async (req, res) => {
  const balance = await getAvailableCredits(req.tenantId);
  res.json(balance);
}));

// POST /api/credits/checkout — create Stripe Checkout session for a credit pack
router.post('/checkout', asyncHandler(async (req, res) => {
  const { packId } = req.body || {};
  if (!packId) return res.status(400).json({ error: 'packId is required' });

  const pack = await db.prepare(
    'SELECT * FROM credit_packs WHERE id = $1 AND is_active = true'
  ).get(packId);
  if (!pack) return res.status(404).json({ error: 'Credit pack not found' });

  // Check Stripe configuration
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return res.status(503).json({ error: 'Payment processing is not configured' });
  }

  const stripe = require('stripe')(stripeKey);

  // Get or create Stripe customer for this tenant
  const tenant = await db.prepare('SELECT id, slug, display_name, stripe_customer_id FROM tenants WHERE id = $1').get(req.tenantId);
  let customerId = tenant.stripe_customer_id;

  if (!customerId) {
    const customer = await stripe.customers.create({
      metadata: { tenant_id: String(req.tenantId), tenant_slug: tenant.slug },
      name: tenant.display_name,
    });
    customerId = customer.id;
    await db.prepare('UPDATE tenants SET stripe_customer_id = $1 WHERE id = $2').run(customerId, req.tenantId);
  }

  // Determine return URLs
  const origin = req.headers.origin || req.headers.referer?.replace(/\/[^/]*$/, '') || 'https://portal.deepfeedai.com';

  // Create Checkout Session
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'payment',
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: {
          name: `${pack.name} — ${pack.credits.toLocaleString()} AI Credits`,
          description: `${pack.credits.toLocaleString()} AI credits for ${tenant.display_name}`,
        },
        unit_amount: pack.price_cents,
      },
      quantity: 1,
    }],
    metadata: {
      tenant_id: String(req.tenantId),
      pack_id: String(pack.id),
      credits: String(pack.credits),
    },
    success_url: `${origin}/analytics.html?credits=purchased`,
    cancel_url: `${origin}/analytics.html?credits=cancelled`,
  });

  // Record pending purchase
  await db.prepare(`
    INSERT INTO credit_purchases (tenant_id, credits, amount_cents, stripe_session_id, status, purchased_by)
    VALUES ($1, $2, $3, $4, 'pending', $5)
  `).run(req.tenantId, pack.credits, pack.price_cents, session.id, req.user?.sub || null);

  res.json({ checkout_url: session.url });
}));

// GET /api/credits/purchases — purchase history
router.get('/purchases', asyncHandler(async (req, res) => {
  const purchases = await db.prepare(`
    SELECT id, credits, amount_cents, status, created_at, completed_at
    FROM credit_purchases
    WHERE tenant_id = $1
    ORDER BY created_at DESC
    LIMIT 50
  `).all(req.tenantId);
  res.json({ purchases });
}));

module.exports = router;
