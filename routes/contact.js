/**
 * Deep Feed AI Admin — POST /api/contact
 * Receives contact form submissions and emails them via Resend.
 * Public endpoint — no auth required.
 *
 * Body: { name, email, message }
 *
 * Env vars required:
 *   RESEND_API_KEY — Full Access key from resend.com
 */
const express   = require('express');
const rateLimit = require('express-rate-limit');
const router    = express.Router();
const { getSiteConfig } = require('../lib/site-config');
const { logUsage } = require('../lib/ai-usage');
const { getAppConfig } = require('../lib/app-config');

const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many contact requests. Please try again later.' },
  validate: false,
});

function escHtml(str) {
  return String(str || '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
}

router.post('/', contactLimiter, async (req, res) => {
  const name    = String(req.body?.name || '').trim().slice(0, 100);
  const email   = String(req.body?.email || '').trim().slice(0, 254);
  const message = String(req.body?.message || '').trim().slice(0, 2000);

  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  const appCfg = await getAppConfig(req.tenantId);
  const resendKey = appCfg.resend_api_key;
  if (!resendKey) return res.status(500).json({ error: 'Missing Resend config' });

  try {
    const site     = await getSiteConfig(req.tenantId);
    const siteName = site.name || 'Deep Feed AI';
    const domain   = site.domain || 'deepfeedai.com';

    const _start = Date.now();
    const emailRes = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:     `${siteName} <contact@${domain}>`,
        to:       [`contact@${domain}`],
        reply_to: email,
        subject:  `[${siteName}] Message from ${name}`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
            <h2 style="color:#7c3aed;">New Contact Form Submission</h2>
            <p><strong>Name:</strong> ${escHtml(name)}</p>
            <p><strong>Email:</strong> <a href="mailto:${escHtml(email)}">${escHtml(email)}</a></p>
            <p><strong>Message:</strong></p>
            <div style="background:#f8f8f8;border-left:4px solid #7c3aed;padding:1rem;border-radius:4px;white-space:pre-wrap;">${escHtml(message)}</div>
            <hr style="margin:2rem 0;border:none;border-top:1px solid #eee;" />
            <p style="color:#999;font-size:12px;">Sent from ${domain} contact form</p>
          </div>
        `,
      }),
    });

    if (!emailRes.ok) {
      const err = await emailRes.text();
      console.error('[contact] Resend error:', err);
      logUsage({ provider: 'resend', operation: 'contact-email', trigger: 'manual', emailCount: 1, durationMs: Date.now() - _start, success: false, error: err, tenantId: req.tenantId }).catch(() => {});
      return res.status(500).json({ error: 'Failed to send message' });
    }

    logUsage({ provider: 'resend', operation: 'contact-email', trigger: 'manual', emailCount: 1, durationMs: Date.now() - _start, tenantId: req.tenantId }).catch(() => {});
    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('[contact] error:', err);
    return res.status(502).json({ error: 'Failed to send message' });
  }
});

module.exports = router;
