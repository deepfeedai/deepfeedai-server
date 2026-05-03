/**
 * Deep Feed AI — Living Story Timelines
 *
 * Persistent, named story arcs that group articles across multiple topic_tags.
 * Unlike story_threads (one thread per topic_tag, originals only), timelines:
 *   - span multiple topic_tags (detected by embedding similarity)
 *   - accept any article type via many-to-many join
 *   - have Maxwell-generated names + "story so far" summaries
 *   - expose a dedicated public page at /story/:slug
 *
 * Detection strategy (called from post-publish after embedding is ready):
 *   1. Find stories that already contain articles sharing this article's topic_tag.
 *   2. If pgvector is available, also find stories whose articles are
 *      embedding-close (cosine similarity > SIMILARITY_THRESHOLD).
 *   3. Add the article to every matching story (many-to-many).
 *   4. If no matching story exists AND ≥ MIN_ARTICLES_TO_CREATE other published
 *      articles share the topic_tag → auto-create a story and add all of them.
 *   5. After creation, invoke Maxwell to generate name + summary (fire-and-forget).
 */
'use strict';

const db = require('../db');
const { toSlug } = require('./utils');

const SIMILARITY_THRESHOLD  = 0.78;
const MIN_ARTICLES_TO_CREATE = 2;
const DORMANT_DAYS  = 7;
const ARCHIVE_DAYS  = 14;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect which stories a newly-published article belongs to and assign it.
 * Also creates a new story when a qualifying cluster exists with no story yet.
 * All errors are caught — never throws.
 */
async function detectAndAssignStories(article, tenantId) {
  if (!article || !tenantId) return;
  const tag = (article.topic_tag || '').trim();
  if (!tag) return;

  try {
    // 1. Find stories that already have articles with this topic_tag
    const tagMatches = await db.prepare(`
      SELECT DISTINCT sta.story_id
      FROM story_timeline_articles sta
      JOIN articles a ON a.id = sta.article_id AND a.tenant_id = sta.tenant_id
      WHERE sta.tenant_id = $1
        AND a.topic_tag   = $2
        AND sta.article_id != $3
    `).all(tenantId, tag, article.id).catch(() => []);

    // 2. Embedding-based matches (when available)
    let embeddingMatches = [];
    if (article.embedding) {
      embeddingMatches = await db.prepare(`
        SELECT DISTINCT sta.story_id
        FROM story_timeline_articles sta
        JOIN articles a ON a.id = sta.article_id AND a.tenant_id = sta.tenant_id
        WHERE sta.tenant_id = $1
          AND sta.article_id != $2
          AND a.embedding IS NOT NULL
          AND 1 - (a.embedding <=> $3::vector) > $4
      `).all(tenantId, article.id, article.embedding, SIMILARITY_THRESHOLD).catch(() => []);
    }

    const matchedStoryIds = new Set([
      ...tagMatches.map(r => r.story_id),
      ...embeddingMatches.map(r => r.story_id),
    ]);

    // 3. Add article to all matching stories
    for (const storyId of matchedStoryIds) {
      await _addArticleToStory(storyId, article.id, tenantId);
    }

    // 4. Auto-create a new story when no match found but enough articles share the tag
    if (matchedStoryIds.size === 0) {
      const siblings = await db.prepare(`
        SELECT id FROM articles
        WHERE tenant_id = $1
          AND topic_tag = $2
          AND id != $3
          AND is_published = 1
          AND (is_archived = 0 OR is_archived IS NULL)
        LIMIT $4
      `).all(tenantId, tag, article.id, MIN_ARTICLES_TO_CREATE).catch(() => []);

      if (siblings.length >= MIN_ARTICLES_TO_CREATE) {
        const story = await _autoCreateStory(tag, [article, ...siblings], tenantId);
        if (story) {
          _generateStoryNameAndSummary(story, tenantId).catch(() => {});
        }
      }
    } else {
      // Regenerate summaries for affected stories (throttled — at most once per story per hour)
      for (const storyId of matchedStoryIds) {
        _maybeRegenerateSummary(storyId, tenantId).catch(() => {});
      }
    }
  } catch (err) {
    console.error('[story-timelines] detectAndAssignStories failed:', err.message);
  }
}

/**
 * Fetch a single story with its articles for the public page.
 * Articles are returned in chronological order for the timeline view.
 */
async function getStory(tenantId, slug) {
  const story = await db.prepare(
    'SELECT * FROM story_timelines WHERE tenant_id = $1 AND slug = $2'
  ).get(tenantId, slug).catch(() => null);
  if (!story) return null;

  const articles = await _fetchStoryArticles(tenantId, story.id);
  const intensity = await _coverageIntensity(tenantId, story.id);
  return { ...story, articles, intensity };
}

/**
 * Fetch a single story by ID (admin use).
 */
async function getStoryById(tenantId, storyId) {
  const story = await db.prepare(
    'SELECT * FROM story_timelines WHERE tenant_id = $1 AND id = $2'
  ).get(tenantId, storyId).catch(() => null);
  if (!story) return null;
  const articles = await _fetchStoryArticles(tenantId, storyId);
  const intensity = await _coverageIntensity(tenantId, storyId);
  return { ...story, articles, intensity };
}

/**
 * List stories (public — active only; admin — any status).
 */
async function listStories(tenantId, opts = {}) {
  const {
    status    = ['active'],
    limit     = 20,
    offset    = 0,
    withCover = true,
  } = opts;

  const statuses = Array.isArray(status) ? status : [status];
  const lim = Math.min(Math.max(parseInt(limit) || 20, 1), 100);
  const off = Math.max(parseInt(offset) || 0, 0);

  const rows = await db.prepare(`
    SELECT st.*,
           a.slug          AS cover_slug,
           a.generated_title AS cover_title,
           a.title         AS cover_title_raw,
           a.image_url     AS cover_image_url,
           a.published_at  AS cover_published_at
    FROM story_timelines st
    LEFT JOIN articles a ON a.id = st.cover_article_id AND a.tenant_id = st.tenant_id
    WHERE st.tenant_id = $1
      AND st.status    = ANY($2::text[])
    ORDER BY st.last_activity_at DESC
    LIMIT $3 OFFSET $4
  `).all(tenantId, statuses, lim, off).catch(() => []);

  const total = await db.prepare(
    `SELECT COUNT(*)::int AS cnt FROM story_timelines WHERE tenant_id = $1 AND status = ANY($2::text[])`
  ).get(tenantId, statuses).catch(() => ({ cnt: 0 }));

  return {
    stories:    rows.map(_serializeStory),
    totalCount: total?.cnt || 0,
    hasMore:    off + lim < (total?.cnt || 0),
  };
}

/**
 * Create a story manually (editor-initiated).
 */
async function createStory(tenantId, { name, summary, articleIds = [] }) {
  if (!name?.trim()) throw new Error('name is required');
  const slug = await _uniqueSlug(tenantId, name);
  const story = await db.prepare(`
    INSERT INTO story_timelines (tenant_id, name, slug, summary, status, article_count)
    VALUES ($1, $2, $3, $4, 'active', $5)
    RETURNING *
  `).get(tenantId, name.trim().slice(0, 300), slug, summary || null, articleIds.length);

  for (const aid of articleIds) {
    await _addArticleToStory(story.id, aid, tenantId).catch(() => {});
  }
  if (articleIds.length) await _updateCoverArticle(story.id, tenantId).catch(() => {});
  return story;
}

/**
 * Update story metadata.
 */
async function updateStory(tenantId, storyId, patch = {}) {
  const sets   = [];
  const params = [tenantId, storyId];

  if (patch.name != null) {
    params.push(String(patch.name).slice(0, 300));
    sets.push(`name = $${params.length}`);
  }
  if (patch.summary != null) {
    params.push(String(patch.summary));
    sets.push(`summary = $${params.length}`);
  }
  if (patch.status != null) {
    const valid = ['active', 'dormant', 'archived'];
    if (!valid.includes(patch.status)) throw new Error('invalid status');
    params.push(patch.status);
    sets.push(`status = $${params.length}`);
    if (patch.status === 'archived') sets.push('archived_at = NOW()');
    else                              sets.push('archived_at = NULL');
  }
  if (!sets.length) return getStoryById(tenantId, storyId);

  sets.push('updated_at = NOW()');
  return db.prepare(
    `UPDATE story_timelines SET ${sets.join(', ')} WHERE tenant_id = $1 AND id = $2 RETURNING *`
  ).get(...params).catch(err => {
    console.error('[story-timelines] updateStory failed:', err.message);
    return null;
  });
}

/**
 * Add an article to a story manually.
 */
async function addArticleToStory(storyId, articleId, tenantId, { isKeyMoment = false } = {}) {
  await _addArticleToStory(storyId, articleId, tenantId, isKeyMoment);
  await _updateCoverArticle(storyId, tenantId).catch(() => {});
}

/**
 * Remove an article from a story.
 */
async function removeArticleFromStory(storyId, articleId, tenantId) {
  await db.prepare(
    'DELETE FROM story_timeline_articles WHERE story_id = $1 AND article_id = $2 AND tenant_id = $3'
  ).run(storyId, articleId, tenantId).catch(() => {});
  await _recount(storyId, tenantId);
  await _updateCoverArticle(storyId, tenantId).catch(() => {});
}

/**
 * Toggle is_key_moment flag on an article within a story.
 */
async function setKeyMoment(storyId, articleId, tenantId, isKeyMoment) {
  await db.prepare(
    'UPDATE story_timeline_articles SET is_key_moment = $1 WHERE story_id = $2 AND article_id = $3 AND tenant_id = $4'
  ).run(!!isKeyMoment, storyId, articleId, tenantId).catch(() => {});
}

/**
 * Lifecycle cron — flip active → dormant → archived on inactivity.
 * Returns { dormanted, archived }.
 */
async function runLifecycle(tenantId) {
  const dormanted = await db.prepare(`
    UPDATE story_timelines
    SET status = 'dormant', updated_at = NOW()
    WHERE tenant_id = $1
      AND status = 'active'
      AND last_activity_at < NOW() - make_interval(days => $2)
    RETURNING id
  `).all(tenantId, DORMANT_DAYS).catch(() => []);

  const archived = await db.prepare(`
    UPDATE story_timelines
    SET status = 'archived', archived_at = NOW(), updated_at = NOW()
    WHERE tenant_id = $1
      AND status = 'dormant'
      AND last_activity_at < NOW() - make_interval(days => $2)
    RETURNING id
  `).all(tenantId, ARCHIVE_DAYS).catch(() => []);

  return { dormanted: dormanted.length, archived: archived.length };
}

/**
 * (Re)generate Maxwell name + summary for a story.
 * Used by admin "Regenerate" action and auto-called after story creation.
 */
async function generateStoryNameAndSummary(storyId, tenantId) {
  return _generateStoryNameAndSummary({ id: storyId }, tenantId);
}

/**
 * Backfill — cluster existing published articles into stories by topic_tag.
 * Skips topic_tags that already have a story. Returns { created, skipped, errors }.
 */
async function backfill(tenantId, { dryRun = false } = {}) {
  const stats = { created: 0, skipped: 0, errors: 0, stories: [] };

  // Find topic_tags with enough articles (published originals OR curated sources) that have no story yet
  const tags = await db.prepare(`
    SELECT a.topic_tag, COUNT(*) AS cnt,
           array_agg(a.id ORDER BY a.published_at ASC) AS article_ids
    FROM articles a
    WHERE a.tenant_id = $1
      AND a.topic_tag IS NOT NULL
      AND a.topic_tag != ''
      AND (a.is_published = 1 OR a.content_type = 'curated')
      AND (a.is_archived = 0 OR a.is_archived IS NULL)
    GROUP BY a.topic_tag
    HAVING COUNT(*) >= $2
  `).all(tenantId, MIN_ARTICLES_TO_CREATE + 1).catch(() => []);

  for (const row of tags) {
    // Skip if a story already covers this tag
    const existing = await db.prepare(`
      SELECT DISTINCT sta.story_id FROM story_timeline_articles sta
      JOIN articles a ON a.id = sta.article_id AND a.tenant_id = sta.tenant_id
      WHERE sta.tenant_id = $1 AND a.topic_tag = $2 LIMIT 1
    `).get(tenantId, row.topic_tag).catch(() => null);

    if (existing) { stats.skipped++; continue; }

    if (dryRun) {
      stats.stories.push({ tag: row.topic_tag, count: parseInt(row.cnt) });
      stats.created++;
      continue;
    }

    try {
      const articleRows = await db.prepare(`
        SELECT id, topic_tag FROM articles WHERE id = ANY($1::int[]) AND tenant_id = $2
      `).all(row.article_ids, tenantId).catch(() => []);

      if (articleRows.length < MIN_ARTICLES_TO_CREATE + 1) { stats.skipped++; continue; }

      const story = await _autoCreateStory(row.topic_tag, articleRows, tenantId);
      if (story) {
        stats.created++;
        stats.stories.push({ id: story.id, slug: story.slug, tag: row.topic_tag, count: articleRows.length });
        _generateStoryNameAndSummary(story, tenantId).catch(() => {});
      }
    } catch (err) {
      console.error('[story-timelines] backfill error for tag', row.topic_tag, err.message);
      stats.errors++;
    }
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function _autoCreateStory(tag, articles, tenantId) {
  try {
    const name = _humanizeTag(tag);
    const slug = await _uniqueSlug(tenantId, name);
    const firstArticle = articles.reduce((a, b) =>
      new Date(a.published_at || 0) < new Date(b.published_at || 0) ? a : b
    , articles[0]);

    const story = await db.prepare(`
      INSERT INTO story_timelines
        (tenant_id, name, slug, status, article_count, cover_article_id, last_activity_at)
      VALUES ($1, $2, $3, 'active', $4, $5, NOW())
      RETURNING *
    `).get(tenantId, name, slug, articles.length, firstArticle?.id || null);

    for (const a of articles) {
      await db.prepare(`
        INSERT INTO story_timeline_articles (story_id, article_id, tenant_id)
        VALUES ($1, $2, $3) ON CONFLICT DO NOTHING
      `).run(story.id, a.id, tenantId).catch(() => {});
    }
    await _updateCoverArticle(story.id, tenantId).catch(() => {});
    return story;
  } catch (err) {
    console.error('[story-timelines] _autoCreateStory failed:', err.message);
    return null;
  }
}

async function _addArticleToStory(storyId, articleId, tenantId, isKeyMoment = false) {
  await db.prepare(`
    INSERT INTO story_timeline_articles (story_id, article_id, tenant_id, is_key_moment)
    VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING
  `).run(storyId, articleId, tenantId, isKeyMoment).catch(() => {});
  await _recount(storyId, tenantId);
  await db.prepare(`
    UPDATE story_timelines SET last_activity_at = NOW(), status = CASE
      WHEN status = 'archived' THEN 'active'
      WHEN status = 'dormant'  THEN 'active'
      ELSE status
    END WHERE id = $1 AND tenant_id = $2
  `).run(storyId, tenantId).catch(() => {});
}

async function _recount(storyId, tenantId) {
  await db.prepare(`
    UPDATE story_timelines
    SET article_count = (
      SELECT COUNT(*) FROM story_timeline_articles
      WHERE story_id = $1 AND tenant_id = $2
    )
    WHERE id = $1 AND tenant_id = $2
  `).run(storyId, tenantId).catch(() => {});
}

async function _updateCoverArticle(storyId, tenantId) {
  // Cover = most recent article in the story that has an image
  const cover = await db.prepare(`
    SELECT a.id FROM articles a
    JOIN story_timeline_articles sta ON sta.article_id = a.id
    WHERE sta.story_id = $1 AND sta.tenant_id = $2
      AND a.image_url IS NOT NULL AND a.image_url != ''
    ORDER BY a.published_at DESC LIMIT 1
  `).get(storyId, tenantId).catch(() => null);

  if (cover) {
    await db.prepare(
      'UPDATE story_timelines SET cover_article_id = $1 WHERE id = $2 AND tenant_id = $3'
    ).run(cover.id, storyId, tenantId).catch(() => {});
  }
}

async function _fetchStoryArticles(tenantId, storyId) {
  return db.prepare(`
    SELECT a.id, a.slug, a.title, a.generated_title, a.tldr_overview, a.summary,
           a.image_url, a.category, a.importance, a.content_type, a.source, a.source_url,
           a.published_at, a.writer_id,
           w.name AS writer_name, w.slug AS writer_slug, w.avatar_url AS writer_avatar,
           sta.is_key_moment, sta.added_at
    FROM story_timeline_articles sta
    JOIN articles a ON a.id = sta.article_id AND a.tenant_id = sta.tenant_id
    LEFT JOIN writers w ON w.id = a.writer_id AND w.tenant_id = a.tenant_id
    WHERE sta.story_id  = $1
      AND sta.tenant_id = $2
      AND (a.is_archived = 0 OR a.is_archived IS NULL)
    ORDER BY a.published_at ASC
  `).all(storyId, tenantId).catch(() => []);
}

async function _coverageIntensity(tenantId, storyId) {
  // Daily article counts for the past 60 days — used for the sparkline
  return db.prepare(`
    SELECT DATE(a.published_at)::text AS date, COUNT(*)::int AS count
    FROM story_timeline_articles sta
    JOIN articles a ON a.id = sta.article_id AND a.tenant_id = sta.tenant_id
    WHERE sta.story_id  = $1
      AND sta.tenant_id = $2
      AND a.published_at >= NOW() - INTERVAL '60 days'
    GROUP BY DATE(a.published_at)
    ORDER BY date ASC
  `).all(storyId, tenantId).catch(() => []);
}

// Rate-limit summary regeneration: at most once per story per 60 minutes
const _lastRegenerated = new Map();
async function _maybeRegenerateSummary(storyId, tenantId) {
  const key = `${tenantId}:${storyId}`;
  const last = _lastRegenerated.get(key) || 0;
  if (Date.now() - last < 60 * 60 * 1000) return;
  _lastRegenerated.set(key, Date.now());
  return _generateStoryNameAndSummary({ id: storyId }, tenantId);
}

async function _generateStoryNameAndSummary(story, tenantId) {
  try {
    const { complete: aiComplete } = require('./ai-router');
    const { loadPrompt }           = require('./prompt-loader');
    const { canSpend }             = require('./budget');

    const budget = await canSpend('summary', tenantId);
    if (!budget.allowed) return;

    // Fetch a sample of articles for context
    const articles = await db.prepare(`
      SELECT a.title, a.generated_title, a.tldr_overview, a.summary, a.published_at
      FROM story_timeline_articles sta
      JOIN articles a ON a.id = sta.article_id AND a.tenant_id = sta.tenant_id
      WHERE sta.story_id = $1 AND sta.tenant_id = $2
        AND (a.is_published = 1 OR a.content_type = 'curated')
      ORDER BY a.published_at ASC LIMIT 15
    `).all(story.id, tenantId).catch(() => []);
    if (!articles.length) return;

    const p = loadPrompt('story-name');
    const articleSummaries = articles.map((a, i) =>
      `${i + 1}. [${new Date(a.published_at).toLocaleDateString()}] ${a.generated_title || a.title}: ${(a.tldr_overview || a.summary || '').slice(0, 150)}`
    ).join('\n');

    const { messages } = p.render({ articleSummaries, count: articles.length });
    const result = await aiComplete({
      operation:   'summary',
      tenantId,
      messages:    [{ role: 'user', content: messages[0].content }],
      temperature: 0.4,
      maxTokens:   400,
      trigger:     'story-timeline',
    });

    if (!result?.text) return;
    const cleaned = result.text.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
    const parsed  = JSON.parse(cleaned);

    const updates = {};
    if (parsed.name)    updates.name    = parsed.name.slice(0, 300);
    if (parsed.summary) updates.summary = parsed.summary;

    if (Object.keys(updates).length) {
      const current = await db.prepare(
        'SELECT name FROM story_timelines WHERE id = $1 AND tenant_id = $2'
      ).get(story.id, tenantId).catch(() => null);

      const sets   = [];
      const params = [tenantId, story.id];
      if (updates.name && current) {
        params.push(updates.name);
        sets.push(`name = $${params.length}`);
        // Re-slug only if name changes significantly (avoids breaking existing URLs)
        if (current.name !== updates.name) {
          const newSlug = await _uniqueSlug(tenantId, updates.name, story.id);
          params.push(newSlug);
          sets.push(`slug = $${params.length}`);
        }
      }
      if (updates.summary) {
        params.push(updates.summary);
        sets.push(`summary = $${params.length}`);
      }
      if (sets.length) {
        await db.prepare(
          `UPDATE story_timelines SET ${sets.join(', ')} WHERE tenant_id = $1 AND id = $2`
        ).run(...params).catch(() => {});
      }
    }
  } catch (err) {
    console.error('[story-timelines] _generateStoryNameAndSummary failed:', err.message);
  }
}

// Public alias used by route
const _generateStoryNameAndSummaryPublic = _generateStoryNameAndSummary;

async function _uniqueSlug(tenantId, name, excludeId = null) {
  let base    = toSlug(name);
  let slug    = base;
  let attempt = 1;
  while (true) {
    const params = [tenantId, slug];
    let sql = 'SELECT id FROM story_timelines WHERE tenant_id = $1 AND slug = $2';
    if (excludeId) { params.push(excludeId); sql += ` AND id != $${params.length}`; }
    const existing = await db.prepare(sql).get(...params).catch(() => null);
    if (!existing) return slug;
    slug = `${base}-${++attempt}`;
  }
}

function _humanizeTag(tag) {
  return String(tag || '').split('-').filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function _serializeStory(row) {
  return {
    id:              row.id,
    name:            row.name,
    slug:            row.slug,
    summary:         row.summary,
    status:          row.status,
    articleCount:    row.article_count,
    lastActivityAt:  row.last_activity_at,
    createdAt:       row.created_at,
    archivedAt:      row.archived_at,
    cover: row.cover_article_id ? {
      articleId:   row.cover_article_id,
      slug:        row.cover_slug,
      title:       row.cover_title || row.cover_title_raw,
      imageUrl:    row.cover_image_url,
      publishedAt: row.cover_published_at,
    } : null,
  };
}

async function deleteStory(tenantId, storyId) {
  await db.prepare(
    'DELETE FROM story_timeline_articles WHERE story_id = $1 AND tenant_id = $2'
  ).run(storyId, tenantId).catch(() => {});
  const result = await db.prepare(
    'DELETE FROM story_timelines WHERE id = $1 AND tenant_id = $2 RETURNING id'
  ).get(storyId, tenantId).catch(() => null);
  return !!result;
}

module.exports = {
  detectAndAssignStories,
  getStory,
  getStoryById,
  listStories,
  createStory,
  updateStory,
  deleteStory,
  addArticleToStory,
  removeArticleFromStory,
  setKeyMoment,
  generateStoryNameAndSummary,
  runLifecycle,
  backfill,
};
