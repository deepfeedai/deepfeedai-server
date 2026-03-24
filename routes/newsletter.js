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
const { requirePermission } = require('../middleware/permissions');
const { getSiteConfig } = require('../lib/site-config');
const { logUsage } = require('../lib/ai-usage');
const { getAppConfig } = require('../lib/app-config');
const { logAudit } = require('../middleware/audit');

const TOP_N = 8; // articles to include per newsletter

const { timingSafeEqual } = require('crypto');
const { getSecrets } = require('../lib/secrets');

function safeCompare(a, b) {
  if (!a || !b) return false;
  // Use HMAC comparison to avoid leaking secret length via timing
  const crypto = require('crypto');
  const macA = crypto.createHmac('sha256', 'safeCompare').update(a).digest();
  const macB = crypto.createHmac('sha256', 'safeCompare').update(b).digest();
  return timingSafeEqual(macA, macB);
}

// Auth: admin JWT OR cron secret
async function cronOrAdmin(req, res, next) {
  const { cronSecret } = await getSecrets();
  const provided = req.headers['x-cron-secret'];
  if (cronSecret && safeCompare(provided, cronSecret)) {
    // Cron jobs get full permissions
    req.user = { permissions: ['*'], type: 'cron' };
    return next();
  }
  return auth(req, res, next);
}

router.post('/send', cronOrAdmin, requirePermission('newsletter.send'), asyncHandler(async (req, res) => {
  const preview    = req.query.preview === 'true' || req.query.preview === '1';
  const appCfg     = await getAppConfig(req.tenantId);
  const resendKey  = appCfg.resend_api_key;
  const audienceId = appCfg.resend_audience_id;

  // Only require Resend config when actually sending (not for preview)
  if (!preview && (!resendKey || !audienceId)) {
    return res.status(500).json({ error: 'Missing Resend config' });
  }

  // Fetch published articles directly from DB
  const dbResult = await getPool().query(
    `SELECT * FROM articles
     WHERE tenant_id = $1 AND is_published = 1 AND (is_archived = 0 OR is_archived IS NULL)
     ORDER BY
       CASE WHEN content_type = 'deep-dive' THEN 0 ELSE 1 END,
       published_at DESC
     LIMIT 50`,
    [req.tenantId]
  );
  const raw = dbResult.rows.map(serializeRow);

  const articles = raw
    .filter(a => a.title && (a.source_url || a.content_type === 'deep-dive' || a.content_type === 'original') && a.category !== 'Uncategorized')
    .sort((a, b) => {
      // Deep dives first, then by date
      const aDD = a.content_type === 'deep-dive' ? 0 : 1;
      const bDD = b.content_type === 'deep-dive' ? 0 : 1;
      if (aDD !== bDD) return aDD - bDD;
      return new Date(b.published_at) - new Date(a.published_at);
    })
    .slice(0, TOP_N)
    .map(a => ({
      title:       a.title,
      description: a.summary || '',
      url:         a.source_url || `https://${appCfg.domain || 'deepfeedai.com'}/article/${a.slug}`,
      source:      a.source || '',
      publishedAt: a.published_at,
      category:    a.category || 'Industry',
      imageUrl:    a.image_url || null,
      contentType: a.content_type || null,
    }));

  if (articles.length === 0) {
    return res.status(500).json({ error: 'No published articles found' });
  }

  const site    = await getSiteConfig(req.tenantId);
  const subject = (req.body?.subject && String(req.body.subject).trim())
    || site.newsletter_subject
    || '🤖 Deep Feed AI — Your Weekly AI Digest';
  const html    = buildEmail(articles, site);

  // Preview mode — return rendered HTML
  if (preview) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  }

  // Create broadcast
  const _nlStart = Date.now();
  const createRes = await fetch('https://api.resend.com/broadcasts', {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      audience_id: audienceId,
      from:        `${site.email_from_name || 'Deep Feed AI'} <newsletter@${site.domain || 'deepfeedai.com'}>`,
      reply_to:    `hello@${site.domain || 'deepfeedai.com'}`,
      subject,
      html,
    }),
  });

  if (!createRes.ok) {
    const err = await createRes.text();
    console.error('[newsletter] create broadcast failed:', err);
    logUsage({ provider: 'resend', operation: 'newsletter', trigger: 'manual', durationMs: Date.now() - _nlStart, success: false, error: err, tenantId: req.tenantId }).catch(() => {});
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
    logUsage({ provider: 'resend', operation: 'newsletter', trigger: 'manual', durationMs: Date.now() - _nlStart, success: false, error: err, tenantId: req.tenantId }).catch(() => {});
    return res.status(500).json({ error: 'Failed to send broadcast', detail: err });
  }

  logUsage({ provider: 'resend', operation: 'newsletter', trigger: 'manual', emailCount: articles.length, durationMs: Date.now() - _nlStart, tenantId: req.tenantId }).catch(() => {});

  // Log to DB
  try {
    await getPool().query(
      `INSERT INTO newsletter_sends (tenant_id, subject, article_count, broadcast_id, status) VALUES ($1, $2, $3, $4, 'sent')`,
      [req.tenantId, subject, articles.length, broadcastId]
    );
  } catch (e) {
    console.error('[newsletter] failed to log send:', e.message);
  }

  await logAudit(req, 'newsletter.send', 'newsletter', null, { subject, articleCount: articles.length, broadcastId });
  console.log(`[newsletter] sent broadcast ${broadcastId} with ${articles.length} articles`);
  return res.status(200).json({ success: true, broadcastId, articleCount: articles.length });
}));

// GET /api/newsletter/history — last 20 sends
router.get('/history', auth, requirePermission('newsletter.read'), asyncHandler(async (req, res) => {
  const result = await getPool().query(
    `SELECT id, sent_at, subject, article_count, broadcast_id, status
     FROM newsletter_sends
     WHERE tenant_id = $1
     ORDER BY sent_at DESC
     LIMIT 20`,
    [req.tenantId]
  );
  return res.json(result.rows);
}));

// ── Email builder ─────────────────────────────────────────────────────────────

function buildEmail(articles, site = {}) {
  const date      = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const siteName  = site.name || 'Deep Feed AI';
  const logoEmoji = site.logo_emoji || '🤖';
  const siteUrl   = (site.url || 'https://deepfeedai.com').replace(/\/$/, '');
  const domain    = site.domain || 'deepfeedai.com';
  const catColors = {};
  if (Array.isArray(site.categories)) {
    for (const c of site.categories) catColors[c.name] = c.color;
  }
  const cards = articles.map(a => articleCard(a, siteUrl, catColors)).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${siteName} — Weekly Digest</title>
</head>
<body style="margin:0;padding:0;background:#0d0d1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0d0d1a;">
  <tr><td align="center" style="padding:32px 16px;">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

      <!-- Header -->
      <tr><td style="background:linear-gradient(135deg,#1a0a2e 0%,#0d1a3a 100%);border-radius:16px 16px 0 0;padding:40px 32px;text-align:center;border-bottom:2px solid #7c3aed;">
        <div style="font-size:40px;margin-bottom:8px;">${logoEmoji}</div>
        <h1 style="margin:0;font-size:28px;font-weight:800;background:linear-gradient(90deg,#a855f7,#22d3ee);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;">${siteName}</h1>
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
        <a href="${siteUrl}" style="display:inline-block;background:linear-gradient(135deg,#7c3aed,#0ea5e9);color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 32px;border-radius:8px;">View Full Feed →</a>
      </td></tr>

      <!-- Footer -->
      <tr><td style="background:#0d0d1a;border-radius:0 0 16px 16px;padding:24px 32px;text-align:center;border:1px solid #1e293b;border-top:none;">
        <p style="margin:0 0 8px;color:#475569;font-size:13px;">You're receiving this because you subscribed at <a href="${siteUrl}" style="color:#7c3aed;text-decoration:none;">${domain}</a></p>
        <p style="margin:0;color:#475569;font-size:13px;"><a href="{{{RESEND_UNSUBSCRIBE_URL}}}" style="color:#475569;">Unsubscribe</a></p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function articleCard(article, siteUrl = 'https://deepfeedai.com', catColors = {}) {
  const cat      = article.category || 'AI';
  const fallbackColors = { LLMs: '#7c3aed', 'Image AI': '#0ea5e9', Research: '#10b981', Tools: '#f59e0b', Business: '#f97316', Policy: '#6366f1', Industry: '#ef4444', CyberSecurity: '#dc2626' };
  const catColor = catColors[cat] || fallbackColors[cat] || '#7c3aed';
  const date     = article.publishedAt ? new Date(article.publishedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
  const summary  = article.description ? article.description.slice(0, 160) + (article.description.length > 160 ? '…' : '') : '';
  const link     = `${siteUrl}/article?u=${encodeURIComponent(article.url)}&t=${encodeURIComponent(article.title)}&s=${encodeURIComponent(article.source || '')}&c=${encodeURIComponent(cat)}`;

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
