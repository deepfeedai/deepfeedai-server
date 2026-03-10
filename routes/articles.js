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
          image_url, author, is_featured, is_published, published_at } = body;

  if (is_featured) {
    await db.prepare('UPDATE articles SET is_featured = 0, updated_at = NOW()').run();
  }

  const article = await db.prepare(`
    INSERT INTO articles
      (title, summary, content, category, source, source_url, image_url, author,
       is_featured, is_published, published_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
          image_url, author, is_featured, is_published, published_at } = body;

  if (is_featured) {
    await db.prepare('UPDATE articles SET is_featured = 0, updated_at = NOW() WHERE id != $1').run(req.params.id);
  }

  const updated = await db.prepare(`
    UPDATE articles SET
      title = $1, summary = $2, content = $3, category = $4, source = $5,
      source_url = $6, image_url = $7, author = $8, is_featured = $9,
      is_published = $10, published_at = $11, updated_at = NOW()
    WHERE id = $12
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
    is_featured  !== undefined ? (is_featured  ? 1 : 0) : existing.is_featured,
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
    SET is_archived = 1, is_published = 0, is_featured = 0,
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
router.put('/:id/feature', auth, asyncHandler(async (req, res) => {
  const article = await db.prepare('SELECT * FROM articles WHERE id = $1').get(req.params.id);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  const newVal = article.is_featured ? 0 : 1;
  if (newVal === 1) {
    await db.prepare('UPDATE articles SET is_featured = 0, updated_at = NOW() WHERE id != $1').run(req.params.id);
  }
  await db.prepare('UPDATE articles SET is_featured = $1, updated_at = NOW() WHERE id = $2').run(newVal, req.params.id);
  res.json({ id: article.id, is_featured: newVal });
}));

// PUT /api/articles/:id/publish
router.put('/:id/publish', auth, asyncHandler(async (req, res) => {
  const article = await db.prepare('SELECT * FROM articles WHERE id = $1').get(req.params.id);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  const newVal = article.is_published ? 0 : 1;
  await db.prepare('UPDATE articles SET is_published = $1, updated_at = NOW() WHERE id = $2').run(newVal, req.params.id);
  res.json({ id: article.id, is_published: newVal });
}));

module.exports = router;
