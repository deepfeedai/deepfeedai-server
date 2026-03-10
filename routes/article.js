/**
 * Deep Feed AI Admin — GET /api/article
 * Public endpoint — looks up a single published article by slug.
 */
const express               = require('express');
const router                = express.Router();
const db                    = require('../db');
const { toSlug, asyncHandler } = require('../lib/utils');

router.get('/', asyncHandler(async (req, res) => {
  const { slug } = req.query;
  if (!slug) return res.status(400).json({ error: 'slug param required' });

  const articles = await db.prepare(
    'SELECT * FROM articles WHERE is_published = 1 AND (is_archived = 0 OR is_archived IS NULL)'
  ).all();

  const match = articles.find(a => toSlug(a.title) === slug);
  if (!match) return res.status(404).json({ error: 'Article not found' });

  res.json({
    title:                  match.title,
    summary:                match.summary,
    category:               match.category,
    source:                 match.source,
    url:                    match.source_url,
    image:                  match.image_url,
    publishedAt:            match.published_at,
    is_featured:            match.is_featured,
    audio_url:              match.audio_url              || null,
    audio_status:           match.audio_status           || null,
    audio_transcript:       match.audio_transcript       || null,
    media_enabled:          match.media_enabled          || 0,
    audio_voice_name:       match.audio_voice_name       || null,
    audio_voice_avatar_url: match.audio_voice_avatar_url || null,
  });
}));

module.exports = router;
