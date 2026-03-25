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
const jwt                                  = require('jsonwebtoken');
const router                               = express.Router();
const { getPool }                          = require('../db');
const db                                   = require('../db');
const { toSlug, serializeRow, asyncHandler } = require('../lib/utils');

const { getSecrets } = require('../lib/secrets');

async function getUserId(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  try {
    const { userJwtSecret } = await getSecrets();
    return jwt.verify(authHeader.slice(7), userJwtSecret).sub;
  } catch { return null; }
}

/** Compute hot score — same formula used in both /hot and enriched feed */
function hotScore(commentCount, reactionCount, publishedAt) {
  const engagement = commentCount + (reactionCount * 0.5);
  const ageHours   = Math.max(0, (Date.now() - new Date(publishedAt).getTime()) / 3600000);
  return engagement / Math.pow(ageHours + 2, 1.5);
}

/** Batch-fetch comment counts and reaction counts for an array of slugs */
async function fetchEngagement(slugs, tenantId) {
  if (!slugs.length) return { countMap: {}, reactionMap: {} };

  const placeholders = slugs.map((_, i) => `$${i + 1}`).join(', ');
  const tenantParam = `$${slugs.length + 1}`;
  const allParams = [...slugs, tenantId];

  const [commentResult, reactionResult] = await Promise.all([
    getPool().query(
      `SELECT article_slug, COUNT(*) AS cnt
       FROM comments
       WHERE article_slug IN (${placeholders}) AND is_deleted = 0 AND tenant_id = ${tenantParam}
       GROUP BY article_slug`,
      allParams
    ),
    getPool().query(
      `SELECT c.article_slug, COUNT(r.id) AS cnt
       FROM comment_reactions r
       JOIN comments c ON c.id = r.comment_id
       WHERE c.article_slug IN (${placeholders}) AND c.is_deleted = 0 AND c.tenant_id = ${tenantParam}
       GROUP BY c.article_slug`,
      allParams
    ),
  ]);

  const countMap    = {};
  const reactionMap = {};
  for (const row of commentResult.rows)  countMap[row.article_slug]    = parseInt(row.cnt, 10);
  for (const row of reactionResult.rows) reactionMap[row.article_slug] = parseInt(row.cnt, 10);

  return { countMap, reactionMap };
}

// GET /api/news
// ?feed=following — filter to articles by writers the current user follows (requires Bearer token)
router.get('/', asyncHandler(async (req, res) => {
  const { category, limit: lim, featured, writer, feed } = req.query;

  // Build filter conditions separately so they can be shared with the count query
  const conditions = ['a.tenant_id = $1', 'a.is_published = 1', '(a.is_archived = 0 OR a.is_archived IS NULL)'];
  const params = [req.tenantId];

  // "Following" feed: only articles by writers the user follows
  if (feed === 'following') {
    const userId = await getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized — sign in to use the following feed' });
    params.push(userId);
    conditions.push(`a.writer_id IN (SELECT writer_id FROM writer_follows WHERE user_id = $${params.length})`);
  }

  if (category) {
    params.push(category);
    conditions.push(`a.category = $${params.length}`);
  }
  if (featured !== undefined) {
    params.push(parseInt(featured));
    conditions.push(`a.is_featured = $${params.length}`);
    // Exclude expired featured articles (featured_until has passed)
    if (parseInt(featured) === 1) {
      conditions.push(`(a.featured_until IS NULL OR a.featured_until > NOW())`);
    }
  }
  if (writer) {
    params.push(writer);
    conditions.push(`w.slug = $${params.length}`);
  }
  if (req.query.content_type) {
    const types = req.query.content_type.split(',').map(t => t.trim()).filter(Boolean);
    if (types.length === 1) {
      params.push(types[0]);
      conditions.push(`a.content_type = $${params.length}`);
    } else if (types.length > 1) {
      const placeholders = types.map((_, i) => `$${params.length + i + 1}`).join(', ');
      types.forEach(t => params.push(t));
      conditions.push(`a.content_type IN (${placeholders})`);
    }
  }

  const whereClause = 'WHERE ' + conditions.join(' AND ');
  const whereParams = [...params];

  let query = `SELECT a.*, w.name AS writer_name, w.slug AS writer_slug,
                      w.avatar_url AS writer_avatar_url,
                      (SELECT COALESCE(json_agg(c2.name), '[]') FROM writer_beats wb2 JOIN categories c2 ON c2.id = wb2.category_id WHERE wb2.writer_id = w.id) AS writer_beats
               FROM articles a
               LEFT JOIN writers w ON w.id = a.writer_id
               ${whereClause}`;

  query += ` ORDER BY
    CASE WHEN a.is_featured = 1 AND (a.featured_until IS NULL OR a.featured_until > NOW()) THEN 1 ELSE 0 END DESC,
    COALESCE(a.featured_priority, 99) ASC,
    a.published_at DESC`;

  const defaultLimit = 30;
  const limit  = parseInt(lim) || defaultLimit;
  const offset = parseInt(req.query.offset) || 0;
  params.push(limit);
  query += ` LIMIT $${params.length}`;
  params.push(offset);
  query += ` OFFSET $${params.length}`;

  // Run data query and count query in parallel
  const countQuery = `SELECT COUNT(*) AS total FROM articles a LEFT JOIN writers w ON w.id = a.writer_id ${whereClause}`;
  const [result, countResult] = await Promise.all([
    getPool().query(query, params),
    getPool().query(countQuery, whereParams),
  ]);
  const totalCount = parseInt(countResult.rows[0].total);
  const items      = result.rows.map(serializeRow);

  // Resolve relative image/audio URLs to absolute (use request host — media is served from this server)
  const mediaBase = `${req.protocol}://${req.get('host')}`;
  items.forEach(item => {
    if (item.image_url && item.image_url.startsWith('/')) {
      item.image_url = mediaBase + item.image_url;
    }
    if (item.audio_url && item.audio_url.startsWith('/')) {
      item.audio_url = mediaBase + item.audio_url;
    }
  });

  // Batch-fetch comment + reaction counts
  const slugs = items.map(a => toSlug(a.title));
  const { countMap, reactionMap } = await fetchEngagement(slugs, req.tenantId);

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

  const hasMore = offset + enriched.length < totalCount;
  res.json({ status: 'ok', items: enriched, count: enriched.length, totalCount, hasMore });
}));

// GET /api/news/hot — top articles ranked by hot_score
// ?limit=10 (default 10, max 30) — returns only articles with engagement > 0
router.get('/hot', asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 10, 30);

  // Fetch recent published articles — 30-day window since older articles have near-zero hot scores
  const result = await getPool().query(
    `SELECT * FROM articles
     WHERE tenant_id = $1 AND is_published = 1 AND (is_archived = 0 OR is_archived IS NULL)
       AND published_at >= NOW() - INTERVAL '30 days'`,
    [req.tenantId]
  );
  const items = result.rows.map(serializeRow);

  // Resolve relative image/audio URLs to absolute (use request host — media is served from this server)
  const hotMediaBase = `${req.protocol}://${req.get('host')}`;
  items.forEach(item => {
    if (item.image_url && item.image_url.startsWith('/')) {
      item.image_url = hotMediaBase + item.image_url;
    }
    if (item.audio_url && item.audio_url.startsWith('/')) {
      item.audio_url = hotMediaBase + item.audio_url;
    }
  });

  const slugs = items.map(a => toSlug(a.title));

  const { countMap, reactionMap } = await fetchEngagement(slugs, req.tenantId);

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
    'SELECT MAX(COALESCE(updated_at, created_at, published_at)) AS ts FROM articles WHERE tenant_id = $1',
    [req.tenantId]
  );
  res.json({ updatedAt: result.rows[0]?.ts || null });
}));

module.exports = router;
