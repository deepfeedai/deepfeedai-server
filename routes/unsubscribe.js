/**
 * Deep Feed AI Admin — POST /api/unsubscribe
 * Removes an email from the Resend Audience for the Deep Feed AI newsletter.
 * Public endpoint — no auth required.
 *
 * Env vars required:
 *   RESEND_API_KEY     — from resend.com dashboard
 *   RESEND_AUDIENCE_ID — from Resend Audiences section
 */
const express = require('express');
const router  = express.Router();
const { getSiteConfig } = require('../lib/site-config');
const { getAppConfig } = require('../lib/app-config');

router.post('/', async (req, res) => {
  const appCfg     = await getAppConfig(req.tenantId);
  const apiKey     = appCfg.resend_api_key;
  const audienceId = appCfg.resend_audience_id;

  if (!apiKey || !audienceId) {
    return res.status(500).json({ error: 'Newsletter service not configured.' });
  }

  const email = (req.body?.email || '').trim().toLowerCase();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  try {
    // Resend: set subscribed=false to unsubscribe (upsert)
    const upstream = await fetch(
      `https://api.resend.com/audiences/${audienceId}/contacts`,
      {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({ email, subscribed: false }),
      }
    );

    const data = await upstream.json();

    if (upstream.ok || upstream.status === 200 || upstream.status === 409) {
      const site     = await getSiteConfig(req.tenantId);
      const siteName = site.name || 'Deep Feed AI';
      return res.status(200).json({
        success: true,
        message: `You've been unsubscribed from the ${siteName} newsletter.`,
      });
    }

    console.error('[unsubscribe] Resend error:', data);
    return res.status(upstream.status).json({ error: data.message || 'Unsubscribe failed.' });

  } catch (err) {
    console.error('[unsubscribe] error:', err);
    return res.status(502).json({ error: 'Could not connect to newsletter service.' });
  }
});

module.exports = router;
