/**
 * Deep Feed AI — RSS feeds (reader-facing)
 *
 * Public, tenant-scoped RSS 2.0 feeds so readers can subscribe in any RSS
 * reader (Feedly, Inoreader, NetNewsWire, Reeder, etc.). Tenant resolution
 * uses the same middleware/tenant.js path the /api routes use, so subdomain
 * + custom-domain + JWT-claim resolution all work uniformly.
 *
 * Routes (no /api prefix — these are reader-facing canonical URLs):
 *   GET /feed.xml                    sitewide (last 50 published)
 *   GET /feed/category/:slug.xml     per-category
 *   GET /feed/writers/:slug.xml      per-writer
 *   GET /feed/briefs.xml             daily briefs + weekly digests (K2)
 *   GET /podcast.xml                 audio articles as iTunes podcast (K2)
 *   GET /feeds.opml                  OPML bundle of writer feeds (K3)
 *
 * Caching: 10-minute Cache-Control on every response. Feeds change at most
 * a few times per hour even on busy tenants, and external readers poll on
 * their own schedule — anything tighter is wasted DB work.
 */
'use strict';

const express = require('express');
const db = require('../db');
const { asyncHandler } = require('../lib/utils');
const { getAppConfig } = require('../lib/app-config');
const { tenantContext } = require('../middleware/tenant');

const router = express.Router();

// Tenant context resolves req.tenantId from subdomain / custom-domain /
// X-Tenant-Slug header / JWT. Same path /api uses.
router.use(tenantContext);

const MAX_ITEMS = 50;
const CACHE_SECONDS = 600;

// ── XML helpers ──────────────────────────────────────────────
function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function cdata(s) {
  // Wrap in CDATA. Defensively split any literal "]]>" inside the payload.
  return '<![CDATA[' + String(s == null ? '' : s).replace(/]]>/g, ']]]]><![CDATA[>') + ']]>';
}

function rfc822(d) {
  return new Date(d || Date.now()).toUTCString();
}

function setRssHeaders(res) {
  res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
  res.setHeader('Cache-Control', `public, max-age=${CACHE_SECONDS}`);
}

// ── Site context ────────────────────────────────────────────
async function getSiteContext(tenantId) {
  const config = await getAppConfig(tenantId);
  const rows = await db.prepare(
    `SELECT key, value FROM settings WHERE tenant_id = $1 AND key IN ('site_name','site_tagline','logo_emoji')`
  ).all(tenantId).catch(() => []);
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const siteUrl = (config.main_site_url || 'https://deepfeedai.com').replace(/\/$/, '');
  return {
    siteUrl,
    siteName: map.site_name || 'Deep Feed AI',
    tagline:  map.site_tagline || 'Your daily signal in the AI noise',
    logo:     map.logo_emoji || '',
  };
}

// ── Article → RSS item ──────────────────────────────────────
function renderItem(a, siteUrl) {
  const link = `${siteUrl}/article/${a.slug}`;
  let item = '<item>'
    + `<title>${cdata(a.title || '(untitled)')}</title>`
    + `<link>${xmlEscape(link)}</link>`
    + `<guid isPermaLink="true">${xmlEscape(link)}</guid>`
    + `<pubDate>${rfc822(a.published_at)}</pubDate>`;
  if (a.writer_name) item += `<dc:creator>${cdata(a.writer_name)}</dc:creator>`;
  if (a.category)    item += `<category>${cdata(a.category)}</category>`;
  const desc = a.summary || (a.full_content ? a.full_content.replace(/<[^>]+>/g, ' ').slice(0, 500) : '');
  if (desc) item += `<description>${cdata(desc)}</description>`;
  if (a.full_content) item += `<content:encoded>${cdata(a.full_content)}</content:encoded>`;
  if (a.image_url)    item += `<media:thumbnail url="${xmlEscape(a.image_url)}"/>`;
  item += '</item>';
  return item;
}

function renderRSS({ siteUrl, siteName, tagline, feedPath, feedTitle, feedDescription, articles }) {
  const channelTitle = feedTitle || siteName;
  const channelDesc  = feedDescription || tagline;
  const lastBuild    = articles[0]?.published_at ? rfc822(articles[0].published_at) : new Date().toUTCString();
  const items = articles.map(a => renderItem(a, siteUrl)).join('');

  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<rss version="2.0" '
    +   'xmlns:atom="http://www.w3.org/2005/Atom" '
    +   'xmlns:content="http://purl.org/rss/1.0/modules/content/" '
    +   'xmlns:dc="http://purl.org/dc/elements/1.1/" '
    +   'xmlns:media="http://search.yahoo.com/mrss/">'
    + '<channel>'
    +   `<title>${cdata(channelTitle)}</title>`
    +   `<link>${xmlEscape(siteUrl)}</link>`
    +   `<description>${cdata(channelDesc)}</description>`
    +   '<language>en-us</language>'
    +   `<lastBuildDate>${lastBuild}</lastBuildDate>`
    +   `<atom:link href="${xmlEscape(siteUrl + feedPath)}" rel="self" type="application/rss+xml"/>`
    +   items
    + '</channel></rss>';
}

// ── Routes ──────────────────────────────────────────────────

// Sitewide feed — last 50 published originals + deep-dives
router.get('/feed.xml', asyncHandler(async (req, res) => {
  const tenantId = req.tenantId || 1;
  const ctx = await getSiteContext(tenantId);
  const articles = await db.prepare(`
    SELECT a.id, a.title, a.slug, a.summary, a.full_content, a.image_url, a.category,
           a.published_at, w.name AS writer_name
    FROM articles a
    LEFT JOIN writers w ON w.id = a.writer_id AND w.tenant_id = a.tenant_id
    WHERE a.tenant_id = $1 AND a.is_published = 1
      AND COALESCE(a.is_archived, 0) = 0
      AND a.content_type IN ('original','deep-dive')
    ORDER BY a.published_at DESC LIMIT $2
  `).all(tenantId, MAX_ITEMS);
  setRssHeaders(res);
  res.send(renderRSS({
    ...ctx, feedPath: '/feed.xml', articles,
    feedDescription: ctx.tagline,
  }));
}));

// Per-category feed
router.get('/feed/category/:slug.xml', asyncHandler(async (req, res) => {
  const tenantId = req.tenantId || 1;
  const ctx = await getSiteContext(tenantId);
  // Resolve slug → category name (tenant-scoped). Categories use a
  // case-insensitive name match here so feed URLs are forgiving.
  const category = await db.prepare(
    `SELECT name FROM categories WHERE tenant_id = $1 AND LOWER(REPLACE(name, ' ', '-')) = LOWER($2) LIMIT 1`
  ).get(tenantId, req.params.slug).catch(() => null);
  if (!category) return res.status(404).type('text/plain').send('Category not found');

  const articles = await db.prepare(`
    SELECT a.id, a.title, a.slug, a.summary, a.full_content, a.image_url, a.category,
           a.published_at, w.name AS writer_name
    FROM articles a
    LEFT JOIN writers w ON w.id = a.writer_id AND w.tenant_id = a.tenant_id
    WHERE a.tenant_id = $1 AND a.is_published = 1
      AND COALESCE(a.is_archived, 0) = 0
      AND a.content_type IN ('original','deep-dive')
      AND LOWER(a.category) = LOWER($2)
    ORDER BY a.published_at DESC LIMIT $3
  `).all(tenantId, category.name, MAX_ITEMS);

  setRssHeaders(res);
  res.send(renderRSS({
    ...ctx,
    feedPath: `/feed/category/${req.params.slug}.xml`,
    feedTitle: `${ctx.siteName} — ${category.name}`,
    feedDescription: `${category.name} coverage from ${ctx.siteName}`,
    articles,
  }));
}));

// Per-writer feed — pairs with the existing follower system to give the
// "subscribe to this writer in your reader of choice" experience
router.get('/feed/writers/:slug.xml', asyncHandler(async (req, res) => {
  const tenantId = req.tenantId || 1;
  const ctx = await getSiteContext(tenantId);
  const writer = await db.prepare(
    `SELECT id, name, bio FROM writers
       WHERE tenant_id = $1 AND slug = $2
         AND COALESCE(role, 'writer') NOT IN ('editor','designer','copy-editor')
       LIMIT 1`
  ).get(tenantId, req.params.slug).catch(() => null);
  if (!writer) return res.status(404).type('text/plain').send('Writer not found');

  const articles = await db.prepare(`
    SELECT a.id, a.title, a.slug, a.summary, a.full_content, a.image_url, a.category,
           a.published_at, $3::text AS writer_name
    FROM articles a
    WHERE a.tenant_id = $1 AND a.writer_id = $2 AND a.is_published = 1
      AND COALESCE(a.is_archived, 0) = 0
      AND a.content_type IN ('original','deep-dive')
    ORDER BY a.published_at DESC LIMIT $4
  `).all(tenantId, writer.id, writer.name, MAX_ITEMS);

  setRssHeaders(res);
  res.send(renderRSS({
    ...ctx,
    feedPath: `/feed/writers/${req.params.slug}.xml`,
    feedTitle: `${writer.name} — ${ctx.siteName}`,
    feedDescription: writer.bio || `All articles from ${writer.name} on ${ctx.siteName}`,
    articles,
  }));
}));

// ── Briefs feed ──────────────────────────────────────────────
// Each daily brief / weekly digest becomes a feed item. Lets readers
// subscribe to "Maxwell's daily editorial" in any RSS reader — distinct
// from the article feed.
router.get('/feed/briefs.xml', asyncHandler(async (req, res) => {
  const tenantId = req.tenantId || 1;
  const ctx = await getSiteContext(tenantId);
  const events = await db.prepare(`
    SELECT id, event_type, payload, created_at
      FROM newsroom_events
     WHERE tenant_id = $1
       AND event_type IN ('daily_brief', 'weekly_digest')
       AND dismissed_at IS NULL
     ORDER BY created_at DESC
     LIMIT $2
  `).all(tenantId, MAX_ITEMS).catch(() => []);

  const items = events.map(e => {
    const payload = (typeof e.payload === 'string' ? JSON.parse(e.payload || '{}') : (e.payload || {}));
    const isWeekly = e.event_type === 'weekly_digest';
    const dateStr = payload.period_range
      || new Date(e.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const title = isWeekly ? `Week in Review — ${dateStr}` : `Day Brief — ${dateStr}`;
    const headline = payload.headline || '';
    const prose = payload.prose || payload.text || '';
    const desc = headline ? `${headline}\n\n${prose}` : prose;
    const link = `${ctx.siteUrl}/briefs/${e.id}`;
    return '<item>'
      + `<title>${cdata(title)}</title>`
      + `<link>${xmlEscape(link)}</link>`
      + `<guid isPermaLink="false">brief-${e.id}</guid>`
      + `<pubDate>${rfc822(e.created_at)}</pubDate>`
      + (desc ? `<description>${cdata(desc)}</description>` : '')
      + (prose ? `<content:encoded>${cdata(prose)}</content:encoded>` : '')
      + '</item>';
  }).join('');

  const lastBuild = events[0] ? rfc822(events[0].created_at) : new Date().toUTCString();
  setRssHeaders(res);
  res.send(
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">'
    + '<channel>'
    +   `<title>${cdata(ctx.siteName + ' — Editorial Briefs')}</title>`
    +   `<link>${xmlEscape(ctx.siteUrl)}</link>`
    +   `<description>${cdata("Maxwell's daily editorial brief and weekly digest from " + ctx.siteName)}</description>`
    +   '<language>en-us</language>'
    +   `<lastBuildDate>${lastBuild}</lastBuildDate>`
    +   `<atom:link href="${xmlEscape(ctx.siteUrl + '/feed/briefs.xml')}" rel="self" type="application/rss+xml"/>`
    +   items
    + '</channel></rss>'
  );
}));

// ── Podcast feed (iTunes namespace) ──────────────────────────
// Articles with audio (TTS-narrated via the audio feature) become
// podcast episodes. iTunes-compatible — readers can paste the URL into
// Apple Podcasts, Overcast, Pocket Casts, etc.
router.get('/podcast.xml', asyncHandler(async (req, res) => {
  const tenantId = req.tenantId || 1;
  const ctx = await getSiteContext(tenantId);

  // Optional cover image lives in settings as podcast_cover_url; falls
  // back to the site logo or a default placeholder.
  const cover = await db.prepare(
    `SELECT value FROM settings WHERE tenant_id = $1 AND key = 'podcast_cover_url' LIMIT 1`
  ).get(tenantId).catch(() => null);
  const coverUrl = cover?.value || `${ctx.siteUrl}/podcast-cover.png`;

  const articles = await db.prepare(`
    SELECT a.id, a.title, a.slug, a.summary, a.image_url, a.published_at,
           a.audio_url, a.audio_voice_name, w.name AS writer_name
      FROM articles a
      LEFT JOIN writers w ON w.id = a.writer_id AND w.tenant_id = a.tenant_id
     WHERE a.tenant_id = $1 AND a.is_published = 1
       AND COALESCE(a.is_archived, 0) = 0
       AND a.audio_status = 'ready' AND a.audio_url IS NOT NULL
       AND a.content_type IN ('original','deep-dive')
     ORDER BY a.published_at DESC LIMIT $2
  `).all(tenantId, MAX_ITEMS).catch(() => []);

  const items = articles.map(a => {
    const link = `${ctx.siteUrl}/article/${a.slug}`;
    const author = a.audio_voice_name || a.writer_name || ctx.siteName;
    const desc = a.summary || a.title || '';
    return '<item>'
      + `<title>${cdata(a.title || '(untitled)')}</title>`
      + `<link>${xmlEscape(link)}</link>`
      + `<guid isPermaLink="false">audio-${a.id}</guid>`
      + `<pubDate>${rfc822(a.published_at)}</pubDate>`
      + `<description>${cdata(desc)}</description>`
      + `<enclosure url="${xmlEscape(a.audio_url)}" type="audio/mpeg" length="0"/>`
      + `<itunes:author>${cdata(author)}</itunes:author>`
      + `<itunes:summary>${cdata(desc)}</itunes:summary>`
      + (a.image_url ? `<itunes:image href="${xmlEscape(a.image_url)}"/>` : '')
      + '<itunes:explicit>false</itunes:explicit>'
      + '</item>';
  }).join('');

  const lastBuild = articles[0] ? rfc822(articles[0].published_at) : new Date().toUTCString();
  setRssHeaders(res);
  res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
  res.send(
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<rss version="2.0" '
    +   'xmlns:atom="http://www.w3.org/2005/Atom" '
    +   'xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" '
    +   'xmlns:content="http://purl.org/rss/1.0/modules/content/">'
    + '<channel>'
    +   `<title>${cdata(ctx.siteName)}</title>`
    +   `<link>${xmlEscape(ctx.siteUrl)}</link>`
    +   `<description>${cdata(ctx.tagline + ' — narrated articles')}</description>`
    +   '<language>en-us</language>'
    +   `<lastBuildDate>${lastBuild}</lastBuildDate>`
    +   `<atom:link href="${xmlEscape(ctx.siteUrl + '/podcast.xml')}" rel="self" type="application/rss+xml"/>`
    +   `<itunes:author>${cdata(ctx.siteName)}</itunes:author>`
    +   `<itunes:summary>${cdata(ctx.tagline)}</itunes:summary>`
    +   `<itunes:image href="${xmlEscape(coverUrl)}"/>`
    +   '<itunes:category text="News"/>'
    +   '<itunes:explicit>false</itunes:explicit>'
    +   `<image><url>${xmlEscape(coverUrl)}</url><title>${cdata(ctx.siteName)}</title><link>${xmlEscape(ctx.siteUrl)}</link></image>`
    +   items
    + '</channel></rss>'
  );
}));

// ── OPML bundle ──────────────────────────────────────────────
// Power-user export: a single OPML file that bundles every writer
// feed + the main feed + briefs feed + all categories. Import once
// in your reader and you've subscribed to the whole newsroom.
router.get('/feeds.opml', asyncHandler(async (req, res) => {
  const tenantId = req.tenantId || 1;
  const ctx = await getSiteContext(tenantId);

  const writers = await db.prepare(`
    SELECT name, slug FROM writers
     WHERE tenant_id = $1
       AND COALESCE(role, 'writer') NOT IN ('editor','designer','copy-editor')
       AND slug IS NOT NULL
     ORDER BY name ASC
  `).all(tenantId).catch(() => []);

  const categories = await db.prepare(`
    SELECT name FROM categories WHERE tenant_id = $1 ORDER BY name ASC
  `).all(tenantId).catch(() => []);

  function outline(text, xmlUrl, htmlUrl) {
    return `<outline type="rss" text="${xmlEscape(text)}" title="${xmlEscape(text)}" xmlUrl="${xmlEscape(xmlUrl)}" htmlUrl="${xmlEscape(htmlUrl)}"/>`;
  }

  const newsroomOutlines = ''
    + outline(`${ctx.siteName} — All Articles`, `${ctx.siteUrl}/feed.xml`, ctx.siteUrl)
    + outline(`${ctx.siteName} — Editorial Briefs`, `${ctx.siteUrl}/feed/briefs.xml`, ctx.siteUrl)
    + outline(`${ctx.siteName} — Podcast`, `${ctx.siteUrl}/podcast.xml`, ctx.siteUrl);

  const writerOutlines = writers.map(w =>
    outline(w.name, `${ctx.siteUrl}/feed/writers/${w.slug}.xml`, `${ctx.siteUrl}/writers/${w.slug}`)
  ).join('');

  const categoryOutlines = categories.map(c => {
    const slug = c.name.toLowerCase().replace(/\s+/g, '-');
    return outline(c.name, `${ctx.siteUrl}/feed/category/${slug}.xml`, `${ctx.siteUrl}/category/${slug}`);
  }).join('');

  res.setHeader('Content-Type', 'text/x-opml; charset=utf-8');
  res.setHeader('Cache-Control', `public, max-age=${CACHE_SECONDS}`);
  res.send(
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<opml version="2.0">'
    + '<head>'
    +   `<title>${xmlEscape(ctx.siteName + ' Feeds')}</title>`
    +   `<dateCreated>${rfc822(new Date())}</dateCreated>`
    + '</head>'
    + '<body>'
    +   `<outline text="Newsroom" title="Newsroom">${newsroomOutlines}</outline>`
    +   (writerOutlines    ? `<outline text="Writers" title="Writers">${writerOutlines}</outline>` : '')
    +   (categoryOutlines  ? `<outline text="Categories" title="Categories">${categoryOutlines}</outline>` : '')
    + '</body>'
    + '</opml>'
  );
}));

// ── JSON Feed alternative ────────────────────────────────────
// JSON Feed 1.1 spec — modern alt to RSS, supported by Reeder, NetNewsWire,
// Feedbin, etc. Same content as /feed.xml, different wire format.
router.get('/feed.json', asyncHandler(async (req, res) => {
  const tenantId = req.tenantId || 1;
  const ctx = await getSiteContext(tenantId);
  const articles = await db.prepare(`
    SELECT a.id, a.title, a.slug, a.summary, a.full_content, a.image_url, a.category,
           a.published_at, w.name AS writer_name
    FROM articles a
    LEFT JOIN writers w ON w.id = a.writer_id AND w.tenant_id = a.tenant_id
    WHERE a.tenant_id = $1 AND a.is_published = 1
      AND COALESCE(a.is_archived, 0) = 0
      AND a.content_type IN ('original','deep-dive')
    ORDER BY a.published_at DESC LIMIT $2
  `).all(tenantId, MAX_ITEMS);

  const items = articles.map(a => {
    const link = `${ctx.siteUrl}/article/${a.slug}`;
    const item = {
      id:    link,
      url:   link,
      title: a.title || '(untitled)',
      date_published: new Date(a.published_at).toISOString(),
    };
    if (a.summary)      item.summary       = a.summary;
    if (a.full_content) item.content_html  = a.full_content;
    if (a.image_url)    item.image         = a.image_url;
    if (a.writer_name)  item.authors       = [{ name: a.writer_name }];
    if (a.category)     item.tags          = [a.category];
    return item;
  });

  res.setHeader('Content-Type', 'application/feed+json; charset=utf-8');
  res.setHeader('Cache-Control', `public, max-age=${CACHE_SECONDS}`);
  res.json({
    version:       'https://jsonfeed.org/version/1.1',
    title:         ctx.siteName,
    home_page_url: ctx.siteUrl,
    feed_url:      `${ctx.siteUrl}/feed.json`,
    description:   ctx.tagline,
    language:      'en-US',
    items,
  });
}));

module.exports = router;
