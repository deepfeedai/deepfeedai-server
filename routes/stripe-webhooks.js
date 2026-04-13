/**
 * Deep Feed AI — /api/webhooks/stripe
 * Stripe webhook handler for credit purchase fulfillment and subscription management.
 * No auth middleware — uses Stripe signature verification.
 * IMPORTANT: Must be mounted BEFORE express.json() body parser,
 * or use express.raw() middleware on this route.
 */
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { bustPlanCache } = require('../lib/plan-limits');
const { bustFeatureCache } = require('../lib/feature-registry');
const { getStripeConfig } = require('../lib/stripe-config');
const { logAudit } = require('../middleware/audit');

function auditFromWebhook(tenantId, eventId, action, resource, resourceId, details) {
  const pseudoReq = {
    tenantId: tenantId || 1,
    user: { sub: null, email: `stripe:${eventId || 'webhook'}` },
    headers: { 'user-agent': 'stripe-webhook' },
    ip: null,
  };
  return logAudit(pseudoReq, action, resource, resourceId, details).catch(() => {});
}

// Use raw body for Stripe signature verification
router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  const stripeConfig = await getStripeConfig();
  const stripeKey = stripeConfig.secretKey;
  const webhookSecret = stripeConfig.webhookSecret;

  if (!stripeKey || !webhookSecret) {
    console.error('[Stripe Webhook] Missing Stripe secret key or webhook secret');
    return res.status(500).json({ error: 'Stripe not configured' });
  }

  const stripe = require('stripe')(stripeKey);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('[Stripe Webhook] Signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;

        // ── Subscription checkout (signup flow) ──
        if (session.mode === 'subscription' && session.metadata?.signup === 'true') {
          const tenantId = parseInt(session.metadata.tenant_id);
          if (!tenantId) {
            console.warn('[Stripe Webhook] Subscription checkout missing tenant_id metadata');
            break;
          }

          // Activate tenant and store subscription info
          await db.prepare(`
            UPDATE tenants
            SET status = 'active',
                stripe_subscription_id = $1,
                stripe_customer_id = COALESCE(stripe_customer_id, $2)
            WHERE id = $3 AND status = 'pending_payment'
          `).run(session.subscription || null, session.customer || null, tenantId);

          bustPlanCache(tenantId);
          bustFeatureCache(tenantId);
          auditFromWebhook(tenantId, event.id, 'stripe.subscription.activated', 'tenant', tenantId, {
            stripe_subscription_id: session.subscription,
            stripe_customer_id: session.customer,
          });
          console.log(`[Stripe Webhook] Subscription activated for tenant ${tenantId} (subscription: ${session.subscription})`);
          break;
        }

        // ── One-time credit purchase checkout ──
        if (session.payment_status !== 'paid') {
          console.log(`[Stripe Webhook] Session ${session.id} not yet paid (${session.payment_status}), skipping`);
          break;
        }

        const sessionId = session.id;

        // Find pending purchase
        const purchase = await db.prepare(
          "SELECT id, tenant_id, credits FROM credit_purchases WHERE stripe_session_id = $1 AND status = 'pending'"
        ).get(sessionId);

        if (!purchase) {
          console.warn('[Stripe Webhook] No pending purchase found for session:', sessionId);
          break;
        }

        // Mark completed
        await db.prepare(`
          UPDATE credit_purchases
          SET status = 'completed',
              completed_at = NOW(),
              stripe_payment_intent = $1
          WHERE id = $2
        `).run(session.payment_intent || null, purchase.id);

        // Update Stripe customer ID on tenant if not set
        if (session.customer) {
          await db.prepare(
            'UPDATE tenants SET stripe_customer_id = $1 WHERE id = $2 AND stripe_customer_id IS NULL'
          ).run(session.customer, purchase.tenant_id);
        }

        auditFromWebhook(purchase.tenant_id, event.id, 'stripe.credits.purchased', 'credit_purchase', purchase.id, {
          credits: purchase.credits,
          stripe_payment_intent: session.payment_intent,
        });
        console.log(`[Stripe Webhook] Credit purchase completed: ${purchase.credits} credits for tenant ${purchase.tenant_id}`);
        break;
      }

      case 'customer.subscription.deleted': {
        // Subscription cancelled — downgrade tenant to free plan
        const sub = event.data.object;
        const affected = await db.prepare(
          'SELECT id FROM tenants WHERE stripe_subscription_id = $1'
        ).get(sub.id);
        const result = await db.prepare(`
          UPDATE tenants SET plan = 'free', stripe_subscription_id = NULL
          WHERE stripe_subscription_id = $1
        `).run(sub.id);

        if (result.changes > 0) {
          bustPlanCache();
          bustFeatureCache();
          auditFromWebhook(affected?.id, event.id, 'stripe.subscription.cancelled', 'tenant', affected?.id, {
            stripe_subscription_id: sub.id,
          });
          console.log(`[Stripe Webhook] Subscription ${sub.id} deleted — tenant downgraded to free`);
        }
        break;
      }

      case 'customer.subscription.updated': {
        // Subscription changed (e.g. plan upgrade/downgrade)
        const sub = event.data.object;
        if (sub.status === 'active' && sub.items?.data?.[0]?.price?.id) {
          const priceId = sub.items.data[0].price.id;
          // Look up which plan this price belongs to
          const planRow = await db.prepare('SELECT plan FROM plan_limits WHERE stripe_price_id = $1').get(priceId);
          if (planRow) {
            const affected = await db.prepare(
              'SELECT id FROM tenants WHERE stripe_subscription_id = $1'
            ).get(sub.id);
            await db.prepare(
              'UPDATE tenants SET plan = $1 WHERE stripe_subscription_id = $2'
            ).run(planRow.plan, sub.id);
            bustPlanCache();
            bustFeatureCache();
            auditFromWebhook(affected?.id, event.id, 'stripe.subscription.updated', 'tenant', affected?.id, {
              stripe_subscription_id: sub.id,
              plan: planRow.plan,
              price_id: priceId,
            });
            console.log(`[Stripe Webhook] Subscription ${sub.id} updated — plan changed to ${planRow.plan}`);
          }
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        if (invoice.subscription) {
          const affected = await db.prepare(
            'SELECT id FROM tenants WHERE stripe_subscription_id = $1'
          ).get(invoice.subscription);
          auditFromWebhook(affected?.id, event.id, 'stripe.payment.failed', 'tenant', affected?.id, {
            stripe_subscription_id: invoice.subscription,
            amount_due: invoice.amount_due,
          });
          console.warn(`[Stripe Webhook] Payment failed for subscription ${invoice.subscription}`);
        }
        break;
      }

      case 'charge.refunded': {
        const charge = event.data.object;
        const paymentIntent = charge.payment_intent;

        if (paymentIntent) {
          // Only void credits on full refund (amount_refunded >= amount)
          const isFullRefund = charge.refunded === true || charge.amount_refunded >= charge.amount;
          if (isFullRefund) {
            const purchase = await db.prepare(
              "SELECT id, tenant_id, credits FROM credit_purchases WHERE stripe_payment_intent = $1 AND status = 'completed'"
            ).get(paymentIntent);
            const result = await db.prepare(
              "UPDATE credit_purchases SET status = 'refunded' WHERE stripe_payment_intent = $1 AND status = 'completed'"
            ).run(paymentIntent);

            if (result.changes > 0) {
              auditFromWebhook(purchase?.tenant_id, event.id, 'stripe.credits.refunded', 'credit_purchase', purchase?.id, {
                credits: purchase?.credits,
                stripe_payment_intent: paymentIntent,
                amount_refunded: charge.amount_refunded,
              });
              console.log(`[Stripe Webhook] Credit purchase fully refunded for payment_intent: ${paymentIntent}`);
            }
          } else {
            console.log(`[Stripe Webhook] Partial refund on ${paymentIntent} — credits not voided`);
          }
        }
        break;
      }

      default:
        // Unhandled event type — ignore
        break;
    }
  } catch (err) {
    console.error('[Stripe Webhook] Error processing event:', err.message);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }

  res.json({ received: true });
});

module.exports = router;
