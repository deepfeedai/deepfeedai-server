/**
 * Deep Feed AI Admin — POST /api/subscribe
 * Adds an email to the Resend Audience for the Deep Feed AI newsletter.
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

  const email = (req.body?.email || '').trim().toLowerCase().slice(0, 254);

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  try {
    const site     = await getSiteConfig(req.tenantId);
    const siteName = site.name || 'Deep Feed AI';
    const siteUrl  = (site.url || appCfg.main_site_url || 'https://deepfeedai.com').replace(/\/$/, '');
    const logoEmoji = site.logo_emoji || '🤖';

    const upstream = await fetch(
      `https://api.resend.com/audiences/${audienceId}/contacts`,
      {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          email,
          subscribed:      true,
          unsubscribe_url: `${siteUrl}/unsubscribe`,
        }),
      }
    );

    const data = await upstream.json();

    // 200 = new contact, 409 = already subscribed (both are fine)
    if (upstream.ok || upstream.status === 409) {
      return res.status(200).json({
        success: true,
        message: upstream.status === 409
          ? "You're already subscribed!"
          : `You're subscribed! Welcome to ${siteName}. ${logoEmoji}`,
      });
    }

    console.error('[subscribe] Resend error:', data);
    return res.status(upstream.status).json({ error: data.message || 'Subscription failed.' });

  } catch (err) {
    console.error('[subscribe] error:', err);
    return res.status(502).json({ error: 'Could not connect to newsletter service.' });
  }
});

module.exports = router;
