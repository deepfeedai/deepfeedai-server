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
const publication = require('./story-publication');
const { toSlug } = require('./utils');

const SIMILARITY_THRESHOLD  = 0.78;
const MIN_ARTICLES_TO_CREATE = 2;  // require ≥2 sibling articles before auto-creating a story
const DORMANT_DAYS  = 7;
const ARCHIVE_DAYS  = 14;
const REGEN_MAP_MAX = 2000;        // max in-process throttle entries before eviction

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
    let tagMatches = [];
    try {
      tagMatches = await db.prepare(`
        SELECT DISTINCT sta.story_id
        FROM story_timeline_articles sta
        JOIN articles a ON a.id = sta.article_id AND a.tenant_id = sta.tenant_id
        WHERE sta.tenant_id = $1
          AND a.topic_tag   = $2
          AND sta.article_id != $3
      `).all(tenantId, tag, article.id);
    } catch (err) {
      console.error('[story-timelines] tag-match query failed:', err.message);
    }

    // 2. Embedding-based matches (when available)
    let embeddingMatches = [];
    if (article.embedding) {
      try {
        embeddingMatches = await db.prepare(`
          SELECT DISTINCT sta.story_id
          FROM story_timeline_articles sta
          JOIN articles a ON a.id = sta.article_id AND a.tenant_id = sta.tenant_id
          WHERE sta.tenant_id = $1
            AND sta.article_id != $2
            AND a.embedding IS NOT NULL
            AND 1 - (a.embedding <=> $3::vector) > $4
        `).all(tenantId, article.id, article.embedding, SIMILARITY_THRESHOLD);
      } catch (err) {
        console.error('[story-timelines] embedding-match query failed:', err.message);
      }
    }

    const matchedStoryIds = new Set([
      ...tagMatches.map(r => r.story_id),
      ...embeddingMatches.map(r => r.story_id),
    ]);

    // 3. Add article to all matching stories
    for (const storyId of matchedStoryIds) {
      try {
        await _addArticleToStory(storyId, article.id, tenantId);
      } catch (err) {
        console.error(`[story-timelines] addArticleToStory(${storyId}) failed:`, err.message);
      }
    }

    // 4. Auto-create a new story when no match found but enough articles share the tag
    if (matchedStoryIds.size === 0) {
      try {
        const siblings = await db.prepare(`
          SELECT id FROM articles
          WHERE tenant_id = $1
            AND topic_tag = $2
            AND id != $3
            AND is_published = 1
            AND (is_archived = 0 OR is_archived IS NULL)
          LIMIT $4
        `).all(tenantId, tag, article.id, MIN_ARTICLES_TO_CREATE);

        if (siblings.length >= MIN_ARTICLES_TO_CREATE) {
          const story = await _autoCreateStory(tag, [article, ...siblings], tenantId);
          if (story) {
            // Naming is an explicit paid editor action.
          }
        }
      } catch (err) {
        console.error('[story-timelines] auto-create story failed:', err.message);
      }
    } else {
      // Regenerate summaries for affected stories (throttled — at most once per story per hour)
      for (const storyId of matchedStoryIds) {
        // Existing stories retain their summary until an editor regenerates it.
      }
    }
  } catch (err) {
    console.error('[story-timelines] detectAndAssignStories unexpected error:', err.message);
  }
}

/**
 * Fetch a single story with its articles for the public page.
 * Articles are returned in chronological order for the timeline view.
 */
async function getStory(tenantId, slug) {
  const story = await db.prepare(
    `SELECT * FROM ${publication.projection} st WHERE tenant_id = $1 AND slug = $2`
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
  const projection = await db.prepare(`SELECT * FROM ${publication.projection} st WHERE id=$1 AND tenant_id=$2`).get(storyId,tenantId);
  const aiJob = await require('./story-ai').latest(tenantId,storyId);
  const intensity = await _coverageIntensity(tenantId, storyId);
  return { ...story, article_count:projection.article_count, cover_article_id:projection.cover_article_id, image_url:projection.image_url, articles, intensity, aiJob };
}

/**
 * List stories (public — active only; admin — any status).
 */
async function listStories(tenantId, opts = {}) {
  const {
    status    = ['active'],
    limit     = 20,
    offset    = 0,
    search    = null,
    category  = null,
  } = opts;

  const statuses = Array.isArray(status) ? status : [status];
  const lim = Math.min(Math.max(parseInt(limit) || 20, 1), 100);
  const off = Math.max(parseInt(offset) || 0, 0);

  const baseParams = [tenantId, statuses];
  let searchClause = '';
  if (search?.trim()) {
    baseParams.push(`%${search.trim()}%`);
    searchClause = `AND (st.name ILIKE $${baseParams.length} OR st.summary ILIKE $${baseParams.length})`;
  }

  let categoryClause = '';
  if (category?.trim()) {
    baseParams.push(category.trim());
    categoryClause = `AND EXISTS (
      SELECT 1 FROM story_timeline_articles _sta
      JOIN articles _a ON _a.id = _sta.article_id AND _a.tenant_id = _sta.tenant_id
      WHERE _sta.story_id = st.id AND _sta.tenant_id = st.tenant_id
        AND ${publication.eligible('_a')} AND _a.category = $${baseParams.length}
    )`;
  }

  const rows = await db.prepare(`
    SELECT st.*,
           a.slug            AS cover_slug,
           a.generated_title AS cover_title,
           a.title           AS cover_title_raw,
           a.image_url       AS cover_image_url,
           a.published_at    AS cover_published_at,
           a.category        AS cover_category,
           (
             SELECT COUNT(*)::int FROM story_timeline_articles _sta2
             JOIN articles _a2 ON _a2.id = _sta2.article_id AND _a2.tenant_id = _sta2.tenant_id
             WHERE _sta2.story_id = st.id AND _sta2.tenant_id = st.tenant_id
               AND ${publication.eligible('_a2')} AND _a2.published_at >= NOW() - INTERVAL '24 hours'
           ) AS recent_article_count,
           (
             SELECT COUNT(DISTINCT _a3.writer_id)::int FROM story_timeline_articles _sta3
             JOIN articles _a3 ON _a3.id = _sta3.article_id AND _a3.tenant_id = _sta3.tenant_id
             WHERE _sta3.story_id = st.id AND _sta3.tenant_id = st.tenant_id
               AND ${publication.eligible('_a3')} AND _a3.writer_id IS NOT NULL
           ) AS writer_count
    FROM ${publication.projection} st
    LEFT JOIN articles a ON a.id = st.cover_article_id AND a.tenant_id = st.tenant_id
    WHERE st.tenant_id = $1
      AND st.status    = ANY($2::text[])
      ${searchClause}
      ${categoryClause}
    ORDER BY st.last_activity_at DESC, st.id DESC
    LIMIT $${baseParams.length + 1} OFFSET $${baseParams.length + 2}
  `).all(...baseParams, lim, off).catch((err) => {
    console.error('[story-timelines] listStories query failed:', err.message);
    return [];
  });

  const total = await db.prepare(`
    SELECT COUNT(*)::int AS cnt FROM ${publication.projection} st
    WHERE st.tenant_id = $1 AND st.status = ANY($2::text[]) ${searchClause} ${categoryClause}
  `).get(...baseParams).catch((err) => {
    console.error('[story-timelines] listStories count failed:', err.message);
    return { cnt: 0 };
  });

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
  if (!name?.trim()) throw publication.invalid('name is required');
  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');
    // Serialize slug allocation inside this tenant, without locking other tenants.
    await client.query('SELECT pg_advisory_xact_lock(73412, $1)', [tenantId]);
    const ids = await publication.validateArticles(client, tenantId, articleIds);
    const slug = await _uniqueSlug(tenantId, name, null, client);
    const { rows: [story] } = await client.query(`INSERT INTO story_timelines
      (tenant_id,name,slug,summary,status) VALUES($1,$2,$3,$4,'active') RETURNING *`,
      [tenantId,name.trim().slice(0,300),slug,summary || null]);
    for (const id of ids) await client.query(`INSERT INTO story_timeline_articles
      (story_id,article_id,tenant_id) VALUES($1,$2,$3)`, [story.id,id,tenantId]);
    await publication.refresh(client,story.id,tenantId);
    if (summary) await client.query('UPDATE story_timelines SET summary_article_ids=$1 WHERE id=$2 AND tenant_id=$3',[ids.sort((a,b)=>a-b),story.id,tenantId]);
    const {rows:[updated]} = await client.query('SELECT * FROM story_timelines WHERE id=$1 AND tenant_id=$2',[story.id,tenantId]);
    await client.query('COMMIT'); return updated;
  } catch(error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
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
    sets.push(`summary_article_ids = (SELECT COALESCE(array_agg(a.id ORDER BY a.id), '{}'::int[]) FROM story_timeline_articles l JOIN articles a ON a.id=l.article_id AND a.tenant_id=l.tenant_id WHERE l.story_id=$2 AND l.tenant_id=$1 AND ${publication.eligible('a')})`);
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
  return publication.changeLinks(db.getPool(),storyId,tenantId,async client => {
    await client.query('DELETE FROM story_timeline_articles WHERE story_id=$1 AND article_id=$2 AND tenant_id=$3',[storyId,articleId,tenantId]);
  });
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
  // Use interval arithmetic directly — make_interval(days => $2) fails silently
  // in some pg versions when named-argument syntax meets a positional placeholder.
  const dormanted = await db.prepare(`
    UPDATE story_timelines
    SET status = 'dormant', updated_at = NOW()
    WHERE tenant_id = $1
      AND status = 'active'
      AND last_activity_at < NOW() - ($2::int * INTERVAL '1 day')
    RETURNING id
  `).all(tenantId, DORMANT_DAYS).catch((err) => {
    console.error('[story-timelines] lifecycle dormant failed:', err.message);
    return [];
  });

  const archived = await db.prepare(`
    UPDATE story_timelines
    SET status = 'archived', archived_at = NOW(), updated_at = NOW()
    WHERE tenant_id = $1
      AND status = 'dormant'
      AND last_activity_at < NOW() - ($2::int * INTERVAL '1 day')
    RETURNING id
  `).all(tenantId, ARCHIVE_DAYS).catch((err) => {
    console.error('[story-timelines] lifecycle archive failed:', err.message);
    return [];
  });

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
      AND (${publication.eligible('a')})
      AND ${publication.eligible('a')}
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
        // Naming is an explicit paid editor action.
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
  return createStory(tenantId, {name:_humanizeTag(tag),articleIds:articles.map(a=>a.id)});
}

async function _addArticleToStory(storyId, articleId, tenantId, isKeyMoment = false) {
  const inserted = await publication.changeLinks(db.getPool(),storyId,tenantId,async client => {
    await publication.validateArticles(client,tenantId,[articleId]);
    const result = await client.query(`INSERT INTO story_timeline_articles
      (story_id,article_id,tenant_id,is_key_moment) VALUES($1,$2,$3,$4)
      ON CONFLICT DO NOTHING RETURNING article_id`,[storyId,articleId,tenantId,isKeyMoment]);
    if(result.rowCount) await client.query(`UPDATE story_timelines SET last_activity_at=NOW(),
      status='active',archived_at=NULL WHERE id=$1 AND tenant_id=$2`,[storyId,tenantId]);
    return result.rowCount > 0;
  });
  if (!inserted) return;
  // Notify story followers (fire-and-forget)
  setImmediate(() => {
    (async () => {
      try {
        const { notify } = require('./notifications');
        const story = await db.prepare(
          'SELECT name, slug FROM story_timelines WHERE id = $1 AND tenant_id = $2'
        ).get(storyId, tenantId).catch(() => null);
        const article = await db.prepare(
          'SELECT title, generated_title, slug FROM articles WHERE id = $1 AND tenant_id = $2'
        ).get(articleId, tenantId).catch(() => null);
        if (!story || !article) return;

        // Newsroom Glass — public live feed event
        const { recordEvent } = require('./newsroom-events');
        recordEvent({
          tenantId, type: 'story_updated',
          targetArticleId: articleId,
          isPublic: true,
          headline: `Developing: new source added to "${(story.name || '').slice(0, 120)}"`,
          entitySlug: story.slug || null,
          payload: { story_name: story.name, story_slug: story.slug, article_title: article.generated_title || article.title },
        }).catch(() => {});

        const followers = await db.prepare(
          'SELECT user_id FROM user_story_follows WHERE story_id = $1 AND tenant_id = $2'
        ).all(storyId, tenantId).catch(() => []);
        if (!followers.length) return;
        const articleTitle = article.generated_title || article.title;
        for (const f of followers) {
          notify({
            tenantId,
            userId: f.user_id,
            kind: 'story_article_added',
            title: story.name,
            body: articleTitle,
            payload: { story_id: storyId, story_slug: story.slug, article_id: articleId, article_slug: article.slug },
            actionable: [
              { label: 'Read article', actionKind: 'article.open', targetId: articleId, targetType: 'article' },
            ],
          }).catch(() => {});
        }
      } catch { /* non-fatal */ }
    })();
  });
}

async function _recount(storyId, tenantId) {
  return publication.refresh(db.getPool(),storyId,tenantId);
}
async function _updateCoverArticle(storyId, tenantId) {
  return publication.refresh(db.getPool(),storyId,tenantId);
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
      AND ${publication.eligible('a')}
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
      AND ${publication.eligible('a')} AND a.published_at >= NOW() - INTERVAL '60 days'
    GROUP BY DATE(a.published_at)
    ORDER BY date ASC
  `).all(storyId, tenantId).catch(() => []);
}

// Rate-limit summary regeneration: at most once per story per 60 minutes.
// Map is bounded to REGEN_MAP_MAX entries — evict oldest half when full.
const _lastRegenerated = new Map();
async function _maybeRegenerateSummary(storyId, tenantId) {
  const key = `${tenantId}:${storyId}`;
  const last = _lastRegenerated.get(key) || 0;
  if (Date.now() - last < 60 * 60 * 1000) return;
  if (_lastRegenerated.size >= REGEN_MAP_MAX) {
    const half = Math.floor(REGEN_MAP_MAX / 2);
    let evicted = 0;
    for (const k of _lastRegenerated.keys()) {
      _lastRegenerated.delete(k);
      if (++evicted >= half) break;
    }
  }
  _lastRegenerated.set(key, Date.now());
  return _generateStoryNameAndSummary({ id: storyId }, tenantId);
}

async function _generateStoryNameAndSummary(story, tenantId) {
  const logId = `story#${story.id}`;
  try {
    const { complete: aiComplete } = require('./ai-router');
    const { loadPrompt }           = require('./prompt-loader');
    const { canSpend }             = require('./budget');

    const budget = await canSpend('summary', tenantId);
    if (!budget.allowed) {
      console.warn(`[story-timelines] ${logId} budget blocked: ${budget.reason}`);
      return {state:'skipped', message:'Budget limit reached'};
    }

    // Fetch current name up-front — used for the generic-name rejection check
    // and later for slug re-generation. The initial placeholder is always _humanizeTag(tag).
    const current = await db.prepare(
      'SELECT name FROM story_timelines WHERE id = $1 AND tenant_id = $2'
    ).get(story.id, tenantId).catch(() => null);

    // Fetch a sample of articles for context
    const articles = await db.prepare(`
      SELECT a.id, a.title, a.generated_title, a.tldr_overview, a.summary, a.published_at
      FROM story_timeline_articles sta
      JOIN articles a ON a.id = sta.article_id AND a.tenant_id = sta.tenant_id
      WHERE sta.story_id = $1 AND sta.tenant_id = $2
        AND (${publication.eligible('a')})
      ORDER BY a.published_at ASC
    `).all(story.id, tenantId).catch(() => []);
    if (!articles.length) {
      console.warn(`[story-timelines] ${logId} no qualifying articles found`);
      return {state:'skipped', message:'No published articles available'};
    }

    const p = loadPrompt('story-name');
    const articleSummaries = articles.slice(0, 15).map((a, i) =>
      `${i + 1}. [${new Date(a.published_at).toLocaleDateString()}] ${a.generated_title || a.title}: ${(a.tldr_overview || a.summary || '').slice(0, 150)}`
    ).join('\n');

    const { messages } = p.render({ articleSummaries, count: articles.length });
    const result = await aiComplete({
      operation:      'summary',
      tenantId,
      messages:       [{ role: 'user', content: messages[0].content }],
      temperature:    0.4,
      maxTokens:      1000,
      thinkingBudget: 0,   // disable thinking — story naming doesn't need it and it eats the token budget
      trigger:        'story-timeline',
    });

    if (!result?.text) {
      console.warn(`[story-timelines] ${logId} AI returned no text`);
      throw new Error('Empty AI response');
    }
    const cleaned = result.text.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
    const parsed  = JSON.parse(cleaned);

    const updates = {};
    if (typeof parsed.name === 'string') {
      const candidate = parsed.name.slice(0, 300).trim();
      // Reject if the AI returned essentially the same name as the existing placeholder
      // (i.e. it didn't actually produce a specific story name).
      // `current` was fetched above and holds the humanized tag placeholder.
      const placeholder = (current?.name || '').toLowerCase().replace(/[^a-z0-9 ]/g, '');
      const isGeneric = !candidate
        || (placeholder.length > 3 && candidate.toLowerCase().replace(/[^a-z0-9 ]/g, '') === placeholder)
        || candidate.split(/\s+/).length < 3; // fewer than 3 words is a topic, not a story name
      if (isGeneric) {
        console.warn(`[story-timelines] ${logId} rejected generic name: "${candidate}"`);
      } else {
        updates.name = candidate;
      }
    } else {
      console.warn(`[story-timelines] ${logId} AI returned null name (articles don't form a specific story)`);
    }
    if (typeof parsed.summary === 'string' && parsed.summary.trim()) updates.summary = parsed.summary.trim().slice(0, 10000);

    if (Object.keys(updates).length) {
      const sets   = [];
      const params = [tenantId, story.id];
      if (updates.name && current) {
        params.push(updates.name);
        sets.push(`name = $${params.length}`);
        // Keep the original slug: existing reader links are permanent.
      }
      if (updates.summary) {
        params.push(updates.summary);
        sets.push(`summary = $${params.length}`);
        params.push(articles.map(a=>a.id).sort((a,b)=>a-b));
        sets.push(`summary_article_ids = $${params.length}::int[]`);
      }
      if (sets.length) {
        console.log(`[story-timelines] ${logId} updated: ${sets.join(', ')} → name="${updates.name}"`);
        await db.prepare(
          `UPDATE story_timelines SET ${sets.join(', ')} WHERE tenant_id = $1 AND id = $2`
        ).run(...params);
      }
    } else {
      console.warn(`[story-timelines] ${logId} no updates to apply (name="${parsed.name}", summary=${!!parsed.summary})`);
    }
    return {state: Object.keys(updates).length ? 'ready' : 'skipped', message: Object.keys(updates).length ? 'Name and summary updated' : 'No changes suggested'};
  } catch (err) {
    throw err;
  }
}

// Public alias used by route
const _generateStoryNameAndSummaryPublic = _generateStoryNameAndSummary;

async function _uniqueSlug(tenantId, name, excludeId = null, client = null) {
  let base    = toSlug(name);
  let slug    = base;
  let attempt = 1;
  while (true) {
    const params = [tenantId, slug];
    let sql = 'SELECT id FROM story_timelines WHERE tenant_id = $1 AND slug = $2';
    if (excludeId) { params.push(excludeId); sql += ` AND id != $${params.length}`; }
    const existing = client ? (await client.query(sql,params)).rows[0] : await db.prepare(sql).get(...params);
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
    id:                 row.id,
    name:               row.name,
    slug:               row.slug,
    summary:            row.summary,
    status:             row.status,
    articleCount:       row.article_count,
    recentArticleCount: row.recent_article_count || 0,
    writerCount:        row.writer_count || 0,
    category:           row.cover_category || null,
    imageUrl:           row.image_url || row.cover_image_url || null,
    lastActivityAt:     row.last_activity_at,
    createdAt:          row.created_at,
    archivedAt:         row.archived_at,
    cover: row.cover_article_id ? {
      articleId:   row.cover_article_id,
      slug:        row.cover_slug,
      title:       row.cover_title || row.cover_title_raw,
      imageUrl:    row.cover_image_url,
      publishedAt: row.cover_published_at,
    } : null,
  };
}

/**
 * Sweep articles published/curated within the last `windowHours` that haven't
 * been assigned to any story yet, and run them through detectAndAssignStories.
 * Safe to run nightly — skips articles that already have at least one assignment.
 */
async function retroBackfillUnassigned(tenantId, { windowHours = 48 } = {}) {
  const stats = { processed: 0, assigned: 0, errors: 0 };

  const articles = await db.prepare(`
    SELECT a.id, a.topic_tag, a.title, a.generated_title, a.embedding,
           a.is_published, a.content_type
    FROM articles a
    WHERE a.tenant_id = $1
      AND (${publication.eligible('a')})
      AND ${publication.eligible('a')}
      AND a.topic_tag IS NOT NULL AND a.topic_tag != ''
      AND a.published_at >= NOW() - ($2 || ' hours')::interval
      AND NOT EXISTS (
        SELECT 1 FROM story_timeline_articles sta
        WHERE sta.article_id = a.id AND sta.tenant_id = a.tenant_id
      )
    ORDER BY a.published_at ASC
  `).all(tenantId, windowHours).catch(() => []);

  for (const article of articles) {
    stats.processed++;
    try {
      const before = await db.prepare(
        'SELECT COUNT(*)::int AS cnt FROM story_timeline_articles WHERE article_id = $1 AND tenant_id = $2'
      ).get(article.id, tenantId).catch(() => ({ cnt: 0 }));

      await detectAndAssignStories(article, tenantId);

      const after = await db.prepare(
        'SELECT COUNT(*)::int AS cnt FROM story_timeline_articles WHERE article_id = $1 AND tenant_id = $2'
      ).get(article.id, tenantId).catch(() => ({ cnt: 0 }));

      if ((after?.cnt || 0) > (before?.cnt || 0)) stats.assigned++;
    } catch {
      stats.errors++;
    }
  }

  return stats;
}

async function deleteStory(tenantId, storyId) {
  const pool = db.getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'DELETE FROM story_timeline_articles WHERE story_id = $1 AND tenant_id = $2',
      [storyId, tenantId]
    );
    const result = await client.query(
      'DELETE FROM story_timelines WHERE id = $1 AND tenant_id = $2 RETURNING id',
      [storyId, tenantId]
    );
    await client.query('COMMIT');
    return (result.rowCount || 0) > 0;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
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
  retroBackfillUnassigned,
};
