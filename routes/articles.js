const express                        = require('express');
const router                         = express.Router();
const rateLimit                      = require('express-rate-limit');
const db                             = require('../db');
const publication = require('../lib/publication');
const { getPool }                    = require('../db');
const { auth }                       = require('../middleware/auth');
const { requirePermission }          = require('../middleware/permissions');
const { serializeRow, asyncHandler, cleanInlineMarkdownText } = require('../lib/utils');
const { articleCreate, articleUpdate, validate } = require('../lib/schemas');
const { onArticlePublished } = require('../lib/post-publish');
const { findBestWriter } = require('../lib/writer-assign');
const { getAppConfig } = require('../lib/app-config');
const { nextDropWindow } = require('../lib/news-budget');
// Plan limit for articles removed — credits are the natural throttle
const { logAudit, logAuditWithDiff } = require('../middleware/audit');
const { learnFromCorrection } = require('../lib/categorize');
const { deleteImage, deleteAudio } = require('../lib/media-helpers');
const { validateBlocks, blocksToMarkdown } = require('../lib/blocks');

// Rate limiters for public user AI regen endpoints — applied after JWT so keyed by user ID
const { rateLimitHandler } = require('../middleware/rate-limit-log');
const userRegenLimiter = rateLimit({
  windowMs:        60 * 60 * 1000, // 1 hour
  max:             20,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator:    (req) => req.user?.sub ? `regen:${req.user.sub}` : `regen-ip:${req.ip}`,
  message:         { error: 'Too many regeneration requests — limit is 20 per hour.' },
  validate:        false,
  skip:            (req) => req.method === 'OPTIONS',
  handler:         rateLimitHandler('user.regen'),
});

// Image regen is expensive — tighter limit: 5 calls/hour per user
const userImageRegenLimiter = rateLimit({
  windowMs:        60 * 60 * 1000,
  max:             5,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator:    (req) => req.user?.sub ? `img-regen:${req.user.sub}` : `img-regen-ip:${req.ip}`,
  message:         { error: 'Too many image regeneration requests — limit is 5 per hour.' },
  validate:        false,
  skip:            (req) => req.method === 'OPTIONS',
  handler:         rateLimitHandler('user.img-regen'),
});


router.get('/:id/history',auth,requirePermission('articles.read'),asyncHandler(async(req,res)=>{
 const rows=await db.prepare('SELECT revision,action,actor_id,before_state,after_state,created_at FROM article_publication_history WHERE article_id=$1 AND tenant_id=$2 ORDER BY id DESC LIMIT 50').all(req.params.id,req.tenantId);res.json({history:rows});
}));

// GET /api/articles
router.get('/', auth, requirePermission('articles.read'), asyncHandler(async (req, res) => {
  const isCurated = req.query.type === 'curated';
  // For curated view, join groups and compute pitch_status in SQL
  let query = isCurated
    ? `SELECT articles.*,
              fg.name  AS group_name,
              fg.color AS group_color,
              CASE
                WHEN EXISTS (
                  SELECT 1 FROM story_pitches sp
                  WHERE sp.tenant_id = articles.tenant_id
                    AND sp.source_article_ids @> to_jsonb(articles.id)
                    AND sp.status IN ('approved','synthesized')
                ) THEN 'used'
                WHEN EXISTS (
                  SELECT 1 FROM article_pitches ap
                  WHERE ap.tenant_id = articles.tenant_id
                    AND (ap.source_article_id = articles.id OR ap.attached_article_ids @> to_jsonb(articles.id))
                    AND ap.status NOT IN ('dismissed','killed','rejected')
                    AND ap.spawned_article_id IS NOT NULL
                ) THEN 'used'
                WHEN EXISTS (
                  SELECT 1 FROM story_pitches sp
                  WHERE sp.tenant_id = articles.tenant_id
                    AND sp.source_article_ids @> to_jsonb(articles.id)
                    AND sp.status = 'pending'
                ) THEN 'in_pitch'
                WHEN EXISTS (
                  SELECT 1 FROM article_pitches ap
                  WHERE ap.tenant_id = articles.tenant_id
                    AND (ap.source_article_id = articles.id OR ap.attached_article_ids @> to_jsonb(articles.id))
                    AND ap.status NOT IN ('dismissed','killed','rejected')
                    AND ap.spawned_article_id IS NULL
                ) THEN 'in_pitch'
                ELSE 'unused'
              END AS pitch_status
       FROM articles
       LEFT JOIN feed_groups fg ON fg.id = articles.group_id AND fg.tenant_id = articles.tenant_id
       WHERE articles.tenant_id = $1`
    : 'SELECT * FROM articles WHERE tenant_id = $1';
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
  if (req.query.type === 'editorial') {
    query += ` AND content_type IN ('original', 'deep-dive')`;
    countQuery += ` AND content_type IN ('original', 'deep-dive')`;
  } else if (req.query.type === 'video') {
    query += ` AND content_type = 'video'`;
    countQuery += ` AND content_type = 'video'`;
  } else if (req.query.type === 'curated') {
    query += ` AND (content_type IS NULL OR content_type = 'curated') AND (is_archived IS NULL OR is_archived = 0)`;
    countQuery += ` AND (content_type IS NULL OR content_type = 'curated') AND (is_archived IS NULL OR is_archived = 0)`;
    // Group filter: ?group_id=<n> or ?group_id=none
    if (req.query.group_id === 'none') {
      query += ` AND articles.group_id IS NULL`;
      countQuery += ` AND articles.group_id IS NULL`;
    } else if (req.query.group_id) {
      params.push(parseInt(req.query.group_id));
      countParams.push(parseInt(req.query.group_id));
      query += ` AND articles.group_id = $${params.length}`;
      countQuery += ` AND articles.group_id = $${countParams.length}`;
    }
    // Pitch status filter: ?pitch_status=unused|in_pitch|used
    if (req.query.pitch_status === 'unused') {
      query += ` AND NOT EXISTS (
        SELECT 1 FROM story_pitches sp WHERE sp.tenant_id = articles.tenant_id AND sp.source_article_ids @> to_jsonb(articles.id)
      ) AND NOT EXISTS (
        SELECT 1 FROM article_pitches ap WHERE ap.tenant_id = articles.tenant_id AND (ap.source_article_id = articles.id OR ap.attached_article_ids @> to_jsonb(articles.id))
      )`;
      countQuery += ` AND NOT EXISTS (
        SELECT 1 FROM story_pitches sp WHERE sp.tenant_id = articles.tenant_id AND sp.source_article_ids @> to_jsonb(articles.id)
      ) AND NOT EXISTS (
        SELECT 1 FROM article_pitches ap WHERE ap.tenant_id = articles.tenant_id AND (ap.source_article_id = articles.id OR ap.attached_article_ids @> to_jsonb(articles.id))
      )`;
    }
  }
  query += ' ORDER BY articles.created_at DESC';

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

  const { computeEffectiveImportance } = require('../lib/story-levels');
  const articles = result.rows.map(row => {
    const s = serializeRow(row);
    s.effective_importance = computeEffectiveImportance(s);
    return s;
  });

  res.json({
    articles,
    count: articles.length,
    totalCount,
    hasMore: offset + articles.length < totalCount,
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
    selectSql = `SELECT id, image_url, audio_url, inline_images FROM articles WHERE tenant_id = $1 AND (content_type IS NULL OR content_type = 'curated')`;
  } else if (type === 'original') {
    selectSql = `SELECT id, image_url, audio_url, inline_images FROM articles WHERE tenant_id = $1 AND content_type IN ('original', 'deep-dive')`;
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
    deleteSql = `DELETE FROM articles WHERE tenant_id = $1 AND (content_type IS NULL OR content_type = 'curated') RETURNING id`;
  } else if (type === 'original') {
    deleteSql = `DELETE FROM articles WHERE tenant_id = $1 AND content_type IN ('original', 'deep-dive') RETURNING id`;
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

// GET /api/articles/scheduled — articles in status='scheduled' (drop queue)
router.get('/scheduled', auth, requirePermission('articles.read'), asyncHandler(async (req, res) => {
  const { rows } = await getPool().query(`
    SELECT a.id, a.title, a.generated_title, a.publish_at, a.editorial_score,
           a.category, a.writer_id, w.name AS writer_name, w.avatar_url AS writer_avatar_url
    FROM articles a
    LEFT JOIN writers w ON w.id = a.writer_id AND w.tenant_id = a.tenant_id
    WHERE a.tenant_id = $1 AND a.status = 'scheduled'
    ORDER BY a.publish_at ASC NULLS LAST
  `, [req.tenantId]);
  res.json({ articles: rows.map(serializeRow), count: rows.length });
}));

// PUT /api/articles/:id/reschedule — change drop time or publish immediately
// Body: { action: 'now' }  OR  { action: 'window', publish_at: ISO_string }
router.put('/:id/reschedule', auth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const article = await db.prepare(
    'SELECT id, title, status FROM articles WHERE id = $1 AND tenant_id = $2'
  ).get(req.params.id, req.tenantId);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  if (article.status !== 'scheduled') return res.status(400).json({ error: 'Only scheduled articles can be rescheduled' });

  const { action, publish_at } = req.body || {};
  if (!action) return res.status(400).json({ error: 'action required: "now" or "window"' });

  if (action === 'now') {
    const updated = await publication.change(Number(req.params.id),req.tenantId,{published:true,force:req.body?.force_publish===true,expectedRevision:req.body?.expected_revision,userId:req.user?.sub});
    return res.json(updated);
  }

  if (action === 'window') {
    if (!publish_at) return res.status(400).json({ error: 'publish_at required for action "window"' });
    const newTime = new Date(publish_at);
    if (isNaN(newTime.getTime())) return res.status(400).json({ error: 'Invalid publish_at timestamp' });
    if (newTime <= new Date()) return res.status(400).json({ error: 'publish_at must be in the future' });
    const updated = await db.prepare(
      'UPDATE articles SET publish_at = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3 RETURNING *'
    ).get(newTime.toISOString(), req.params.id, req.tenantId);
    logAudit(req, 'article.reschedule', 'article', parseInt(req.params.id), { title: article.title, publish_at: newTime.toISOString() });
    return res.json(updated);
  }

  res.status(400).json({ error: 'action must be "now" or "window"' });
}));

// PUT /api/articles/bulk-action — approve / reject-draft / discard multiple articles at once
// Must be declared before /:id routes so 'bulk-action' isn't matched as a numeric id.
router.put('/bulk-action', auth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const { ids, action } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids array required' });
  if (!['approve', 'reject-draft', 'discard'].includes(action)) {
    return res.status(400).json({ error: 'action must be: approve, reject-draft, or discard' });
  }

  const safeIds = [...new Set(ids.map(id => parseInt(id, 10)).filter(id => Number.isFinite(id) && id > 0))];
  if (!safeIds.length) return res.status(400).json({ error: 'no valid ids provided' });

  // Verify articles belong to this tenant and are in review status
  const ph = safeIds.map((_, i) => `$${i + 2}`).join(', ');
  const { rows: candidates } = await getPool().query(
    `SELECT id, title FROM articles WHERE tenant_id = $1 AND id IN (${ph}) AND status = 'review'`,
    [req.tenantId, ...safeIds]
  );
  if (!candidates.length) return res.json({ processed: 0, skipped: safeIds.length });

  const validIds  = candidates.map(a => a.id);
  const vph       = validIds.map((_, i) => `$${i + 3}`).join(', ');
  const reviewer  = req.user?.sub || null;

  if (action === 'approve') {
    const results=[];
    for(const id of safeIds){
      try{const article=await publication.change(id,req.tenantId,{published:true,approve:true,userId:reviewer});results.push({id,status:article.status,ok:true});}
      catch(e){results.push({id,ok:false,error:e.status?e.message:'Publication failed; reload the article before retrying.'});}
    }
    return res.json({processed:results.filter(r=>r.ok).length,skipped:results.filter(r=>!r.ok).length,results});

  } else if (action === 'reject-draft') {
    const vph2 = validIds.map((_, i) => `$${i + 2}`).join(', ');
    await getPool().query(
      `UPDATE articles
       SET status = 'draft', is_published = 0, is_archived = 0,
           submitted_for_review_at = NULL, reviewed_by = NULL, reviewed_at = NULL, updated_at = NOW()
       WHERE tenant_id = $1 AND id IN (${vph2})`,
      [req.tenantId, ...validIds]
    );

  } else { // discard — hard reject, archive without returning to draft
    await getPool().query(
      `UPDATE articles
       SET status = 'rejected', is_published = 0, is_archived = 1,
           reviewed_by = $1, reviewed_at = NOW(), updated_at = NOW()
       WHERE tenant_id = $2 AND id IN (${vph})`,
      [reviewer, req.tenantId, ...validIds]
    );
  }

  logAudit(req, `article.bulk-${action}`, 'articles', null, { count: validIds.length, ids: validIds });
  res.json({ processed: validIds.length, skipped: safeIds.length - validIds.length });
}));

// POST /api/articles/:id/editorial-review — trigger AI editorial review on demand
router.post('/:id/editorial-review', auth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const article = await db.prepare(
    'SELECT * FROM articles WHERE id = $1 AND tenant_id = $2'
  ).get(req.params.id, req.tenantId);
  if (!article) return res.status(404).json({ error: 'Article not found' });

  const { editorialReview } = require('../lib/editorial');
  const verdict = await editorialReview(article, req.tenantId, { force: true });
  res.json({ success: true, verdict });
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

// PATCH /api/articles/:id/importance — manual story-level override
// Body: { importance: 'standard'|'trending'|'major'|'breaking', unlock?: boolean }
router.patch('/:id/importance', auth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const { importance, unlock } = req.body || {};
  const { setImportanceManual, unlockImportance, LEVELS } = require('../lib/story-levels');
  if (unlock) {
    await unlockImportance(req.params.id, req.tenantId);
    logAudit(req, 'article.importance.unlocked', 'articles', req.params.id, {});
    return res.json({ ok: true, unlocked: true });
  }
  if (!LEVELS.includes(importance)) {
    return res.status(400).json({ error: `importance must be one of: ${LEVELS.join(', ')}` });
  }
  await setImportanceManual(req.params.id, req.tenantId, importance);
  logAudit(req, 'article.importance.set', 'articles', req.params.id, { importance });
  res.json({ ok: true, importance, locked: true });
}));

// GET /api/articles/youtube-search?q= — proxy YouTube Data API search (user JWT)
// NOTE: must be registered before GET /:id so Express doesn't consume this path as an id param.
router.get('/youtube-search', require('../middleware/user-jwt'), asyncHandler(async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'q param required' });

  const config = await getAppConfig(req.tenantId);
  const apiKey = config.youtube_api_key;
  if (!apiKey) return res.status(503).json({ error: 'YouTube API key not configured in tenant settings' });

  const url = 'https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=5'
    + '&q=' + encodeURIComponent(q) + '&key=' + apiKey;

  const ytRes = await fetch(url);
  const data  = await ytRes.json();

  if (!ytRes.ok) return res.status(502).json({ error: data.error?.message || 'YouTube API error' });

  const results = (data.items || []).map(item => ({
    videoId:   item.id.videoId,
    title:     item.snippet.title,
    channel:   item.snippet.channelTitle,
    thumbnail: item.snippet.thumbnails.medium?.url || item.snippet.thumbnails.default?.url || '',
  }));

  res.json({ results });
}));

// GET /api/articles/quick-stories?slug= — list active/dormant stories for story picker (public user JWT)
// NOTE: must be registered before GET /:id so Express doesn't consume this path as an id param.
router.get('/quick-stories', require('../middleware/user-jwt'), asyncHandler(async (req, res) => {
  const slug = req.query.slug;
  if (!slug) return res.status(400).json({ error: 'slug required' });

  const article = await db.prepare(
    'SELECT id, tenant_id FROM articles WHERE slug = $1'
  ).get(slug);
  if (!article) return res.status(404).json({ error: 'Article not found' });

  const adminRow = await db.prepare(
    'SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND tenant_id = $2 AND is_active = 1'
  ).get(req.user.email, article.tenant_id);
  if (!adminRow) return res.status(403).json({ error: 'Admin access required' });

  const stories = await db.prepare(`
    SELECT st.id, st.name,
      CASE WHEN sta.story_id IS NOT NULL THEN 1 ELSE 0 END AS already_added
    FROM story_timelines st
    LEFT JOIN story_timeline_articles sta
      ON sta.story_id = st.id AND sta.article_id = $2
    WHERE st.tenant_id = $1 AND st.status IN ('active','dormant')
    ORDER BY st.name ASC
    LIMIT 100
  `).all(article.tenant_id, article.id);

  res.json({ stories: stories || [] });
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

  if(body.writer_id&&!await db.prepare("SELECT id FROM writers WHERE id=$1 AND tenant_id=$2 AND role='writer'").get(body.writer_id,req.tenantId))return res.status(400).json({error:'Select a writer from this workspace'});
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
  const pubVal = 0; // New articles are saved as drafts; publication is a separate action.
  const initStatus = pubVal ? 'published' : 'draft';
  const article = await db.prepare(`
    INSERT INTO articles
      (title, slug, summary, content, content_blocks, full_content, category, source, source_url, image_url, author,
       is_featured, featured_priority, is_published, published_at, status, tenant_id,writer_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,$18)
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
    req.tenantId,body.writer_id||null
  );
  // Auto-assign best writer if none set
  if (!article.writer_id && process.env.AUTOMATION_ENABLED!=='false' && !Object.hasOwn(body,'writer_id')) {
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

  const validated = validate(articleUpdate, req.body, res);
  if (!validated) return;
  // Create defaults must not overwrite omitted fields during a partial correction.
  const body = Object.fromEntries(Object.entries(validated).filter(([key]) => Object.hasOwn(req.body, key)));

  const { title, summary, content, content_blocks, category, source, source_url,
          image_url, author, is_featured, featured_priority, is_published, published_at, disable_summary } = body;

  if(body.writer_id&&!await db.prepare("SELECT id FROM writers WHERE id=$1 AND tenant_id=$2 AND role='writer'").get(body.writer_id,req.tenantId))return res.status(400).json({error:'Select a writer from this workspace'});
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

  // Check raw body — Zod .default() fills is_published even when not sent
  const pubExplicit = req.body.is_published !== undefined;
  const newIsPublished = pubExplicit ? (is_published ? 1 : 0) : existing.is_published;
  // Only change status if is_published was explicitly sent AND actually changed
  const pubChanged = pubExplicit && newIsPublished !== existing.is_published;
  if(pubChanged) return res.status(400).json({error:'Save edits first, then use the explicit Publish or Unpublish action.'});
  const expectedRevision=req.body.expected_revision ?? existing.publication_revision;
  if(!Number.isSafeInteger(expectedRevision)||expectedRevision!==existing.publication_revision)return res.status(409).json({error:'This article changed since it was opened. Reload before saving; your edits have not been applied.'});
  const newStatus = pubChanged ? (newIsPublished ? 'published' : 'draft') : (existing.status || 'draft');

  // Recompute slug when title changes
  const { toSlug } = require('../lib/utils');
  const newTitle = title !== undefined ? title : existing.title;
  const newSlug = existing.slug || toSlug(newTitle); // Corrections preserve reader URLs.

  const client=await getPool().connect();let updated;
  try{
   await client.query('BEGIN');
   await client.query('SELECT pg_advisory_xact_lock(78241,$1)',[req.tenantId]);
   const result = await client.query(`
    UPDATE articles SET
      generated_title=CASE WHEN title IS DISTINCT FROM $1 THEN NULL ELSE generated_title END,
      title = $1, slug = $2, summary = $3, content = $4, category = $5, source = $6,
      source_url = $7, image_url = $8, author = $9, is_featured = $10,
      featured_priority = $11, is_published = $12, published_at = $13, status = $14,
      content_blocks = $15, full_content = $16, disable_summary = $17, writer_id=$21, publication_revision=publication_revision+1, updated_at = NOW()
    WHERE id = $18 AND tenant_id = $19 AND publication_revision=$20
    RETURNING *
  `, [
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
    derivedFullContent !== undefined ? derivedFullContent : (content !== undefined ? content : (existing.full_content || null)),
    disable_summary !== undefined ? (disable_summary ? 1 : 0) : (existing.disable_summary || 0),
    req.params.id,
    req.tenantId, expectedRevision,body.writer_id!==undefined?body.writer_id:existing.writer_id
  ]);
  updated=result.rows[0];
  if(!updated)throw Object.assign(new Error('Article changed while saving. Reload and review your edits.'),{status:409});
  if(updated.is_published)await publication.validate(client,updated,req.tenantId);
  if(newFeatured&&newPriority)await client.query('UPDATE articles SET is_featured=0,featured_priority=NULL,updated_at=NOW() WHERE featured_priority=$1 AND id!=$2 AND tenant_id=$3',[newPriority,updated.id,req.tenantId]);
  await publication.history(client,req.tenantId,updated.id,'correction',req.user?.sub,existing,updated);
  await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}

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

// Explicit desired state makes repeated requests safe.
router.put('/:id/publish',auth,requirePermission('articles.update'),asyncHandler(async(req,res)=>{
 const article=await publication.change(Number(req.params.id),req.tenantId,{published:req.body?.published,expectedRevision:req.body?.expected_revision,force:req.body?.force_publish===true,userId:req.user?.sub});
 res.json(article);
}));

// PUT /api/articles/:id/submit-review
router.put('/:id/submit-review', auth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const updated = await publication.submitReview(Number(req.params.id), req.tenantId, {expectedRevision:req.body?.expected_revision,userId:req.user?.sub});
  logAudit(req, 'article.submit_review', 'article', parseInt(req.params.id), { title: updated.title });
  res.json(updated);
}));

// Approval remains an explicit editorial action; scheduling is reflected in the result.
router.put('/:id/approve',auth,requirePermission('articles.update'),asyncHandler(async(req,res)=>{
 const article=await publication.change(Number(req.params.id),req.tenantId,{published:true,approve:true,expectedRevision:req.body?.expected_revision,force:req.body?.force_publish===true,userId:req.user?.sub});
 res.json(article);
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

  // Fire-and-forget: article_revision_requested notification.
  // Writers are AI agents (not users), so we fan out to editors; the writer
  // agent picks up revision work via the newsroom-events / review queue.
  setImmediate(() => {
    (async () => {
      try {
        const { notify } = require('../lib/notifications');
        const editors = await db.prepare(`
          SELECT id FROM users
          WHERE tenant_id = $1
            AND is_active = 1
            AND role IN ('owner', 'admin', 'editor', 'superadmin')
        `).all(req.tenantId);
        const feedback = article.review_notes || req.body?.feedback || '';
        const body = feedback
          ? `"${article.title}" sent back for revision: ${feedback}`
          : `"${article.title}" sent back for revision.`;
        for (const ed of editors) {
          notify({
            tenantId: req.tenantId,
            userId:   ed.id,
            kind:     'article_revision_requested',
            title:    'Revision requested',
            body,
            payload:  {
              article_id: article.id,
              title:      article.title,
              feedback:   feedback || null,
            },
            actionable: [
              { label: 'Open article', actionKind: 'article.open', targetId: article.id, targetType: 'article' },
            ],
          }).catch(err => console.error('[articles.reject] notify failed:', err.message));
        }
      } catch (err) {
        console.error('[articles.reject] notify fanout failed:', err.message);
      }
    })();
  });

  res.json(updated);
}));

// PUT /api/articles/:id/discard — hard reject: archive the article without returning it to draft
router.put('/:id/discard', auth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const article = await db.prepare('SELECT * FROM articles WHERE id = $1 AND tenant_id = $2').get(req.params.id, req.tenantId);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  if (article.status !== 'review') return res.status(400).json({ error: 'Only articles in review can be discarded' });
  const updated = await db.prepare(`
    UPDATE articles SET status = 'rejected', is_published = 0, is_archived = 1,
      reviewed_by = $1, reviewed_at = NOW(), updated_at = NOW()
    WHERE id = $2 AND tenant_id = $3 RETURNING *
  `).get(req.user?.sub || null, req.params.id, req.tenantId);
  logAudit(req, 'article.discard', 'article', parseInt(req.params.id), { title: article.title });
  res.json(updated);
}));

// POST /api/articles/:id/request-revision
// Sets status → revision_requested, sends editorial feedback to writer's channel,
// then fires a rewrite immediately (fire-and-forget).
router.post('/:id/request-revision', auth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const article = await db.prepare('SELECT * FROM articles WHERE id = $1 AND tenant_id = $2').get(req.params.id, req.tenantId);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  if (article.status !== 'review') return res.status(400).json({ error: 'Only articles in review can be sent for revision' });

  // Build feedback from editor_verdict + optional editor note
  let verdict = article.editor_verdict;
  if (typeof verdict === 'string') try { verdict = JSON.parse(verdict); } catch { verdict = null; }
  const score      = verdict?.score ?? null;
  const issues     = verdict?.issues || [];
  const suggestion = verdict?.suggestion || '';
  const editorNote = (req.body?.note || '').trim();

  const feedbackParts = [];
  if (score !== null) feedbackParts.push(`Score: ${score}/10`);
  if (issues.length)  feedbackParts.push(`Issues:\n${issues.map(i => '- ' + i).join('\n')}`);
  if (suggestion)     feedbackParts.push(`Suggestion: ${suggestion}`);
  if (editorNote)     feedbackParts.push(`Editor note: ${editorNote}`);
  const feedback = feedbackParts.join('\n\n');

  await db.prepare(`
    UPDATE articles SET
      status = 'revision_requested',
      is_published = 0,
      review_notes = $1,
      editor_verdict = NULL,
      last_reviewed_at = NULL,
      submitted_for_review_at = NULL,
      reviewed_by = NULL,
      reviewed_at = NULL,
      updated_at = NOW()
    WHERE id = $2 AND tenant_id = $3
  `).run(feedback || null, article.id, req.tenantId);

  logAudit(req, 'article.request-revision', 'article', parseInt(req.params.id), { title: article.title, score });

  // Notify writer's channel + trigger rewrite (fire-and-forget)
  setImmediate(() => {
    (async () => {
      try {
        // 1. Send feedback message to writer's channel
        if (article.writer_id && feedback) {
          const { sendMessage } = require('../lib/messaging');
          const channelMsg = `Revision requested — "${article.title}"\n\n${feedback}\n\nRewriting now and will resubmit for review.`;
          await sendMessage(req.tenantId, article.writer_id, channelMsg).catch(() => {});
        }

        // 2. Rewrite the article using the feedback, then resubmit
        if (article.writer_id) {
          const { rewriteArticleWithFeedback } = require('../lib/synthesis');
          const writer = await db.prepare('SELECT * FROM writers WHERE id = $1 AND tenant_id = $2').get(article.writer_id, req.tenantId);
          if (writer) {
            const fresh = await db.prepare('SELECT * FROM articles WHERE id = $1 AND tenant_id = $2').get(article.id, req.tenantId);
            await rewriteArticleWithFeedback(fresh, writer, feedback, req.tenantId);
          }
        }

        // 3. Notify editors that rewrite has been triggered
        const { notify } = require('../lib/notifications');
        const editors = await db.prepare(
          "SELECT id FROM users WHERE tenant_id = $1 AND is_active = 1 AND role IN ('owner', 'admin', 'editor', 'superadmin')"
        ).all(req.tenantId);
        for (const ed of editors) {
          notify({
            tenantId: req.tenantId,
            userId:   ed.id,
            kind:     'article_revision_requested',
            title:    'Revision in progress',
            body:     `"${article.title}" sent for revision — rewriting now.`,
            payload:  { article_id: article.id, title: article.title, feedback: feedback || null },
            actionable: [
              { label: 'Open article', actionKind: 'article.open', targetId: article.id, targetType: 'article' },
            ],
          }).catch(() => {});
        }
      } catch (err) {
        console.error('[articles.request-revision] background task failed:', err.message);
      }
    })();
  });

  res.json({ ok: true, article_id: article.id, feedback });
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

// POST /api/articles/:id/generate-followups — generate follow-up Q&As without regenerating content
router.post('/:id/generate-followups', auth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const article = await db.prepare('SELECT * FROM articles WHERE id = $1 AND tenant_id = $2').get(req.params.id, req.tenantId);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  if (!article.full_content && !article.summary) {
    return res.status(400).json({ error: 'Article has no content to generate follow-ups from' });
  }

  const { complete: aiComplete } = require('../lib/ai-router');
  const { sanitizeForPrompt } = require('../lib/utils');

  // Build source refs context if available
  let sourceContext = '';
  try {
    const raw = typeof article.source_article_ids === 'string'
      ? JSON.parse(article.source_article_ids) : (article.source_article_ids || []);
    if (raw.length) {
      sourceContext = '\n\nSources referenced in the article:\n' + raw.map((r, i) => {
        const title = (typeof r === 'object' && r.title) ? r.title : 'Source ' + (i + 1);
        const source = (typeof r === 'object' && r.source) ? r.source : '';
        return `[${i + 1}] ${title}${source ? ' (' + source + ')' : ''}`;
      }).join('\n');
    }
  } catch {}

  const contentText = sanitizeForPrompt(article.full_content || article.summary || '', 3000);

  const { loadPrompt } = require('../lib/prompt-loader');
  const p = loadPrompt('followup-qa');
  const { messages, ...meta } = p.render({
    title: sanitizeForPrompt(article.title, 200),
    contentText,
    sourceContext,
  });

  const result = await aiComplete({
    ...meta, messages, tenantId: req.tenantId,
    trigger: 'manual',
  });

  if (!result?.text) return res.status(502).json({ error: 'AI returned no content' });

  const followups = [];
  const qMatches = [...result.text.matchAll(/Q(\d+):\s*(.+)\nA\1:\s*([\s\S]+?)(?=\nQ\d+:|$)/g)];
  for (const m of qMatches) {
    followups.push({ question: m[2].trim(), answer: m[3].trim() });
  }

  if (!followups.length) return res.status(502).json({ error: 'Could not parse follow-ups from AI response' });

  await db.prepare(
    'UPDATE articles SET followups = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3'
  ).run(JSON.stringify(followups), article.id, req.tenantId);

  logAudit(req, 'article.generate-followups', 'article', parseInt(req.params.id), { count: followups.length });
  res.json({ ok: true, followups });
}));

// POST /api/articles/:id/regenerate — re-synthesize from original sources
router.post('/:id/regenerate', auth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const article = await db.prepare('SELECT * FROM articles WHERE id = $1 AND tenant_id = $2').get(req.params.id, req.tenantId);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  if (article.content_type !== 'original' && article.content_type !== 'deep-dive') {
    return res.status(400).json({ error: 'Only original and deep-dive articles can be regenerated' });
  }

  // Parse source refs to get source article IDs
  let sourceIds;
  try {
    const raw = typeof article.source_article_ids === 'string'
      ? JSON.parse(article.source_article_ids)
      : (article.source_article_ids || []);
    sourceIds = raw.map(r => (typeof r === 'object' && r !== null) ? r.id : r).filter(Boolean);
  } catch { return res.status(400).json({ error: 'Cannot parse source_article_ids' }); }

  if (sourceIds.length < 2) {
    return res.status(400).json({ error: `Only ${sourceIds.length} source articles found (need 2+)` });
  }

  // Fetch source articles
  const placeholders = sourceIds.map((_, i) => `$${i + 1}`).join(', ');
  const sources = await getPool().query(
    `SELECT * FROM articles WHERE id IN (${placeholders}) AND tenant_id = $${sourceIds.length + 1}`,
    [...sourceIds, req.tenantId]
  );

  if (sources.rows.length < 2) {
    return res.status(400).json({ error: `Only ${sources.rows.length} source articles still exist (need 2+)` });
  }

  // Get the writer
  const writer = await db.prepare('SELECT * FROM writers WHERE id = $1 AND tenant_id = $2').get(article.writer_id, req.tenantId);
  if (!writer) return res.status(400).json({ error: 'Writer not found' });

  const { synthesizeCluster } = require('../lib/synthesis');

  // Re-synthesize — preserve article_subtype and parent link so followup articles
  // don't revert to standalone originals after regeneration.
  const cluster = {
    topic: article.category,
    articles: sources.rows,
    article_subtype: article.article_subtype || null,
    parent_article_id: article.parent_article_id || null,
  };
  const result = await synthesizeCluster(cluster, writer, req.tenantId);
  if (!result) return res.status(500).json({ error: 'Synthesis returned no result' });

  // Update the existing article row (preserve ID, slug, URL — no broken links).
  // Clear all stale AI-generated fields so post-publish hooks regenerate them for the new content.
  // topic_tag is cleared here so the COALESCE in onArticlePublished hook #1 replaces it with the
  // fresh tag from the new synthesis rather than keeping the old one.
  // pull_quote and article_subtype/parent_article_id are copied from the fresh synthesis result.
  await db.prepare(`
    UPDATE articles SET
      title = $1, summary = $2, full_content = $3,
      source_article_ids = $4, synthesis_meta = $5, followups = $6,
      editorial_score = $7, pull_quote = $8,
      article_subtype = $9, parent_article_id = $10,
      generated_title = NULL, tldr_overview = NULL, tldr_context = NULL,
      final_thoughts = NULL, topic_tag = NULL,
      updated_at = NOW()
    WHERE id = $11 AND tenant_id = $12
  `).run(
    result.title,
    result.summary,
    result.full_content,
    typeof result.source_article_ids === 'string' ? result.source_article_ids : JSON.stringify(result.source_article_ids),
    typeof result.synthesis_meta === 'string' ? result.synthesis_meta : JSON.stringify(result.synthesis_meta),
    result.followups ? (typeof result.followups === 'string' ? result.followups : JSON.stringify(result.followups)) : null,
    result.editorial_score || null,
    result.pull_quote || null,
    result.article_subtype || article.article_subtype || null,
    result.parent_article_id || article.parent_article_id || null,
    article.id,
    req.tenantId
  );

  // Delete the duplicate row that synthesizeCluster created
  if (result.id && result.id !== article.id) {
    await db.prepare('DELETE FROM articles WHERE id = $1 AND tenant_id = $2').run(result.id, req.tenantId);
  }

  // Re-run post-publish hooks for the original article so generated_title, final_thoughts,
  // topic_tag etc are refreshed for the new content (synthesis fired them for the temp row).
  if (article.is_published) {
    const { onArticlePublished } = require('../lib/post-publish');
    onArticlePublished(article.id, req.tenantId).catch(() => {});
  }

  logAudit(req, 'article.regenerate', 'article', parseInt(req.params.id), { title: result.title });
  res.json({ ok: true, title: result.title, summary: result.summary });
}));

// POST /api/articles/:id/generate-tldr — generate or regenerate tldr_overview (user JWT)
router.post('/:id/generate-tldr', require('../middleware/user-jwt'), asyncHandler(async (req, res) => {
  const article = await db.prepare('SELECT * FROM articles WHERE id = $1 AND tenant_id = $2').get(req.params.id, req.tenantId);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  if (!article.summary && !article.full_content) return res.status(400).json({ error: 'Article has no content to summarise' });

  const { generateWriterTldr } = require('../lib/writer-assign');
  const { aiComplete } = require('../lib/ai-router');
  const { canSpend } = require('../lib/budget');

  const budget = await canSpend('writer-tldr', req.tenantId);
  if (!budget.allowed) return res.status(429).json({ error: 'AI budget exhausted for TLDR generation' });

  let tldr = null;

  if (article.writer_id) {
    const writer = await db.prepare('SELECT * FROM writers WHERE id = $1 AND tenant_id = $2').get(article.writer_id, req.tenantId);
    if (writer) {
      const artObj = { id: article.id, title: article.title, summary: article.summary, category: article.category, source: article.source, slug: article.slug };
      tldr = await generateWriterTldr(artObj, writer, req.tenantId);
    }
  }

  // Fallback: neutral summarisation if no writer assigned or writer-voice generation failed
  if (!tldr) {
    const text = (article.summary || article.full_content || '').replace(/<[^>]+>/g, '').slice(0, 800);
    const result = await aiComplete({
      tier: 'fast',
      operation: 'writer-tldr',
      tenantId: req.tenantId,
      trigger: 'admin-action',
      articleSlug: article.slug,
      messages: [{
        role: 'user',
        content: `Write a 2-3 sentence AI summary of this article.\n\nTitle: ${article.title}\nSummary: ${text}\n\nAI Summary:`,
      }],
    });
    tldr = (result?.content || '').trim() || null;
  }

  if (!tldr) return res.status(500).json({ error: 'TLDR generation returned empty result' });

  await db.prepare('UPDATE articles SET tldr_overview = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3')
    .run(tldr, article.id, req.tenantId);
  logAudit(req, 'article.generate_tldr', 'article', parseInt(req.params.id), { title: article.title });

  res.json({ tldr_overview: tldr });
}));

// POST /api/articles/:id/final-thoughts — regenerate writer's final thoughts (admin JWT)
router.post('/:id/final-thoughts', auth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const { regenerateFinalThoughts } = require('../lib/final-thoughts');
  const text = await regenerateFinalThoughts(req.params.id, req.tenantId);
  logAudit(req, 'article.final_thoughts', 'article', parseInt(req.params.id), {});
  res.json({ ok: true, final_thoughts: text });
}));

// POST /api/articles/regen-final-thoughts?slug=<slug> — via public user JWT, slug-based
// Requires the caller's email to match an active admin user for the article's tenant.
router.post('/regen-final-thoughts', require('../middleware/user-jwt'), userRegenLimiter, asyncHandler(async (req, res) => {
  const slug = req.query.slug;
  if (!slug) return res.status(400).json({ error: 'slug required' });

  const article = await db.prepare('SELECT id, tenant_id FROM articles WHERE slug = $1').get(slug);
  if (!article) return res.status(404).json({ error: 'Article not found' });

  const adminRow = await db.prepare(
    'SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND tenant_id = $2 AND is_active = 1'
  ).get(req.user.email, article.tenant_id);
  if (!adminRow) return res.status(403).json({ error: 'Admin access required' });

  const { regenerateFinalThoughts } = require('../lib/final-thoughts');
  const text = await regenerateFinalThoughts(article.id, article.tenant_id);
  res.json({ ok: true, final_thoughts: text });
}));

// POST /api/articles/regen-hero-image?slug=<slug> — regenerate hero/thumbnail via public user JWT
router.post('/regen-hero-image', require('../middleware/user-jwt'), userImageRegenLimiter, asyncHandler(async (req, res) => {
  const slug = req.query.slug;
  if (!slug) return res.status(400).json({ error: 'slug required' });

  const article = await db.prepare('SELECT id, tenant_id, image_url, is_archived FROM articles WHERE slug = $1').get(slug);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  if (article.is_archived) return res.status(400).json({ error: 'Cannot regenerate image for archived article' });

  if (!await require('../lib/image-policy').canGenerateForUser(req.user.email,article.tenant_id)) return res.status(403).json({error:'Media creation permission required'});


  try {
    const imageUrl=await require('../lib/media-helpers').regenerateArticleImage(article.id,article.tenant_id);
    if(!imageUrl) throw new Error('No image generated');
    res.json({ok:true,image_url:imageUrl});
  } catch(e) {res.status(502).json(require('../lib/image-errors').publicImageError(e));}

}));

// POST /api/admin/articles/:id/generate-inline-images — admin-initiated inline image generation
// Only for original/deep-dive articles. Returns synchronous per-image outcomes.
router.post('/:id/generate-inline-images', auth, requirePermission('articles.write'), asyncHandler(async (req, res) => {
  const articleId = parseInt(req.params.id, 10);
  if (!articleId) return res.status(400).json({ error: 'Invalid article id' });

  const article = await db.prepare(
    'SELECT id, content_type, is_archived FROM articles WHERE id = $1 AND tenant_id = $2'
  ).get(articleId, req.tenantId);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  if (article.is_archived) return res.status(400).json({ error: 'Cannot generate images for archived article' });
  if (article.content_type !== 'original' && article.content_type !== 'deep-dive') {
    return res.status(400).json({ error: 'Inline images are only available for original and deep-dive articles' });
  }

  try {
    const result=await require('../lib/media-helpers').generateInlineImages(articleId,req.tenantId,{replace:true});
    res.json({ok:true,...result});
  } catch(e) {res.status(502).json(require('../lib/image-errors').publicImageError(e));}

}));

// POST /api/articles/regen-inline-images?slug=<slug> — regenerate section images via public user JWT
// Only works for original and deep-dive articles. Returns synchronous per-image outcomes.
router.post('/regen-inline-images', require('../middleware/user-jwt'), userImageRegenLimiter, asyncHandler(async (req, res) => {
  const slug = req.query.slug;
  if (!slug) return res.status(400).json({ error: 'slug required' });

  const article = await db.prepare('SELECT id, tenant_id, content_type, is_archived FROM articles WHERE slug = $1').get(slug);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  if (article.is_archived) return res.status(400).json({ error: 'Cannot regenerate images for archived article' });
  if (article.content_type !== 'original' && article.content_type !== 'deep-dive') {
    return res.status(400).json({ error: 'Inline images are only available for original and deep-dive articles' });
  }

  if (!await require('../lib/image-policy').canGenerateForUser(req.user.email,article.tenant_id)) return res.status(403).json({error:'Media creation permission required'});


  try {
    const result=await require('../lib/media-helpers').generateInlineImages(article.id,article.tenant_id,{replace:true});
    res.json({ok:true,...result});
  } catch(e) {res.status(502).json(require('../lib/image-errors').publicImageError(e));}

}));

// POST /api/articles/regen-audio?slug=<slug> — regenerate TTS audio via public user JWT
router.post('/regen-audio', require('../middleware/user-jwt'), userImageRegenLimiter, asyncHandler(async (req, res) => {
  const slug = req.query.slug;
  if (!slug) return res.status(400).json({ error: 'slug required' });

  const article = await db.prepare('SELECT id, tenant_id, media_enabled, audio_url, is_archived FROM articles WHERE slug = $1').get(slug);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  if (article.is_archived) return res.status(400).json({ error: 'Cannot regenerate audio for archived article' });
  if (!article.media_enabled) return res.status(400).json({ error: 'Audio is not enabled for this article' });

  const adminRow = await db.prepare(
    'SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND tenant_id = $2 AND is_active = 1'
  ).get(req.user.email, article.tenant_id);
  if (!adminRow) return res.status(403).json({ error: 'Admin access required' });

  const { generateAudioForArticle } = require('../lib/media-helpers');

  // Clear existing audio so generateAudioForArticle doesn't skip
  await deleteAudio(article.audio_url, article.tenant_id);
  await db.prepare("UPDATE articles SET audio_url = NULL, audio_status = NULL, updated_at = NOW() WHERE id = $1 AND tenant_id = $2")
    .run(article.id, article.tenant_id);

  // Fire async — TTS + LLM text-clean can take ~10-20s
  setImmediate(() => generateAudioForArticle(article.id, article.tenant_id).catch(err => {
    console.error('[articles] regen-audio background error:', err.message);
  }));

  res.json({ ok: true, queued: true });
}));

// ── Quick-action endpoints (public user JWT, slug-based) ─────────────────────
// Used by the floating admin toolbar on the public site. All require the caller's
// email to match an active admin user for the article's tenant.

// POST /api/articles/quick-publish?slug= — toggle published status
router.post('/quick-publish', require('../middleware/user-jwt'), asyncHandler(async (req, res) => {
  const article=await db.prepare('SELECT id FROM articles WHERE slug=$1 AND tenant_id=$2').get(req.query.slug,req.tenantId);
  if(!article)return res.status(404).json({error:'Article not found'});
  const admin=await db.prepare('SELECT id,role FROM users WHERE LOWER(email)=LOWER($1) AND tenant_id=$2 AND is_active=1').get(req.user.email,req.tenantId);
  if(!admin)return res.status(403).json({error:'Admin access required'});
  const role=await db.prepare('SELECT permissions FROM roles WHERE name=$1 AND tenant_id=$2').get(admin.role,req.tenantId);
  let perms=role?.permissions||[];if(typeof perms==='string'){try{perms=JSON.parse(perms);}catch{perms=[];}}
  if(admin.role!=='owner'&&!perms.some(p=>['*','articles.*','articles.update'].includes(p)))return res.status(403).json({error:'Insufficient permissions'});
  const result=await publication.change(article.id,req.tenantId,{published:req.body?.published,expectedRevision:req.body?.expected_revision,userId:admin.id});
  res.json({ok:true,is_published:result.is_published,publication_revision:result.publication_revision});
}));

// POST /api/articles/set-embed?slug= — attach or clear a YouTube video embed
router.post('/set-embed', require('../middleware/user-jwt'), asyncHandler(async (req, res) => {
  const slug = req.query.slug;
  if (!slug) return res.status(400).json({ error: 'slug required' });

  const { embed_url } = req.body || {};

  // Validate and normalise to embed format, or clear if empty
  let normalised = null;
  if (embed_url && embed_url.trim()) {
    try {
      const u = new URL(embed_url.trim());
      let videoId = null;
      if ((u.hostname === 'www.youtube.com' || u.hostname === 'youtube.com') && u.searchParams.get('v')) {
        videoId = u.searchParams.get('v');
      } else if (u.hostname === 'youtu.be') {
        videoId = u.pathname.slice(1).split('?')[0];
      } else if ((u.hostname === 'www.youtube.com' || u.hostname === 'youtube.com') && u.pathname.startsWith('/embed/')) {
        videoId = u.pathname.split('/embed/')[1].split('/')[0];
      }
      if (!videoId) return res.status(400).json({ error: 'Not a valid YouTube URL' });
      normalised = 'https://www.youtube.com/embed/' + videoId;
    } catch {
      return res.status(400).json({ error: 'Invalid URL' });
    }
  }

  const article = await db.prepare(
    'SELECT id, tenant_id, content_type FROM articles WHERE slug = $1'
  ).get(slug);
  if (!article) return res.status(404).json({ error: 'Article not found' });

  const adminRow = await db.prepare(
    'SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND tenant_id = $2 AND is_active = 1'
  ).get(req.user.email, article.tenant_id);
  if (!adminRow) return res.status(403).json({ error: 'Admin access required' });

  // When clearing a video embed, reset content_type from 'video' to 'curated' so it
  // doesn't fall through to a broken render state with no embed and no article content.
  const contentTypeReset = (!normalised && article.content_type === 'video') ? 'curated' : article.content_type;

  await db.prepare(
    'UPDATE articles SET embed_url = $1, embed_type = $2, content_type = $3, updated_at = NOW() WHERE id = $4 AND tenant_id = $5'
  ).run(normalised, normalised ? 'youtube' : null, contentTypeReset, article.id, article.tenant_id);

  res.json({ ok: true, embed_url: normalised });
}));

// POST /api/articles/quick-archive?slug= — soft-archive article
router.post('/quick-archive', require('../middleware/user-jwt'), asyncHandler(async (req, res) => {
  const slug = req.query.slug;
  if (!slug) return res.status(400).json({ error: 'slug required' });

  const article = await db.prepare(
    'SELECT id, tenant_id FROM articles WHERE slug = $1'
  ).get(slug);
  if (!article) return res.status(404).json({ error: 'Article not found' });

  const adminRow = await db.prepare(
    'SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND tenant_id = $2 AND is_active = 1'
  ).get(req.user.email, article.tenant_id);
  if (!adminRow) return res.status(403).json({ error: 'Admin access required' });

  await db.prepare(`
    UPDATE articles
    SET is_archived = 1, is_published = 0, is_featured = 0, featured_priority = NULL,
        is_pinned = 0, featured_source = NULL, featured_until = NULL,
        status = 'archived', archived_at = NOW(), updated_at = NOW()
    WHERE id = $1 AND tenant_id = $2
  `).run(article.id, article.tenant_id);

  res.json({ ok: true });
}));

// POST /api/articles/quick-feature?slug= — toggle featured status
router.post('/quick-feature', require('../middleware/user-jwt'), asyncHandler(async (req, res) => {
  const slug = req.query.slug;
  if (!slug) return res.status(400).json({ error: 'slug required' });

  const article = await db.prepare(
    'SELECT id, tenant_id, is_featured FROM articles WHERE slug = $1'
  ).get(slug);
  if (!article) return res.status(404).json({ error: 'Article not found' });

  const adminRow = await db.prepare(
    'SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND tenant_id = $2 AND is_active = 1'
  ).get(req.user.email, article.tenant_id);
  if (!adminRow) return res.status(403).json({ error: 'Admin access required' });

  const newFeatured = article.is_featured ? 0 : 1;
  if (newFeatured) {
    await db.prepare(
      'UPDATE articles SET is_featured = 1, featured_priority = 1, featured_source = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3'
    ).run('toolbar', article.id, article.tenant_id);
  } else {
    await db.prepare(
      'UPDATE articles SET is_featured = 0, featured_priority = NULL, featured_source = NULL, featured_until = NULL, updated_at = NOW() WHERE id = $1 AND tenant_id = $2'
    ).run(article.id, article.tenant_id);
  }

  res.json({ ok: true, is_featured: newFeatured });
}));

// POST /api/articles/quick-story?slug= — add article to a story
// Body: { storyId }
router.post('/quick-story', require('../middleware/user-jwt'), asyncHandler(async (req, res) => {
  const slug = req.query.slug;
  if (!slug) return res.status(400).json({ error: 'slug required' });

  const { storyId } = req.body || {};
  if (!storyId) return res.status(400).json({ error: 'storyId required' });

  const article = await db.prepare(
    'SELECT id, tenant_id FROM articles WHERE slug = $1'
  ).get(slug);
  if (!article) return res.status(404).json({ error: 'Article not found' });

  const adminRow = await db.prepare(
    'SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND tenant_id = $2 AND is_active = 1'
  ).get(req.user.email, article.tenant_id);
  if (!adminRow) return res.status(403).json({ error: 'Admin access required' });

  const story = await db.prepare(
    'SELECT id FROM story_timelines WHERE id = $1 AND tenant_id = $2'
  ).get(parseInt(storyId), article.tenant_id);
  if (!story) return res.status(404).json({ error: 'Story not found' });

  const { addArticleToStory } = require('../lib/story-timelines');
  await addArticleToStory(story.id, article.id, article.tenant_id);

  res.json({ ok: true });
}));

// ── End quick-action endpoints ────────────────────────────────────────────────

// PATCH /api/articles/:id/final-thoughts — manually set final thoughts text
router.patch('/:id/final-thoughts', auth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const { text } = req.body;
  if (typeof text !== 'string') return res.status(400).json({ error: 'text required' });
  const existing = await db.prepare('SELECT id FROM articles WHERE id = $1 AND tenant_id = $2').get(req.params.id, req.tenantId);
  if (!existing) return res.status(404).json({ error: 'Article not found' });
  await db.prepare('UPDATE articles SET final_thoughts = $1 WHERE id = $2 AND tenant_id = $3').run(text.trim() || null, req.params.id, req.tenantId);
  logAudit(req, 'article.final_thoughts_edit', 'article', parseInt(req.params.id), {});
  res.json({ ok: true, final_thoughts: text.trim() || null });
}));

// POST /api/articles/backfill-embeddings — Generate embeddings for articles without them
// ?type=curated|original|all  (default: all)
// ?batch=N  (default: 50, max: 100)
router.post('/backfill-embeddings', auth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const { generateEmbedding, isPgvectorAvailable } = require('../lib/embeddings');

  if (!(await isPgvectorAvailable())) {
    return res.json({ ok: false, error: 'pgvector extension not available' });
  }

  const batchSize = Math.min(parseInt(req.query.batch) || 50, 100);
  const type = (req.query.type || 'all').toLowerCase();

  // Content-type filter: curated = NULL or 'curated', original = original/deep-dive
  let typeFilter;
  if (type === 'original') typeFilter = `content_type IN ('original', 'deep-dive') AND is_published = 1`;
  else if (type === 'curated') typeFilter = `(content_type IS NULL OR content_type NOT IN ('original', 'deep-dive')) AND is_archived = 0`;
  else typeFilter = `((content_type IN ('original', 'deep-dive') AND is_published = 1) OR ((content_type IS NULL OR content_type NOT IN ('original', 'deep-dive')) AND is_archived = 0))`;

  const articles = await db.prepare(`
    SELECT id, title, COALESCE(enriched_summary, tldr_overview, LEFT(summary, 400)) AS text
    FROM articles
    WHERE tenant_id = $1 AND ${typeFilter} AND embedding IS NULL
    ORDER BY created_at DESC
    LIMIT $2
  `).all(req.tenantId, batchSize);

  if (!articles.length) {
    return res.json({ ok: true, processed: 0, remaining: 0, message: 'All articles already have embeddings' });
  }

  let processed = 0;
  let errors = 0;

  for (const a of articles) {
    try {
      const textToEmbed = `${a.title} — ${a.text || ''}`.slice(0, 1000);
      const vector = await generateEmbedding(req.tenantId, textToEmbed);
      await db.prepare('UPDATE articles SET embedding = $1 WHERE id = $2 AND tenant_id = $3')
        .run(JSON.stringify(vector), a.id, req.tenantId);
      processed++;
    } catch (err) {
      errors++;
      console.error(`[backfill] Embedding failed for article ${a.id}:`, err.message);
    }
  }

  const remaining = await db.prepare(
    `SELECT COUNT(*)::int AS cnt FROM articles WHERE tenant_id = $1 AND ${typeFilter} AND embedding IS NULL`
  ).get(req.tenantId);

  logAudit(req, 'articles.backfill-embeddings', 'articles', null, { type, processed, errors, remaining: remaining?.cnt || 0 });
  res.json({ ok: true, type, processed, errors, remaining: remaining?.cnt || 0 });
}));

// POST /api/articles/backfill-topic-tags — AI-cluster existing articles without a topic_tag
// ?batch=N  (default: 80, max: 150)
router.post('/backfill-topic-tags', auth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const { complete: aiComplete } = require('../lib/ai-router');
  const batchSize = Math.min(parseInt(req.query.batch) || 80, 150);

  const articles = await db.prepare(`
    SELECT id, title, summary
    FROM articles
    WHERE tenant_id = $1
      AND topic_tag IS NULL
      AND is_published = 1
      AND content_type IN ('original', 'deep-dive')
      AND (is_archived = 0 OR is_archived IS NULL)
    ORDER BY published_at DESC
    LIMIT $2
  `).all(req.tenantId, batchSize);

  if (!articles.length) {
    return res.json({ ok: true, processed: 0, remaining: 0, message: 'All articles already have topic tags' });
  }

  // Build a compact list: ID + title + first 120 chars of summary
  const articleLines = articles.map(a =>
    `ID_${a.id}: ${a.title}${a.summary ? ' — ' + a.summary.slice(0, 120) : ''}`
  ).join('\n');

  const result = await aiComplete({
    operation: 'backfill-topic-tags',
    tenantId:  req.tenantId,
    skipBudget: true,
    messages: [{
      role: 'user',
      content: `Assign a topic tag to each news article below. Articles covering the same ongoing story MUST share the same tag.

Tags must be:
- 2–4 words, lowercase, hyphenated (e.g. "bitcoin-price-rally", "openai-board-crisis", "us-china-tariffs")
- Specific to the event or story, not just the category

Reply with exactly one line per article:
ID_<number>: <tag>

Articles:
${articleLines}`,
    }],
    temperature: 0.1,
    maxTokens: Math.max(articles.length * 20, 800),
  });

  const rawText = result.text || '';

  // Parse response — resilient to markdown decoration (-, *, **, etc.)
  // Matches: ID_123: tag  OR  - ID_123: tag  OR  **ID_123**: tag
  const tagMap = new Map();
  for (const line of rawText.split('\n')) {
    const m = line.match(/[*_\-\s]*ID_?(\d+)[*_]*:\s*([^\n]+)/i);
    if (!m) continue;
    const id  = parseInt(m[1], 10);
    const tag = m[2].trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
    if (tag) tagMap.set(id, tag);
  }

  let processed = 0;
  let errors    = 0;
  for (const a of articles) {
    const tag = tagMap.get(a.id);
    if (!tag) { errors++; continue; }
    try {
      await db.prepare('UPDATE articles SET topic_tag = $1 WHERE id = $2 AND tenant_id = $3')
        .run(tag, a.id, req.tenantId);
      processed++;
    } catch (err) {
      errors++;
      console.error(`[backfill-topic-tags] Failed for article ${a.id}:`, err.message);
    }
  }

  const remaining = await db.prepare(
    `SELECT COUNT(*)::int AS cnt FROM articles WHERE tenant_id = $1 AND topic_tag IS NULL AND is_published = 1 AND content_type IN ('original', 'deep-dive') AND (is_archived = 0 OR is_archived IS NULL)`
  ).get(req.tenantId);

  logAudit(req, 'articles.backfill-topic-tags', 'articles', null, { processed, errors, remaining: remaining?.cnt || 0 });
  // Include a snippet of the raw AI response to aid debugging if parse rate is low
  const parseRate = articles.length ? Math.round(tagMap.size / articles.length * 100) : 0;
  res.json({
    ok: true, processed, errors, remaining: remaining?.cnt || 0,
    ...(parseRate < 80 ? { debug_sample: rawText.slice(0, 400) } : {}),
  });
}));

// POST /api/articles/:id/rewrite — lightweight AI rewrite of headline, summary, or full body
// Body: { mode: 'headline' | 'summary' | 'full' }
router.post('/:id/rewrite', auth, requirePermission('articles.update'), asyncHandler(async (req, res) => {
  const { mode } = req.body || {};
  if (!['headline', 'summary', 'full'].includes(mode)) {
    return res.status(400).json({ error: 'mode must be headline, summary, or full' });
  }

  const article = await db.prepare('SELECT * FROM articles WHERE id = $1 AND tenant_id = $2').get(req.params.id, req.tenantId);
  if (!article) return res.status(404).json({ error: 'Article not found' });

  const { complete: aiComplete } = require('../lib/ai-router');

  if (mode === 'headline') {
    const prompt = `Rewrite this news headline to be clear, direct, and compelling without clickbait or sensationalism. Return only the headline text, no quotes.\n\nOriginal: ${article.title}\n\nContext: ${(article.summary || '').slice(0, 200)}`;
    const result = await aiComplete({
      operation: 'summary',
      tenantId: req.tenantId,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      maxTokens: 100,
      trigger: 'article-rewrite',
    });
    const newTitle = cleanInlineMarkdownText((result?.text || '').trim().replace(/^["']|["']$/g, ''), 220);
    if (!newTitle) return res.status(500).json({ error: 'AI returned no result' });
    await db.prepare('UPDATE articles SET generated_title = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3').run(newTitle, article.id, req.tenantId);
    logAudit(req, 'article.rewrite', 'article', parseInt(req.params.id), { mode, title: newTitle });
    return res.json({ ok: true, mode, generated_title: newTitle });
  }

  if (mode === 'summary') {
    const body = (article.full_content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1200);
    const prompt = `Write a concise 1–2 sentence news summary for the article below. Return only the summary text.\n\nTitle: ${article.title}\n\nBody: ${body}`;
    const result = await aiComplete({
      operation: 'summary',
      tenantId: req.tenantId,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.5,
      maxTokens: 160,
      trigger: 'article-rewrite',
    });
    const newSummary = cleanInlineMarkdownText((result?.text || '').trim().replace(/^["']|["']$/g, ''), 500);
    if (!newSummary) return res.status(500).json({ error: 'AI returned no result' });
    await db.prepare('UPDATE articles SET summary = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3').run(newSummary, article.id, req.tenantId);
    logAudit(req, 'article.rewrite', 'article', parseInt(req.params.id), { mode });
    return res.json({ ok: true, mode, summary: newSummary });
  }

  if (mode === 'full') {
    const body = article.full_content || '';
    if (!body || body.trim().length < 100) return res.status(400).json({ error: 'Article body is too short to rewrite' });
    const prompt = `You are a tech news editor. Rewrite the following article to improve clarity, flow, and readability while preserving all facts and key information. Return only the rewritten article body in plain markdown.\n\nTitle: ${article.title}\n\nArticle:\n${body.slice(0, 4000)}`;
    const result = await aiComplete({
      operation: 'content',
      tenantId: req.tenantId,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.6,
      maxTokens: 2000,
      trigger: 'article-rewrite',
    });
    const newContent = result?.text?.trim();
    if (!newContent) return res.status(500).json({ error: 'AI returned no result' });
    await db.prepare('UPDATE articles SET full_content = $1, content_blocks = NULL, updated_at = NOW() WHERE id = $2 AND tenant_id = $3').run(newContent, article.id, req.tenantId);
    logAudit(req, 'article.rewrite', 'article', parseInt(req.params.id), { mode });
    return res.json({ ok: true, mode, full_content: newContent });
  }
}));

module.exports = router;
