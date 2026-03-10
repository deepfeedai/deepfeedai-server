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
        const image    = item.enclosure?.url || item['media:thumbnail']?.['$']?.url || null;
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
      }
      await db.prepare('UPDATE sources SET last_fetched = $1 WHERE id = $2').run(new Date().toISOString(), source.id);
    } catch (err) {
      errors.push({ source: source.name, error: err.message });
    }
  }

  // Enrich articles missing images via OG scraping — fire and forget
  setImmediate(async () => {
    try {
      const noImage = await db.prepare(
        `SELECT id, source_url FROM articles
         WHERE (image_url IS NULL OR image_url = '')
           AND (is_archived = 0 OR is_archived IS NULL)
         ORDER BY id DESC LIMIT 30`
      ).all();
      const CONCURRENCY = 3;
      for (let i = 0; i < noImage.length; i += CONCURRENCY) {
        const batch = noImage.slice(i, i + CONCURRENCY);
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
