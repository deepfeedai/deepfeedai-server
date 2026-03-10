/**
 * Deep Feed AI — /api/fetch
 * Fetches RSS from all active sources and inserts new articles into the DB.
 */
const router             = require('express').Router();
const RSSParser          = require('rss-parser');
const db                 = require('../db');
const { scrapeOgImage }  = require('../lib/scrape');
const { auth }           = require('../middleware/auth');
const { asyncHandler }   = require('../lib/utils');
const { detectCategory } = require('../lib/categorize');

const parser = new RSSParser();

async function fetchAllSources(autoPublish = false) {
  const sources  = await db.prepare('SELECT * FROM sources WHERE is_active = 1').all();
  let inserted = 0, skipped = 0;
  const errors = [];
  const needsImage = []; // { id, source_url } — newly inserted articles without an RSS image

  for (const source of sources) {
    const shouldAutoPublish = source.auto_publish ? true : autoPublish;
    const maxToPublish      = parseInt(source.auto_publish_max, 10) || 5;
    let autoPublishedForSource = 0;

    try {
      const feed  = await parser.parseURL(source.url);
      const items = (feed.items || []).slice().sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));
      const cutoff = Date.now() - 48 * 60 * 60 * 1000;

      for (const item of items) {
        const url = item.link || item.guid;
        if (!url || !item.title) continue;

        const pubMs = item.pubDate ? new Date(item.pubDate).getTime() : 0;
        if (pubMs && pubMs < cutoff) { skipped++; continue; }

        const existing = await db.prepare('SELECT id FROM articles WHERE source_url = $1').get(url);
        if (existing) { skipped++; continue; }

        const category = detectCategory(item);
        const image    =
          item.enclosure?.url                              ||  // standard podcast/media enclosure
          item['media:content']?.['$']?.url               ||  // media:content (common in news feeds)
          item['media:thumbnail']?.['$']?.url             ||  // media:thumbnail
          item.image?.url                                  ||  // image.url (some feeds)
          item['itunes:image']?.['$']?.href               ||  // iTunes image
          null;
        const summary  = (item.contentSnippet || item.content || '').replace(/<[^>]+>/g, '').trim().slice(0, 500) || null;
        const pubDate  = item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString();
        const author   = item.creator || item.author || null;

        const publish = shouldAutoPublish && autoPublishedForSource < maxToPublish ? 1 : 0;
        if (publish) autoPublishedForSource++;

        await db.prepare(
          `INSERT INTO articles (title, summary, category, source, source_url, image_url, author, is_published, is_featured, published_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9)`
        ).run(item.title, summary, category, source.name, url, image, author, publish, pubDate);
        inserted++;

        // Track articles without an RSS image for synchronous OG enrichment below
        if (!image) {
          const row = await db.prepare('SELECT id FROM articles WHERE source_url = $1').get(url);
          if (row) needsImage.push({ id: row.id, source_url: url });
        }
      }
      await db.prepare('UPDATE sources SET last_fetched = $1 WHERE id = $2').run(new Date().toISOString(), source.id);
    } catch (err) {
      errors.push({ source: source.name, error: err.message });
    }
  }

  // ── Synchronous OG enrichment for current batch ─────────────────────────
  // Run inline (blocking) for up to 15 newly fetched articles that had no RSS
  // image, so they get a real thumbnail before the response is returned.
  // Concurrency 5, ~5s per article max → typically finishes in a few seconds.
  if (needsImage.length > 0) {
    const SYNC_LIMIT = 15;
    const syncBatch  = needsImage.slice(0, SYNC_LIMIT);
    const CONCURRENCY = 5;
    for (let i = 0; i < syncBatch.length; i += CONCURRENCY) {
      const chunk = syncBatch.slice(i, i + CONCURRENCY);
      await Promise.all(chunk.map(async ({ id, source_url }) => {
        try {
          const img = await scrapeOgImage(source_url);
          if (img) await db.prepare('UPDATE articles SET image_url = $1, updated_at = NOW() WHERE id = $2').run(img, id);
        } catch { /* ignore per-article scrape failures */ }
      }));
    }
  }

  // ── Background enrichment for remaining / older articles without images ──
  setImmediate(async () => {
    try {
      // Exclude IDs already handled synchronously above
      const syncIds = needsImage.map(a => a.id);
      const noImage = await db.prepare(
        `SELECT id, source_url FROM articles
         WHERE (image_url IS NULL OR image_url = '')
           AND (is_archived = 0 OR is_archived IS NULL)
         ORDER BY id DESC LIMIT 30`
      ).all();
      const remaining = noImage.filter(a => !syncIds.includes(a.id));
      const CONCURRENCY = 3;
      for (let i = 0; i < remaining.length; i += CONCURRENCY) {
        const batch = remaining.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(async (a) => {
          try {
            const img = await scrapeOgImage(a.source_url);
            if (img) await db.prepare('UPDATE articles SET image_url = $1, updated_at = NOW() WHERE id = $2').run(img, a.id);
          } catch { /* ignore per-article failures */ }
        }));
      }
    } catch { /* ignore enrichment errors */ }
  });

  return { inserted, skipped, errors };
}

// POST /api/fetch
router.post('/', auth, asyncHandler(async (req, res) => {
  const result = await fetchAllSources(req.body.autoPublish === true);
  res.json({ status: 'ok', ...result });
}));

// POST /api/fetch/recategorize
router.post('/recategorize', auth, asyncHandler(async (req, res) => {
  const articles = await db.prepare(
    'SELECT id, title, summary, category FROM articles WHERE is_archived = 0 OR is_archived IS NULL'
  ).all();

  let updated = 0;
  for (const a of articles) {
    const newCat = detectCategory({ title: a.title, contentSnippet: a.summary });
    if (newCat !== a.category) {
      await db.prepare('UPDATE articles SET category = $1, updated_at = NOW() WHERE id = $2').run(newCat, a.id);
      updated++;
    }
  }
  res.json({ status: 'ok', total: articles.length, updated });
}));

module.exports = { router, fetchAllSources, detectCategory };
