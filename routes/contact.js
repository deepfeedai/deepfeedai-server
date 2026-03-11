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
const express = require('express');
const router  = express.Router();

function escHtml(str) {
  return String(str || '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
}

router.post('/', async (req, res) => {
  const { name, email, message } = req.body || {};

  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return res.status(500).json({ error: 'Missing Resend config' });

  try {
    const emailRes = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:     'Deep Feed AI <contact@deepfeedai.com>',
        to:       ['contact@deepfeedai.com'],
        reply_to: email,
        subject:  `[Deep Feed AI] Message from ${name}`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
            <h2 style="color:#7c3aed;">New Contact Form Submission</h2>
            <p><strong>Name:</strong> ${escHtml(name)}</p>
            <p><strong>Email:</strong> <a href="mailto:${escHtml(email)}">${escHtml(email)}</a></p>
            <p><strong>Message:</strong></p>
            <div style="background:#f8f8f8;border-left:4px solid #7c3aed;padding:1rem;border-radius:4px;white-space:pre-wrap;">${escHtml(message)}</div>
            <hr style="margin:2rem 0;border:none;border-top:1px solid #eee;" />
            <p style="color:#999;font-size:12px;">Sent from deepfeedai.com contact form</p>
          </div>
        `,
      }),
    });

    if (!emailRes.ok) {
      const err = await emailRes.text();
      console.error('[contact] Resend error:', err);
      return res.status(500).json({ error: 'Failed to send message' });
    }

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('[contact] error:', err);
    return res.status(502).json({ error: 'Failed to send message' });
  }
});

module.exports = router;
