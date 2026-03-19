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
    `SELECT a.*, w.name AS writer_name, w.slug AS writer_slug,
            w.avatar_url AS writer_avatar_url,
            (SELECT COALESCE(json_agg(c2.name), '[]') FROM writer_beats wb2 JOIN categories c2 ON c2.id = wb2.category_id WHERE wb2.writer_id = w.id) AS writer_beats
     FROM articles a
     LEFT JOIN writers w ON w.id = a.writer_id
     WHERE a.tenant_id = $1 AND a.is_published = 1 AND (a.is_archived = 0 OR a.is_archived IS NULL)`
  ).all(req.tenantId);

  const match = articles.find(a => toSlug(a.title) === slug);
  if (!match) return res.status(404).json({ error: 'Article not found' });

  // Resolve relative image/audio URLs to absolute (use request host — media is served from this server)
  const mediaBase = `${req.protocol}://${req.get('host')}`;
  if (match.image_url && match.image_url.startsWith('/')) {
    match.image_url = mediaBase + match.image_url;
  }
  if (match.audio_url && match.audio_url.startsWith('/')) {
    match.audio_url = mediaBase + match.audio_url;
  }

  // Fetch comment count for this article
  const countRow = await db.prepare(
    'SELECT COUNT(*) AS cnt FROM comments WHERE article_slug = $1 AND is_deleted = 0 AND tenant_id = $2'
  ).get(slug, req.tenantId);
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
    writer_beat:            (match.writer_beats && match.writer_beats[0]) || null,
    writer_beats:           match.writer_beats           || [],
    content_type:           match.content_type           || 'curated',
    full_content:           match.full_content           || null,
    source_article_ids:     match.source_article_ids     || null,
    slug:                   match.slug                   || null,
    embed_url:              match.embed_url              || null,
    embed_type:             match.embed_type             || null,
    source_type:            match.source_type            || null,
    synthesis_meta:         match.synthesis_meta         || null,
  });
}));

module.exports = router;
