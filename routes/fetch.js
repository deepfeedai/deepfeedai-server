/**
 * Deep Feed AI — /api/fetch
 * Fetches RSS from all active sources and inserts new articles into the DB.
 */
const router             = require('express').Router();
const RSSParser          = require('rss-parser');
const db                 = require('../db');
const { scrapeOgImage }  = require('../lib/scrape');
const { auth }           = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { asyncHandler, decodeEntities } = require('../lib/utils');
const { detectCategory } = require('../lib/categorize');
const { findBestWriter } = require('../lib/writer-assign');
const { logUsage } = require('../lib/ai-usage');
const { onArticlePublished } = require('../lib/post-publish');
const { getAppConfig } = require('../lib/app-config');

const parser = new RSSParser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; DeepFeedAI/1.0; +https://deepfeedai.com)',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*',
  },
});

async function fetchAllSources(autoPublish = false, tenantId = 1) {
  const sources  = await db.prepare('SELECT * FROM sources WHERE is_active = 1 AND tenant_id = $1').all(tenantId);
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
      // First fetch for a new source: use 30-day lookback to pull in backlog
      const lookbackMs = source.last_fetched ? 48 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
      const cutoff = Date.now() - lookbackMs;

      for (const item of items) {
        const url = item.link || item.guid;
        if (!url || !item.title) continue;

        const pubMs = item.pubDate ? new Date(item.pubDate).getTime() : 0;
        if (pubMs && pubMs < cutoff) { skipped++; continue; }

        const existing = await db.prepare('SELECT id FROM articles WHERE source_url = $1 AND tenant_id = $2').get(url, tenantId);
        if (existing) { skipped++; continue; }

        const category = await detectCategory(item, { defaultCategory: source.default_category, tenantId });
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

        const wantPublish = shouldAutoPublish && autoPublishedForSource < maxToPublish;
        if (wantPublish) autoPublishedForSource++;

        // Insert as draft; auto-publish path upgrades to 'published' if selected
        await db.prepare(
          `INSERT INTO articles (title, summary, category, source, source_url, image_url, author, is_published, is_featured, published_at, status, tenant_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0, $8, 'draft', $9)`
        ).run(decodeEntities(item.title), summary, category, source.name, url, image, author, pubDate, tenantId);
        inserted++;

        // Fire-and-forget: writer assignment + quality gate auto-publish
        try {
          const inserted_row = await db.prepare('SELECT * FROM articles WHERE source_url = $1 AND tenant_id = $2').get(url, tenantId);
          if (inserted_row) {
            const artObj = { id: inserted_row.id, title: decodeEntities(item.title), summary, category, source: source.name };
            (async () => {
              try {
                const writer = await findBestWriter(artObj, tenantId);
                if (writer) {
                  await db.prepare('UPDATE articles SET writer_id = $1 WHERE id = $2 AND tenant_id = $3').run(writer.id, artObj.id, tenantId);
                  // TLDR generation deferred to post-publish to avoid wasting tokens
                  // on articles that will be consumed by synthesis
                }

                if (wantPublish) {
                  await db.prepare("UPDATE articles SET is_published = 1, status = 'published' WHERE id = $1 AND tenant_id = $2").run(inserted_row.id, tenantId);
                  onArticlePublished(inserted_row.id, tenantId).catch(() => {});
                }
              } catch (e) { console.error('[fetch] auto-assign/publish error:', e.message); }
            })();
          }
        } catch { /* ignore */ }

        // Track articles without an RSS image for synchronous OG enrichment below
        if (!image) {
          const row = await db.prepare('SELECT id FROM articles WHERE source_url = $1 AND tenant_id = $2').get(url, tenantId);
          if (row) needsImage.push({ id: row.id, source_url: url });
        }
      }
      await db.prepare('UPDATE sources SET last_fetched = $1 WHERE id = $2 AND tenant_id = $3').run(new Date().toISOString(), source.id, tenantId);
    } catch (err) {
      errors.push({ source: source.name, error: err.message });
    }
  }

  // ── Background OG image enrichment (non-blocking) ──────────────────────
  setImmediate(async () => {
    try {
      const noImage = await db.prepare(
        `SELECT id, source_url FROM articles
         WHERE (image_url IS NULL OR image_url = '')
           AND (is_archived = 0 OR is_archived IS NULL)
           AND tenant_id = $1
         ORDER BY id DESC LIMIT 30`
      ).all(tenantId);
      const CONCURRENCY = 5;
      for (let i = 0; i < noImage.length; i += CONCURRENCY) {
        const batch = noImage.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(async (a) => {
          try {
            const img = await scrapeOgImage(a.source_url, tenantId);
            if (img) await db.prepare('UPDATE articles SET image_url = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3').run(img, a.id, tenantId);
          } catch { /* ignore per-article failures */ }
        }));
      }
    } catch { /* ignore enrichment errors */ }
  });

  return { inserted, skipped, errors };
}

// ── Live news fetch (NewsAPI + Brave Search) ──────────────────────────────────

const DEFAULT_NEWSAPI_QUERY = '("artificial intelligence" OR "machine learning" OR "large language model" OR OpenAI OR Anthropic OR "deep learning" OR LLM OR ChatGPT OR "generative AI" OR "neural network")';
const DEFAULT_BRAVE_QUERY  = 'artificial intelligence generative AI LLM OpenAI Anthropic machine learning deep learning';
const LIVE_PAGE_SIZE = 20;

async function fetchNewsAPIArticles(apiKey, query) {
  const q   = encodeURIComponent(query || DEFAULT_NEWSAPI_QUERY);
  const url = `https://newsapi.org/v2/everything?q=${q}&language=en&sortBy=publishedAt&pageSize=${LIVE_PAGE_SIZE}&apiKey=${apiKey}`;
  const _start = Date.now();
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    logUsage({ provider: 'newsapi', operation: 'news-fetch', trigger: 'cron', durationMs: Date.now() - _start, success: false, error: `${res.status}` }).catch(() => {});
    throw new Error(`NewsAPI ${res.status}`);
  }
  const data = await res.json();
  logUsage({ provider: 'newsapi', operation: 'news-fetch', trigger: 'cron', durationMs: Date.now() - _start }).catch(() => {});
  return (data.articles || [])
    .filter(a => a.title && a.title !== '[Removed]' && a.url)
    .map(a => ({
      title:       a.title.trim(),
      summary:     (a.description || '').trim().slice(0, 500),
      source:      a.source?.name || 'NewsAPI',
      url:         a.url,
      image:       a.urlToImage || null,
      publishedAt: a.publishedAt || new Date().toISOString(),
      sourceType:  'newsapi',
    }));
}

async function fetchBraveArticles(apiKey, query) {
  const q   = encodeURIComponent(query || DEFAULT_BRAVE_QUERY);
  const url = `https://api.search.brave.com/res/v1/news/search?q=${q}&count=${LIVE_PAGE_SIZE}&search_lang=en&freshness=pd`;
  const _start = Date.now();
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json', 'X-Subscription-Token': apiKey },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    logUsage({ provider: 'brave', operation: 'news-fetch', trigger: 'cron', durationMs: Date.now() - _start, success: false, error: `${res.status}` }).catch(() => {});
    throw new Error(`Brave API ${res.status}`);
  }
  const data = await res.json();
  logUsage({ provider: 'brave', operation: 'news-fetch', trigger: 'cron', durationMs: Date.now() - _start }).catch(() => {});
  return (data.results || [])
    .filter(a => a.title && a.url)
    .map(a => ({
      title:       a.title.trim(),
      summary:     (a.description || a.extra_snippets?.[0] || '').trim().slice(0, 500),
      source:      a.source?.name || a.meta_url?.netloc || 'Brave News',
      url:         a.url,
      image:       a.thumbnail?.src || null,
      publishedAt: resolveAge(a.age),
      sourceType:  'brave',
    }));
}

function resolveAge(age) {
  if (!age) return new Date().toISOString();
  const m = age.match(/(\d+)\s+(minute|hour|day|week)/i);
  if (!m) return new Date().toISOString();
  const ms = { minute: 60000, hour: 3600000, day: 86400000, week: 604800000 }[m[2].toLowerCase()] || 0;
  return new Date(Date.now() - parseInt(m[1]) * ms).toISOString();
}

async function fetchLiveSources(autoPublish = false, tenantId = 1) {
  const appCfg     = await getAppConfig(tenantId);
  const newsApiKey = appCfg.news_api_key;
  const braveKey   = appCfg.brave_api_key;

  if (!newsApiKey && !braveKey) {
    return { inserted: 0, skipped: 0, errors: [{ source: 'live', error: 'No API keys configured' }] };
  }

  // Read per-tenant search query from settings (falls back to AI defaults)
  let liveNewsQuery = null;
  try {
    const querySetting = await db.prepare(
      "SELECT value FROM settings WHERE tenant_id = $1 AND key = 'live_news_query'"
    ).get(tenantId);
    liveNewsQuery = querySetting?.value || null;
  } catch { /* use defaults */ }

  const [newsApiResult, braveResult] = await Promise.allSettled([
    newsApiKey ? fetchNewsAPIArticles(newsApiKey, liveNewsQuery) : Promise.resolve([]),
    braveKey   ? fetchBraveArticles(braveKey, liveNewsQuery)     : Promise.resolve([]),
  ]);

  const errors = [];
  if (newsApiResult.status === 'rejected') errors.push({ source: 'newsapi', error: newsApiResult.reason.message });
  if (braveResult.status   === 'rejected') errors.push({ source: 'brave',   error: braveResult.reason.message   });

  const candidates = [
    ...(newsApiResult.status === 'fulfilled' ? newsApiResult.value : []),
    ...(braveResult.status   === 'fulfilled' ? braveResult.value   : []),
  ];

  // Deduplicate by URL within this batch
  const seen = new Set();
  const deduped = candidates.filter(a => {
    if (seen.has(a.url)) return false;
    seen.add(a.url);
    return true;
  });

  let inserted = 0, skipped = 0;

  for (const item of deduped) {
    // Skip if already in DB
    const existing = await db.prepare('SELECT id FROM articles WHERE source_url = $1 AND tenant_id = $2').get(item.url, tenantId);
    if (existing) { skipped++; continue; }

    // Use server-side categorization (detectCategory expects an RSS-item-shaped object)
    const category = await detectCategory({ title: item.title, contentSnippet: item.summary }, { tenantId });

    // Insert as draft; auto-publish path upgrades to 'published' if selected
    await db.prepare(
      `INSERT INTO articles (title, summary, category, source, source_url, image_url, published_at, is_published, is_featured, source_type, status, tenant_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0, $8, 'draft', $9)`
    ).run(decodeEntities(item.title), item.summary, category, item.source, item.url, item.image, item.publishedAt, item.sourceType, tenantId);
    inserted++;

    // Fire-and-forget: writer assignment + quality gate auto-publish
    try {
      const inserted_row = await db.prepare('SELECT * FROM articles WHERE source_url = $1 AND tenant_id = $2').get(item.url, tenantId);
      if (inserted_row) {
        const artObj = { id: inserted_row.id, title: decodeEntities(item.title), summary: item.summary, category, source: item.source };
        (async () => {
          try {
            // Writer assignment (TLDR deferred to post-publish)
            const writer = await findBestWriter(artObj, tenantId);
            if (writer) {
              await db.prepare('UPDATE articles SET writer_id = $1 WHERE id = $2 AND tenant_id = $3').run(writer.id, artObj.id, tenantId);
            }

            // Auto-publish directly for curated articles (quality gate is for synthesis only)
            if (autoPublish) {
              await db.prepare("UPDATE articles SET is_published = 1, status = 'published' WHERE id = $1 AND tenant_id = $2").run(inserted_row.id, tenantId);
              onArticlePublished(inserted_row.id, tenantId).catch(() => {});
            }
          } catch (e) { console.error('[fetch] auto-assign/publish error:', e.message); }
        })();
      }
    } catch { /* ignore */ }
  }

  return { inserted, skipped, errors };
}

// POST /api/fetch
router.post('/', auth, requirePermission('fetch.execute'), asyncHandler(async (req, res) => {
  const result = await fetchAllSources(req.body.autoPublish === true, req.tenantId);
  res.json({ status: 'ok', ...result });
}));

// POST /api/fetch/recategorize
// Body: { articleIds?, category?, days?, dryRun? }
router.post('/recategorize', auth, requirePermission('fetch.execute'), asyncHandler(async (req, res) => {
  const { articleIds, category, days, dryRun } = req.body || {};

  // Build dynamic WHERE clause
  const conditions = ['(is_archived = 0 OR is_archived IS NULL)', `tenant_id = $1`];
  const params = [req.tenantId];
  let idx = 2;

  if (Array.isArray(articleIds) && articleIds.length) {
    conditions.push(`id = ANY($${idx}::int[])`);
    params.push(articleIds);
    idx++;
  }
  if (category && typeof category === 'string') {
    conditions.push(`category = $${idx}`);
    params.push(category);
    idx++;
  }
  if (days && Number(days) > 0) {
    conditions.push(`COALESCE(published_at, created_at) > NOW() - make_interval(days => $${idx})`);
    params.push(Number(days));
    idx++;
  }

  const sql = `SELECT id, title, summary, category, writer_id FROM articles WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT 2000`;
  const articles = await db.prepare(sql).all(...params);

  const moves = {};
  const toUpdate = [];

  for (const a of articles) {
    const newCat = await detectCategory({ title: a.title, contentSnippet: a.summary }, { tenantId: req.tenantId });
    if (newCat !== a.category) {
      const key = `${a.category} → ${newCat}`;
      moves[key] = (moves[key] || 0) + 1;
      toUpdate.push({ id: a.id, title: a.title, summary: a.summary, newCat, hasWriter: !!a.writer_id });
    }
  }

  let writerReassignments = 0;

  if (!dryRun && toUpdate.length) {
    for (const item of toUpdate) {
      await db.prepare('UPDATE articles SET category = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3').run(item.newCat, item.id, req.tenantId);
      // Re-run writer assignment for articles without a writer
      if (!item.hasWriter) {
        try {
          const writer = await findBestWriter({ id: item.id, title: item.title, summary: item.summary, category: item.newCat }, req.tenantId);
          if (writer) {
            await db.prepare('UPDATE articles SET writer_id = $1 WHERE id = $2 AND tenant_id = $3').run(writer.id, item.id, req.tenantId);
            writerReassignments++;
          }
        } catch { /* best effort */ }
      }
    }
  }

  res.json({
    total: articles.length,
    updated: toUpdate.length,
    unchanged: articles.length - toUpdate.length,
    moves,
    writerReassignments,
  });
}));

// POST /api/fetch/decode-titles — one-time cleanup of HTML entities in existing titles
router.post('/decode-titles', auth, requirePermission('fetch.execute'), asyncHandler(async (req, res) => {
  const articles = await db.prepare(
    `SELECT id, title FROM articles WHERE tenant_id = $1 AND (title LIKE '%&#%' OR title LIKE '%&amp;%' OR title LIKE '%&quot;%' OR title LIKE '%&apos;%')`
  ).all(req.tenantId);

  let updated = 0;
  for (const a of articles) {
    const decoded = decodeEntities(a.title);
    if (decoded !== a.title) {
      await db.prepare('UPDATE articles SET title = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3').run(decoded, a.id, req.tenantId);
      updated++;
    }
  }
  res.json({ status: 'ok', total: articles.length, updated });
}));

// POST /api/fetch/live — fetch from NewsAPI + Brave Search
router.post('/live', auth, requirePermission('fetch.execute'), asyncHandler(async (req, res) => {
  const result = await fetchLiveSources(req.body.autoPublish === true, req.tenantId);
  res.json({ status: 'ok', ...result });
}));

module.exports = { router, fetchAllSources, fetchLiveSources, detectCategory };
