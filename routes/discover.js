/**
 * Deep Feed AI — /api/admin/discover
 * Search news across Brave Search and NewsAPI, then selectively import as articles.
 */
const router             = require('express').Router();
const db                 = require('../db');
const { asyncHandler, toSlug, decodeEntities } = require('../lib/utils');
const { auth }           = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { getAppConfig }   = require('../lib/app-config');
const { detectCategory } = require('../lib/categorize');
const { scrapeOgImage }  = require('../lib/scrape');
const { findBestWriter } = require('../lib/writer-assign');
const { logAudit }       = require('../middleware/audit');

// ── GET / — Search across sources ───────────────────────────────────────────

router.get('/', auth, requirePermission('fetch.execute'), asyncHandler(async (req, res) => {
  const { q, sources, period } = req.query;
  if (!q || !q.trim()) return res.status(400).json({ error: 'Search query (q) is required' });

  const config = await getAppConfig(req.tenantId);
  const sourceList = (sources || 'brave,newsapi').split(',').map(s => s.trim().toLowerCase());

  // Determine date range
  const periodMap = { '1h': 1, '24h': 24, '7d': 168, '30d': 720 };
  const hours = periodMap[period] || 24;
  const fromDate = new Date(Date.now() - hours * 60 * 60 * 1000);

  const results = [];

  // Query Brave Search API
  if (sourceList.includes('brave') && config.brave_api_key) {
    try {
      const freshnessMap = { '1h': 'pd', '7d': 'pw', '30d': 'pm' };
      const freshness = freshnessMap[period] || 'pd';
      const braveUrl = `https://api.search.brave.com/res/v1/news/search?q=${encodeURIComponent(q)}&count=20&freshness=${freshness}`;
      const braveRes = await fetch(braveUrl, {
        headers: { 'X-Subscription-Token': config.brave_api_key, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      if (braveRes.ok) {
        const data = await braveRes.json();
        for (const item of (data.results || [])) {
          results.push({
            title: item.title,
            url: item.url,
            description: item.description || '',
            source: 'brave',
            sourceName: item.meta_url?.hostname || new URL(item.url).hostname,
            publishedAt: item.age || item.page_age || null,
            imageUrl: item.thumbnail?.src || null,
          });
        }
      }
    } catch (err) {
      console.error('[Discover] Brave search error:', err.message);
    }
  }

  // Query NewsAPI
  if (sourceList.includes('newsapi') && config.news_api_key) {
    try {
      const from = fromDate.toISOString().split('T')[0];
      const newsUrl = `https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&from=${from}&sortBy=publishedAt&pageSize=20&apiKey=${config.news_api_key}`;
      const newsRes = await fetch(newsUrl, { signal: AbortSignal.timeout(10000) });
      if (newsRes.ok) {
        const data = await newsRes.json();
        for (const item of (data.articles || [])) {
          if (!item.title || item.title === '[Removed]' || !item.url) continue;
          results.push({
            title: item.title,
            url: item.url,
            description: item.description || '',
            source: 'newsapi',
            sourceName: item.source?.name || '',
            publishedAt: item.publishedAt || null,
            imageUrl: item.urlToImage || null,
          });
        }
      }
    } catch (err) {
      console.error('[Discover] NewsAPI search error:', err.message);
    }
  }

  // Deduplicate by URL
  const seen = new Set();
  const unique = results.filter(r => {
    const key = r.url.replace(/\/$/, '').toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Auto-detect category (keyword-only, no AI budget burn)
  for (const r of unique) {
    try {
      const cat = await detectCategory(
        { title: r.title, contentSnippet: r.description },
        { tenantId: req.tenantId }
      );
      r.detectedCategory = cat || null;
    } catch {
      r.detectedCategory = null;
    }
  }

  // Check which URLs are already imported
  for (const r of unique) {
    try {
      const existing = await db.prepare(
        'SELECT id FROM articles WHERE source_url = $1 AND tenant_id = $2'
      ).get(r.url, req.tenantId);
      r.alreadyImported = !!existing;
    } catch {
      r.alreadyImported = false;
    }
  }

  res.json({ results: unique, total: unique.length, query: q });
}));

// ── POST /import — Import selected articles ─────────────────────────────────

router.post('/import', auth, requirePermission('articles.create'), asyncHandler(async (req, res) => {
  const { articles, status, autoAssignWriter, autoCategorize } = req.body;
  if (!articles || !Array.isArray(articles) || articles.length === 0) {
    return res.status(400).json({ error: 'articles array is required' });
  }
  if (articles.length > 20) {
    return res.status(400).json({ error: 'Maximum 20 articles per import' });
  }

  const importPublished = status === 'published';
  const results = { imported: 0, skipped: 0, errors: [] };

  for (const article of articles) {
    try {
      if (!article.url) {
        results.errors.push({ url: article.url, error: 'Missing URL' });
        continue;
      }

      // Check for duplicate
      const existing = await db.prepare(
        'SELECT id FROM articles WHERE source_url = $1 AND tenant_id = $2'
      ).get(article.url, req.tenantId);
      if (existing) {
        results.skipped++;
        continue;
      }

      // Scrape OG image if no image provided
      let ogImage = null;
      if (!article.imageUrl) {
        try {
          ogImage = await scrapeOgImage(article.url, req.tenantId);
        } catch { /* use provided data */ }
      }

      const title = decodeEntities(article.title || 'Untitled');
      const summary = (article.description || '').trim().slice(0, 500);
      const imageUrl = article.imageUrl || ogImage || null;
      const slug = toSlug(title);

      // Detect category
      let category = article.category || null;
      if (!category && autoCategorize !== false) {
        try {
          category = await detectCategory(
            { title, contentSnippet: summary },
            { tenantId: req.tenantId }
          );
        } catch { /* leave null */ }
      }

      // Insert article
      // Extract source domain name
      let sourceName = '';
      try { sourceName = new URL(article.url).hostname.replace(/^www\./, ''); } catch {}

      const row = await db.prepare(`
        INSERT INTO articles (title, slug, summary, source_url, source, image_url, category, is_published, is_featured, published_at, source_type, tenant_id, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, ${importPublished ? 'NOW()' : 'NULL'}, 'manual', $9, NOW())
        RETURNING id
      `).get(title, slug, summary, article.url, sourceName, imageUrl, category, importPublished ? 1 : 0, req.tenantId);

      // Auto-assign writer if requested
      if (autoAssignWriter !== false && row) {
        try {
          const writer = await findBestWriter(
            { id: row.id, title, summary, category, source: article.sourceName || '' },
            req.tenantId
          );
          if (writer) {
            await db.prepare('UPDATE articles SET writer_id = $1 WHERE id = $2 AND tenant_id = $3')
              .run(writer.id, row.id, req.tenantId);
          }
        } catch { /* non-fatal */ }
      }

      results.imported++;
    } catch (err) {
      results.errors.push({ url: article.url, error: err.message });
    }
  }

  await logAudit(req, 'discover.import', 'articles', null, {
    imported: results.imported,
    skipped: results.skipped,
    errors: results.errors.length,
    status: status || 'draft',
  });

  res.json(results);
}));

// ── Saved Searches ──────────────────────────────────────────────────────────

// GET /saved — list saved searches
router.get('/saved', auth, requirePermission('fetch.execute'), asyncHandler(async (req, res) => {
  const rows = await db.prepare(
    'SELECT * FROM saved_searches WHERE tenant_id = $1 ORDER BY name'
  ).all(req.tenantId);
  res.json(rows);
}));

// POST /saved — save a search with current results
router.post('/saved', auth, requirePermission('fetch.execute'), asyncHandler(async (req, res) => {
  const { name, query, sources, period, results } = req.body;
  if (!name || !query) return res.status(400).json({ error: 'name and query are required' });

  const resultsJson = results && Array.isArray(results) ? JSON.stringify(results) : null;
  const resultCount = results && Array.isArray(results) ? results.length : 0;

  const row = await db.prepare(`
    INSERT INTO saved_searches (tenant_id, name, query, sources, period, created_by, results, result_count, last_run_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
    ON CONFLICT (tenant_id, name) DO UPDATE SET query = EXCLUDED.query, sources = EXCLUDED.sources, period = EXCLUDED.period, results = EXCLUDED.results, result_count = EXCLUDED.result_count, last_run_at = NOW()
    RETURNING id, name, query, sources, period, result_count, last_run_at, created_at
  `).get(req.tenantId, name.trim(), query.trim(), sources || 'brave,newsapi', period || '24h', req.user.sub || null, resultsJson, resultCount);

  res.status(201).json(row);
}));

// GET /saved/:id — get saved search with cached results
router.get('/saved/:id', auth, requirePermission('fetch.execute'), asyncHandler(async (req, res) => {
  const search = await db.prepare(
    'SELECT * FROM saved_searches WHERE id = $1 AND tenant_id = $2'
  ).get(req.params.id, req.tenantId);
  if (!search) return res.status(404).json({ error: 'Saved search not found' });

  // Parse results JSONB
  let results = [];
  if (search.results) {
    results = typeof search.results === 'string' ? JSON.parse(search.results) : search.results;
  }

  // Re-check alreadyImported status for cached results
  for (const r of results) {
    try {
      const existing = await db.prepare(
        'SELECT id FROM articles WHERE source_url = $1 AND tenant_id = $2'
      ).get(r.url, req.tenantId);
      r.alreadyImported = !!existing;
    } catch {
      r.alreadyImported = false;
    }
  }

  res.json({
    ...search,
    results,
    cached: true,
  });
}));

// DELETE /saved/:id — delete a saved search
router.delete('/saved/:id', auth, requirePermission('fetch.execute'), asyncHandler(async (req, res) => {
  await db.prepare(
    'DELETE FROM saved_searches WHERE id = $1 AND tenant_id = $2'
  ).run(req.params.id, req.tenantId);
  res.json({ message: 'Deleted' });
}));

// POST /saved/:id/refresh — re-run search and update cached results
router.post('/saved/:id/refresh', auth, requirePermission('fetch.execute'), asyncHandler(async (req, res) => {
  const search = await db.prepare(
    'SELECT * FROM saved_searches WHERE id = $1 AND tenant_id = $2'
  ).get(req.params.id, req.tenantId);
  if (!search) return res.status(404).json({ error: 'Saved search not found' });

  // Execute search using the saved params — reuse the GET / logic
  req.query = { q: search.query, sources: search.sources, period: search.period };

  const config = await getAppConfig(req.tenantId);
  const sourceList = (search.sources || 'brave,newsapi').split(',').map(s => s.trim().toLowerCase());
  const periodMap = { '1h': 1, '24h': 24, '7d': 168, '30d': 720 };
  const hours = periodMap[search.period] || 24;
  const fromDate = new Date(Date.now() - hours * 60 * 60 * 1000);

  const results = [];

  if (sourceList.includes('brave') && config.brave_api_key) {
    try {
      const freshnessMap = { '1h': 'pd', '7d': 'pw', '30d': 'pm' };
      const freshness = freshnessMap[search.period] || 'pd';
      const braveUrl = `https://api.search.brave.com/res/v1/news/search?q=${encodeURIComponent(search.query)}&count=20&freshness=${freshness}`;
      const braveRes = await fetch(braveUrl, {
        headers: { 'X-Subscription-Token': config.brave_api_key, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      if (braveRes.ok) {
        const data = await braveRes.json();
        for (const item of (data.results || [])) {
          results.push({ title: item.title, url: item.url, description: item.description || '', source: 'brave', sourceName: item.meta_url?.hostname || new URL(item.url).hostname, publishedAt: item.age || item.page_age || null, imageUrl: item.thumbnail?.src || null });
        }
      }
    } catch {}
  }

  if (sourceList.includes('newsapi') && config.news_api_key) {
    try {
      const from = fromDate.toISOString().split('T')[0];
      const newsUrl = `https://newsapi.org/v2/everything?q=${encodeURIComponent(search.query)}&from=${from}&sortBy=publishedAt&pageSize=20&apiKey=${config.news_api_key}`;
      const newsRes = await fetch(newsUrl, { signal: AbortSignal.timeout(10000) });
      if (newsRes.ok) {
        const data = await newsRes.json();
        for (const item of (data.articles || [])) {
          if (!item.title || item.title === '[Removed]' || !item.url) continue;
          results.push({ title: item.title, url: item.url, description: item.description || '', source: 'newsapi', sourceName: item.source?.name || '', publishedAt: item.publishedAt || null, imageUrl: item.urlToImage || null });
        }
      }
    } catch {}
  }

  // Deduplicate
  const seen = new Set();
  const unique = results.filter(r => { const k = r.url.replace(/\/$/, '').toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });

  // Auto-categorize
  for (const r of unique) {
    try { r.detectedCategory = await detectCategory({ title: r.title, contentSnippet: r.description }, { tenantId: req.tenantId }) || null; } catch { r.detectedCategory = null; }
  }

  // Check already imported
  for (const r of unique) {
    try { const ex = await db.prepare('SELECT id FROM articles WHERE source_url = $1 AND tenant_id = $2').get(r.url, req.tenantId); r.alreadyImported = !!ex; } catch { r.alreadyImported = false; }
  }

  // Update saved search with fresh results
  await db.prepare(
    'UPDATE saved_searches SET results = $1, result_count = $2, last_run_at = NOW() WHERE id = $3'
  ).run(JSON.stringify(unique), unique.length, search.id);

  res.json({ results: unique, total: unique.length, query: search.query, cached: false });
}));

module.exports = router;
