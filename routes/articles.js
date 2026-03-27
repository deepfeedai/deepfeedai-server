const express                        = require('express');
const router                         = express.Router();
const db                             = require('../db');
const { getPool }                    = require('../db');
const { auth }                       = require('../middleware/auth');
const { requirePermission }          = require('../middleware/permissions');
const { serializeRow, asyncHandler } = require('../lib/utils');
const { articleCreate, articleUpdate, validate } = require('../lib/schemas');
const { onArticlePublished } = require('../lib/post-publish');
const { findBestWriter } = require('../lib/writer-assign');
// Plan limit for articles removed — credits are the natural throttle
const { logAudit, logAuditWithDiff } = require('../middleware/audit');
const { learnFromCorrection } = require('../lib/categorize');
const { deleteImage, deleteAudio } = require('../lib/media-helpers');
const { validateBlocks, blocksToMarkdown } = require('../lib/blocks');

// GET /api/articles
router.get('/', auth, requirePermission('articles.read'), asyncHandler(async (req, res) => {
  let query = 'SELECT * FROM articles WHERE tenant_id = $1';
  let countQuery = 'SELECT COUNT(*) AS cnt FROM articles WHERE tenant_id = $1';
  const params = [req.tenantId];
  const countParams = [req.tenantId];

  if (req.query.published !== undefined) {
    const pubVal = parseInt(req.query.published);
    if (pubVal === 0 || pubVal === 1) {
      params.push(pubVal);
      countParams.push(pubVal);
      query += ` AND is_published = $${params.length}`;
      countQuery += ` AND is_published = $${countParams.length}`;
    }
  }
  if (req.query.category) {
    params.push(req.query.category);
    countParams.push(req.query.category);
    query += ` AND category = $${params.length}`;
    countQuery += ` AND category = $${countParams.length}`;
  }
  if (req.query.search) {
    const search = String(req.query.search).slice(0, 200);
    params.push('%' + search + '%');
    countParams.push('%' + search + '%');
    query += ` AND LOWER(title) LIKE LOWER($${params.length})`;
    countQuery += ` AND LOWER(title) LIKE LOWER($${countParams.length})`;
  }
  query += ' ORDER BY created_at DESC';

  // Pagination: ?limit=50&offset=0 (defaults: limit 100, offset 0)
  const limit  = Math.min(Math.max(1, parseInt(req.query.limit) || 100), 500);
  const offset = Math.max(0, parseInt(req.query.offset) || 0);
  params.push(limit);
  query += ` LIMIT $${params.length}`;
  params.push(offset);
  query += ` OFFSET $${params.length}`;

  const [result, countRow] = await Promise.all([
    getPool().query(query, params),
    getPool().query(countQuery, countParams),
  ]);
  const totalCount = parseInt(countRow.rows[0]?.cnt ?? 0, 10);

  res.json({
    articles: result.rows.map(serializeRow),
    count: result.rows.length,
    totalCount,
    hasMore: offset + result.rows.length < totalCount,
  });
}));

// ── GET /api/articles/export — must be BEFORE /:id to avoid "export" being parsed as an integer
// Optional query params:
//   format=csv|json (default: json)
//   category=<name>  filter by category
//   since=<ISO date> filter by published_at >= date
// DELETE /api/articles/purge-all — hard delete all articles (testing/reset)
// ?type=curated|original|all (default: all)
router.delete('/purge-all', auth, requirePermission('articles.delete'), asyncHandler(async (req, res) => {
  const { type = 'all' } = req.query;

  // Fetch media URLs before deleting so we can clean up storage
  let selectSql;
  if (type === 'curated') {
    selectSql = `SELECT id, image_url, audio_url, inline_images FROM articles WHERE tenant_id = $1 AND (content_type != 'original' OR content_type IS NULL)`;
  } else if (type === 'original') {
    selectSql = `SELECT id, image_url, audio_url, inline_images FROM articles WHERE tenant_id = $1 AND content_type = 'original'`;
  } else {
    selectSql = `SELECT id, image_url, audio_url, inline_images FROM articles WHERE tenant_id = $1`;
  }
  const articles = await db.prepare(selectSql).all(req.tenantId);

  // Clean up stored media files (best effort, don't block on failures)
  for (const a of articles) {
    await deleteAudio(a.audio_url, req.tenantId);
    await deleteImage(a.image_url, req.tenantId);
    const inlines = typeof a.inline_images === 'string'
      ? JSON.parse(a.inline_images) : (a.inline_images || []);
    for (const img of inlines) {
      if (img.url) await deleteImage(img.url, req.tenantId);
    }
  }

  let deleteSql;
  if (type === 'curated') {
    deleteSql = `DELETE FROM articles WHERE tenant_id = $1 AND (content_type != 'original' OR content_type IS NULL) RETURNING id`;
  } else if (type === 'original') {
    deleteSql = `DELETE FROM articles WHERE tenant_id = $1 AND content_type = 'original' RETURNING id`;
  } else {
    deleteSql = `DELETE FROM articles WHERE tenant_id = $1 RETURNING id`;
  }
  const deleted = await db.prepare(deleteSql).all(req.tenantId);

  // Clean up analytics events for purged articles (preserve ai_usage for credit history)
  if (type === 'all') {
    await db.prepare('DELETE FROM analytics_events WHERE tenant_id = $1').run(req.tenantId);
  } else {
    const { toSlug } = require('../lib/utils');
    for (const a of articles) {
      if (!a.title) continue;
      const slug = toSlug(a.title);
      if (slug) {
        await db.prepare('DELETE FROM analytics_events WHERE tenant_id = $1 AND article_slug = $2').run(req.tenantId, slug);
      }
    }
  }

  res.json({ deleted: deleted.length, type });
}));

router.get('/export', auth, requirePermission('articles.read'), asyncHandler(async (req, res) => {
  const format   = (req.query.format || 'json').toLowerCase();
  const category = req.query.category || null;
  const since    = req.query.since    || null;

  if (!['csv', 'json'].includes(format)) {
    return res.status(400).json({ error: 'format must be csv or json' });
  }

  // By default export ALL articles; optional filters narrow the set
  const conditions = ['tenant_id = $1'];
  const params = [req.tenantId];

  if (category) {
    params.push(category);
    conditions.push(`category = $${params.length}`);
  }
  if (since) {
    const sinceDate = new Date(since);
    if (isNaN(sinceDate)) return res.status(400).json({ error: 'invalid since date' });
    params.push(sinceDate.toISOString());
    conditions.push(`published_at >= $${params.length}`);
  }

  const sql = `
    SELECT id, title, summary, category, source, source_url, image_url, author,
           is_featured, featured_priority, is_published, is_archived,
           published_at, created_at, updated_at, audio_url, media_enabled
    FROM articles
    WHERE ${conditions.join(' AND ')}
    ORDER BY published_at DESC
  `;

  const result = await getPool().query(sql, params);
  const rows   = result.rows.map(serializeRow);
  const ts     = new Date().toISOString().slice(0, 10);

  if (format === 'json') {
    res.setHeader('Content-Disposition', `attachment; filename="articles-${ts}.json"`);
    res.setHeader('Content-Type', 'application/json');
    return res.json({ exported_at: new Date().toISOString(), count: rows.length, articles: rows });
  }

  // CSV
  const COLS = ['id','title','summary','category','source','source_url','image_url',
                'author','is_featured','featured_priority','is_published','is_archived',
                'published_at','created_at','updated_at','audio_url','media_enabled'];

  function csvCell(val) {
    if (val === null || val === undefined) return '';
    let s = String(val);
    // Prevent CSV formula injection — prefix dangerous leading characters with a tab
    if (/^[=+\-@\t\r]/.test(s)) s = '\t' + s;
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  const header = COLS.join(',');
  const lines  = rows.map(r => COLS.map(c => csvCell(r[c])).join(','));
  const csv    = [header, ...lines].join('\r\n');

  res.setHeader('Content-Disposition', `attachment; filename="articles-${ts}.csv"`);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  return res.send(csv);
}));

// POST /api/articles/bulk-assign-writer — auto-assign best writer to multiple articles
router.post('/bulk-assign-writer', auth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const { articleIds } = req.body;
  if (!Array.isArray(articleIds) || !articleIds.length) return res.status(400).json({ error: 'articleIds required' });

  const MAX_BULK = 200;
  const safeIds = articleIds.map(id => parseInt(id, 10)).filter(n => Number.isFinite(n) && n > 0);
  if (!safeIds.length) return res.status(400).json({ error: 'articleIds must be non-empty integers' });
  if (safeIds.length > MAX_BULK) return res.status(400).json({ error: `Maximum ${MAX_BULK} articles per request` });

  // Pre-fetch auto-assign writers once for the whole batch
  const autoWriters = await db.prepare(`
    SELECT w.*, array_agg(c.name) FILTER (WHERE c.name IS NOT NULL) AS beat_names
    FROM writers w
    LEFT JOIN writer_beats wb ON wb.writer_id = w.id AND wb.tenant_id = $1
    LEFT JOIN categories c ON c.id = wb.category_id AND c.tenant_id = $1
    WHERE w.is_auto = true AND w.tenant_id = $1
    GROUP BY w.id
  `).all(req.tenantId);

  let assigned = 0, skipped = 0;
  const results = [];

  for (const id of safeIds) {
    const article = await db.prepare('SELECT * FROM articles WHERE id = $1 AND tenant_id = $2').get(id, req.tenantId);
    if (!article) { skipped++; continue; }

    const writer = await findBestWriter(article, req.tenantId, autoWriters);
    if (!writer) { skipped++; results.push({ id, writer: null }); continue; }

    await db.prepare('UPDATE articles SET writer_id = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3').run(writer.id, id, req.tenantId);
    assigned++;
    results.push({ id, writer: { id: writer.id, name: writer.name } });
  }

  logAudit(req, 'articles.bulk-assign-writer', 'articles', null, { assigned, skipped, count: safeIds.length });
  res.json({ assigned, skipped, results });
}));

// GET /api/articles/review-queue (must be before /:id)
router.get('/review-queue', auth, requirePermission('articles.read'), asyncHandler(async (req, res) => {
  const result = await getPool().query(
    'SELECT * FROM articles WHERE tenant_id = $1 AND status = $2 ORDER BY submitted_for_review_at ASC',
    [req.tenantId, 'review']
  );
  res.json({ articles: result.rows.map(serializeRow), count: result.rows.length });
}));

// GET /api/articles/preview-by-slug?slug=...  (search current tenant, fallback to all)
router.get('/preview-by-slug', auth, requirePermission('articles.read'), asyncHandler(async (req, res) => {
  const { slug } = req.query;
  if (!slug) return res.status(400).json({ error: 'slug param required' });

  const { toSlug } = require('../lib/utils');
  // Search current tenant first
  let articles = await db.prepare(
    'SELECT * FROM articles WHERE tenant_id = $1 AND is_published = 1 ORDER BY published_at DESC'
  ).all(req.tenantId);
  let match = articles.find(a => toSlug(a.title) === slug);

  if (!match) return res.status(404).json({ error: 'Article not found' });

  // Include writer info
  let writer = null;
  if (match.writer_id) {
    writer = await db.prepare('SELECT id, name, slug, avatar_url FROM writers WHERE id = $1').get(match.writer_id);
  }

  res.json({ article: serializeRow(match), writer: writer || null });
}));

// ── Featured rotation endpoints (must be before /:id) ────────────────
const { rotateFeatured, getRotationStatus } = require('../lib/featured-rotation');

// POST /api/articles/rotate-featured — manual trigger
router.post('/rotate-featured', auth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const result = await rotateFeatured(req.tenantId, { force: true });
  logAudit(req, 'article.rotate-featured', 'articles', null, { ...result });
  res.json(result);
}));

// GET /api/articles/rotation-status
router.get('/rotation-status', auth, requirePermission('articles.read'), asyncHandler(async (req, res) => {
  const status = await getRotationStatus(req.tenantId);
  res.json(status);
}));

// GET /api/articles/rotation-log
router.get('/rotation-log', auth, requirePermission('articles.read'), asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const logs = await db.prepare(
    'SELECT * FROM featured_rotation_log WHERE tenant_id = $1 ORDER BY rotated_at DESC LIMIT $2'
  ).all(req.tenantId, limit);
  res.json(logs);
}));

// GET /api/articles/:id
router.get('/:id', auth, requirePermission('articles.read'), asyncHandler(async (req, res) => {
  const article = await db.prepare('SELECT * FROM articles WHERE id = $1 AND tenant_id = $2').get(req.params.id, req.tenantId);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  res.json(article);
}));

// POST /api/articles
router.post('/', auth, requirePermission('articles.create'), asyncHandler(async (req, res) => {
  const body = validate(articleCreate, req.body, res);
  if (!body) return;

  const { title, summary, content, content_blocks, category, source, source_url,
          image_url, author, is_featured, featured_priority: fp, is_published, published_at } = body;

  // Validate content_blocks if provided
  let blocksJson = null;
  let derivedContent = content || null;
  if (content_blocks && content_blocks.blocks && content_blocks.blocks.length) {
    const v = validateBlocks(content_blocks);
    if (!v.valid) return res.status(400).json({ error: 'Invalid content_blocks', details: v.errors });
    blocksJson = content_blocks;
    derivedContent = blocksToMarkdown(content_blocks);
  }

  const newPriority = fp ? parseInt(fp) : null;

  if (is_featured && newPriority) {
    // Evict whoever holds this slot
    await db.prepare(
      'UPDATE articles SET is_featured = 0, featured_priority = NULL, updated_at = NOW() WHERE featured_priority = $1 AND tenant_id = $2'
    ).run(newPriority, req.tenantId);
  }

  const { toSlug } = require('../lib/utils');
  const pubVal = is_published !== undefined ? (is_published ? 1 : 0) : 1;
  const initStatus = pubVal ? 'published' : 'draft';
  const article = await db.prepare(`
    INSERT INTO articles
      (title, slug, summary, content, content_blocks, full_content, category, source, source_url, image_url, author,
       is_featured, featured_priority, is_published, published_at, status, tenant_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
    RETURNING *
  `).get(
    title,
    toSlug(title),
    summary    || null,
    derivedContent,
    blocksJson ? JSON.stringify(blocksJson) : null,
    blocksJson ? derivedContent : null,
    category   || 'Industry',
    source     || null,
    source_url || null,
    image_url  || null,
    author     || null,
    is_featured  ? 1 : 0,
    newPriority,
    pubVal,
    published_at || new Date().toISOString(),
    initStatus,
    req.tenantId
  );
  // Auto-assign best writer if none set
  if (!article.writer_id) {
    findBestWriter({ id: article.id, title: article.title, summary: article.summary, category: article.category }, req.tenantId)
      .then(writer => {
        if (writer) db.prepare('UPDATE articles SET writer_id = $1 WHERE id = $2 AND tenant_id = $3').run(writer.id, article.id, req.tenantId);
      }).catch(() => {});
  }

  logAudit(req, 'article.create', 'article', article.id, { title: article.title });
  res.status(201).json(article);
}));

// PUT /api/articles/:id
router.put('/:id', auth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const existing = await db.prepare('SELECT * FROM articles WHERE id = $1 AND tenant_id = $2').get(req.params.id, req.tenantId);
  if (!existing) return res.status(404).json({ error: 'Article not found' });

  const body = validate(articleUpdate, req.body, res);
  if (!body) return;

  const { title, summary, content, content_blocks, category, source, source_url,
          image_url, author, is_featured, featured_priority, is_published, published_at, disable_summary } = body;

  // Handle content_blocks: validate and derive full_content
  let blocksJson = undefined; // undefined = not sent, don't update
  let derivedFullContent = undefined;
  if (content_blocks !== undefined) {
    if (content_blocks && content_blocks.blocks && content_blocks.blocks.length) {
      const v = validateBlocks(content_blocks);
      if (!v.valid) return res.status(400).json({ error: 'Invalid content_blocks', details: v.errors });
      blocksJson = content_blocks;
      derivedFullContent = blocksToMarkdown(content_blocks);
    } else {
      blocksJson = null;
      derivedFullContent = null;
    }
  }

  const newFeatured = is_featured !== undefined ? (is_featured ? 1 : 0) : existing.is_featured;
  const newPriority = featured_priority !== undefined ? (featured_priority || null) : existing.featured_priority;

  if (newFeatured) {
    // If assigning a priority slot, evict whoever currently holds it
    if (newPriority) {
      await db.prepare(
        'UPDATE articles SET is_featured = 0, featured_priority = NULL, updated_at = NOW() WHERE featured_priority = $1 AND id != $2 AND tenant_id = $3'
      ).run(newPriority, req.params.id, req.tenantId);
    }
  }

  // Check raw body — Zod .default() fills is_published even when not sent
  const pubExplicit = req.body.is_published !== undefined;
  const newIsPublished = pubExplicit ? (is_published ? 1 : 0) : existing.is_published;
  // Only change status if is_published was explicitly sent AND actually changed
  const pubChanged = pubExplicit && newIsPublished !== existing.is_published;
  const newStatus = pubChanged ? (newIsPublished ? 'published' : 'draft') : (existing.status || 'draft');

  // Recompute slug when title changes
  const { toSlug } = require('../lib/utils');
  const newTitle = title !== undefined ? title : existing.title;
  const newSlug = title !== undefined ? toSlug(title) : existing.slug;

  const updated = await db.prepare(`
    UPDATE articles SET
      title = $1, slug = $2, summary = $3, content = $4, category = $5, source = $6,
      source_url = $7, image_url = $8, author = $9, is_featured = $10,
      featured_priority = $11, is_published = $12, published_at = $13, status = $14,
      content_blocks = $15, full_content = $16, disable_summary = $17, updated_at = NOW()
    WHERE id = $18 AND tenant_id = $19
    RETURNING *
  `).get(
    newTitle,
    newSlug,
    summary      !== undefined ? summary      : existing.summary,
    content      !== undefined ? content      : existing.content,
    category     !== undefined ? category     : existing.category,
    source       !== undefined ? source       : existing.source,
    source_url   !== undefined ? source_url   : existing.source_url,
    image_url    !== undefined ? image_url    : existing.image_url,
    author       !== undefined ? author       : existing.author,
    newFeatured,
    newPriority,
    newIsPublished,
    published_at !== undefined ? published_at : existing.published_at,
    newStatus,
    blocksJson !== undefined ? (blocksJson ? JSON.stringify(blocksJson) : null) : (existing.content_blocks || null),
    derivedFullContent !== undefined ? derivedFullContent : (existing.full_content || null),
    disable_summary !== undefined ? (disable_summary ? 1 : 0) : (existing.disable_summary || 0),
    req.params.id,
    req.tenantId
  );
  // Learn from manual category corrections
  if (category !== undefined && category !== existing.category && updated?.title) {
    learnFromCorrection(updated.title, category, req.tenantId).catch(() => {});
  }

  logAuditWithDiff(req, 'article.update', 'article', parseInt(req.params.id), existing, updated, { title: updated?.title });
  res.json(updated);
}));

// DELETE /api/articles/:id — soft archive
router.delete('/:id', auth, requirePermission('articles.delete'), asyncHandler(async (req, res) => {
  const existing = await db.prepare('SELECT id FROM articles WHERE id = $1 AND tenant_id = $2').get(req.params.id, req.tenantId);
  if (!existing) return res.status(404).json({ error: 'Article not found' });
  await db.prepare(`
    UPDATE articles
    SET is_archived = 1, is_published = 0, is_featured = 0, featured_priority = NULL,
        is_pinned = 0, featured_source = NULL, featured_until = NULL,
        status = 'archived', archived_at = NOW(), updated_at = NOW()
    WHERE id = $1 AND tenant_id = $2
  `).run(req.params.id, req.tenantId);
  logAudit(req, 'article.archive', 'article', parseInt(req.params.id));
  res.json({ message: 'Article archived' });
}));

// DELETE /api/articles/:id/purge — hard delete
router.delete('/:id/purge', auth, requirePermission('articles.delete'), asyncHandler(async (req, res) => {
  const existing = await db.prepare('SELECT id, title, image_url, audio_url, inline_images FROM articles WHERE id = $1 AND tenant_id = $2').get(req.params.id, req.tenantId);
  if (!existing) return res.status(404).json({ error: 'Article not found' });

  // Clean up stored media files
  await deleteAudio(existing.audio_url, req.tenantId);
  await deleteImage(existing.image_url, req.tenantId);
  const inlines = typeof existing.inline_images === 'string'
    ? JSON.parse(existing.inline_images) : (existing.inline_images || []);
  for (const img of inlines) {
    if (img.url) await deleteImage(img.url, req.tenantId);
  }

  await db.prepare('DELETE FROM articles WHERE id = $1 AND tenant_id = $2').run(req.params.id, req.tenantId);

  // Clean up analytics events for this article (preserve ai_usage for credit history)
  if (existing.title) {
    const { toSlug } = require('../lib/utils');
    const slug = toSlug(existing.title);
    if (slug) {
      await db.prepare('DELETE FROM analytics_events WHERE tenant_id = $1 AND article_slug = $2').run(req.tenantId, slug);
    }
  }

  logAudit(req, 'article.purge', 'article', parseInt(req.params.id));
  res.json({ message: 'Article permanently deleted' });
}));

// PUT /api/articles/:id/restore
router.put('/:id/restore', auth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const existing = await db.prepare('SELECT id FROM articles WHERE id = $1 AND tenant_id = $2').get(req.params.id, req.tenantId);
  if (!existing) return res.status(404).json({ error: 'Article not found' });
  const updated = await db.prepare(`
    UPDATE articles
    SET is_archived = 0, archived_at = NULL, status = 'draft', updated_at = NOW()
    WHERE id = $1 AND tenant_id = $2
    RETURNING *
  `).get(req.params.id, req.tenantId);
  res.json(updated);
}));

// PUT /api/articles/:id/feature
// Body: { priority: 1|2|3 } to feature at a slot, or omit/null to unfeature
router.put('/:id/feature', auth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const article = await db.prepare('SELECT * FROM articles WHERE id = $1 AND tenant_id = $2').get(req.params.id, req.tenantId);
  if (!article) return res.status(404).json({ error: 'Article not found' });

  const MAX_FEATURED = 5;
  const { priority } = req.body || {};

  const { featured_until } = req.body || {};

  // Unfeature: no priority supplied, or priority === 0/null
  if (!priority) {
    await db.prepare(
      'UPDATE articles SET is_featured = 0, featured_priority = NULL, is_pinned = 0, featured_source = NULL, featured_until = NULL, updated_at = NOW() WHERE id = $1 AND tenant_id = $2'
    ).run(req.params.id, req.tenantId);
    return res.json({ id: article.id, is_featured: 0, featured_priority: null });
  }

  const slot = parseInt(priority);
  if (slot < 1 || slot > MAX_FEATURED) {
    return res.status(400).json({ error: `priority must be between 1 and ${MAX_FEATURED}` });
  }

  // Count currently featured (excluding this article)
  const { count } = await db.prepare(
    'SELECT COUNT(*) AS count FROM articles WHERE is_featured = 1 AND id != $1 AND tenant_id = $2'
  ).get(req.params.id, req.tenantId);

  if (count >= MAX_FEATURED) {
    // Bump the article currently holding this slot (if any) to unfeature
    await db.prepare(
      'UPDATE articles SET is_featured = 0, featured_priority = NULL, updated_at = NOW() WHERE featured_priority = $1 AND id != $2 AND tenant_id = $3'
    ).run(slot, req.params.id, req.tenantId);
  }

  await db.prepare(
    'UPDATE articles SET is_featured = 1, featured_priority = $1, featured_source = $2, featured_until = $3, updated_at = NOW() WHERE id = $4 AND tenant_id = $5'
  ).run(slot, 'manual', featured_until || null, req.params.id, req.tenantId);

  res.json({ id: article.id, is_featured: 1, featured_priority: slot, featured_source: 'manual', featured_until: featured_until || null });
}));

// PUT /api/articles/:id/pin — toggle pin on a featured article
router.put('/:id/pin', auth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const article = await db.prepare('SELECT * FROM articles WHERE id = $1 AND tenant_id = $2').get(req.params.id, req.tenantId);
  if (!article) return res.status(404).json({ error: 'Article not found' });

  const { pinned } = req.body || {};
  const newPinned = pinned ? 1 : 0;

  if (newPinned && !article.is_featured) {
    // Auto-feature when pinning an unfeatured article — assign next open slot
    const { count } = await db.prepare(
      'SELECT COUNT(*) AS count FROM articles WHERE is_featured = 1 AND tenant_id = $1'
    ).get(req.tenantId);
    if (count >= 5) return res.status(400).json({ error: 'All 5 featured slots are full — unfeature one first' });

    const used = await db.prepare(
      'SELECT featured_priority FROM articles WHERE is_featured = 1 AND tenant_id = $1'
    ).all(req.tenantId);
    const usedSlots = new Set(used.map(r => r.featured_priority));
    let slot = 1;
    while (usedSlots.has(slot) && slot <= 5) slot++;

    await db.prepare(`
      UPDATE articles
      SET is_featured = 1, featured_priority = $1, is_pinned = 1,
          featured_source = 'manual', updated_at = NOW()
      WHERE id = $2 AND tenant_id = $3
    `).run(slot, req.params.id, req.tenantId);
    logAudit(req, 'article.pin', 'article', parseInt(req.params.id));
    return res.json({ id: article.id, is_featured: 1, featured_priority: slot, is_pinned: 1 });
  }

  await db.prepare(
    'UPDATE articles SET is_pinned = $1, featured_source = $2, updated_at = NOW() WHERE id = $3 AND tenant_id = $4'
  ).run(newPinned, newPinned ? 'manual' : article.featured_source, req.params.id, req.tenantId);

  logAudit(req, newPinned ? 'article.pin' : 'article.unpin', 'article', parseInt(req.params.id));
  res.json({ id: article.id, is_pinned: newPinned });
}));

// Status ↔ legacy field sync helper
function syncStatusFields(status) {
  switch (status) {
    case 'published': return { is_published: 1, is_archived: 0 };
    case 'archived':  return { is_published: 0, is_archived: 1 };
    default:          return { is_published: 0, is_archived: 0 }; // draft, review
  }
}

// PUT /api/articles/:id/publish (toggle — kept for backwards compat)
router.put('/:id/publish', auth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const article = await db.prepare('SELECT * FROM articles WHERE id = $1 AND tenant_id = $2').get(req.params.id, req.tenantId);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  const newVal = article.is_published ? 0 : 1;
  const newStatus = newVal ? 'published' : 'draft';
  const sync = syncStatusFields(newStatus);
  await db.prepare(
    'UPDATE articles SET is_published = $1, is_archived = $2, status = $3, updated_at = NOW() WHERE id = $4 AND tenant_id = $5'
  ).run(sync.is_published, sync.is_archived, newStatus, req.params.id, req.tenantId);
  if (newVal === 1) onArticlePublished(article.id, req.tenantId).catch(() => {});
  logAudit(req, newVal ? 'article.publish' : 'article.unpublish', 'article', parseInt(req.params.id));
  res.json({ id: article.id, is_published: newVal, status: newStatus });
}));

// PUT /api/articles/:id/submit-review
router.put('/:id/submit-review', auth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const article = await db.prepare('SELECT * FROM articles WHERE id = $1 AND tenant_id = $2').get(req.params.id, req.tenantId);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  if (article.status !== 'draft') return res.status(400).json({ error: 'Only draft articles can be submitted for review' });
  const updated = await db.prepare(`
    UPDATE articles SET status = 'review', submitted_for_review_at = NOW(), updated_at = NOW()
    WHERE id = $1 AND tenant_id = $2 RETURNING *
  `).get(req.params.id, req.tenantId);
  logAudit(req, 'article.submit_review', 'article', parseInt(req.params.id), { title: article.title });
  res.json(updated);
}));

// PUT /api/articles/:id/approve
router.put('/:id/approve', auth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const article = await db.prepare('SELECT * FROM articles WHERE id = $1 AND tenant_id = $2').get(req.params.id, req.tenantId);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  if (article.status !== 'review') return res.status(400).json({ error: 'Only articles in review can be approved' });
  const updated = await db.prepare(`
    UPDATE articles SET status = 'published', is_published = 1, is_archived = 0,
      reviewed_by = $1, reviewed_at = NOW(), published_at = NOW(), updated_at = NOW()
    WHERE id = $2 AND tenant_id = $3 RETURNING *
  `).get(req.user?.sub || null, req.params.id, req.tenantId);
  onArticlePublished(article.id, req.tenantId).catch(() => {});
  logAudit(req, 'article.approve', 'article', parseInt(req.params.id), { title: article.title });
  res.json(updated);
}));

// PUT /api/articles/:id/reject
router.put('/:id/reject', auth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const article = await db.prepare('SELECT * FROM articles WHERE id = $1 AND tenant_id = $2').get(req.params.id, req.tenantId);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  if (article.status !== 'review') return res.status(400).json({ error: 'Only articles in review can be rejected' });
  const updated = await db.prepare(`
    UPDATE articles SET status = 'draft', is_published = 0, is_archived = 0,
      submitted_for_review_at = NULL, reviewed_by = NULL, reviewed_at = NULL, updated_at = NOW()
    WHERE id = $1 AND tenant_id = $2 RETURNING *
  `).get(req.params.id, req.tenantId);
  logAudit(req, 'article.reject', 'article', parseInt(req.params.id), { title: article.title });
  res.json(updated);
}));

// POST /api/articles/purge-old — archive articles older than N days
router.post('/purge-old', auth, requirePermission('articles.delete'), asyncHandler(async (req, res) => {
  const {
    days           = 30,
    dryRun         = true,
    protectFeatured = true,
    protectAudio    = false,
  } = req.body;

  const minDays = 7;
  const safeDays = Math.max(parseInt(days) || 30, minDays);
  const cutoff = new Date(Date.now() - safeDays * 86400000).toISOString();

  // Build query for eligible articles
  let query = `
    SELECT id, title, category, is_featured, audio_status, audio_url, created_at
    FROM articles
    WHERE tenant_id = $1
      AND is_archived = 0
      AND (created_at < $2 OR (published_at IS NOT NULL AND published_at < $2))
  `;
  const rows = await db.prepare(query).all(req.tenantId, cutoff);

  const eligible  = [];
  const protected_ = [];

  for (const row of rows) {
    let reason = null;
    if (protectFeatured && row.is_featured) reason = 'featured';
    else if (protectAudio && row.audio_status === 'ready' && row.audio_url) reason = 'has audio';

    if (reason) protected_.push({ id: row.id, title: row.title, reason });
    else eligible.push(row);
  }

  if (dryRun) {
    return res.json({
      dryRun: true,
      days: safeDays,
      eligible: eligible.map(r => ({ id: r.id, title: r.title, category: r.category, created_at: r.created_at })),
      eligibleCount: eligible.length,
      protectedCount: protected_.length,
      protected: protected_,
    });
  }

  // Execute: soft-archive all eligible
  let purgedCount = 0;
  for (const row of eligible) {
    await db.prepare(`
      UPDATE articles
      SET is_archived = 1, is_published = 0, is_featured = 0, featured_priority = NULL,
          is_pinned = 0, featured_source = NULL, featured_until = NULL,
          status = 'archived', archived_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND tenant_id = $2
    `).run(row.id, req.tenantId);
    purgedCount++;
  }

  res.json({
    dryRun: false,
    days: safeDays,
    purgedCount,
    protectedCount: protected_.length,
    message: `${purgedCount} article(s) archived. ${protected_.length} protected.`,
  });
}));



// PUT /api/articles/:id/assign-writer
router.put('/:id/assign-writer', auth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const article = await db.prepare('SELECT id FROM articles WHERE id = $1 AND tenant_id = $2').get(req.params.id, req.tenantId);
  if (!article) return res.status(404).json({ error: 'Article not found' });

  const { writerId } = req.body;
  if (writerId !== null && writerId !== undefined) {
    const writer = await db.prepare('SELECT id FROM writers WHERE id = $1 AND tenant_id = $2').get(writerId, req.tenantId);
    if (!writer) return res.status(400).json({ error: 'Writer not found' });
  }

  const updated = await db.prepare(
    'UPDATE articles SET writer_id = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3 RETURNING *'
  ).get(writerId ?? null, req.params.id, req.tenantId);
  res.json(updated);
}));

module.exports = router;
