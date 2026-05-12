/**
 * Deep Feed AI — /api/newsletter
 *
 * Draft workflow (v1.1.0):
 *   GET    /draft              — load today's draft (or ?date=YYYY-MM-DD)
 *   POST   /draft              — upsert draft (article_ids, subject, intro, format, audience)
 *   PATCH  /draft              — update draft status (skip, cancel)
 *   POST   /draft/suggest-intro   — AI-generated editorial intro
 *   POST   /draft/suggest-subject — AI-generated subject line
 *   GET    /candidates         — article pool for curation picker
 *
 * Send:
 *   POST   /send               — send using draft selection (or legacy auto-fetch)
 *   POST   /send?preview=true  — return HTML without sending
 *   GET    /preview            — cached public preview of latest newsletter
 *   GET    /history            — last 20 sends
 *
 * Reader (public user JWT):
 *   GET    /reader-status      — current subscription tier for logged-in reader
 *   POST   /reader-checkout    — create Stripe checkout for paid tier
 *   POST   /reader-portal      — create Stripe billing portal session
 *
 * Auth: admin JWT or cron secret (reader endpoints use public user JWT)
 */
const express             = require('express');
const router              = express.Router();
const { getPool }         = require('../db');
const { serializeRow, asyncHandler } = require('../lib/utils');
const { auth }            = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { getSiteConfig }   = require('../lib/site-config');
const { logUsage }        = require('../lib/ai-usage');
const { getAppConfig }    = require('../lib/app-config');
const { logAudit }        = require('../middleware/audit');
const { requireFeature }  = require('../middleware/feature-gate');
const { complete: aiComplete } = require('../lib/ai-router');
const { loadPrompt }      = require('../lib/prompt-loader');
const requireUser         = require('../middleware/user-jwt');
const { getStripeConfig } = require('../lib/stripe-config');

const TOP_N = 8;
const { timingSafeEqual } = require('crypto');
const { getSecrets }      = require('../lib/secrets');

function safeCompare(a, b) {
  if (!a || !b) return false;
  const crypto = require('crypto'); // already loaded; cached by module system
  const macA = crypto.createHmac('sha256', 'safeCompare').update(a).digest();
  const macB = crypto.createHmac('sha256', 'safeCompare').update(b).digest();
  return timingSafeEqual(macA, macB);
}

async function cronOrAdmin(req, res, next) {
  const { cronSecret } = await getSecrets();
  const provided = req.headers['x-cron-secret'];
  if (cronSecret && safeCompare(provided, cronSecret)) {
    req.user = { permissions: ['*'], type: 'cron' };
    return next();
  }
  return auth(req, res, next);
}

// ── Tenant-scoped preview cache ───────────────────────────────────────────────
const _previewCache = new Map(); // tenantId → { html, ts }
const PREVIEW_TTL   = 30 * 60 * 1000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayStr(tz = 'UTC') {
  return new Date().toLocaleDateString('en-CA', { timeZone: tz });
}

async function getTodayDraft(tenantId, format = 'daily', date) {
  const appCfg  = await getAppConfig(tenantId).catch(() => ({}));
  const tz      = appCfg.newsroom_timezone || 'UTC';
  const dateStr = date || todayStr(tz);
  return getPool().query(
    `SELECT * FROM newsletter_drafts WHERE tenant_id = $1 AND send_date = $2 AND format = $3 LIMIT 1`,
    [tenantId, dateStr, format]
  ).then(r => r.rows[0] ? serializeRow(r.rows[0]) : null);
}

async function getArticlesByIds(tenantId, ids) {
  if (!ids || !ids.length) return [];
  const appCfg = await getAppConfig(tenantId).catch(() => ({}));
  const result = await getPool().query(
    `SELECT a.*, w.name AS writer_name
     FROM articles a
     LEFT JOIN writers w ON w.id = a.writer_id AND w.tenant_id = a.tenant_id
     WHERE a.tenant_id = $1 AND a.id = ANY($2::int[]) AND a.is_published = 1`,
    [tenantId, ids]
  );
  // Preserve caller order
  const byId = Object.fromEntries(result.rows.map(serializeRow).map(r => [r.id, r]));
  const siteUrl = (appCfg.domain ? `https://${appCfg.domain}` : 'https://deepfeedai.com').replace(/\/$/, '');
  return ids.map(id => byId[id]).filter(Boolean).map(a => articleToEmailItem(a, siteUrl, appCfg));
}

function articleToEmailItem(a, siteUrl, appCfg = {}) {
  return {
    id:          a.id,
    title:       a.title,
    description: a.summary || '',
    url:         a.source_url || `${siteUrl}/article/${a.slug}`,
    source:      a.source || '',
    publishedAt: a.published_at,
    category:    a.category || 'Industry',
    imageUrl:    a.image_url || null,
    contentType: a.content_type || null,
    tier:        a.importance || 'standard',
  };
}

async function fetchCandidates(tenantId) {
  const appCfg  = await getAppConfig(tenantId).catch(() => ({}));
  const siteUrl = (appCfg.domain ? `https://${appCfg.domain}` : 'https://deepfeedai.com').replace(/\/$/, '');

  // Last sent draft's article_ids — exclude from candidates to avoid repeats
  const lastSent = await getPool().query(
    `SELECT article_ids FROM newsletter_drafts
     WHERE tenant_id = $1 AND sent_at IS NOT NULL
     ORDER BY sent_at DESC LIMIT 1`,
    [tenantId]
  );
  const excludeIds = lastSent.rows[0]?.article_ids || [];

  const result = await getPool().query(
    `SELECT a.*, w.name AS writer_name
     FROM articles a
     LEFT JOIN writers w ON w.id = a.writer_id AND w.tenant_id = a.tenant_id
     WHERE a.tenant_id = $1
       AND a.is_published = 1
       AND (a.is_archived = 0 OR a.is_archived IS NULL)
       AND a.content_type IN ('original', 'deep-dive')
       AND a.category != 'Uncategorized'
       AND a.published_at >= NOW() - INTERVAL '48 hours'
       AND ($2::int[] IS NULL OR a.id != ALL($2::int[]))
     ORDER BY
       CASE WHEN a.importance = 'breaking' THEN 0
            WHEN a.importance = 'major'    THEN 1
            WHEN a.importance = 'trending' THEN 2
            ELSE 3 END,
       a.published_at DESC
     LIMIT 20`,
    [tenantId, excludeIds.length ? excludeIds : null]
  );
  return result.rows.map(serializeRow).map(a => articleToEmailItem(a, siteUrl, appCfg));
}

// ── GET /reader-status — public user's newsletter tier for this tenant ────────
router.get('/reader-status', requireUser, requireFeature('newsletter'), asyncHandler(async (req, res) => {
  const row = await getPool().query(
    `SELECT tier, stripe_status FROM newsletter_subscriptions
     WHERE public_user_id = $1 AND tenant_id = $2`,
    [req.user.sub, req.tenantId]
  ).then(r => r.rows[0] || null);

  const appCfg = await getAppConfig(req.tenantId).catch(() => ({}));
  const hasPaidConfig = !!(appCfg.newsletter_paid_price_id);
  return res.json({
    tier:         row?.tier || 'free',
    stripeStatus: row?.stripe_status || null,
    email:        req.user.email || null,
    paidAvailable: hasPaidConfig,
  });
}));

// ── POST /reader-checkout — create Stripe checkout for paid newsletter tier ───
router.post('/reader-checkout', requireUser, requireFeature('newsletter'), asyncHandler(async (req, res) => {
  const appCfg  = await getAppConfig(req.tenantId);
  const priceId = appCfg.newsletter_paid_price_id;
  if (!priceId) return res.status(503).json({ error: 'Paid newsletter not available for this site.' });

  const { secretKey } = await getStripeConfig();
  if (!secretKey) return res.status(503).json({ error: 'Billing not configured.' });

  const site    = await getSiteConfig(req.tenantId);
  const siteUrl = (site.url || appCfg.main_site_url || 'https://deepfeedai.com').replace(/\/$/, '');
  const stripe  = require('stripe')(secretKey);

  // Atomically claim the (user, tenant) slot before touching Stripe to avoid duplicate customers
  // on concurrent requests. ON CONFLICT returns the existing stripe_customer_id if already set.
  const lock = await getPool().query(
    `INSERT INTO newsletter_subscriptions (public_user_id, tenant_id, tier, stripe_status, updated_at)
     VALUES ($1, $2, 'free', 'pending_checkout', NOW())
     ON CONFLICT (public_user_id, tenant_id) DO UPDATE SET updated_at = NOW()
     RETURNING stripe_customer_id`,
    [req.user.sub, req.tenantId]
  );

  let customerId = lock.rows[0]?.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email:    req.user.email || undefined,
      name:     req.user.displayName || undefined,
      metadata: { public_user_id: String(req.user.sub), tenant_id: String(req.tenantId) },
    });
    customerId = customer.id;
    // Store the new customer ID so concurrent retries reuse it
    await getPool().query(
      `UPDATE newsletter_subscriptions SET stripe_customer_id = $1, updated_at = NOW()
       WHERE public_user_id = $2 AND tenant_id = $3`,
      [customerId, req.user.sub, req.tenantId]
    );
  }

  const session = await stripe.checkout.sessions.create({
    mode:       'subscription',
    customer:   customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${siteUrl}/newsletter?nl_success=1`,
    cancel_url:  `${siteUrl}/newsletter`,
    metadata: {
      type:           'newsletter_reader',
      public_user_id: String(req.user.sub),
      tenant_id:      String(req.tenantId),
    },
  });

  return res.json({ url: session.url });
}));

// ── POST /reader-portal — Stripe customer portal for subscription management ──
router.post('/reader-portal', requireUser, requireFeature('newsletter'), asyncHandler(async (req, res) => {
  const sub = await getPool().query(
    `SELECT stripe_customer_id FROM newsletter_subscriptions
     WHERE public_user_id = $1 AND tenant_id = $2 AND stripe_customer_id IS NOT NULL`,
    [req.user.sub, req.tenantId]
  ).then(r => r.rows[0]);

  if (!sub) return res.status(404).json({ error: 'No active subscription found.' });

  const { secretKey } = await getStripeConfig();
  if (!secretKey) return res.status(503).json({ error: 'Billing not configured.' });

  const appCfg  = await getAppConfig(req.tenantId).catch(() => ({}));
  const site    = await getSiteConfig(req.tenantId);
  const siteUrl = (site.url || appCfg.main_site_url || 'https://deepfeedai.com').replace(/\/$/, '');
  const stripe  = require('stripe')(secretKey);

  const session = await stripe.billingPortal.sessions.create({
    customer:   sub.stripe_customer_id,
    return_url: `${siteUrl}/newsletter`,
  });

  return res.json({ url: session.url });
}));

// ── GET /candidates ───────────────────────────────────────────────────────────
router.get('/candidates', auth, requirePermission('newsletter.send'), requireFeature('newsletter'), asyncHandler(async (req, res) => {
  const candidates = await fetchCandidates(req.tenantId);
  return res.json(candidates);
}));

// ── GET /draft ────────────────────────────────────────────────────────────────
router.get('/draft', auth, requirePermission('newsletter.send'), requireFeature('newsletter'), asyncHandler(async (req, res) => {
  const format = req.query.format || 'daily';
  const date   = req.query.date;
  const draft  = await getTodayDraft(req.tenantId, format, date);
  return res.json(draft || null);
}));

// ── POST /draft — upsert ──────────────────────────────────────────────────────
router.post('/draft', auth, requirePermission('newsletter.send'), requireFeature('newsletter'), asyncHandler(async (req, res) => {
  const VALID_FORMATS   = ['daily', 'weekly'];
  const VALID_AUDIENCES = ['all', 'paid'];
  const { article_ids, subject, intro, story_arc, date } = req.body || {};
  const format   = VALID_FORMATS.includes(req.body?.format)     ? req.body.format    : 'daily';
  const audience = VALID_AUDIENCES.includes(req.body?.audience) ? req.body.audience  : 'all';
  const appCfg  = await getAppConfig(req.tenantId).catch(() => ({}));
  const tz      = appCfg.newsroom_timezone || 'UTC';
  const dateStr = (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : todayStr(tz);

  const ids = Array.isArray(article_ids) && article_ids.length
    ? article_ids.map(Number).filter(n => Number.isInteger(n) && n > 0)
    : null;

  const result = await getPool().query(
    `INSERT INTO newsletter_drafts (tenant_id, send_date, format, article_ids, subject, intro, story_arc, audience, status, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', NOW())
     ON CONFLICT (tenant_id, send_date, format) DO UPDATE
       SET article_ids = COALESCE(EXCLUDED.article_ids, newsletter_drafts.article_ids),
           subject     = COALESCE(EXCLUDED.subject, newsletter_drafts.subject),
           intro       = COALESCE(EXCLUDED.intro, newsletter_drafts.intro),
           story_arc   = COALESCE(EXCLUDED.story_arc, newsletter_drafts.story_arc),
           audience    = EXCLUDED.audience,
           status      = CASE WHEN newsletter_drafts.status = 'sent' THEN newsletter_drafts.status ELSE 'pending' END,
           updated_at  = NOW()
     RETURNING *`,
    [req.tenantId, dateStr, format, ids || null, subject || null, intro || null, story_arc || null, audience]
  );
  return res.json(serializeRow(result.rows[0]));
}));

// ── PATCH /draft — status update (skip / cancel) ──────────────────────────────
router.patch('/draft', auth, requirePermission('newsletter.send'), requireFeature('newsletter'), asyncHandler(async (req, res) => {
  const VALID_FORMATS = ['daily', 'weekly'];
  const { status, date } = req.body || {};
  const format = VALID_FORMATS.includes(req.body?.format) ? req.body.format : 'daily';
  if (!['skipped', 'cancelled', 'pending'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  const appCfg  = await getAppConfig(req.tenantId).catch(() => ({}));
  const tz      = appCfg.newsroom_timezone || 'UTC';
  const dateStr = (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : todayStr(tz);

  const result = await getPool().query(
    `UPDATE newsletter_drafts SET status = $1, updated_at = NOW()
     WHERE tenant_id = $2 AND send_date = $3 AND format = $4
     RETURNING *`,
    [status, req.tenantId, dateStr, format]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'No draft found' });
  return res.json(serializeRow(result.rows[0]));
}));

// ── POST /draft/suggest-intro ─────────────────────────────────────────────────
router.post('/draft/suggest-intro', auth, requirePermission('newsletter.send'), requireFeature('newsletter'), asyncHandler(async (req, res) => {
  const { article_ids } = req.body || {};
  if (!Array.isArray(article_ids) || !article_ids.length) {
    return res.status(400).json({ error: 'article_ids required' });
  }

  const articles = await getArticlesByIds(req.tenantId, article_ids.map(Number));
  if (!articles.length) return res.status(400).json({ error: 'No valid articles found' });

  const site     = await getSiteConfig(req.tenantId);
  const stories  = articles.map((a, i) => `${i + 1}. ${a.title}`).join('\n');
  const prompt   = await loadPrompt('newsletter-intro', { siteName: site.name || 'Deep Feed AI', stories });

  const result = await aiComplete({
    operation: 'newsletter-intro',
    tenantId:  req.tenantId,
    messages:  [{ role: 'user', content: prompt }],
  });

  return res.json({ intro: result.text.trim() });
}));

// ── POST /draft/suggest-subject ───────────────────────────────────────────────
router.post('/draft/suggest-subject', auth, requirePermission('newsletter.send'), requireFeature('newsletter'), asyncHandler(async (req, res) => {
  const { article_ids } = req.body || {};
  if (!Array.isArray(article_ids) || !article_ids.length) {
    return res.status(400).json({ error: 'article_ids required' });
  }

  const articles = await getArticlesByIds(req.tenantId, article_ids.map(Number));
  if (!articles.length) return res.status(400).json({ error: 'No valid articles found' });

  const stories = articles.slice(0, 5).map((a, i) => `${i + 1}. ${a.title}`).join('\n');
  const prompt  = await loadPrompt('newsletter-subject', { stories });

  const result = await aiComplete({
    operation: 'newsletter-subject',
    tenantId:  req.tenantId,
    messages:  [{ role: 'user', content: prompt }],
  });

  return res.json({ subject: result.text.trim().replace(/^["']|["']$/g, '') });
}));

// ── POST /draft/suggest-story-arc (Phase 4 — weekly) ─────────────────────────
router.post('/draft/suggest-story-arc', auth, requirePermission('newsletter.send'), requireFeature('newsletter'), asyncHandler(async (req, res) => {
  const { article_ids } = req.body || {};
  if (!Array.isArray(article_ids) || !article_ids.length) {
    return res.status(400).json({ error: 'article_ids required' });
  }

  const articles = await getArticlesByIds(req.tenantId, article_ids.map(Number));
  if (!articles.length) return res.status(400).json({ error: 'No valid articles found' });

  const site     = await getSiteConfig(req.tenantId);
  const articleList = articles.map((a, i) => `${i + 1}. ${a.title} (${a.publishedAt ? new Date(a.publishedAt).toLocaleDateString() : ''})`).join('\n');
  const prompt   = await loadPrompt('newsletter-story-arc', { siteName: site.name || 'Deep Feed AI', articles: articleList });

  const result = await aiComplete({
    operation: 'newsletter-story-arc',
    tenantId:  req.tenantId,
    messages:  [{ role: 'user', content: prompt }],
  });

  return res.json({ storyArc: result.text.trim() });
}));

// ── POST /send ────────────────────────────────────────────────────────────────
router.post('/send', cronOrAdmin, requirePermission('newsletter.send'), requireFeature('newsletter'), asyncHandler(async (req, res) => {
  const preview    = req.query.preview === 'true' || req.query.preview === '1';
  const appCfg     = await getAppConfig(req.tenantId);
  const resendKey  = appCfg.resend_api_key;

  // Resolve format, audience, and article selection
  const VALID_FORMATS   = ['daily', 'weekly'];
  const VALID_AUDIENCES = ['all', 'paid'];
  const { article_ids, subject: bodySubject, intro: bodyIntro, story_arc: bodyStoryArc } = req.body || {};
  const format   = VALID_FORMATS.includes(req.body?.format)     ? req.body.format    : 'daily';
  const audience = VALID_AUDIENCES.includes(req.body?.audience) ? req.body.audience  : 'all';

  // Fail explicitly when paid audience selected but not configured — avoid silently blasting free list
  if (!preview && audience === 'paid' && !appCfg.resend_paid_audience_id) {
    return res.status(400).json({ error: 'Paid newsletter audience is not configured. Set resend_paid_audience_id in settings before sending to paid subscribers.' });
  }

  const audienceId = audience === 'paid'
    ? appCfg.resend_paid_audience_id
    : appCfg.resend_audience_id;

  if (!preview && (!resendKey || !audienceId)) {
    return res.status(500).json({ error: 'Missing Resend config (resend_api_key and resend_audience_id required)' });
  }

  let articles = [];
  let draftId  = null;

  if (Array.isArray(article_ids) && article_ids.length) {
    articles = await getArticlesByIds(req.tenantId, article_ids.map(Number));
  } else {
    // Try today's draft
    const draft = await getTodayDraft(req.tenantId, format);
    if (draft && draft.article_ids && draft.article_ids.length) {
      articles = await getArticlesByIds(req.tenantId, draft.article_ids);
      draftId  = draft.id;
    }
  }

  // Fallback: auto-fetch latest articles
  if (!articles.length) {
    articles = await _autoFetchArticles(req.tenantId, appCfg);
  }

  if (!articles.length) {
    return res.status(500).json({ error: 'No published articles found' });
  }

  const site    = await getSiteConfig(req.tenantId);
  const subject = (bodySubject && String(bodySubject).trim())
    || site.newsletter_subject
    || '🤖 Deep Feed AI — Your Daily AI Digest';

  const intro = bodyIntro || null;
  const isWeekly = format === 'weekly';
  const html = isWeekly
    ? buildWeeklyEmail(articles, site, intro, bodyStoryArc || null)
    : buildEmail(articles, site, intro);

  if (preview) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  }

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

  // Record broadcastId on the draft immediately so it's recoverable if the send call fails
  if (draftId) {
    getPool().query(
      `UPDATE newsletter_drafts SET sent_broadcast_id = $1, updated_at = NOW() WHERE id = $2`,
      [broadcastId, draftId]
    ).catch(e => console.error('[newsletter] failed to record broadcastId on draft:', e.message));
  }

  const sendRes = await fetch(`https://api.resend.com/broadcasts/${broadcastId}/send`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({}),
  });

  if (!sendRes.ok) {
    const err = await sendRes.text();
    console.error('[newsletter] send broadcast failed, broadcastId=' + broadcastId + ':', err);
    logUsage({ provider: 'resend', operation: 'newsletter', trigger: 'manual', durationMs: Date.now() - _nlStart, success: false, error: err, tenantId: req.tenantId }).catch(() => {});
    return res.status(500).json({ error: 'Failed to send broadcast', detail: err, broadcastId });
  }

  logUsage({ provider: 'resend', operation: 'newsletter', trigger: req.user?.type === 'cron' ? 'cron' : 'manual', emailCount: articles.length, durationMs: Date.now() - _nlStart, tenantId: req.tenantId }).catch(() => {});

  // Mark draft as sent and record broadcast ID + audience
  if (draftId) {
    await getPool().query(
      `UPDATE newsletter_drafts SET status = 'sent', sent_at = NOW(), sent_broadcast_id = $1, audience = $2, updated_at = NOW() WHERE id = $3`,
      [broadcastId, audience, draftId]
    ).catch(e => console.error('[newsletter] draft update failed:', e.message));
  }

  // Log to newsletter_sends
  try {
    await getPool().query(
      `INSERT INTO newsletter_sends (tenant_id, subject, article_count, broadcast_id, status, audience, sent_at)
       VALUES ($1, $2, $3, $4, 'sent', $5, NOW())`,
      [req.tenantId, subject, articles.length, broadcastId, audience]
    );
  } catch (e) {
    console.error('[newsletter] failed to log send:', e.message);
  }

  // Bust preview cache for this tenant
  _previewCache.delete(req.tenantId);

  await logAudit(req, 'newsletter.send', 'newsletter', null, { subject, articleCount: articles.length, broadcastId, format, audience, draftId });
  console.log(`[newsletter] sent broadcast ${broadcastId} (${format}, audience=${audience}) with ${articles.length} articles (tenant ${req.tenantId})`);
  return res.status(200).json({ success: true, broadcastId, articleCount: articles.length, audience });
}));

// ── GET /preview — public cached preview ──────────────────────────────────────
router.get('/preview', asyncHandler(async (req, res) => {
  const now    = Date.now();
  const cached = _previewCache.get(req.tenantId);
  if (cached?.html && (now - cached.ts) < PREVIEW_TTL) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(cached.html);
  }

  const appCfg   = await getAppConfig(req.tenantId);
  const articles = await _autoFetchArticles(req.tenantId, appCfg);

  if (!articles.length) {
    return res.status(200).send('<p style="color:#94a3b8;text-align:center;padding:2rem;">No newsletter preview available yet.</p>');
  }

  const site = await getSiteConfig(req.tenantId);
  const html = buildEmail(articles, site, null);
  _previewCache.set(req.tenantId, { html, ts: now });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(html);
}));

// ── GET /history ──────────────────────────────────────────────────────────────
router.get('/history', auth, requirePermission('newsletter.read'), asyncHandler(async (req, res) => {
  const result = await getPool().query(
    `SELECT id, sent_at, subject, article_count, broadcast_id, status, audience
     FROM newsletter_sends
     WHERE tenant_id = $1
     ORDER BY sent_at DESC
     LIMIT 20`,
    [req.tenantId]
  );
  return res.json(result.rows);
}));

// ── Internal: auto-draft cron helper ─────────────────────────────────────────
async function createAutoDraft(tenantId, format = 'daily') {
  const appCfg  = await getAppConfig(tenantId).catch(() => ({}));
  const tz      = appCfg.newsroom_timezone || 'UTC';
  const dateStr = todayStr(tz);

  // Skip if a draft already exists for today
  const existing = await getPool().query(
    `SELECT id, status FROM newsletter_drafts WHERE tenant_id = $1 AND send_date = $2 AND format = $3`,
    [tenantId, dateStr, format]
  );
  if (existing.rows.length) return { skipped: true, reason: 'draft_exists', status: existing.rows[0].status };

  const candidates = await fetchCandidates(tenantId);
  const selected   = candidates.slice(0, TOP_N).map(a => a.id);

  if (!selected.length) return { skipped: true, reason: 'no_candidates' };

  const insertResult = await getPool().query(
    `INSERT INTO newsletter_drafts (tenant_id, send_date, format, article_ids, status)
     VALUES ($1, $2, $3, $4, 'pending')
     ON CONFLICT (tenant_id, send_date, format) DO NOTHING`,
    [tenantId, dateStr, format, selected]
  );

  // Only notify if we actually created a new draft (not a no-op conflict)
  if (!insertResult.rowCount) return { skipped: true, reason: 'draft_exists_race' };

  // Notify editors with newsletter.send permission
  try {
    const { notify } = require('../lib/notifications');
    const editors = await getPool().query(
      `SELECT id FROM users WHERE tenant_id = $1 AND is_active = 1 AND role IN ('owner', 'admin', 'editor', 'superadmin')`,
      [tenantId]
    ).then(r => r.rows);

    for (const ed of editors) {
      notify({
        tenantId,
        userId:  ed.id,
        kind:    'newsletter_draft_ready',
        title:   'Newsletter draft ready',
        body:    `${selected.length} articles curated for today's ${format} newsletter. Review and send by 7:30 AM or it will send automatically.`,
        payload: { format, articleCount: selected.length, date: dateStr },
      }).catch(() => {});
    }
  } catch (err) {
    console.warn('[newsletter] draft notification failed (non-fatal):', err.message);
  }

  console.log(`[newsletter] auto-draft created (tenant ${tenantId}, ${format}, ${selected.length} articles)`);
  return { created: true, articleCount: selected.length, date: dateStr };
}

// ── Internal: auto-send cron helper ──────────────────────────────────────────
async function autoSendPendingDraft(tenantId, format = 'daily') {
  const appCfg  = await getAppConfig(tenantId).catch(() => ({}));
  const tz      = appCfg.newsroom_timezone || 'UTC';
  const dateStr = todayStr(tz);
  const resendKey = appCfg.resend_api_key;

  if (!resendKey || !appCfg.resend_audience_id) return { skipped: true, reason: 'no_resend_config' };

  // Only send if draft is pending AND hasn't been edited in the last 5 minutes
  const draft = await getPool().query(
    `SELECT * FROM newsletter_drafts
     WHERE tenant_id = $1 AND send_date = $2 AND format = $3
       AND status = 'pending'
       AND updated_at < NOW() - INTERVAL '5 minutes'`,
    [tenantId, dateStr, format]
  ).then(r => r.rows[0] ? serializeRow(r.rows[0]) : null);

  if (!draft) return { skipped: true, reason: 'no_pending_draft_or_recently_edited' };

  const articles = await getArticlesByIds(tenantId, draft.article_ids || []);
  if (!articles.length) {
    await getPool().query(
      `UPDATE newsletter_drafts SET status = 'skipped', updated_at = NOW() WHERE id = $1`,
      [draft.id]
    );
    return { skipped: true, reason: 'no_valid_articles' };
  }

  const site    = await getSiteConfig(tenantId);
  const subject = draft.subject || site.newsletter_subject || '🤖 Deep Feed AI — Your Daily AI Digest';
  const html    = format === 'weekly'
    ? buildWeeklyEmail(articles, site, draft.intro, draft.story_arc || null)
    : buildEmail(articles, site, draft.intro);

  // Resolve audience from draft; fail explicitly rather than silently blasting the free list
  const draftAudience = draft.audience || 'all';
  if (draftAudience === 'paid' && !appCfg.resend_paid_audience_id) {
    return { skipped: true, reason: 'paid_audience_not_configured' };
  }
  const audienceId = draftAudience === 'paid'
    ? appCfg.resend_paid_audience_id
    : appCfg.resend_audience_id;

  const _start = Date.now();
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
    console.error(`[newsletter] auto-send create broadcast failed (tenant ${tenantId}):`, err);
    return { error: err };
  }

  const { id: broadcastId } = await createRes.json();

  // Record broadcastId immediately so it's recoverable even if the send call below fails
  await getPool().query(
    `UPDATE newsletter_drafts SET sent_broadcast_id = $1, updated_at = NOW() WHERE id = $2`,
    [broadcastId, draft.id]
  ).catch(e => console.error('[newsletter] failed to record broadcastId:', e.message));

  const sendRes = await fetch(`https://api.resend.com/broadcasts/${broadcastId}/send`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({}),
  });

  if (!sendRes.ok) {
    const err = await sendRes.text();
    console.error(`[newsletter] auto-send send broadcast failed (tenant ${tenantId}), broadcastId=${broadcastId}:`, err);
    // Mark as send_failed so the cron doesn't retry endlessly
    await getPool().query(
      `UPDATE newsletter_drafts SET status = 'send_failed', updated_at = NOW() WHERE id = $1`,
      [draft.id]
    ).catch(() => {});
    return { error: err, broadcastId };
  }

  logUsage({ provider: 'resend', operation: 'newsletter', trigger: 'cron', emailCount: articles.length, durationMs: Date.now() - _start, tenantId }).catch(() => {});

  await getPool().query(
    `UPDATE newsletter_drafts SET status = 'sent', sent_at = NOW(), sent_broadcast_id = $1, updated_at = NOW() WHERE id = $2`,
    [broadcastId, draft.id]
  );

  try {
    await getPool().query(
      `INSERT INTO newsletter_sends (tenant_id, subject, article_count, broadcast_id, status, audience, sent_at)
       VALUES ($1, $2, $3, $4, 'sent', $5, NOW())`,
      [tenantId, subject, articles.length, broadcastId, draftAudience]
    );
  } catch (e) {
    console.error('[newsletter] failed to log auto-send:', e.message);
  }

  _previewCache.delete(tenantId);
  console.log(`[newsletter] auto-sent broadcast ${broadcastId} (tenant ${tenantId}, ${format}, audience=${draftAudience}, ${articles.length} articles)`);
  return { sent: true, broadcastId, articleCount: articles.length, audience: draftAudience };
}

// ── Auto-fetch fallback (legacy behaviour) ────────────────────────────────────
async function _autoFetchArticles(tenantId, appCfg) {
  const siteUrl = (appCfg?.domain ? `https://${appCfg.domain}` : 'https://deepfeedai.com').replace(/\/$/, '');
  const result = await getPool().query(
    `SELECT a.* FROM articles a
     WHERE a.tenant_id = $1 AND a.is_published = 1 AND (a.is_archived = 0 OR a.is_archived IS NULL)
     ORDER BY
       CASE WHEN a.content_type = 'deep-dive' THEN 0 ELSE 1 END,
       a.published_at DESC
     LIMIT 50`,
    [tenantId]
  );
  return result.rows.map(serializeRow)
    .filter(a => a.title && (a.source_url || a.content_type === 'deep-dive' || a.content_type === 'original') && a.category !== 'Uncategorized')
    .sort((a, b) => {
      const aDD = a.content_type === 'deep-dive' ? 0 : 1;
      const bDD = b.content_type === 'deep-dive' ? 0 : 1;
      if (aDD !== bDD) return aDD - bDD;
      return new Date(b.published_at) - new Date(a.published_at);
    })
    .slice(0, TOP_N)
    .map(a => articleToEmailItem(a, siteUrl, appCfg));
}

// ── Email builders ────────────────────────────────────────────────────────────

function buildEmail(articles, site = {}, intro = null) {
  const date      = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const siteName  = _escHtmlEmail(site.name || 'Deep Feed AI');
  const logoEmoji = _escHtmlEmail(site.logo_emoji || '🤖');
  const siteUrl   = _safeUrl((site.url || 'https://deepfeedai.com').replace(/\/$/, ''));
  const domain    = _escHtmlEmail(site.domain || 'deepfeedai.com');
  const catColors = {};
  if (Array.isArray(site.categories)) {
    for (const c of site.categories) catColors[c.name] = c.color;
  }
  const cards = articles.map(a => articleCard(a, siteUrl, catColors)).join('');
  const introHtml = intro
    ? `<tr><td style="background:#111827;padding:20px 32px 0;border-left:1px solid #1e293b;border-right:1px solid #1e293b;">
        <p style="margin:0;color:#e2e8f0;font-size:15px;line-height:1.7;font-style:italic;border-left:3px solid #7c3aed;padding-left:16px;">${_escHtmlEmail(intro)}</p>
       </td></tr>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${siteName} — Daily Digest</title>
</head>
<body style="margin:0;padding:0;background:#0d0d1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0d0d1a;">
  <tr><td align="center" style="padding:32px 16px;">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

      <!-- Header -->
      <tr><td style="background:linear-gradient(135deg,#1a0a2e 0%,#0d1a3a 100%);border-radius:16px 16px 0 0;padding:40px 32px;text-align:center;border-bottom:2px solid #7c3aed;">
        <div style="font-size:40px;margin-bottom:8px;">${logoEmoji}</div>
        <h1 style="margin:0;font-size:28px;font-weight:800;background:linear-gradient(90deg,#a855f7,#22d3ee);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;">${siteName}</h1>
        <p style="margin:8px 0 0;color:#94a3b8;font-size:14px;">Daily AI News Digest &nbsp;·&nbsp; ${date}</p>
      </td></tr>

      <!-- Intro (static fallback) -->
      <tr><td style="background:#111827;padding:24px 32px ${intro ? '8px' : '24px'};border-left:1px solid #1e293b;border-right:1px solid #1e293b;">
        <p style="margin:0;color:#cbd5e1;font-size:15px;line-height:1.6;">Here are the top AI stories — curated and delivered straight to your inbox. Click any headline to read the full article.</p>
      </td></tr>

      ${introHtml}

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

function buildWeeklyEmail(articles, site = {}, intro = null, storyArc = null) {
  const date      = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const siteName  = _escHtmlEmail(site.name || 'Deep Feed AI');
  const logoEmoji = _escHtmlEmail(site.logo_emoji || '🤖');
  const siteUrl   = _safeUrl((site.url || 'https://deepfeedai.com').replace(/\/$/, ''));
  const domain    = _escHtmlEmail(site.domain || 'deepfeedai.com');
  const catColors = {};
  if (Array.isArray(site.categories)) {
    for (const c of site.categories) catColors[c.name] = c.color;
  }

  const introHtml = intro
    ? `<tr><td style="background:#111827;padding:20px 32px 0;border-left:1px solid #1e293b;border-right:1px solid #1e293b;">
        <p style="margin:0;color:#e2e8f0;font-size:15px;line-height:1.7;font-style:italic;border-left:3px solid #7c3aed;padding-left:16px;">${_escHtmlEmail(intro)}</p>
       </td></tr>`
    : '';

  const storyArcHtml = storyArc
    ? `<tr><td style="background:#0f172a;padding:24px 32px;border-left:1px solid #1e293b;border-right:1px solid #1e293b;border-top:1px solid #1e293b;">
        <div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#7c3aed;margin-bottom:8px;">📖 Story Arc</div>
        <p style="margin:0;color:#cbd5e1;font-size:14px;line-height:1.7;">${_escHtmlEmail(storyArc)}</p>
       </td></tr>`
    : '';

  const cards = articles.map(a => articleCard(a, siteUrl, catColors)).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${siteName} — Weekly Intelligence Report</title>
</head>
<body style="margin:0;padding:0;background:#0d0d1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0d0d1a;">
  <tr><td align="center" style="padding:32px 16px;">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

      <!-- Header -->
      <tr><td style="background:linear-gradient(135deg,#0a1a2e 0%,#1a0a2e 100%);border-radius:16px 16px 0 0;padding:40px 32px;text-align:center;border-bottom:2px solid #a855f7;">
        <div style="font-size:40px;margin-bottom:8px;">${logoEmoji}</div>
        <h1 style="margin:0;font-size:28px;font-weight:800;background:linear-gradient(90deg,#22d3ee,#a855f7);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;">${siteName}</h1>
        <p style="margin:4px 0 0;color:#94a3b8;font-size:13px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;">Weekly Intelligence Report &nbsp;·&nbsp; ${date}</p>
      </td></tr>

      <!-- Intro -->
      <tr><td style="background:#111827;padding:24px 32px ${intro ? '8px' : '24px'};border-left:1px solid #1e293b;border-right:1px solid #1e293b;">
        <p style="margin:0;color:#cbd5e1;font-size:15px;line-height:1.6;">Your weekly briefing on the most significant developments in AI — what happened, what it means, and what to watch.</p>
      </td></tr>

      ${introHtml}
      ${storyArcHtml}

      <!-- Articles -->
      ${cards}

      <!-- CTA -->
      <tr><td style="background:#111827;padding:24px 32px;text-align:center;border-left:1px solid #1e293b;border-right:1px solid #1e293b;">
        <a href="${siteUrl}" style="display:inline-block;background:linear-gradient(135deg,#a855f7,#0ea5e9);color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 32px;border-radius:8px;">Read Everything →</a>
      </td></tr>

      <!-- Footer -->
      <tr><td style="background:#0d0d1a;border-radius:0 0 16px 16px;padding:24px 32px;text-align:center;border:1px solid #1e293b;border-top:none;">
        <p style="margin:0 0 8px;color:#475569;font-size:13px;">Weekly Intelligence Report from <a href="${siteUrl}" style="color:#a855f7;text-decoration:none;">${domain}</a></p>
        <p style="margin:0;color:#475569;font-size:13px;"><a href="{{{RESEND_UNSUBSCRIBE_URL}}}" style="color:#475569;">Unsubscribe</a></p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function _escHtmlEmail(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

const _CSS_COLOR_RE = /^#[0-9a-fA-F]{3,6}$/;
function _safeCssColor(val, fallback = '#7c3aed') {
  return _CSS_COLOR_RE.test(val || '') ? val : fallback;
}
function _safeUrl(val, fallback = 'https://deepfeedai.com') {
  return /^https?:\/\//.test(val || '') ? val : fallback;
}

function articleCard(article, siteUrl = 'https://deepfeedai.com', catColors = {}) {
  const cat      = article.category || 'AI';
  const fallbackColors = { LLMs: '#7c3aed', 'Image AI': '#0ea5e9', Research: '#10b981', Tools: '#f59e0b', Business: '#f97316', Policy: '#6366f1', Industry: '#ef4444', CyberSecurity: '#dc2626' };
  const catColor = _safeCssColor(catColors[cat]) || _safeCssColor(fallbackColors[cat]) || '#7c3aed';
  const date     = article.publishedAt ? new Date(article.publishedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
  const summary  = article.description ? _escHtmlEmail(article.description.slice(0, 160) + (article.description.length > 160 ? '…' : '')) : '';
  const link     = `${siteUrl}/article?u=${encodeURIComponent(article.url)}&t=${encodeURIComponent(article.title)}&s=${encodeURIComponent(article.source || '')}&c=${encodeURIComponent(cat)}`;
  const safeImg  = _safeUrl(article.imageUrl, '');

  const thumbRow = safeImg ? `
      <tr>
        <td style="padding-top:12px;">
          <img src="${safeImg}" alt="" width="100%" style="border-radius:8px;display:block;max-height:200px;object-fit:cover;" />
        </td>
      </tr>` : '';

  return `
  <tr><td style="background:#111827;padding:0 32px 4px;border-left:1px solid #1e293b;border-right:1px solid #1e293b;">
    <table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #1e293b;padding:20px 0;">
      <tr>
        <td>
          <span style="display:inline-block;background:${catColor}22;color:${catColor};font-size:11px;font-weight:700;padding:3px 10px;border-radius:12px;letter-spacing:.5px;text-transform:uppercase;margin-bottom:8px;">${_escHtmlEmail(cat)}</span>
          ${date ? `<span style="color:#475569;font-size:12px;margin-left:8px;">${date}</span>` : ''}
          <div style="margin-top:4px;">
            <a href="${link}" style="color:#e2e8f0;text-decoration:none;font-size:16px;font-weight:600;line-height:1.4;">${_escHtmlEmail(article.title)}</a>
          </div>
          ${summary ? `<p style="margin:8px 0 0;color:#94a3b8;font-size:13px;line-height:1.5;">${summary}</p>` : ''}
          <div style="margin-top:10px;">
            <span style="color:#475569;font-size:12px;">${_escHtmlEmail(article.source || '')}</span>
            <a href="${link}" style="color:#7c3aed;font-size:12px;font-weight:600;text-decoration:none;margin-left:12px;">Read more →</a>
          </div>
        </td>
      </tr>${thumbRow}
    </table>
  </td></tr>`;
}

module.exports = router;
module.exports.createAutoDraft    = createAutoDraft;
module.exports.autoSendPendingDraft = autoSendPendingDraft;
