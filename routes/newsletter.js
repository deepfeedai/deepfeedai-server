/**
 * Deep Feed AI Admin — POST /api/newsletter/send
 * Fetches published articles, builds a branded HTML email, and sends it
 * to all Resend Audience subscribers via Resend Broadcasts API.
 *
 * Protected by admin JWT (same as other admin routes).
 * Also callable by Railway cron via CRON_SECRET header.
 *
 * Supports ?preview=true to return rendered HTML without sending.
 *
 * Env vars required:
 *   RESEND_API_KEY     — Full Access key from resend.com
 *   RESEND_AUDIENCE_ID — Audience ID from Resend dashboard
 *   CRON_SECRET        — Secret for Railway cron caller (optional)
 */
const express          = require('express');
const router           = express.Router();
const { getPool }      = require('../db');
const { serializeRow, asyncHandler } = require('../lib/utils');
const { auth } = require('../middleware/auth');

const TOP_N = 8; // articles to include per newsletter

// Auth: admin JWT OR cron secret
function cronOrAdmin(req, res, next) {
  const cronSecret = process.env.CRON_SECRET;
  const provided   = req.headers['x-cron-secret'] || req.body?.secret;
  if (cronSecret && provided === cronSecret) return next();
  return auth(req, res, next);
}

router.post('/send', cronOrAdmin, asyncHandler(async (req, res) => {
  const resendKey  = process.env.RESEND_API_KEY;
  const audienceId = process.env.RESEND_AUDIENCE_ID;

  if (!resendKey || !audienceId) {
    return res.status(500).json({ error: 'Missing Resend config' });
  }

  const preview = req.query.preview === 'true' || req.query.preview === '1';

  // Fetch published articles directly from DB
  const dbResult = await getPool().query(
    `SELECT * FROM articles
     WHERE is_published = 1 AND (is_archived = 0 OR is_archived IS NULL)
     ORDER BY published_at DESC
     LIMIT 50`
  );
  const raw = dbResult.rows.map(serializeRow);

  const articles = raw
    .filter(a => a.title && a.source_url)
    .sort((a, b) => new Date(b.published_at) - new Date(a.published_at))
    .slice(0, TOP_N)
    .map(a => ({
      title:       a.title,
      description: a.summary || '',
      url:         a.source_url,
      source:      a.source || '',
      publishedAt: a.published_at,
      category:    a.category || 'Industry',
      imageUrl:    a.image_url || null,
    }));

  if (articles.length === 0) {
    return res.status(500).json({ error: 'No published articles found' });
  }

  const subject = '🤖 Deep Feed AI — Your Weekly AI Digest';
  const html    = buildEmail(articles);

  // Preview mode — return rendered HTML
  if (preview) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  }

  // Create broadcast
  const createRes = await fetch('https://api.resend.com/broadcasts', {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      audience_id: audienceId,
      from:        'Deep Feed AI <newsletter@deepfeedai.com>',
      reply_to:    'hello@deepfeedai.com',
      subject,
      html,
    }),
  });

  if (!createRes.ok) {
    const err = await createRes.text();
    console.error('[newsletter] create broadcast failed:', err);
    return res.status(500).json({ error: 'Failed to create broadcast', detail: err });
  }

  const { id: broadcastId } = await createRes.json();

  // Send broadcast
  const sendRes = await fetch(`https://api.resend.com/broadcasts/${broadcastId}/send`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({}),
  });

  if (!sendRes.ok) {
    const err = await sendRes.text();
    console.error('[newsletter] send broadcast failed:', err);
    return res.status(500).json({ error: 'Failed to send broadcast', detail: err });
  }

  console.log(`[newsletter] sent broadcast ${broadcastId} with ${articles.length} articles`);
  return res.status(200).json({ success: true, broadcastId, articleCount: articles.length });
}));

// ── Email builder ─────────────────────────────────────────────────────────────

function buildEmail(articles) {
  const date  = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const cards = articles.map(articleCard).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Deep Feed AI — Weekly Digest</title>
</head>
<body style="margin:0;padding:0;background:#0d0d1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0d0d1a;">
  <tr><td align="center" style="padding:32px 16px;">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

      <!-- Header -->
      <tr><td style="background:linear-gradient(135deg,#1a0a2e 0%,#0d1a3a 100%);border-radius:16px 16px 0 0;padding:40px 32px;text-align:center;border-bottom:2px solid #7c3aed;">
        <div style="font-size:40px;margin-bottom:8px;">🤖</div>
        <h1 style="margin:0;font-size:28px;font-weight:800;background:linear-gradient(90deg,#a855f7,#22d3ee);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;">Deep Feed AI</h1>
        <p style="margin:8px 0 0;color:#94a3b8;font-size:14px;">Your Weekly AI News Digest &nbsp;·&nbsp; ${date}</p>
      </td></tr>

      <!-- Intro -->
      <tr><td style="background:#111827;padding:24px 32px;border-left:1px solid #1e293b;border-right:1px solid #1e293b;">
        <p style="margin:0;color:#cbd5e1;font-size:15px;line-height:1.6;">Here are the top AI stories from the past week — curated and delivered straight to your inbox. Click any headline to read the full article.</p>
      </td></tr>

      <!-- Articles -->
      ${cards}

      <!-- CTA -->
      <tr><td style="background:#111827;padding:24px 32px;text-align:center;border-left:1px solid #1e293b;border-right:1px solid #1e293b;">
        <a href="https://deepfeedai.com" style="display:inline-block;background:linear-gradient(135deg,#7c3aed,#0ea5e9);color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 32px;border-radius:8px;">View Full Feed →</a>
      </td></tr>

      <!-- Footer -->
      <tr><td style="background:#0d0d1a;border-radius:0 0 16px 16px;padding:24px 32px;text-align:center;border:1px solid #1e293b;border-top:none;">
        <p style="margin:0 0 8px;color:#475569;font-size:13px;">You're receiving this because you subscribed at <a href="https://deepfeedai.com" style="color:#7c3aed;text-decoration:none;">deepfeedai.com</a></p>
        <p style="margin:0;color:#475569;font-size:13px;"><a href="{{{RESEND_UNSUBSCRIBE_URL}}}" style="color:#475569;">Unsubscribe</a></p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function articleCard(article) {
  const cat      = article.category || 'AI';
  const catColor = { LLMs: '#7c3aed', 'Image AI': '#0ea5e9', Research: '#10b981', Tools: '#f59e0b', Business: '#f97316', Policy: '#6366f1', Industry: '#ef4444', CyberSecurity: '#dc2626' }[cat] || '#7c3aed';
  const date     = article.publishedAt ? new Date(article.publishedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
  const summary  = article.description ? article.description.slice(0, 160) + (article.description.length > 160 ? '…' : '') : '';
  const link     = `https://deepfeedai.com/article?u=${encodeURIComponent(article.url)}&t=${encodeURIComponent(article.title)}&s=${encodeURIComponent(article.source || '')}&c=${encodeURIComponent(cat)}`;

  const thumbRow = article.imageUrl ? `
      <tr>
        <td style="padding-top:12px;">
          <img src="${article.imageUrl}" alt="" width="100%" style="border-radius:8px;display:block;max-height:200px;object-fit:cover;" />
        </td>
      </tr>` : '';

  return `
  <tr><td style="background:#111827;padding:0 32px 4px;border-left:1px solid #1e293b;border-right:1px solid #1e293b;">
    <table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #1e293b;padding:20px 0;">
      <tr>
        <td>
          <span style="display:inline-block;background:${catColor}22;color:${catColor};font-size:11px;font-weight:700;padding:3px 10px;border-radius:12px;letter-spacing:.5px;text-transform:uppercase;margin-bottom:8px;">${cat}</span>
          ${date ? `<span style="color:#475569;font-size:12px;margin-left:8px;">${date}</span>` : ''}
          <div style="margin-top:4px;">
            <a href="${link}" style="color:#e2e8f0;text-decoration:none;font-size:16px;font-weight:600;line-height:1.4;">${article.title}</a>
          </div>
          ${summary ? `<p style="margin:8px 0 0;color:#94a3b8;font-size:13px;line-height:1.5;">${summary}</p>` : ''}
          <div style="margin-top:10px;">
            <span style="color:#475569;font-size:12px;">${article.source || ''}</span>
            <a href="${link}" style="color:#7c3aed;font-size:12px;font-weight:600;text-decoration:none;margin-left:12px;">Read more →</a>
          </div>
        </td>
      </tr>${thumbRow}
    </table>
  </td></tr>`;
}

module.exports = router;
