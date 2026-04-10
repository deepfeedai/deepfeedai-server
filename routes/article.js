/**
 * Deep Feed AI Admin — GET /api/article
 * Public endpoint — looks up a single published article by slug.
 */
const express               = require('express');
const router                = express.Router();
const db                    = require('../db');
const { getPool }           = require('../db');
const { toSlug, asyncHandler, significantWords } = require('../lib/utils');

router.get('/', asyncHandler(async (req, res) => {
  const { slug } = req.query;
  if (!slug) return res.status(400).json({ error: 'slug param required' });

  // Direct slug lookup using indexed column (fast path)
  let match = await db.prepare(
    `SELECT a.*, w.name AS writer_name, w.slug AS writer_slug,
            w.avatar_url AS writer_avatar_url,
            (SELECT COALESCE(json_agg(c2.name), '[]') FROM writer_beats wb2 JOIN categories c2 ON c2.id = wb2.category_id WHERE wb2.writer_id = w.id) AS writer_beats
     FROM articles a
     LEFT JOIN writers w ON w.id = a.writer_id
     WHERE a.tenant_id = $1 AND a.slug = $2 AND a.is_published = 1 AND (a.is_archived = 0 OR a.is_archived IS NULL)`
  ).get(req.tenantId, slug);

  // Fallback: compute slug from title for articles not yet backfilled
  if (!match) {
    const articles = await db.prepare(
      `SELECT a.*, w.name AS writer_name, w.slug AS writer_slug,
              w.avatar_url AS writer_avatar_url,
              (SELECT COALESCE(json_agg(c2.name), '[]') FROM writer_beats wb2 JOIN categories c2 ON c2.id = wb2.category_id WHERE wb2.writer_id = w.id) AS writer_beats
       FROM articles a
       LEFT JOIN writers w ON w.id = a.writer_id
       WHERE a.tenant_id = $1 AND a.is_published = 1 AND (a.is_archived = 0 OR a.is_archived IS NULL) AND (a.slug IS NULL OR a.slug = '')`
    ).all(req.tenantId);
    match = articles.find(a => toSlug(a.title) === slug);
  }
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
    content_blocks:         match.content_blocks         || null,
    source_article_ids:     match.source_article_ids     || null,
    slug:                   match.slug                   || null,
    embed_url:              match.embed_url              || null,
    embed_type:             match.embed_type             || null,
    source_type:            match.source_type            || null,
    synthesis_meta:         match.synthesis_meta         || null,
    inline_images:          match.inline_images          || [],
    disable_summary:        match.disable_summary        || 0,
    generated_title:        match.generated_title        || null,
    topic_tag:              match.topic_tag              || null,
    followups:              match.followups              || [],
  });
}));

// GET /api/article/related?slug=...
// Returns up to 6 related articles scored by keyword overlap, topic_tag match, content type, and recency.
router.get('/related', asyncHandler(async (req, res) => {
  const { slug } = req.query;
  if (!slug) return res.status(400).json({ error: 'slug param required' });

  // Check cache first (skip if ?refresh=1)
  const pool = getPool();
  const cacheKey = `related_${slug}`;
  if (!req.query.refresh) {
    const cached = await pool.query(
      `SELECT payload FROM summary_cache
       WHERE tenant_id = $1 AND cache_key = $2
         AND created_at > NOW() - INTERVAL '6 hours'`,
      [req.tenantId, cacheKey]
    );
    if (cached.rows[0]?.payload) {
      res.setHeader('X-Cache', 'HIT');
      const p = cached.rows[0].payload;
      return res.json(typeof p === 'string' ? JSON.parse(p) : p);
    }
  }

  // Fetch the source article
  const article = await db.prepare(
    `SELECT id, title, category, topic_tag, content_type FROM articles
     WHERE tenant_id = $1 AND slug = $2 AND is_published = 1`
  ).get(req.tenantId, slug);
  if (!article) return res.status(404).json({ error: 'Article not found' });

  // Fetch candidate articles (same tenant, published, not archived, not self)
  const candidates = await db.prepare(
    `SELECT a.id, a.title, a.slug, a.category, a.topic_tag, a.content_type,
            a.image_url, a.source, a.published_at, a.generated_title,
            w.name AS writer_name, w.slug AS writer_slug, w.avatar_url AS writer_avatar_url
     FROM articles a
     LEFT JOIN writers w ON w.id = a.writer_id
     WHERE a.tenant_id = $1 AND a.is_published = 1 AND (a.is_archived = 0 OR a.is_archived IS NULL)
       AND a.id != $2
     ORDER BY a.published_at DESC
     LIMIT 200`
  ).all(req.tenantId, article.id);

  // Score candidates
  const sourceWords = new Set(significantWords(article.title));
  const now = Date.now();

  const scored = candidates.map(c => {
    let score = 0;
    let hasDirectMatch = false; // requires keyword overlap OR topic tag match

    // Keyword overlap: +2 per shared significant word
    const cWords = significantWords(c.title);
    for (const w of cWords) {
      if (sourceWords.has(w)) { score += 2; hasDirectMatch = true; }
    }

    // Topic tag match: +5
    if (article.topic_tag && c.topic_tag && article.topic_tag === c.topic_tag) {
      score += 5;
      hasDirectMatch = true;
    }

    // Only apply bonus signals if there's a direct content match
    if (!hasDirectMatch) return { ...c, score: 0 };

    // Category match: +2 (bonus, not standalone qualifier)
    if (article.category && c.category === article.category) {
      score += 2;
    }

    // Synthesis/deep-dive boost: +1 (reduced — shouldn't dominate scoring)
    if (c.content_type === 'original' || c.content_type === 'deep-dive') {
      score += 1;
    }

    // Recency: +1 if within 7 days
    const age = now - new Date(c.published_at).getTime();
    if (age < 7 * 24 * 60 * 60 * 1000) {
      score += 1;
    }

    return { ...c, score };
  });

  // Sort by score desc, take top 6, filter out zero-score
  const related = scored
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map(({ score, ...rest }) => rest);

  // Cache the result
  await pool.query(
    `INSERT INTO summary_cache (tenant_id, cache_key, payload, created_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (tenant_id, cache_key) DO UPDATE SET payload = EXCLUDED.payload, created_at = NOW()`,
    [req.tenantId, cacheKey, JSON.stringify(related)]
  ).catch(() => {});

  res.setHeader('X-Cache', 'MISS');
  res.json(related);
}));

module.exports = router;
