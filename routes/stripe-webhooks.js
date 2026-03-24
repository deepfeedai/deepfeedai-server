/**
 * Deep Feed AI — /api/webhooks/stripe
 * Stripe webhook handler for credit purchase fulfillment.
 * No auth middleware — uses Stripe signature verification.
 * IMPORTANT: Must be mounted BEFORE express.json() body parser,
 * or use express.raw() middleware on this route.
 */
const express = require('express');
const router  = express.Router();
const db      = require('../db');

// Use raw body for Stripe signature verification
router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!stripeKey || !webhookSecret) {
    console.error('[Stripe Webhook] Missing STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET');
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

        // Only fulfill if payment is confirmed
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

        console.log(`[Stripe Webhook] Credit purchase completed: ${purchase.credits} credits for tenant ${purchase.tenant_id}`);
        break;
      }

      case 'charge.refunded': {
        const charge = event.data.object;
        const paymentIntent = charge.payment_intent;

        if (paymentIntent) {
          // Only void credits on full refund (amount_refunded >= amount)
          const isFullRefund = charge.refunded === true || charge.amount_refunded >= charge.amount;
          if (isFullRefund) {
            const result = await db.prepare(
              "UPDATE credit_purchases SET status = 'refunded' WHERE stripe_payment_intent = $1 AND status = 'completed'"
            ).run(paymentIntent);

            if (result.changes > 0) {
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
