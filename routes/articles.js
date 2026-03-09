const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const db      = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'deepfeedai_super_secret_jwt_key_2026';

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid or expired token' }); }
}

// GET /api/articles
router.get('/', auth, async (req, res) => {
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
  const { getPool } = require('../db');
  const result = await getPool().query(query, params.length ? params : undefined);
  res.json(result.rows.map(row => {
    const out = {};
    for (const [k, v] of Object.entries(row)) out[k] = v instanceof Date ? v.toISOString() : v;
    return out;
  }));
});

// GET /api/articles/:id
router.get('/:id', auth, async (req, res) => {
  const article = await db.prepare('SELECT * FROM articles WHERE id = ?').get(req.params.id);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  res.json(article);
});

// POST /api/articles
router.post('/', auth, async (req, res) => {
  const { title, summary, content, category, source, source_url,
          image_url, author, is_featured, is_published, published_at } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });

  if (is_featured) {
    await db.prepare('UPDATE articles SET is_featured = 0, updated_at = NOW()').run();
  }

  const article = await db.prepare(`
    INSERT INTO articles
      (title, summary, content, category, source, source_url, image_url, author,
       is_featured, is_published, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
});

// PUT /api/articles/:id
router.put('/:id', auth, async (req, res) => {
  const existing = await db.prepare('SELECT * FROM articles WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Article not found' });

  const { title, summary, content, category, source, source_url,
          image_url, author, is_featured, is_published, published_at } = req.body;

  if (is_featured) {
    await db.prepare('UPDATE articles SET is_featured = 0, updated_at = NOW() WHERE id != ?').run(req.params.id);
  }

  const updated = await db.prepare(`
    UPDATE articles SET
      title = ?, summary = ?, content = ?, category = ?, source = ?,
      source_url = ?, image_url = ?, author = ?, is_featured = ?,
      is_published = ?, published_at = ?, updated_at = NOW()
    WHERE id = ?
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
});

// DELETE /api/articles/:id — soft archive
router.delete('/:id', auth, async (req, res) => {
  const existing = await db.prepare('SELECT id FROM articles WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Article not found' });
  await db.prepare(`
    UPDATE articles
    SET is_archived = 1, is_published = 0, is_featured = 0,
        archived_at = NOW(), updated_at = NOW()
    WHERE id = ?
  `).run(req.params.id);
  res.json({ message: 'Article archived' });
});

// DELETE /api/articles/:id/purge — hard delete
router.delete('/:id/purge', auth, async (req, res) => {
  const existing = await db.prepare('SELECT id FROM articles WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Article not found' });
  await db.prepare('DELETE FROM articles WHERE id = ?').run(req.params.id);
  res.json({ message: 'Article permanently deleted' });
});

// PUT /api/articles/:id/restore
router.put('/:id/restore', auth, async (req, res) => {
  const existing = await db.prepare('SELECT id FROM articles WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Article not found' });
  const updated = await db.prepare(`
    UPDATE articles
    SET is_archived = 0, archived_at = NULL, updated_at = NOW()
    WHERE id = ?
    RETURNING *
  `).get(req.params.id);
  res.json(updated);
});

// PUT /api/articles/:id/feature
router.put('/:id/feature', auth, async (req, res) => {
  const article = await db.prepare('SELECT * FROM articles WHERE id = ?').get(req.params.id);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  const newVal = article.is_featured ? 0 : 1;
  if (newVal === 1) {
    await db.prepare('UPDATE articles SET is_featured = 0, updated_at = NOW() WHERE id != ?').run(req.params.id);
  }
  await db.prepare('UPDATE articles SET is_featured = ?, updated_at = NOW() WHERE id = ?').run(newVal, req.params.id);
  res.json({ id: article.id, is_featured: newVal });
});

// PUT /api/articles/:id/publish
router.put('/:id/publish', auth, async (req, res) => {
  const article = await db.prepare('SELECT * FROM articles WHERE id = ?').get(req.params.id);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  const newVal = article.is_published ? 0 : 1;
  await db.prepare('UPDATE articles SET is_published = ?, updated_at = NOW() WHERE id = ?').run(newVal, req.params.id);
  res.json({ id: article.id, is_published: newVal });
});

module.exports = router;
