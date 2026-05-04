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
const { computeEffectiveImportance, RANK: IMPORTANCE_RANK } = require('../lib/story-levels');
const { isFeatureEnabled } = require('../lib/feature-registry');

// In-memory brief cache — keyed by `${tenantId}:${tag}`, TTL 2 hours
const _briefCache = new Map();
const BRIEF_TTL   = 2 * 3600 * 1000;

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

/** Batch-fetch comment counts, reaction counts, and share counts for an array of slugs */
async function fetchEngagement(slugs, tenantId) {
  if (!slugs.length) return { countMap: {}, reactionMap: {}, shareMap: {} };

  const placeholders = slugs.map((_, i) => `$${i + 1}`).join(', ');
  const tenantParam = `$${slugs.length + 1}`;
  const allParams = [...slugs, tenantId];

  const [commentResult, reactionResult, shareResult] = await Promise.all([
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
    getPool().query(
      `SELECT article_slug, COUNT(*) AS cnt
       FROM analytics_events
       WHERE article_slug IN (${placeholders}) AND event_type = 'share' AND tenant_id = ${tenantParam}
       GROUP BY article_slug`,
      allParams
    ),
  ]);

  const countMap    = {};
  const reactionMap = {};
  const shareMap    = {};
  for (const row of commentResult.rows)  countMap[row.article_slug]    = parseInt(row.cnt, 10);
  for (const row of reactionResult.rows) reactionMap[row.article_slug] = parseInt(row.cnt, 10);
  for (const row of shareResult.rows)    shareMap[row.article_slug]    = parseInt(row.cnt, 10);

  return { countMap, reactionMap, shareMap };
}

// GET /api/news
// ?feed=following — filter to articles by writers the current user follows (requires Bearer token)
router.get('/', asyncHandler(async (req, res) => {
  const { category, limit: lim, featured, writer, feed } = req.query;

  // ── "Developing" feed: source articles awaiting synthesis ──────────
  if (feed === 'developing') {
    const devLimit = Math.min(parseInt(lim) || 20, 50);
    const devResult = await getPool().query(
      `SELECT a.id, a.title, a.summary, a.category, a.source, a.source_url,
              a.image_url, a.editorial_score, a.created_at, a.slug, a.topic_tag
       FROM articles a
       WHERE a.tenant_id = $1
         AND a.is_published = 0
         AND (a.is_archived = 0 OR a.is_archived IS NULL)
         AND (content_type IS NULL OR content_type NOT IN ('original', 'deep-dive'))
         AND a.created_at > NOW() - INTERVAL '48 hours'
       ORDER BY a.created_at DESC
       LIMIT $2`,
      [req.tenantId, devLimit]
    );

    const devItems = devResult.rows.map(serializeRow);

    // Compute "sources tracking this" — count other source articles with 2+ shared title words
    const { significantWords } = require('../lib/utils');
    for (const item of devItems) {
      const words = new Set(significantWords(item.title));
      let tracking = 1; // count self
      for (const other of devItems) {
        if (other.id === item.id) continue;
        if (other.category !== item.category) continue;
        const otherWords = significantWords(other.title);
        let shared = 0;
        for (const w of otherWords) {
          if (words.has(w)) shared++;
        }
        if (shared >= 2) tracking++;
      }

      // Check if synthesis already published an article using this source
      let publishedSlug = null;
      try {
        const published = await db.prepare(
          `SELECT slug, title FROM articles
           WHERE tenant_id = $1 AND content_type IN ('original', 'deep-dive')
             AND is_published = 1 AND source_article_ids::text LIKE $2
             AND created_at > NOW() - INTERVAL '7 days'
           LIMIT 1`
        ).get(req.tenantId, `%"id":${item.id}%`);
        if (published) publishedSlug = published.slug;
      } catch { /* ignore */ }

      item.tracking_count = tracking;
      item.published_slug = publishedSlug;
    }

    return res.json({ status: 'ok', items: devItems, count: devItems.length });
  }

  // Build filter conditions separately so they can be shared with the count query
  const conditions = ['a.tenant_id = $1', 'a.is_published = 1', '(a.is_archived = 0 OR a.is_archived IS NULL)', "a.category != 'Uncategorized'"];
  const params = [req.tenantId];

  // "Following" feed: articles by followed writers, categories, or topic tags
  if (feed === 'following') {
    const userId = await getUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized — sign in to use the following feed' });
    params.push(userId);
    const uidIdx = params.length;
    params.push(req.tenantId);
    const tidIdx = params.length;
    conditions.push(
      `(a.writer_id IN (SELECT writer_id FROM writer_follows WHERE user_id = $${uidIdx} AND tenant_id = $${tidIdx})` +
      ` OR a.category IN (SELECT category_name FROM user_category_follows WHERE user_id = $${uidIdx} AND tenant_id = $${tidIdx})` +
      ` OR (a.topic_tag IS NOT NULL AND a.topic_tag IN (SELECT topic_tag FROM user_topic_follows WHERE user_id = $${uidIdx} AND tenant_id = $${tidIdx})))`
    );
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
  // Alias: ?originals_only=1 forces the default originals+deep-dive filter even
  // if a content_type override is present. Kept as an explicit param so clients
  // that want curated can still opt in with ?content_type=curated.
  const originalsOnly = req.query.originals_only === '1' || req.query.originals_only === 'true';

  if (req.query.content_type && !originalsOnly) {
    const types = req.query.content_type.split(',').map(t => t.trim()).filter(Boolean);
    if (types.length === 1) {
      params.push(types[0]);
      conditions.push(`a.content_type = $${params.length}`);
    } else if (types.length > 1) {
      const placeholders = types.map((_, i) => `$${params.length + i + 1}`).join(', ');
      types.forEach(t => params.push(t));
      conditions.push(`a.content_type IN (${placeholders})`);
    }
  } else {
    // Default: only show original and deep-dive articles (source-first pipeline)
    conditions.push(`a.content_type IN ('original', 'deep-dive')`);
  }
  if (req.query.since) {
    const sinceMs = parseInt(req.query.since, 10);
    if (!isNaN(sinceMs)) {
      params.push(new Date(sinceMs).toISOString());
      conditions.push(`a.published_at >= $${params.length}`);
    }
  }
  if (req.query.has_audio === '1') {
    conditions.push(`a.audio_url IS NOT NULL AND a.audio_status = 'ready' AND a.media_enabled = 1`);
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
  const { countMap, reactionMap, shareMap } = await fetchEngagement(slugs, req.tenantId);

  const enriched = items.map(a => {
    const slug     = toSlug(a.title);
    const comments = countMap[slug]    ?? 0;
    const reactions = reactionMap[slug] ?? 0;
    return {
      ...a,
      slug,
      comment_count:  comments,
      reaction_count: reactions,
      share_count:    shareMap[slug] ?? 0,
      hot_score:      hotScore(comments, reactions, a.published_at),
    };
  });

  // ── Story levels: attach effective_importance + re-order by tier, and compute
  // perspective grouping (sibling counts on each lead). Flag-gated per tenant.
  let finalItems = enriched;
  const storyLevelsOn = await isFeatureEnabled(req.tenantId, 'story_levels').catch(() => false);
  if (storyLevelsOn) {
    finalItems = enriched.map(a => ({
      ...a,
      effective_importance: computeEffectiveImportance(a),
    }));

    // Perspective grouping: for each original with a synthesis_meta.from_pitch
    // (or topic_tag), count sibling originals in the same cluster published
    // earlier (those are the "perspectives" hanging off the lead).
    const leadsByTopic = new Map(); // topic_tag -> lead article id (earliest)
    for (const a of finalItems) {
      if (!a.topic_tag) continue;
      const prior = leadsByTopic.get(a.topic_tag);
      if (!prior || new Date(a.published_at) < new Date(prior.published_at)) {
        leadsByTopic.set(a.topic_tag, a);
      }
    }
    const perspectivesByLead = new Map();
    for (const a of finalItems) {
      if (!a.topic_tag) continue;
      const lead = leadsByTopic.get(a.topic_tag);
      if (!lead || lead.id === a.id) continue;
      a.lead_article_id = lead.id;
      perspectivesByLead.set(lead.id, (perspectivesByLead.get(lead.id) || 0) + 1);
    }
    for (const a of finalItems) {
      a.perspectives_count = perspectivesByLead.get(a.id) || 0;
    }

    // Re-order: tier DESC, then published_at DESC. Featured pin still wins.
    finalItems.sort((a, b) => {
      const aFeat = a.is_featured && (!a.featured_until || new Date(a.featured_until) > new Date()) ? 1 : 0;
      const bFeat = b.is_featured && (!b.featured_until || new Date(b.featured_until) > new Date()) ? 1 : 0;
      if (aFeat !== bFeat) return bFeat - aFeat;
      if (aFeat && bFeat) {
        const aPri = a.featured_priority ?? 99;
        const bPri = b.featured_priority ?? 99;
        if (aPri !== bPri) return aPri - bPri;
      }
      const aRank = IMPORTANCE_RANK[a.effective_importance] || 1;
      const bRank = IMPORTANCE_RANK[b.effective_importance] || 1;
      if (aRank !== bRank) return bRank - aRank;
      return new Date(b.published_at) - new Date(a.published_at);
    });
  }

  const hasMore = offset + finalItems.length < totalCount;
  res.json({ status: 'ok', items: finalItems, count: finalItems.length, totalCount, hasMore });
}));

// GET /api/news/hot — top articles ranked by hot_score
// ?limit=10 (default 10, max 30) — returns only articles with engagement > 0
router.get('/hot', asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 10, 30);

  // Fetch recent published articles — 30-day window since older articles have near-zero hot scores
  const result = await getPool().query(
    `SELECT * FROM articles
     WHERE tenant_id = $1 AND is_published = 1 AND (is_archived = 0 OR is_archived IS NULL)
       AND content_type IN ('original', 'deep-dive')
       AND category != 'Uncategorized'
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

  const { countMap, reactionMap, shareMap } = await fetchEngagement(slugs, req.tenantId);

  const scored = items
    .map(a => {
      const slug      = toSlug(a.title);
      const comments  = countMap[slug]    ?? 0;
      const reactions = reactionMap[slug] ?? 0;
      const score     = hotScore(comments, reactions, a.published_at);
      return { ...a, slug, comment_count: comments, reaction_count: reactions, share_count: shareMap[slug] ?? 0, hot_score: score };
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

// GET /api/news/topic-pulse — live topic clusters ranked by tier + momentum
// Returns up to 25 active clusters from the last 48h, each with article list and writer info.
router.get('/topic-pulse', asyncHandler(async (req, res) => {
  const tenantId = req.tenantId;
  const now = Date.now();
  const TWO_HOURS = 2 * 3600_000;

  // Load the signed-in user's followed topics so cards can show follow state
  const userId = await getUserId(req);
  const followedSet = new Set();
  if (userId) {
    const followRows = await db.prepare(
      'SELECT topic_tag FROM user_topic_follows WHERE user_id = $1 AND tenant_id = $2'
    ).all(userId, tenantId).catch(() => []);
    followRows.forEach(r => followedSet.add(r.topic_tag));
  }

  const [result, statsResult, activityResult] = await Promise.all([
    getPool().query(`
      SELECT a.id, a.title, a.slug, a.topic_tag, a.content_type, a.is_published,
        a.published_at, a.created_at, a.source, a.category, a.summary,
        a.importance, a.importance_updated_at, a.importance_locked, a.editorial_score,
        w.id AS writer_id, w.name AS writer_name, w.slug AS writer_slug, w.avatar_url AS writer_avatar_url
      FROM articles a
      LEFT JOIN writers w ON w.id = a.writer_id AND w.tenant_id = a.tenant_id
      WHERE a.tenant_id = $1
        AND a.topic_tag IS NOT NULL
        AND (a.is_archived = 0 OR a.is_archived IS NULL)
        AND COALESCE(a.published_at, a.created_at) > NOW() - INTERVAL '48 hours'
      ORDER BY COALESCE(a.published_at, a.created_at) DESC
      LIMIT 500
    `, [tenantId]),

    getPool().query(`
      SELECT
        (
          SELECT COUNT(*) FROM (
            SELECT topic_tag,
              COUNT(*) FILTER (WHERE is_published = 1 AND (content_type = 'original' OR content_type = 'deep-dive')) AS pub_count,
              COUNT(*) FILTER (WHERE content_type IS NULL OR content_type = 'curated') AS src_count
            FROM articles
            WHERE tenant_id = $1 AND topic_tag IS NOT NULL
              AND (is_archived = 0 OR is_archived IS NULL)
              AND COALESCE(published_at, created_at) > NOW() - INTERVAL '48 hours'
            GROUP BY topic_tag
          ) t
          WHERE pub_count >= 1 OR src_count >= 2
        ) AS active_topics,
        COUNT(*) FILTER (WHERE content_type = 'curated' AND created_at > NOW() - INTERVAL '1 hour') AS sources_last_hour,
        COUNT(*) FILTER (WHERE is_published = 1 AND (content_type = 'original' OR content_type = 'deep-dive') AND published_at > NOW() - INTERVAL '24 hours') AS articles_today,
        COUNT(DISTINCT writer_id) FILTER (WHERE is_published = 1 AND published_at > NOW() - INTERVAL '24 hours' AND writer_id IS NOT NULL) AS writers_active
      FROM articles
      WHERE tenant_id = $1 AND (is_archived = 0 OR is_archived IS NULL)
    `, [tenantId]),

    getPool().query(`
      SELECT ne.event_type, ne.payload, ne.created_at, ne.target_article_id,
        a.topic_tag,
        w.name AS writer_name, w.slug AS writer_slug, w.avatar_url AS writer_avatar_url
      FROM newsroom_events ne
      JOIN articles a ON a.id = ne.target_article_id AND a.tenant_id = ne.tenant_id
      JOIN writers w ON w.id = ne.actor_writer_id AND w.tenant_id = ne.tenant_id
      WHERE ne.tenant_id = $1
        AND ne.created_at > NOW() - INTERVAL '6 hours'
        AND a.topic_tag IS NOT NULL
      ORDER BY ne.created_at DESC
      LIMIT 200
    `, [tenantId]).catch(() => ({ rows: [] })),
  ]);

  const rows = result.rows.map(serializeRow);

  // Index most-recent writer activity per topic_tag
  const activityByTag = new Map();
  for (const ev of activityResult.rows) {
    if (!activityByTag.has(ev.topic_tag)) {
      activityByTag.set(ev.topic_tag, {
        event_type:   ev.event_type,
        writer_name:  ev.writer_name,
        writer_slug:  ev.writer_slug,
        avatar_url:   ev.writer_avatar_url,
        created_at:   ev.created_at,
      });
    }
  }

  const sr = statsResult.rows[0] || {};
  const stats = {
    active_topics:    parseInt(sr.active_topics  || 0, 10),
    sources_last_hour: parseInt(sr.sources_last_hour || 0, 10),
    articles_today:   parseInt(sr.articles_today  || 0, 10),
    writers_active:   parseInt(sr.writers_active  || 0, 10),
  };

  // Group by topic_tag
  const clusterMap = new Map();
  for (const row of rows) {
    if (!clusterMap.has(row.topic_tag)) clusterMap.set(row.topic_tag, []);
    clusterMap.get(row.topic_tag).push(row);
  }

  const TIER_RANK = { breaking: 4, major: 3, trending: 2, standard: 1, forming: 0 };

  const clusters = [];
  for (const [tag, articles] of clusterMap) {
    const sources   = articles.filter(a => !a.content_type || a.content_type === 'curated');
    const published = articles.filter(a => a.is_published == 1 && (a.content_type === 'original' || a.content_type === 'deep-dive'));
    const forming   = published.length === 0;

    // Surface forming topics only when there are 2+ sources (avoids singleton noise).
    // Published topics always show even with a single article.
    if (forming && sources.length < 2) continue;
    if (!forming && published.length < 1) continue;

    // Momentum: curated sources arriving in the last 2h (scaled 0–5)
    const hotSources = sources.filter(a => now - new Date(a.created_at).getTime() < TWO_HOURS).length;
    const momentum   = Math.min(5, hotSources * 2 + Math.min(published.length, 2));

    // Tier: best effective_importance of published articles, or 'forming'
    let tier = forming ? 'forming' : 'standard';
    if (!forming) {
      for (const a of published) {
        const eff  = computeEffectiveImportance(a);
        if ((TIER_RANK[eff] || 0) > (TIER_RANK[tier] || 0)) tier = eff;
      }
    }

    // Lead article = earliest published original
    const sortedPublished = [...published].sort((a, b) => new Date(a.published_at) - new Date(b.published_at));
    const lead = sortedPublished[0];

    // Display name: derive from the topic_tag slug (human-readable but distinct from article titles).
    // Using article titles caused the topic header to duplicate the first article row.
    const topicName = tag.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    // Unique writers (published articles only)
    const writerMap = new Map();
    for (const a of published) {
      if (a.writer_id && !writerMap.has(a.writer_id)) {
        writerMap.set(a.writer_id, { id: a.writer_id, name: a.writer_name, slug: a.writer_slug, avatar_url: a.writer_avatar_url });
      }
    }

    // Summary: use lead article's AI-generated excerpt, fall back to source titles
    const summary = lead?.summary
      || (sources.length ? (sources.length === 1 ? sources[0].title : `${sources.length} sources including: ${sources[0].title}`) : null);

    clusters.push({
      topic_tag:          tag,
      topic_name:         topicName,
      following:          followedSet.has(tag),
      tier,
      momentum,
      source_count:       sources.length,
      article_count:      published.length,
      forming,
      first_seen_at:      articles[articles.length - 1]?.created_at,
      latest_at:          lead ? sortedPublished[sortedPublished.length - 1]?.published_at : sources[0]?.created_at,
      category:           (lead || sources[0])?.category || null,
      summary,
      writer_activity:    activityByTag.get(tag) || null,
      writers:            [...writerMap.values()],
      articles:           sortedPublished.slice(0, 5).map(a => ({
        id: a.id, title: a.title, slug: a.slug,
        content_type: a.content_type, published_at: a.published_at,
        writer_name: a.writer_name,
      })),
      sources_preview:    forming ? sources.slice(0, 3).map(a => ({
        id: a.id, title: a.title, source: a.source, created_at: a.created_at,
      })) : [],
    });
  }

  // Sort: tier DESC → momentum DESC → latest_at DESC
  clusters.sort((a, b) => {
    const tr = (TIER_RANK[b.tier] || 0) - (TIER_RANK[a.tier] || 0);
    if (tr !== 0) return tr;
    if (b.momentum !== a.momentum) return b.momentum - a.momentum;
    return new Date(b.latest_at || 0) - new Date(a.latest_at || 0);
  });

  res.json({ status: 'ok', topics: clusters.slice(0, 25), stats });
}));

// GET /api/news/topic-pulse/:tag/brief — AI "catch me up" summary for a topic cluster
router.get('/topic-pulse/:tag/brief', asyncHandler(async (req, res) => {
  const tenantId = req.tenantId;
  const tag      = req.params.tag;
  const cacheKey = `${tenantId}:${tag}`;

  // Serve from cache if fresh
  const cached = _briefCache.get(cacheKey);
  if (cached && Date.now() - cached.generatedAt < BRIEF_TTL) {
    return res.json({ status: 'ok', brief: cached.text, generatedAt: cached.generatedAt, cached: true });
  }

  // Fetch up to 8 recent published articles for this topic
  const rows = await getPool().query(`
    SELECT title, summary, published_at
    FROM articles
    WHERE tenant_id = $1
      AND topic_tag = $2
      AND is_published = 1
      AND content_type IN ('original', 'deep-dive')
      AND (is_archived = 0 OR is_archived IS NULL)
    ORDER BY published_at DESC
    LIMIT 8
  `, [tenantId, tag]);

  if (!rows.rows.length) {
    return res.status(404).json({ status: 'error', error: 'No articles found for this topic' });
  }

  const articleBlurbs = rows.rows.map((a, i) =>
    `${i + 1}. ${a.title}${a.summary ? '\n   ' + a.summary.slice(0, 200) : ''}`
  ).join('\n\n');

  const { complete: aiComplete } = require('../lib/ai-router');
  const result = await aiComplete({
    operation:  'topic-brief',
    tenantId,
    skipBudget: false,
    messages: [{
      role: 'user',
      content: `You are a news editor briefing a busy reader on a developing story. Based on these articles, write a 3–4 sentence "catch me up" summary. Cover: what happened, who's involved, where things stand now, and what's still unresolved. Be direct and specific — no hedging phrases like "according to reports". No bullet points, just flowing prose.

Articles:
${articleBlurbs}`,
    }],
    temperature: 0.3,
    maxTokens:   1200,
  });

  const text = (result?.text || '').trim();
  if (!text) return res.status(500).json({ status: 'error', error: 'AI returned no content' });

  const generatedAt = Date.now();
  _briefCache.set(cacheKey, { text, generatedAt });

  res.json({ status: 'ok', brief: text, generatedAt, cached: false });
}));

// GET /api/news/brief — compact morning briefing (top articles, category breakdown, trending keyword)
router.get('/brief', asyncHandler(async (req, res) => {
  const tenantId = req.tenantId;

  // Top 5 articles by editorial_score from last 24h
  const topResult = await getPool().query(
    `SELECT a.*, w.name AS writer_name, w.slug AS writer_slug, w.avatar_url AS writer_avatar_url
     FROM articles a
     LEFT JOIN writers w ON a.writer_id = w.id
     WHERE a.tenant_id = $1 AND a.is_published = 1 AND a.is_archived = 0
       AND a.content_type IN ('original', 'deep-dive')
       AND a.category != 'Uncategorized'
       AND a.published_at >= NOW() - INTERVAL '24 hours'
     ORDER BY a.editorial_score DESC NULLS LAST, a.published_at DESC
     LIMIT 5`,
    [tenantId]
  );

  // Category breakdown
  const catResult = await getPool().query(
    `SELECT category, COUNT(*)::int AS count
     FROM articles
     WHERE tenant_id = $1 AND is_published = 1 AND is_archived = 0
       AND content_type IN ('original', 'deep-dive')
       AND category != 'Uncategorized'
       AND published_at >= NOW() - INTERVAL '24 hours'
     GROUP BY category ORDER BY count DESC`,
    [tenantId]
  );

  // Featured synthesis
  const synthResult = await getPool().query(
    `SELECT a.*, w.name AS writer_name, w.slug AS writer_slug, w.avatar_url AS writer_avatar_url
     FROM articles a
     LEFT JOIN writers w ON a.writer_id = w.id
     WHERE a.tenant_id = $1 AND a.content_type = 'original' AND a.is_published = 1
       AND a.published_at >= NOW() - INTERVAL '24 hours'
     ORDER BY a.editorial_score DESC NULLS LAST
     LIMIT 1`,
    [tenantId]
  );

  // Top trending keyword from trends_cache
  let topKeyword = null;
  try {
    const trendResult = await getPool().query(
      `SELECT value FROM trends_cache WHERE tenant_id = $1 AND type = 'keywords' ORDER BY updated_at DESC LIMIT 1`,
      [tenantId]
    );
    const trend = trendResult.rows[0];
    if (trend && trend.value) {
      const parsed = JSON.parse(trend.value);
      if (Array.isArray(parsed) && parsed.length > 0) {
        topKeyword = parsed[0].keyword || parsed[0].word || parsed[0];
      }
    }
  } catch { /* trends not available */ }

  // Serialize and resolve media URLs
  const mediaBase = `${req.protocol}://${req.get('host')}`;
  function resolveMedia(items) {
    return items.map(row => {
      const item = serializeRow(row);
      if (item.image_url && item.image_url.startsWith('/')) {
        item.image_url = mediaBase + item.image_url;
      }
      if (item.audio_url && item.audio_url.startsWith('/')) {
        item.audio_url = mediaBase + item.audio_url;
      }
      return item;
    });
  }

  const topArticles = resolveMedia(topResult.rows);
  const synthesis = synthResult.rows[0] ? resolveMedia([synthResult.rows[0]])[0] : null;

  res.json({
    status: 'ok',
    top_articles: topArticles,
    category_breakdown: catResult.rows,
    top_keyword: topKeyword,
    featured_synthesis: synthesis,
  });
}));

// ── Topic following ───────────────────────────────────────────────────────────
// These endpoints are user-JWT-authenticated (same pattern as favorites).

// GET /api/news/topic-pulse/following — list topic_tags the signed-in user follows
router.get('/topic-pulse/following', asyncHandler(async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const rows = await db.prepare(
    'SELECT topic_tag FROM user_topic_follows WHERE user_id = $1 AND tenant_id = $2 ORDER BY created_at ASC'
  ).all(userId, req.tenantId);

  res.json({ topics: rows.map(r => r.topic_tag) });
}));

// POST /api/news/topic-pulse/:tag/follow — follow a topic
router.post('/topic-pulse/:tag/follow', asyncHandler(async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const tag = req.params.tag;
  if (!tag || tag.length > 200) return res.status(400).json({ error: 'Invalid topic tag' });

  await db.prepare(
    'INSERT INTO user_topic_follows (user_id, tenant_id, topic_tag) VALUES ($1, $2, $3) ON CONFLICT (user_id, tenant_id, topic_tag) DO NOTHING'
  ).run(userId, req.tenantId, tag);

  res.json({ ok: true, topic_tag: tag, following: true });
}));

// DELETE /api/news/topic-pulse/:tag/follow — unfollow a topic
router.delete('/topic-pulse/:tag/follow', asyncHandler(async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  await db.prepare(
    'DELETE FROM user_topic_follows WHERE user_id = $1 AND tenant_id = $2 AND topic_tag = $3'
  ).run(userId, req.tenantId, req.params.tag);

  res.json({ ok: true, topic_tag: req.params.tag, following: false });
}));

module.exports = router;
