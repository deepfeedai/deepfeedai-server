/**
 * Story Levels — compute importance for an article from cluster signals.
 *
 * Signals:
 *   1. Source diversity — distinct publishers in the same topic cluster within recent window
 *   2. Velocity — how fast curated items on the topic are arriving
 *   3. Editorial score — quality gate output
 *
 * Tiers:
 *   breaking  — >=5 distinct sources within 2h (high velocity + multi-source)
 *   major     — >=3 distinct sources within 24h AND editorial_score >= 7
 *   trending  — >=3 distinct sources within 72h
 *   standard  — anything else (default)
 *
 * Editor manual override: setting importance_locked=true freezes the value.
 */
const db = require('../db');
const { isFeatureEnabled } = require('./feature-registry');

const LEVELS = ['standard', 'trending', 'major', 'breaking'];

async function _countSourcesInWindow(article, hours) {
  if (!article.embedding) {
    // Fallback: count by topic_tag or category in window
    const row = await db.prepare(`
      SELECT COUNT(DISTINCT source)::int AS cnt FROM articles
      WHERE tenant_id = $1
        AND (content_type IS NULL OR content_type = 'curated')
        AND (
          (topic_tag IS NOT NULL AND topic_tag = $2)
          OR (category = $3)
        )
        AND published_at > NOW() - make_interval(hours => $4)
        AND source IS NOT NULL
    `).get(article.tenant_id, article.topic_tag, article.category, hours);
    return row?.cnt || 0;
  }
  // Vector-similarity neighborhood
  const row = await db.prepare(`
    SELECT COUNT(DISTINCT source)::int AS cnt FROM articles
    WHERE tenant_id = $1
      AND (content_type IS NULL OR content_type = 'curated')
      AND embedding IS NOT NULL
      AND published_at > NOW() - make_interval(hours => $3)
      AND source IS NOT NULL
      AND (1 - (embedding <=> $2::vector)) >= 0.72
  `).get(article.tenant_id, article.embedding, hours);
  return row?.cnt || 0;
}

/**
 * Compute and persist importance for an article. No-op if importance_locked or feature off.
 * @returns {Promise<string|null>} the new importance, or null if no change
 */
async function computeAndSetImportance(articleId, tenantId) {
  const enabled = await isFeatureEnabled(tenantId, 'story_levels').catch(() => false);
  if (!enabled) return null;

  const article = await db.prepare(
    'SELECT id, tenant_id, category, topic_tag, embedding, editorial_score, importance, importance_locked FROM articles WHERE id = $1 AND tenant_id = $2'
  ).get(articleId, tenantId);
  if (!article || article.importance_locked) return null;

  const sources2h = await _countSourcesInWindow(article, 2);
  const sources24h = sources2h >= 5 ? sources2h : await _countSourcesInWindow(article, 24);
  const sources72h = sources24h >= 3 ? sources24h : await _countSourcesInWindow(article, 72);
  const score = Number(article.editorial_score) || 0;

  let level = 'standard';
  if (sources2h >= 5) level = 'breaking';
  else if (sources24h >= 3 && score >= 7) level = 'major';
  else if (sources72h >= 3) level = 'trending';

  if (level === article.importance) return null;

  await db.prepare(
    'UPDATE articles SET importance = $1 WHERE id = $2 AND tenant_id = $3'
  ).run(level, articleId, tenantId);

  return level;
}

/**
 * Manually set/override importance. Sets importance_locked=true so auto-compute won't change it.
 */
async function setImportanceManual(articleId, tenantId, importance) {
  if (!LEVELS.includes(importance)) throw new Error('invalid importance');
  await db.prepare(
    'UPDATE articles SET importance = $1, importance_locked = true WHERE id = $2 AND tenant_id = $3'
  ).run(importance, articleId, tenantId);
}

async function unlockImportance(articleId, tenantId) {
  await db.prepare(
    'UPDATE articles SET importance_locked = false WHERE id = $1 AND tenant_id = $2'
  ).run(articleId, tenantId);
}

module.exports = { computeAndSetImportance, setImportanceManual, unlockImportance, LEVELS };
