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

module.exports = router;
