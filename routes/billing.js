/**
 * Deep Feed AI — /api/billing
 * Self-serve billing management for tenant admins.
 *
 * Endpoints:
 *   GET  /api/billing/plans       — list available plans with pricing
 *   GET  /api/billing/status      — current plan + subscription state
 *   POST /api/billing/portal      — create Stripe Customer Portal session
 *   POST /api/billing/subscribe   — create Stripe Checkout session for plan upgrade
 *
 * All routes require admin auth (auth middleware applied at mount point in server.js).
 */
'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { asyncHandler } = require('../lib/utils');
const { getStripeConfig } = require('../lib/stripe-config');
const { getPlanInfo } = require('../lib/plan-limits');

// GET /api/billing/plans — available plans with pricing for upgrade UI
router.get('/plans', asyncHandler(async (req, res) => {
  const plans = await db.prepare(`
    SELECT plan, price_cents, stripe_price_id,
           max_sources, max_writers, max_articles_month,
           max_ai_cost_month, max_credits_month, max_storage_mb
    FROM plan_limits
    WHERE price_cents IS NOT NULL AND price_cents > 0
    ORDER BY price_cents ASC
  `).all();

  res.json({ plans });
}));

// GET /api/billing/status — current tenant plan + subscription state
router.get('/status', asyncHandler(async (req, res) => {
  const tenant = await db.prepare(`
    SELECT plan, status, stripe_subscription_id, stripe_customer_id,
           trial_ends_at, billing_status
    FROM tenants WHERE id = $1
  `).get(req.tenantId);

  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

  const planInfo = await getPlanInfo(req.tenantId);
  const { secretKey } = await getStripeConfig();
  const hasStripe = !!secretKey;

  res.json({
    plan: tenant.plan,
    effectivePlan: planInfo?.effectivePlan || tenant.plan,
    status: tenant.status,
    billingStatus: tenant.billing_status || 'active',
    hasSubscription: !!tenant.stripe_subscription_id,
    hasStripe,
    onTrial: planInfo?.onTrial || false,
    trialEndsAt: planInfo?.trialEndsAt || null,
  });
}));

// POST /api/billing/portal — create Stripe Customer Portal session
router.post('/portal', asyncHandler(async (req, res) => {
  const { secretKey } = await getStripeConfig();
  if (!secretKey) {
    return res.status(503).json({ error: 'Billing is not configured for this instance.' });
  }

  const tenant = await db.prepare(
    'SELECT id, display_name, slug, stripe_customer_id FROM tenants WHERE id = $1'
  ).get(req.tenantId);

  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

  const stripe = require('stripe')(secretKey);

  // Create or retrieve the Stripe customer
  let customerId = tenant.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
      name: tenant.display_name,
      metadata: { tenant_id: String(req.tenantId), tenant_slug: tenant.slug },
    });
    customerId = customer.id;
    await db.prepare('UPDATE tenants SET stripe_customer_id = $1 WHERE id = $2').run(customerId, req.tenantId);
  }

  const origin = req.headers.origin || req.headers.referer?.replace(/\/[^/]*$/, '') || 'https://portal.deepfeedai.com';

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${origin}/settings.html#billing`,
  });

  res.json({ url: session.url });
}));

// POST /api/billing/subscribe — create Stripe Checkout session for plan upgrade
router.post('/subscribe', asyncHandler(async (req, res) => {
  const { plan } = req.body || {};
  if (!plan) return res.status(400).json({ error: 'plan is required' });

  const { secretKey } = await getStripeConfig();
  if (!secretKey) {
    return res.status(503).json({ error: 'Billing is not configured for this instance.' });
  }

  // Look up the plan and its Stripe price
  const planRow = await db.prepare(
    'SELECT plan, stripe_price_id, price_cents FROM plan_limits WHERE plan = $1'
  ).get(plan);

  if (!planRow) return res.status(404).json({ error: 'Plan not found' });
  if (!planRow.stripe_price_id) {
    return res.status(400).json({ error: 'This plan does not have a Stripe price configured.' });
  }

  const tenant = await db.prepare(
    'SELECT id, display_name, slug, stripe_customer_id, stripe_subscription_id FROM tenants WHERE id = $1'
  ).get(req.tenantId);

  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

  // If tenant already has a subscription, direct them to the portal for plan changes
  if (tenant.stripe_subscription_id) {
    return res.status(400).json({
      error: 'You already have an active subscription. Use the billing portal to change your plan.',
      usePortal: true,
    });
  }

  const stripe = require('stripe')(secretKey);

  // Get or create Stripe customer
  let customerId = tenant.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
      name: tenant.display_name,
      metadata: { tenant_id: String(req.tenantId), tenant_slug: tenant.slug },
    });
    customerId = customer.id;
    await db.prepare('UPDATE tenants SET stripe_customer_id = $1 WHERE id = $2').run(customerId, req.tenantId);
  }

  const origin = req.headers.origin || req.headers.referer?.replace(/\/[^/]*$/, '') || 'https://portal.deepfeedai.com';

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [{ price: planRow.stripe_price_id, quantity: 1 }],
    metadata: {
      tenant_id: String(req.tenantId),
      plan,
      signup: 'false',
    },
    success_url: `${origin}/settings.html#billing?upgraded=true`,
    cancel_url:  `${origin}/settings.html#billing`,
  });

  res.json({ checkout_url: session.url });
}));

module.exports = router;
