'use strict';

// Use the same publication flag as the news feed. Curated inbox items are not
// public merely because they have a source URL or a curated content type.
const eligible = alias => `${alias}.is_published = 1 AND COALESCE(${alias}.is_archived, 0) = 0`;

// Derive counts and covers at read time: unpublishing/archiving an article must
// take effect even when it happens outside the Stories editor. Do not delete
// legacy associations as a side effect of reading them.
const projection = `(
 SELECT s.id, s.tenant_id, s.name, s.slug, s.status, s.created_at,
        s.updated_at, s.archived_at, s.last_activity_at,
        CASE WHEN totals.cnt = links.cnt AND s.summary_article_ids = totals.ids THEN s.summary ELSE NULL END AS summary,
        totals.cnt AS article_count, cover.id AS cover_article_id, cover.image_url
 FROM story_timelines s
 CROSS JOIN LATERAL (SELECT COUNT(*)::int cnt FROM story_timeline_articles l
   WHERE l.story_id=s.id AND l.tenant_id=s.tenant_id) links
 CROSS JOIN LATERAL (SELECT COUNT(*)::int cnt, COALESCE(array_agg(a.id ORDER BY a.id), '{}'::int[]) ids FROM story_timeline_articles l
   JOIN articles a ON a.id=l.article_id AND a.tenant_id=l.tenant_id
   WHERE l.story_id=s.id AND l.tenant_id=s.tenant_id AND ${eligible('a')}) totals
 LEFT JOIN LATERAL (SELECT a.id, a.image_url FROM story_timeline_articles l
   JOIN articles a ON a.id=l.article_id AND a.tenant_id=l.tenant_id
   WHERE l.story_id=s.id AND l.tenant_id=s.tenant_id AND ${eligible('a')}
     AND NULLIF(a.image_url, '') IS NOT NULL
   ORDER BY a.published_at DESC NULLS LAST, a.id DESC LIMIT 1) cover ON TRUE
)`;

function invalid(message, status = 400) {
  return Object.assign(new Error(message), { status, statusCode: status });
}

async function validateArticles(client, tenantId, ids) {
  if (!Array.isArray(ids) || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw invalid('Article IDs must be positive integers');
  }
  const unique = [...new Set(ids)];
  const result = await client.query(`SELECT a.id FROM articles a
    WHERE a.tenant_id=$1 AND a.id=ANY($2::int[]) AND ${eligible('a')}
    ORDER BY a.id FOR SHARE`, [tenantId, unique]);
  if (result.rows.length !== unique.length) {
    throw invalid('All attached articles must exist in this workspace and be published, unarchived articles');
  }
  return unique;
}

async function refresh(client, storyId, tenantId) {
  await client.query(`UPDATE story_timelines s SET article_count=p.article_count,
    cover_article_id=p.cover_article_id, image_url=p.image_url, updated_at=NOW()
    FROM ${projection} p WHERE s.id=$1 AND s.tenant_id=$2
      AND p.id=s.id AND p.tenant_id=s.tenant_id`, [storyId, tenantId]);
}

async function changeLinks(pool, storyId, tenantId, action) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = await client.query('SELECT id FROM story_timelines WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [storyId, tenantId]);
    if (!row.rowCount) throw invalid('Story not found', 404);
    const result = await action(client);
    await refresh(client, storyId, tenantId);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

module.exports = { eligible, projection, invalid, validateArticles, refresh, changeLinks };
