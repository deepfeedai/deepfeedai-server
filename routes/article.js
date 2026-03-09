/**
 * Deep Feed AI Admin — GET /api/article
 * Public endpoint — looks up a single published article by slug.
 * Used by article.html on the main site.
 */
const express = require('express');
const router  = express.Router();
const db      = require('../db');

function toSlug(title) {
  return (title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
}

// GET /api/article?slug=some-slug
router.get('/', (req, res) => {
  const { slug } = req.query;
  if (!slug) return res.status(400).json({ error: 'slug param required' });

  const articles = db.all('SELECT * FROM articles WHERE is_published = 1');
  const match    = articles.find(a => toSlug(a.title) === slug);

  if (!match) return res.status(404).json({ error: 'Article not found' });

  res.json({
    title:       match.title,
    summary:     match.summary,
    category:    match.category,
    source:      match.source,
    url:         match.source_url,
    image:       match.image_url,
    publishedAt: match.published_at,
    is_featured: match.is_featured,
  });
});

module.exports = router;
