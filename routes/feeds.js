/**
 * Deep Feed AI — RSS feeds (reader-facing)
 *
 * Tenant-scoped, reader-facing feed routes. Pure render helpers live in
 * lib/rss-render.js so they can be unit-tested without Express or a DB.
 *
 * Routes (no /api prefix — these are canonical reader URLs):
 *   GET /feed.xml                    sitewide RSS
 *   GET /feed/category/:slug.xml     per-category RSS
 *   GET /feed/writers/:slug.xml      per-writer RSS
 *   GET /feed/briefs.xml             editorial briefs RSS
 *   GET /podcast.xml                 narrated articles, iTunes-compatible
 *   GET /feeds.opml                  OPML bundle of every feed
 *   GET /feed.json                   JSON Feed 1.1 alternative
 */
'use strict';

const express = require('express');
const db = require('../db');
const { asyncHandler } = require('../lib/utils');
const { getAppConfig } = require('../lib/app-config');
const { tenantContext } = require('../middleware/tenant');
const render = require('../lib/rss-render');

const router = express.Router();
router.use(tenantContext);

const MAX_ITEMS = 50;
const CACHE_SECONDS = 600;

function setRssHeaders(res) {
  res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
  res.setHeader('Cache-Control', `public, max-age=${CACHE_SECONDS}`);
}

async function getSiteContext(tenantId) {
  const config = await getAppConfig(tenantId);
  const rows = await db.prepare(
    `SELECT key, value FROM settings WHERE tenant_id = $1 AND key IN ('site_name','site_tagline','logo_emoji')`
  ).all(tenantId).catch(() => []);
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return {
    siteUrl:  (config.main_site_url || 'https://deepfeedai.com').replace(/\/$/, ''),
    siteName: map.site_name || 'Deep Feed AI',
    tagline:  map.site_tagline || 'Your daily signal in the AI noise',
  };
}

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
  res.send(render.renderRSS({ ...ctx, feedPath: '/feed.xml', articles }));
}));

router.get('/feed/category/:slug.xml', asyncHandler(async (req, res) => {
  const tenantId = req.tenantId || 1;
  const ctx = await getSiteContext(tenantId);
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
  res.send(render.renderRSS({
    ...ctx,
    feedPath: `/feed/category/${req.params.slug}.xml`,
    feedTitle: `${ctx.siteName} — ${category.name}`,
    feedDescription: `${category.name} coverage from ${ctx.siteName}`,
    articles,
  }));
}));

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
  res.send(render.renderRSS({
    ...ctx,
    feedPath: `/feed/writers/${req.params.slug}.xml`,
    feedTitle: `${writer.name} — ${ctx.siteName}`,
    feedDescription: writer.bio || `All articles from ${writer.name} on ${ctx.siteName}`,
    articles,
  }));
}));

router.get('/feed/briefs.xml', asyncHandler(async (req, res) => {
  const tenantId = req.tenantId || 1;
  const ctx = await getSiteContext(tenantId);
  const events = await db.prepare(`
    SELECT id, event_type, payload, created_at
      FROM newsroom_events
     WHERE tenant_id = $1
       AND event_type IN ('daily_brief', 'weekly_digest')
       AND dismissed_at IS NULL
     ORDER BY created_at DESC LIMIT $2
  `).all(tenantId, MAX_ITEMS).catch(() => []);
  setRssHeaders(res);
  res.send(render.renderBriefsRSS({ ...ctx, events }));
}));

router.get('/podcast.xml', asyncHandler(async (req, res) => {
  const tenantId = req.tenantId || 1;
  const ctx = await getSiteContext(tenantId);
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
  setRssHeaders(res);
  res.send(render.renderPodcastRSS({ ...ctx, coverUrl, articles }));
}));

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
  res.setHeader('Content-Type', 'text/x-opml; charset=utf-8');
  res.setHeader('Cache-Control', `public, max-age=${CACHE_SECONDS}`);
  res.send(render.renderOPML({ ...ctx, writers, categories }));
}));

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
  res.setHeader('Content-Type', 'application/feed+json; charset=utf-8');
  res.setHeader('Cache-Control', `public, max-age=${CACHE_SECONDS}`);
  res.json(render.renderJsonFeed({ ...ctx, articles }));
}));

module.exports = router;
