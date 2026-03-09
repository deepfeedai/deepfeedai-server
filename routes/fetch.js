/**
 * Deep Feed AI — /api/fetch
 * Fetches RSS from all active sources and inserts new articles into the DB.
 */
const router    = require('express').Router();
const RSSParser = require('rss-parser');
const jwt       = require('jsonwebtoken');
const db        = require('../db');
const { scrapeOgImage } = require('../lib/scrape');

const JWT_SECRET = process.env.JWT_SECRET || 'deepfeedai_super_secret_jwt_key_2026';
const parser     = new RSSParser();

function authMiddleware(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

function detectCategory(item) {
  const text = [item.title || '', (item.categories || []).join(' '), item.contentSnippet || '', item.content || ''].join(' ').toLowerCase();
  if (/\bimage\b|dall.?e|midjourney|stable.?diffusion|sora|imagen/.test(text))               return 'Image AI';
  if (/\bresearch\b|paper|arxiv|study|benchmark|evaluation|dataset/.test(text))               return 'Research';
  if (/\btool\b|plugin|extension|sdk|codex|copilot|cursor|vscode|github/.test(text))         return 'Tools';
  if (/\bgpt\b|llm|language model|claude|gemini|llama|mistral|falcon|phi\b|qwen/.test(text)) return 'LLMs';
  return 'Industry';
}

async function fetchAllSources(autoPublish = false) {
  const sources  = await db.prepare('SELECT * FROM sources WHERE is_active = 1').all();
  let inserted = 0, skipped = 0;
  const errors = [];

  for (const source of sources) {
    // Per-source auto-publish overrides the global flag
    const shouldAutoPublish = source.auto_publish ? true : autoPublish;
    const maxToPublish      = parseInt(source.auto_publish_max, 10) || 5;
    let autoPublishedForSource = 0;

    try {
      const feed = await parser.parseURL(source.url);
      // Sort newest-first so auto-publish picks the latest articles
      const items = (feed.items || []).slice().sort((a, b) => {
        return new Date(b.pubDate || 0) - new Date(a.pubDate || 0);
      });

      for (const item of items) {
        const url = item.link || item.guid;
        if (!url || !item.title) continue;

        const existing = await db.prepare('SELECT id FROM articles WHERE source_url = ?').get(url);
        if (existing) { skipped++; continue; }

        const category = detectCategory(item);
        const image    = item.enclosure?.url || item['media:thumbnail']?.['$']?.url || null;
        const summary  = (item.contentSnippet || item.content || '').replace(/<[^>]+>/g, '').trim().slice(0, 500) || null;
        const pubDate  = item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString();
        const author   = item.creator || item.author || null;

        // Auto-publish up to max for this source; rest saved as drafts
        const publish = shouldAutoPublish && autoPublishedForSource < maxToPublish ? 1 : 0;
        if (publish) autoPublishedForSource++;

        await db.prepare(
          `INSERT INTO articles (title, summary, category, source, source_url, image_url, author, is_published, is_featured, published_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
        ).run(item.title, summary, category, source.name, url, image, author, publish, pubDate);
        inserted++;
      }
      await db.prepare('UPDATE sources SET last_fetched = ? WHERE id = ?').run(new Date().toISOString(), source.id);
    } catch (err) {
      errors.push({ source: source.name, error: err.message });
    }
  }

  // Enrich articles missing images via OG scraping — fire and forget
  // (runs in background so the fetch response returns immediately)
  setImmediate(async () => {
    try {
      const noImage = await db.prepare(
        'SELECT id, source_url FROM articles WHERE (image_url IS NULL OR image_url = \'\') AND (is_archived = 0 OR is_archived IS NULL) ORDER BY id DESC LIMIT 30'
      ).all();
      const CONCURRENCY = 3;
      for (let i = 0; i < noImage.length; i += CONCURRENCY) {
        const batch = noImage.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(async (a) => {
          try {
            const img = await scrapeOgImage(a.source_url);
            if (img) await db.prepare('UPDATE articles SET image_url = ?, updated_at = NOW() WHERE id = ?').run(img, a.id);
          } catch { /* ignore per-article failures */ }
        }));
      }
    } catch { /* ignore enrichment errors */ }
  });

  return { inserted, skipped, errors };
}

// POST /api/fetch
router.post('/', authMiddleware, async (req, res) => {
  try {
    const result = await fetchAllSources(req.body.autoPublish === true);
    res.json({ status: 'ok', ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router, fetchAllSources };
