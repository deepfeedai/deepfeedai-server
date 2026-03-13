const express                        = require('express');
const router                         = express.Router();
const db                             = require('../db');
const { getPool }                    = require('../db');
const { auth }                       = require('../middleware/auth');
const { serializeRow, asyncHandler } = require('../lib/utils');
const { articleCreate, articleUpdate, validate } = require('../lib/schemas');

// GET /api/articles
router.get('/', auth, asyncHandler(async (req, res) => {
  let query = 'SELECT * FROM articles WHERE 1=1';
  const params = [];
  if (req.query.published !== undefined) {
    params.push(parseInt(req.query.published));
    query += ` AND is_published = $${params.length}`;
  }
  if (req.query.category) {
    params.push(req.query.category);
    query += ` AND category = $${params.length}`;
  }
  query += ' ORDER BY created_at DESC';
  const result = await getPool().query(query, params.length ? params : undefined);
  res.json(result.rows.map(serializeRow));
}));

// ── GET /api/articles/export — must be BEFORE /:id to avoid "export" being parsed as an integer
// Optional query params:
//   format=csv|json (default: json)
//   category=<name>  filter by category
//   since=<ISO date> filter by published_at >= date
router.get('/export', auth, asyncHandler(async (req, res) => {
  const format   = (req.query.format || 'json').toLowerCase();
  const category = req.query.category || null;
  const since    = req.query.since    || null;

  if (!['csv', 'json'].includes(format)) {
    return res.status(400).json({ error: 'format must be csv or json' });
  }

  const conditions = [
    `is_published = 1`,
    `(is_archived = 0 OR is_archived IS NULL)`,
  ];
  const params = [];

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
           is_featured, featured_priority, published_at, created_at, audio_url, media_enabled
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
                'author','is_featured','featured_priority','published_at','created_at',
                'audio_url','media_enabled'];

  function csvCell(val) {
    if (val === null || val === undefined) return '';
    const s = String(val);
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

// GET /api/articles/:id
router.get('/:id', auth, asyncHandler(async (req, res) => {
  const article = await db.prepare('SELECT * FROM articles WHERE id = $1').get(req.params.id);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  res.json(article);
}));

// POST /api/articles
router.post('/', auth, asyncHandler(async (req, res) => {
  const body = validate(articleCreate, req.body, res);
  if (!body) return;

  const { title, summary, content, category, source, source_url,
          image_url, author, is_featured, featured_priority: fp, is_published, published_at } = body;

  const newPriority = fp ? parseInt(fp) : null;

  if (is_featured && newPriority) {
    // Evict whoever holds this slot
    await db.prepare(
      'UPDATE articles SET is_featured = 0, featured_priority = NULL, updated_at = NOW() WHERE featured_priority = $1'
    ).run(newPriority);
  }

  const article = await db.prepare(`
    INSERT INTO articles
      (title, summary, content, category, source, source_url, image_url, author,
       is_featured, featured_priority, is_published, published_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    RETURNING *
  `).get(
    title,
    summary    || null,
    content    || null,
    category   || 'Industry',
    source     || null,
    source_url || null,
    image_url  || null,
    author     || null,
    is_featured  ? 1 : 0,
    newPriority,
    is_published !== undefined ? (is_published ? 1 : 0) : 1,
    published_at || new Date().toISOString()
  );
  res.status(201).json(article);
}));

// PUT /api/articles/:id
router.put('/:id', auth, asyncHandler(async (req, res) => {
  const existing = await db.prepare('SELECT * FROM articles WHERE id = $1').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Article not found' });

  const body = validate(articleUpdate, req.body, res);
  if (!body) return;

  const { title, summary, content, category, source, source_url,
          image_url, author, is_featured, featured_priority, is_published, published_at } = body;

  const newFeatured = is_featured !== undefined ? (is_featured ? 1 : 0) : existing.is_featured;
  const newPriority = featured_priority !== undefined ? (featured_priority || null) : existing.featured_priority;

  if (newFeatured) {
    // If assigning a priority slot, evict whoever currently holds it
    if (newPriority) {
      await db.prepare(
        'UPDATE articles SET is_featured = 0, featured_priority = NULL, updated_at = NOW() WHERE featured_priority = $1 AND id != $2'
      ).run(newPriority, req.params.id);
    }
  }

  const updated = await db.prepare(`
    UPDATE articles SET
      title = $1, summary = $2, content = $3, category = $4, source = $5,
      source_url = $6, image_url = $7, author = $8, is_featured = $9,
      featured_priority = $10, is_published = $11, published_at = $12, updated_at = NOW()
    WHERE id = $13
    RETURNING *
  `).get(
    title        !== undefined ? title        : existing.title,
    summary      !== undefined ? summary      : existing.summary,
    content      !== undefined ? content      : existing.content,
    category     !== undefined ? category     : existing.category,
    source       !== undefined ? source       : existing.source,
    source_url   !== undefined ? source_url   : existing.source_url,
    image_url    !== undefined ? image_url    : existing.image_url,
    author       !== undefined ? author       : existing.author,
    newFeatured,
    newPriority,
    is_published !== undefined ? (is_published ? 1 : 0) : existing.is_published,
    published_at !== undefined ? published_at : existing.published_at,
    req.params.id
  );
  res.json(updated);
}));

// DELETE /api/articles/:id — soft archive
router.delete('/:id', auth, asyncHandler(async (req, res) => {
  const existing = await db.prepare('SELECT id FROM articles WHERE id = $1').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Article not found' });
  await db.prepare(`
    UPDATE articles
    SET is_archived = 1, is_published = 0, is_featured = 0, featured_priority = NULL,
        archived_at = NOW(), updated_at = NOW()
    WHERE id = $1
  `).run(req.params.id);
  res.json({ message: 'Article archived' });
}));

// DELETE /api/articles/:id/purge — hard delete
router.delete('/:id/purge', auth, asyncHandler(async (req, res) => {
  const existing = await db.prepare('SELECT id FROM articles WHERE id = $1').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Article not found' });
  await db.prepare('DELETE FROM articles WHERE id = $1').run(req.params.id);
  res.json({ message: 'Article permanently deleted' });
}));

// PUT /api/articles/:id/restore
router.put('/:id/restore', auth, asyncHandler(async (req, res) => {
  const existing = await db.prepare('SELECT id FROM articles WHERE id = $1').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Article not found' });
  const updated = await db.prepare(`
    UPDATE articles
    SET is_archived = 0, archived_at = NULL, updated_at = NOW()
    WHERE id = $1
    RETURNING *
  `).get(req.params.id);
  res.json(updated);
}));

// PUT /api/articles/:id/feature
// Body: { priority: 1|2|3 } to feature at a slot, or omit/null to unfeature
router.put('/:id/feature', auth, asyncHandler(async (req, res) => {
  const article = await db.prepare('SELECT * FROM articles WHERE id = $1').get(req.params.id);
  if (!article) return res.status(404).json({ error: 'Article not found' });

  const MAX_FEATURED = 3;
  const { priority } = req.body || {};

  // Unfeature: no priority supplied, or priority === 0/null
  if (!priority) {
    await db.prepare(
      'UPDATE articles SET is_featured = 0, featured_priority = NULL, updated_at = NOW() WHERE id = $1'
    ).run(req.params.id);
    return res.json({ id: article.id, is_featured: 0, featured_priority: null });
  }

  const slot = parseInt(priority);
  if (![1, 2, 3].includes(slot)) {
    return res.status(400).json({ error: 'priority must be 1, 2, or 3' });
  }

  // Count currently featured (excluding this article)
  const { count } = await db.prepare(
    'SELECT COUNT(*) AS count FROM articles WHERE is_featured = 1 AND id != $1'
  ).get(req.params.id);

  if (count >= MAX_FEATURED) {
    // Bump the article currently holding this slot (if any) to unfeature
    await db.prepare(
      'UPDATE articles SET is_featured = 0, featured_priority = NULL, updated_at = NOW() WHERE featured_priority = $1 AND id != $2'
    ).run(slot, req.params.id);
  }

  await db.prepare(
    'UPDATE articles SET is_featured = 1, featured_priority = $1, updated_at = NOW() WHERE id = $2'
  ).run(slot, req.params.id);

  res.json({ id: article.id, is_featured: 1, featured_priority: slot });
}));

// PUT /api/articles/:id/publish
router.put('/:id/publish', auth, asyncHandler(async (req, res) => {
  const article = await db.prepare('SELECT * FROM articles WHERE id = $1').get(req.params.id);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  const newVal = article.is_published ? 0 : 1;
  await db.prepare('UPDATE articles SET is_published = $1, updated_at = NOW() WHERE id = $2').run(newVal, req.params.id);
  res.json({ id: article.id, is_published: newVal });
}));

// POST /api/articles/purge-old — archive articles older than N days
router.post('/purge-old', auth, asyncHandler(async (req, res) => {
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
    WHERE is_archived = 0
      AND (created_at < $1 OR (published_at IS NOT NULL AND published_at < $1))
  `;
  const rows = await db.prepare(query).all(cutoff);

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
          archived_at = NOW(), updated_at = NOW()
      WHERE id = $1
    `).run(row.id);
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



module.exports = router;
