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
const { getCuratedScore } = require('../lib/quality-gate');
const { requireFeature } = require('../middleware/feature-gate');
const { onArticlePublished } = require('../lib/post-publish');

// ── Date range helper ───────────────────────────────────────────────────────

function resolveDateRange(period, fromParam, toParam) {
  const periodHours = { '1h': 1, '24h': 24, '7d': 168, '30d': 720 };
  const freshnessMap = { '1h': 'pd', '24h': 'pd', '7d': 'pw', '30d': 'pm' };

  // Standard periods
  if (periodHours[period]) {
    return {
      fromDate: new Date(Date.now() - periodHours[period] * 3600000).toISOString().split('T')[0],
      toDate: null,
      braveFreshness: freshnessMap[period],
    };
  }
  // Past year
  if (period === 'py') {
    return {
      fromDate: new Date(Date.now() - 365 * 24 * 3600000).toISOString().split('T')[0],
      toDate: null,
      braveFreshness: 'py',
    };
  }
  // Specific year (e.g. "2025")
  if (/^\d{4}$/.test(period)) {
    const year = parseInt(period);
    const now = new Date();
    const endDate = year === now.getFullYear()
      ? now.toISOString().split('T')[0]
      : `${year}-12-31`;
    return {
      fromDate: `${year}-01-01`,
      toDate: endDate,
      braveFreshness: `${year}-01-01to${endDate}`,
    };
  }
  // Custom range
  if (period === 'custom' && fromParam && toParam) {
    return {
      fromDate: fromParam,
      toDate: toParam,
      braveFreshness: `${fromParam}to${toParam}`,
    };
  }
  // Default: 24h
  return {
    fromDate: new Date(Date.now() - 24 * 3600000).toISOString().split('T')[0],
    toDate: null,
    braveFreshness: 'pd',
  };
}

// ── Shared helpers ──────────────────────────────────────────────────────────

async function fetchFromSources(config, sourceList, q, fromDate, toDate, braveFreshness) {
  const fetches = [];

  if (sourceList.includes('brave') && config.brave_api_key) {
    fetches.push((async () => {
      try {
        const url = `https://api.search.brave.com/res/v1/news/search?q=${encodeURIComponent(q)}&count=20&freshness=${encodeURIComponent(braveFreshness)}`;
        const res = await fetch(url, { headers: { 'X-Subscription-Token': config.brave_api_key, 'Accept': 'application/json' }, signal: AbortSignal.timeout(10000) });
        if (!res.ok) return [];
        const data = await res.json();
        return (data.results || []).map(item => ({
          title: item.title, url: item.url, description: item.description || '',
          source: 'brave', sourceName: item.meta_url?.hostname || new URL(item.url).hostname,
          publishedAt: item.age || item.page_age || null, imageUrl: item.thumbnail?.src || null,
        }));
      } catch (err) { console.error('[Discover] Brave error:', err.message); return []; }
    })());
  }

  if (sourceList.includes('newsapi') && config.news_api_key) {
    fetches.push((async () => {
      try {
        let url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&from=${fromDate}&sortBy=publishedAt&pageSize=20&apiKey=${config.news_api_key}`;
        if (toDate) url += `&to=${toDate}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) return [];
        const data = await res.json();
        return (data.articles || [])
          .filter(item => item.title && item.title !== '[Removed]' && item.url)
          .map(item => ({
            title: item.title, url: item.url, description: item.description || '',
            source: 'newsapi', sourceName: item.source?.name || '',
            publishedAt: item.publishedAt || null, imageUrl: item.urlToImage || null,
          }));
      } catch (err) { console.error('[Discover] NewsAPI error:', err.message); return []; }
    })());
  }

  let youtubeQuotaExceeded = false;
  if (sourceList.includes('youtube') && !config.youtube_api_key) {
    console.warn('[Discover] YouTube source requested but no API key configured');
  }
  if (sourceList.includes('youtube') && config.youtube_api_key) {
    fetches.push((async () => {
      try {
        let url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&q=${encodeURIComponent(q)}&maxResults=20&key=${config.youtube_api_key}`;
        if (fromDate) url += `&publishedAfter=${fromDate}T00:00:00Z`;
        if (toDate) url += `&publishedBefore=${toDate}T23:59:59Z`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (res.ok) {
          const data = await res.json();
          return (data.items || []).flatMap(item => {
            const videoId = item.id?.videoId;
            if (!videoId) return [];
            return [{ title: item.snippet.title, url: `https://www.youtube.com/watch?v=${videoId}`,
              description: item.snippet.description || '', source: 'youtube',
              sourceName: item.snippet.channelTitle || 'YouTube', publishedAt: item.snippet.publishedAt,
              imageUrl: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.medium?.url || null,
              embedUrl: `https://www.youtube.com/embed/${videoId}` }];
          });
        }
        const errData = await res.json().catch(() => ({}));
        if (res.status === 403 && errData?.error?.errors?.[0]?.reason === 'quotaExceeded') {
          youtubeQuotaExceeded = true;
          console.warn('[Discover] YouTube quota exceeded');
        } else {
          console.error('[Discover] YouTube API error:', res.status, errData?.error?.message || '');
        }
        return [];
      } catch (err) { console.error('[Discover] YouTube error:', err.message); return []; }
    })());
  }

  const batches = await Promise.all(fetches);
  return { results: batches.flat(), youtubeQuotaExceeded };
}

function dedupeAndFilter(results, fromDate, toDate) {
  const seen = new Set();
  const deduped = results.filter(r => {
    const key = r.url.replace(/\/$/, '').toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!fromDate && !toDate) return deduped;
  return deduped.filter(r => {
    if (!r.publishedAt) return true;
    const d = new Date(r.publishedAt);
    if (isNaN(d.getTime())) return true;
    const iso = d.toISOString().split('T')[0];
    if (fromDate && iso < fromDate) return false;
    if (toDate && iso > toDate) return false;
    return true;
  });
}

// ── GET / — Search across sources ───────────────────────────────────────────

router.get('/', auth, requirePermission('fetch.execute'), asyncHandler(async (req, res) => {
  const { q, sources, period, from, to } = req.query;
  if (!q || !q.trim()) return res.status(400).json({ error: 'Search query (q) is required' });

  const config = await getAppConfig(req.tenantId);
  const sourceList = (sources || 'brave,newsapi').split(',').map(s => s.trim().toLowerCase());

  // Determine date range
  const { fromDate, toDate, braveFreshness } = resolveDateRange(period, from, to);

  const { results, youtubeQuotaExceeded } = await fetchFromSources(config, sourceList, q, fromDate, toDate, braveFreshness);
  const unique = dedupeAndFilter(results, fromDate, toDate);

  // Categorize + duplicate-check in parallel across all results
  await Promise.all(unique.map(async r => {
    const [cat, existing] = await Promise.all([
      detectCategory({ title: r.title, contentSnippet: r.description }, { tenantId: req.tenantId }).catch(() => null),
      db.prepare('SELECT id FROM articles WHERE source_url = $1 AND tenant_id = $2').get(r.url, req.tenantId).catch(() => null),
    ]);
    r.detectedCategory = cat || null;
    r.alreadyImported  = !!existing;
  }));

  const response = { results: unique, total: unique.length, query: q };
  if (youtubeQuotaExceeded) response.youtubeQuotaExceeded = true;
  res.json(response);
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
      // Extract source name — use channel title for YouTube, domain for others
      let sourceName = article.sourceName || '';
      if (!sourceName || article.source !== 'youtube') {
        try { sourceName = new URL(article.url).hostname.replace(/^www\./, ''); } catch {}
      }

      const sourceType = article.source === 'youtube' ? 'youtube' : 'manual';
      const embedType  = article.source === 'youtube' ? 'youtube' : null;
      // YouTube videos are finished content — always publish immediately, skip the draft/pitch flow
      const shouldPublish = importPublished || article.source === 'youtube';

      // Reconstruct embed_url server-side from video ID (zero-trust — ignore client embedUrl)
      let embedUrl = null;
      if (article.source === 'youtube') {
        try {
          const u = new URL(article.url);
          const videoId = u.searchParams.get('v');
          if (videoId && /^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
            embedUrl = `https://www.youtube.com/embed/${videoId}`;
          }
        } catch {}
      }

      const mediaEnabled = embedUrl ? 1 : 0;

      const importStatus  = shouldPublish ? 'published' : 'source';
      const contentType   = embedType === 'youtube' ? 'video' : 'curated';
      const row = await db.prepare(`
        INSERT INTO articles (title, slug, summary, source_url, source, image_url, category, is_published, is_featured, published_at, status, source_type, embed_url, embed_type, content_type, media_enabled, tenant_id, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, ${shouldPublish ? 'NOW()' : 'NULL'}, $9, $10, $11, $12, $13, $14, $15, NOW())
        RETURNING id
      `).get(title, slug, summary, article.url, sourceName, imageUrl, category, shouldPublish ? 1 : 0, importStatus, sourceType, embedUrl, embedType, contentType, mediaEnabled, req.tenantId);

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

      // Score discovered articles
      if (row) {
        try {
          const gate = await getCuratedScore({ title, summary, image_url: imageUrl, author: null, source: sourceName }, req.tenantId);
          await db.prepare('UPDATE articles SET editorial_score = $1, status = $2 WHERE id = $3 AND tenant_id = $4')
            .run(gate.score, shouldPublish ? 'published' : 'draft', row.id, req.tenantId);
        } catch { /* non-fatal */ }
      }

      // Fire post-publish hooks when publishing (topic_tag, story levels, Pulse)
      if (shouldPublish && row) {
        onArticlePublished(row.id, req.tenantId).catch(() => {});
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
router.get('/saved', auth, requirePermission('fetch.execute'), requireFeature('saved_searches'), asyncHandler(async (req, res) => {
  const rows = await db.prepare(
    'SELECT * FROM saved_searches WHERE tenant_id = $1 ORDER BY name'
  ).all(req.tenantId);
  res.json(rows);
}));

// POST /saved — save a search with current results
router.post('/saved', auth, requirePermission('fetch.execute'), requireFeature('saved_searches'), asyncHandler(async (req, res) => {
  const { name, query, sources, period, from_date, to_date, results } = req.body;
  if (!name || !query) return res.status(400).json({ error: 'name and query are required' });

  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (from_date && !dateRe.test(from_date)) return res.status(400).json({ error: 'Invalid from_date format' });
  if (to_date && !dateRe.test(to_date)) return res.status(400).json({ error: 'Invalid to_date format' });

  const resultsJson = results && Array.isArray(results) ? JSON.stringify(results) : null;
  const resultCount = results && Array.isArray(results) ? results.length : 0;

  const row = await db.prepare(`
    INSERT INTO saved_searches (tenant_id, name, query, sources, period, from_date, to_date, created_by, results, result_count, last_run_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
    ON CONFLICT (tenant_id, name) DO UPDATE SET query = EXCLUDED.query, sources = EXCLUDED.sources, period = EXCLUDED.period, from_date = EXCLUDED.from_date, to_date = EXCLUDED.to_date, results = EXCLUDED.results, result_count = EXCLUDED.result_count, last_run_at = NOW()
    RETURNING id, name, query, sources, period, from_date, to_date, result_count, last_run_at, created_at
  `).get(req.tenantId, name.trim(), query.trim(), sources || 'brave,newsapi', period || '24h', from_date || null, to_date || null, req.user.sub || null, resultsJson, resultCount);

  res.status(201).json(row);
}));

// GET /saved/:id — get saved search with cached results
router.get('/saved/:id', auth, requirePermission('fetch.execute'), requireFeature('saved_searches'), asyncHandler(async (req, res) => {
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
router.delete('/saved/:id', auth, requirePermission('fetch.execute'), requireFeature('saved_searches'), asyncHandler(async (req, res) => {
  await db.prepare(
    'DELETE FROM saved_searches WHERE id = $1 AND tenant_id = $2'
  ).run(req.params.id, req.tenantId);
  res.json({ message: 'Deleted' });
}));

// POST /saved/:id/refresh — re-run search and update cached results
router.post('/saved/:id/refresh', auth, requirePermission('fetch.execute'), requireFeature('saved_searches'), asyncHandler(async (req, res) => {
  const search = await db.prepare(
    'SELECT * FROM saved_searches WHERE id = $1 AND tenant_id = $2'
  ).get(req.params.id, req.tenantId);
  if (!search) return res.status(404).json({ error: 'Saved search not found' });

  // Execute search using the saved params — reuse the GET / logic
  const config = await getAppConfig(req.tenantId);
  const sourceList = (search.sources || 'brave,newsapi').split(',').map(s => s.trim().toLowerCase());
  const { fromDate, toDate, braveFreshness } = resolveDateRange(search.period, search.from_date, search.to_date);

  const { results, youtubeQuotaExceeded } = await fetchFromSources(config, sourceList, search.query, fromDate, toDate, braveFreshness);
  const unique = dedupeAndFilter(results, fromDate, toDate);

  await Promise.all(unique.map(async r => {
    const [cat, existing] = await Promise.all([
      detectCategory({ title: r.title, contentSnippet: r.description }, { tenantId: req.tenantId }).catch(() => null),
      db.prepare('SELECT id FROM articles WHERE source_url = $1 AND tenant_id = $2').get(r.url, req.tenantId).catch(() => null),
    ]);
    r.detectedCategory = cat || null;
    r.alreadyImported  = !!existing;
  }));

  // Update saved search with fresh results
  await db.prepare(
    'UPDATE saved_searches SET results = $1, result_count = $2, last_run_at = NOW() WHERE id = $3'
  ).run(JSON.stringify(unique), unique.length, search.id);

  const refreshResponse = { results: unique, total: unique.length, query: search.query, cached: false };
  if (youtubeQuotaExceeded) refreshResponse.youtubeQuotaExceeded = true;
  res.json(refreshResponse);
}));

module.exports = router;
