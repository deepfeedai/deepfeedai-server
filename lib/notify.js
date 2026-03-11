/**
 * Deep Feed AI — lib/notify.js
 * Transactional email notifications via Resend REST API.
 *
 * Uses Node's built-in https — no extra npm package required.
 *
 * Required env var:
 *   RESEND_API_KEY  — get one free at resend.com (3,000 emails/month)
 *
 * Optional env var:
 *   NOTIFY_FROM     — sender address (default: notifications@deepfeedai.com)
 *                     Must be from a domain verified in Resend.
 */

'use strict';

const https = require('https');

const RESEND_API = 'api.resend.com';
const FROM_ADDR  = process.env.NOTIFY_FROM || 'Deep Feed AI <notifications@deepfeedai.com>';
const SITE_URL   = (process.env.MAIN_SITE_URL || 'https://deepfeedai.com').replace(/\/$/, '');

/**
 * Low-level: POST to Resend API.
 */
function resendSend(payload, apiKey) {
  return new Promise((resolve, reject) => {
    const body    = JSON.stringify(payload);
    const options = {
      hostname: RESEND_API,
      path:     '/emails',
      method:   'POST',
      headers:  {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(raw);
          if (res.statusCode >= 400) return reject(new Error(data.message || `HTTP ${res.statusCode}`));
          resolve(data);
        } catch (e) { reject(e); }
      });
    });

    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Resend timeout')); });
    req.write(body);
    req.end();
  });
}

/**
 * Send a reply notification email.
 *
 * @param {object} opts
 *   opts.toEmail       — recipient email
 *   opts.toName        — recipient display name
 *   opts.replierName   — name of the person who replied
 *   opts.articleSlug   — article slug
 *   opts.articleTitle  — article title (for subject line)
 *   opts.replyBody     — excerpt of the reply (max 300 chars)
 *   opts.commentId     — original comment id (for deep link)
 *   opts.unsubToken    — unsubscribe token for opt-out link
 */
async function sendReplyNotification(opts) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[Notify] RESEND_API_KEY not set — skipping reply notification');
    return;
  }

  const articleUrl   = `${SITE_URL}/article/${opts.articleSlug}#comment-${opts.commentId}`;
  const unsubUrl     = `${SITE_URL}/api/notify/unsubscribe?token=${opts.unsubToken}`;
  const replyExcerpt = (opts.replyBody || '').slice(0, 300);
  const safeTitle    = (opts.articleTitle || 'an article').slice(0, 80);

  const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0f1117;font-family:'Inter',Arial,sans-serif;color:#f0f0f0;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f1117;padding:40px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

        <!-- Header -->
        <tr><td style="padding:0 0 24px 0;">
          <a href="${SITE_URL}" style="text-decoration:none;color:#00d9ff;font-size:18px;font-weight:700;">
            🤖 Deep Feed<span style="color:#00d9ff;">AI</span>
          </a>
        </td></tr>

        <!-- Card -->
        <tr><td style="background:#1a1d27;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:28px 32px;">
          <p style="margin:0 0 6px;font-size:13px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.08em;">
            💬 New Reply
          </p>
          <h1 style="margin:0 0 20px;font-size:20px;font-weight:700;line-height:1.3;color:#f0f0f0;">
            ${escHtml(opts.replierName)} replied to your comment
          </h1>

          <!-- Reply excerpt -->
          <div style="background:#0f1117;border-left:3px solid #00d9ff;border-radius:4px;padding:14px 16px;margin:0 0 24px;">
            <p style="margin:0;font-size:14px;color:#cbd5e1;line-height:1.6;">
              ${escHtml(replyExcerpt)}${replyExcerpt.length < (opts.replyBody || '').length ? '…' : ''}
            </p>
          </div>

          <p style="margin:0 0 20px;font-size:13px;color:#94a3b8;">
            On: <strong style="color:#f0f0f0;">${escHtml(safeTitle)}</strong>
          </p>

          <a href="${articleUrl}"
             style="display:inline-block;background:#00d9ff;color:#0f1117;font-weight:700;font-size:14px;
                    text-decoration:none;padding:12px 24px;border-radius:8px;">
            View Reply →
          </a>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:20px 0 0;font-size:12px;color:#475569;text-align:center;">
          You're receiving this because you commented on Deep Feed AI.<br>
          <a href="${unsubUrl}" style="color:#475569;text-decoration:underline;">Unsubscribe from reply notifications</a>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = `${opts.replierName} replied to your comment on Deep Feed AI.\n\n"${replyExcerpt}"\n\nView the reply: ${articleUrl}\n\nUnsubscribe: ${unsubUrl}`;

  await resendSend({
    from:    FROM_ADDR,
    to:      [`${opts.toName} <${opts.toEmail}>`],
    subject: `💬 ${opts.replierName} replied to your comment`,
    html,
    text,
  }, apiKey);
}

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

module.exports = { sendReplyNotification };
