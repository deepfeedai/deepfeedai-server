const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const db = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'deepfeedai_super_secret_jwt_key_2026';

// Auth middleware
function auth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.split(' ')[1];
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// GET /api/articles
router.get('/', auth, (req, res) => {
  let query = 'SELECT * FROM articles WHERE 1=1';
  const params = [];

  if (req.query.published !== undefined) {
    query += ' AND is_published = ?';
    params.push(parseInt(req.query.published));
  }
  if (req.query.category) {
    query += ' AND category = ?';
    params.push(req.query.category);
  }

  query += ' ORDER BY created_at DESC';
  const articles = db.prepare(query).all(...params);
  res.json(articles);
});

// GET /api/articles/:id
router.get('/:id', auth, (req, res) => {
  const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(req.params.id);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  res.json(article);
});

// POST /api/articles
router.post('/', auth, (req, res) => {
  const {
    title, summary, content, category, source, source_url,
    image_url, author, is_featured, is_published, published_at
  } = req.body;

  if (!title) return res.status(400).json({ error: 'Title is required' });

  const stmt = db.prepare(`
    INSERT INTO articles (title, summary, content, category, source, source_url, image_url, author, is_featured, is_published, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    title,
    summary || null,
    content || null,
    category || 'Industry',
    source || null,
    source_url || null,
    image_url || null,
    author || null,
    is_featured ? 1 : 0,
    is_published !== undefined ? (is_published ? 1 : 0) : 1,
    published_at || new Date().toISOString()
  );

  // Get the last inserted article
  const article = db.prepare('SELECT * FROM articles ORDER BY id DESC LIMIT 1').get();
  res.status(201).json(article);
});

// PUT /api/articles/:id
router.put('/:id', auth, (req, res) => {
  const existing = db.prepare('SELECT * FROM articles WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Article not found' });

  const {
    title, summary, content, category, source, source_url,
    image_url, author, is_featured, is_published, published_at
  } = req.body;

  db.prepare(`
    UPDATE articles SET
      title = ?, summary = ?, content = ?, category = ?, source = ?,
      source_url = ?, image_url = ?, author = ?, is_featured = ?,
      is_published = ?, published_at = ?
    WHERE id = ?
  `).run(
    title !== undefined ? title : existing.title,
    summary !== undefined ? summary : existing.summary,
    content !== undefined ? content : existing.content,
    category !== undefined ? category : existing.category,
    source !== undefined ? source : existing.source,
    source_url !== undefined ? source_url : existing.source_url,
    image_url !== undefined ? image_url : existing.image_url,
    author !== undefined ? author : existing.author,
    is_featured !== undefined ? (is_featured ? 1 : 0) : existing.is_featured,
    is_published !== undefined ? (is_published ? 1 : 0) : existing.is_published,
    published_at !== undefined ? published_at : existing.published_at,
    req.params.id
  );

  const updated = db.prepare('SELECT * FROM articles WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// DELETE /api/articles/:id
router.delete('/:id', auth, (req, res) => {
  const existing = db.prepare('SELECT id FROM articles WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Article not found' });

  db.prepare('DELETE FROM articles WHERE id = ?').run(req.params.id);
  res.json({ message: 'Article deleted' });
});

// PUT /api/articles/:id/feature — toggle featured
router.put('/:id/feature', auth, (req, res) => {
  const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(req.params.id);
  if (!article) return res.status(404).json({ error: 'Article not found' });

  const newVal = article.is_featured ? 0 : 1;
  db.prepare('UPDATE articles SET is_featured = ? WHERE id = ?').run(newVal, req.params.id);
  res.json({ id: article.id, is_featured: newVal });
});

// PUT /api/articles/:id/publish — toggle published
router.put('/:id/publish', auth, (req, res) => {
  const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(req.params.id);
  if (!article) return res.status(404).json({ error: 'Article not found' });

  const newVal = article.is_published ? 0 : 1;
  db.prepare('UPDATE articles SET is_published = ? WHERE id = ?').run(newVal, req.params.id);
  res.json({ id: article.id, is_published: newVal });
});

module.exports = router;
