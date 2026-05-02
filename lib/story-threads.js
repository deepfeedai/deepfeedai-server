/**
 * Deep Feed AI — Story threads.
 *
 * First-class metadata for an ongoing story. Joined to `articles` by
 * (tenant_id, topic_tag). The thread row aggregates:
 *   - article_count, source_count, last_update_at
 *   - lead_article_id (first piece tagged), last_article_id (most recent)
 *   - owner_writer_id (writer who's filed the most pieces)
 *   - status: 'active' | 'dormant' | 'closed'
 *
 * Lifecycle:
 *   1. `upsertThreadOnPublish(article, tenantId)` is called from post-publish
 *      hooks for any original/deep-dive that has a topic_tag.
 *   2. `markDormantThreads(tenantId)` runs on a cron — flips 'active' → 'dormant'
 *      when there's been no new piece in `dormancyDays` (default 14).
 *   3. Editors can manually close a thread when the story has resolved.
 *
 * Pure-DB module — no AI calls. All operations are idempotent and
 * fail-soft (errors logged, never thrown to the publish path).
 */
'use strict';

const db = require('../db');

const VALID_STATUS = new Set(['active', 'dormant', 'closed']);

/**
 * Upsert a story thread row in response to a published article.
 *
 * - INSERT on first sight of the topic_tag (sets lead_article_id, owner).
 * - UPDATE on subsequent pieces (bumps last_article_id, recomputes counts,
 *   re-anchors owner if a different writer dominates).
 *
 * Returns the upserted row, or null if the article isn't eligible
 * (no topic_tag, missing tenant, etc).
 */
async function upsertThreadOnPublish(article, tenantId) {
  if (!article || !tenantId) return null;
  const tag = (article.topic_tag || '').trim();
  if (!tag) return null;
  if (!['original', 'deep-dive'].includes(article.content_type)) return null;

  try {
    const stats = await _computeThreadStats(tenantId, tag);
    if (!stats) return null;

    // Use ON CONFLICT to atomically create-or-update. We deliberately
    // don't touch closed_at — only an explicit close mutates that.
    const row = await db.prepare(`
      INSERT INTO story_threads
        (tenant_id, topic_tag, name, lead_article_id, last_article_id,
         article_count, source_count, owner_writer_id,
         first_seen_at, last_update_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      ON CONFLICT (tenant_id, topic_tag) DO UPDATE SET
        last_article_id = EXCLUDED.last_article_id,
        article_count   = EXCLUDED.article_count,
        source_count    = EXCLUDED.source_count,
        owner_writer_id = EXCLUDED.owner_writer_id,
        last_update_at  = EXCLUDED.last_update_at,
        -- An update on a previously-dormant thread reactivates it. A
        -- closed thread stays closed unless an admin reopens it.
        status          = CASE
                            WHEN story_threads.status = 'closed' THEN 'closed'
                            ELSE 'active'
                          END,
        updated_at      = NOW()
      RETURNING *
    `).get(
      tenantId,
      tag,
      stats.name || _humanizeTag(tag),
      stats.leadArticleId,
      stats.lastArticleId,
      stats.articleCount,
      stats.sourceCount,
      stats.ownerWriterId,
      stats.firstSeenAt,
      stats.lastUpdateAt,
    );
    return row;
  } catch (err) {
    console.error('[story-threads] upsertThreadOnPublish failed:', err.message);
    return null;
  }
}

/**
 * Recompute aggregate stats for a thread from the articles table. Used by
 * the upsert path and any manual recompute hook (e.g. an admin tool).
 *
 * Returns:
 *   { name, leadArticleId, lastArticleId, articleCount, sourceCount,
 *     ownerWriterId, firstSeenAt, lastUpdateAt }
 *   or null if the tag has no published originals/deep-dives.
 */
async function _computeThreadStats(tenantId, tag) {
  const rows = await db.prepare(`
    SELECT id, writer_id, source_article_ids, published_at
    FROM articles
    WHERE tenant_id = $1
      AND topic_tag = $2
      AND content_type IN ('original', 'deep-dive')
      AND is_published = 1
      AND (is_archived = 0 OR is_archived IS NULL)
    ORDER BY published_at ASC
  `).all(tenantId, tag);

  if (!rows.length) return null;

  // Distinct source article ids across all pieces in the thread —
  // gives a sense of how many curated sources the thread has consumed.
  const sourceIds = new Set();
  const writerCounts = new Map();
  for (const r of rows) {
    if (r.writer_id) writerCounts.set(r.writer_id, (writerCounts.get(r.writer_id) || 0) + 1);
    let raw = r.source_article_ids;
    if (typeof raw === 'string') {
      try { raw = JSON.parse(raw); } catch { raw = []; }
    }
    for (const item of (raw || [])) {
      const id = (typeof item === 'object' && item !== null) ? item.id : item;
      if (id) sourceIds.add(id);
    }
  }

  // Owner = writer with most pieces in the thread; ties broken by most
  // recent contribution (later in the loop wins).
  let ownerWriterId = null;
  let bestCount = -1;
  for (const [wid, count] of writerCounts) {
    if (count > bestCount) { ownerWriterId = wid; bestCount = count; }
  }

  return {
    name:           null, // caller fills via _humanizeTag if not previously set
    leadArticleId:  rows[0].id,
    lastArticleId:  rows[rows.length - 1].id,
    articleCount:   rows.length,
    sourceCount:    sourceIds.size,
    ownerWriterId,
    firstSeenAt:    rows[0].published_at,
    lastUpdateAt:   rows[rows.length - 1].published_at,
  };
}

/**
 * "openai-board-crisis" → "Openai Board Crisis"
 * Best-effort title-case from the slugged tag. Editors can override the
 * `name` column directly via admin UI / API.
 */
function _humanizeTag(tag) {
  return String(tag || '')
    .split('-')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Mark active threads dormant when no new piece has landed in `dormancyDays`.
 * Returns { scanned, marked }. Closed threads are never touched.
 */
async function markDormantThreads(tenantId, { dormancyDays = 14 } = {}) {
  try {
    const result = await db.prepare(`
      UPDATE story_threads
         SET status = 'dormant', updated_at = NOW()
       WHERE tenant_id = $1
         AND status = 'active'
         AND last_update_at < NOW() - make_interval(days => $2)
       RETURNING id
    `).all(tenantId, dormancyDays);
    return { scanned: result.length, marked: result.length };
  } catch (err) {
    console.error('[story-threads] markDormantThreads failed:', err.message);
    return { scanned: 0, marked: 0, error: err.message };
  }
}

/**
 * Fetch a single thread by topic_tag. Returns null when missing.
 */
async function getThread(tenantId, topicTag) {
  if (!tenantId || !topicTag) return null;
  return db.prepare(
    'SELECT * FROM story_threads WHERE tenant_id = $1 AND topic_tag = $2'
  ).get(tenantId, topicTag).catch(() => null);
}

/**
 * List threads filtered by status + ordered by last_update_at desc.
 *
 * @param {object} opts
 * @param {string|string[]} [opts.status] — 'active' | 'dormant' | 'closed' (default: ['active','dormant'])
 * @param {number} [opts.limit=50]
 * @param {number} [opts.ownerWriterId] — filter by owning writer
 */
async function listThreads(tenantId, opts = {}) {
  const statuses = Array.isArray(opts.status) ? opts.status
                 : opts.status ? [opts.status]
                 : ['active', 'dormant'];
  const limit = Math.min(Math.max(parseInt(opts.limit) || 50, 1), 200);
  const params = [tenantId, statuses];
  let where = `tenant_id = $1 AND status = ANY($2::text[])`;
  if (opts.ownerWriterId) {
    params.push(opts.ownerWriterId);
    where += ` AND owner_writer_id = $${params.length}`;
  }
  params.push(limit);
  return db.prepare(
    `SELECT * FROM story_threads WHERE ${where} ORDER BY last_update_at DESC LIMIT $${params.length}`
  ).all(...params).catch(() => []);
}

/**
 * Manually update thread metadata. Used by editor UI and the "close thread"
 * action. Status is validated; everything else is best-effort.
 */
async function updateThread(tenantId, topicTag, patch = {}) {
  if (!tenantId || !topicTag) return null;
  const sets = [];
  const params = [tenantId, topicTag];
  if (patch.name != null) {
    params.push(String(patch.name).slice(0, 200));
    sets.push(`name = $${params.length}`);
  }
  if (patch.summary != null) {
    params.push(String(patch.summary).slice(0, 1000));
    sets.push(`summary = $${params.length}`);
  }
  if (patch.status != null) {
    if (!VALID_STATUS.has(patch.status)) throw new Error('invalid status');
    params.push(patch.status);
    sets.push(`status = $${params.length}`);
    if (patch.status === 'closed') sets.push('closed_at = NOW()');
    else                            sets.push('closed_at = NULL');
  }
  if (patch.ownerWriterId !== undefined) {
    if (patch.ownerWriterId === null) {
      sets.push('owner_writer_id = NULL');
    } else {
      params.push(parseInt(patch.ownerWriterId, 10));
      sets.push(`owner_writer_id = $${params.length}`);
    }
  }
  if (!sets.length) return getThread(tenantId, topicTag);
  sets.push('updated_at = NOW()');
  return db.prepare(
    `UPDATE story_threads SET ${sets.join(', ')} WHERE tenant_id = $1 AND topic_tag = $2 RETURNING *`
  ).get(...params).catch(err => {
    console.error('[story-threads] updateThread failed:', err.message);
    return null;
  });
}

module.exports = {
  upsertThreadOnPublish,
  markDormantThreads,
  getThread,
  listThreads,
  updateThread,
  // Exported for tests:
  _humanizeTag,
  _computeThreadStats,
  VALID_STATUS,
};
