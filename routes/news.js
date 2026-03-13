/**
 * Deep Feed AI Admin — GET /api/news
 * Public endpoint — returns all published, non-archived articles.
 * Used by the main site to populate the news feed.
 *
 * GET /api/news/hot — top articles by hot_score (comments + reactions + recency)
 *   Hot score formula (Wilson-inspired, time-decayed):
 *     engagement  = comment_count + reaction_count * 0.5
 *     age_hours   = hours since published_at
 *     gravity     = 1.5  (controls how fast items fall)
 *     hot_score   = engagement / (age_hours + 2) ^ gravity
 */
const express                              = require('express');
const router                               = express.Router();
const { getPool }                          = require('../db');
const { toSlug, serializeRow, asyncHandler } = require('../lib/utils');

/** Compute hot score — same formula used in both /hot and enriched feed */
function hotScore(commentCount, reactionCount, publishedAt) {
  const engagement = commentCount + (reactionCount * 0.5);
  const ageHours   = Math.max(0, (Date.now() - new Date(publishedAt).getTime()) / 3600000);
  return engagement / Math.pow(ageHours + 2, 1.5);
}

/** Batch-fetch comment counts and reaction counts for an array of slugs */
async function fetchEngagement(slugs) {
  if (!slugs.length) return { countMap: {}, reactionMap: {} };

  const placeholders = slugs.map((_, i) => `$${i + 1}`).join(', ');

  const [commentResult, reactionResult] = await Promise.all([
    getPool().query(
      `SELECT article_slug, COUNT(*) AS cnt
       FROM comments
       WHERE article_slug IN (${placeholders}) AND is_deleted = 0
       GROUP BY article_slug`,
      slugs
    ),
    getPool().query(
      `SELECT c.article_slug, COUNT(r.id) AS cnt
       FROM comment_reactions r
       JOIN comments c ON c.id = r.comment_id
       WHERE c.article_slug IN (${placeholders}) AND c.is_deleted = 0
       GROUP BY c.article_slug`,
      slugs
    ),
  ]);

  const countMap    = {};
  const reactionMap = {};
  for (const row of commentResult.rows)  countMap[row.article_slug]    = parseInt(row.cnt, 10);
  for (const row of reactionResult.rows) reactionMap[row.article_slug] = parseInt(row.cnt, 10);

  return { countMap, reactionMap };
}

// GET /api/news
router.get('/', asyncHandler(async (req, res) => {
  const { category, limit: lim, featured } = req.query;
  let query = `SELECT a.*, v.name AS writer_name, v.slug AS writer_slug,
                      v.avatar_url AS writer_avatar_url, v.beat AS writer_beat
               FROM articles a
               LEFT JOIN voices v ON v.id = a.writer_id
               WHERE a.is_published = 1 AND (a.is_archived = 0 OR a.is_archived IS NULL)`;
  const params = [];

  if (category) {
    params.push(category);
    query += ` AND a.category = $${params.length}`;
  }
  if (featured !== undefined) {
    params.push(parseInt(featured));
    query += ` AND a.is_featured = $${params.length}`;
  }

  query += ' ORDER BY a.is_featured DESC, COALESCE(a.featured_priority, 99) ASC, a.published_at DESC';

  if (lim) {
    params.push(parseInt(lim));
    query += ` LIMIT $${params.length}`;
  }

  const result = await getPool().query(query, params.length ? params : undefined);
  const items  = result.rows.map(serializeRow);

  // Batch-fetch comment + reaction counts
  const slugs = items.map(a => toSlug(a.title));
  const { countMap, reactionMap } = await fetchEngagement(slugs);

  const enriched = items.map(a => {
    const slug     = toSlug(a.title);
    const comments = countMap[slug]    ?? 0;
    const reactions = reactionMap[slug] ?? 0;
    return {
      ...a,
      slug,
      comment_count:  comments,
      reaction_count: reactions,
      hot_score:      hotScore(comments, reactions, a.published_at),
    };
  });

  res.json({ status: 'ok', items: enriched, count: enriched.length });
}));

// GET /api/news/hot — top articles ranked by hot_score
// ?limit=10 (default 10, max 30) — returns only articles with engagement > 0
router.get('/hot', asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 10, 30);

  // Fetch all published articles (no limit — we need to score & sort first)
  const result = await getPool().query(
    `SELECT * FROM articles
     WHERE is_published = 1 AND (is_archived = 0 OR is_archived IS NULL)`
  );
  const items = result.rows.map(serializeRow);
  const slugs = items.map(a => toSlug(a.title));

  const { countMap, reactionMap } = await fetchEngagement(slugs);

  const scored = items
    .map(a => {
      const slug      = toSlug(a.title);
      const comments  = countMap[slug]    ?? 0;
      const reactions = reactionMap[slug] ?? 0;
      const score     = hotScore(comments, reactions, a.published_at);
      return { ...a, slug, comment_count: comments, reaction_count: reactions, hot_score: score };
    })
    .filter(a => a.hot_score > 0)           // only articles with engagement
    .sort((a, b) => b.hot_score - a.hot_score)
    .slice(0, limit);

  res.json({ status: 'ok', items: scored, count: scored.length });
}));

// GET /api/news/updated-at — lightweight cache-bust timestamp for the main site
router.get('/updated-at', asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const result = await getPool().query(
    'SELECT MAX(COALESCE(updated_at, created_at, published_at)) AS ts FROM articles'
  );
  res.json({ updatedAt: result.rows[0]?.ts || null });
}));

module.exports = router;
