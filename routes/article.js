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
    `SELECT a.*, v.name AS writer_name, v.slug AS writer_slug,
            v.avatar_url AS writer_avatar_url, v.beat AS writer_beat
     FROM articles a
     LEFT JOIN voices v ON v.id = a.writer_id
     WHERE a.is_published = 1 AND (a.is_archived = 0 OR a.is_archived IS NULL)`
  ).all();

  const match = articles.find(a => toSlug(a.title) === slug);
  if (!match) return res.status(404).json({ error: 'Article not found' });

  // Fetch comment count for this article
  const countRow = await db.prepare(
    'SELECT COUNT(*) AS cnt FROM comments WHERE article_slug = $1 AND is_deleted = 0'
  ).get(slug);
  const commentCount = parseInt(countRow?.cnt ?? 0, 10);

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
    comment_count:          commentCount,
    writer_id:              match.writer_id              || null,
    writer_name:            match.writer_name            || null,
    writer_slug:            match.writer_slug            || null,
    writer_avatar_url:      match.writer_avatar_url      || null,
    writer_beat:            match.writer_beat            || null,
    content_type:           match.content_type           || 'curated',
    full_content:           match.full_content           || null,
    source_article_ids:     match.source_article_ids     || null,
    slug:                   match.slug                   || null,
  });
}));

module.exports = router;
