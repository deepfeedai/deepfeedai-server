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
 *
 * Decay: once an article's importance has been set, it ages naturally based on
 * `importance_updated_at`:
 *   - within 6h   → keep original tier
 *   - 6h–24h      → cap at 'major'
 *   - 24h–72h     → cap at 'trending'
 *   - > 72h       → 'standard'
 * `computeEffectiveImportance()` returns the live tier without mutating the DB;
 * the hourly `recomputeImportanceDecay` cron persists the decayed value so
 * indexes + feed queries stay correct.
 */
const db = require('../db');
const { isFeatureEnabled } = require('./feature-registry');

const LEVELS = ['standard', 'trending', 'major', 'breaking'];
const RANK = { standard: 1, trending: 2, major: 3, breaking: 4 };

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
 * Also stamps `importance_updated_at` when the level changes so decay can age it.
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
    'UPDATE articles SET importance = $1, importance_updated_at = NOW() WHERE id = $2 AND tenant_id = $3'
  ).run(level, articleId, tenantId);

  return level;
}

/**
 * Manually set/override importance. Sets importance_locked=true so auto-compute won't change it.
 */
async function setImportanceManual(articleId, tenantId, importance) {
  if (!LEVELS.includes(importance)) throw new Error('invalid importance');
  await db.prepare(
    'UPDATE articles SET importance = $1, importance_locked = true, importance_updated_at = NOW() WHERE id = $2 AND tenant_id = $3'
  ).run(importance, articleId, tenantId);
}

async function unlockImportance(articleId, tenantId) {
  await db.prepare(
    'UPDATE articles SET importance_locked = false WHERE id = $1 AND tenant_id = $2'
  ).run(articleId, tenantId);
}

/**
 * Compute the live tier for an article given its stored importance + updated_at.
 * Pure function — does NOT mutate the DB. Used by the feed API so stale rows
 * render with the aged-down tier even if the decay cron hasn't run yet.
 *
 * Input: an article-like object with { importance, importance_locked, importance_updated_at, published_at }.
 */
function computeEffectiveImportance(article) {
  const stored = article?.importance || 'standard';
  if (article?.importance_locked) return stored;

  // When no timestamp exists (never auto-computed), fall through to stored.
  const ts = article?.importance_updated_at || article?.published_at;
  if (!ts) return stored;

  const ageMs = Date.now() - new Date(ts).getTime();
  const HOUR = 3600_000;
  const storedRank = RANK[stored] || 1;

  // Standard can't decay further
  if (storedRank <= 1) return 'standard';

  if (ageMs < 6 * HOUR)  return stored;                                   // full strength
  if (ageMs < 24 * HOUR) return storedRank >= RANK.major    ? 'major'    : stored;
  if (ageMs < 72 * HOUR) return storedRank >= RANK.trending ? 'trending' : stored;
  return 'standard';
}

/**
 * Recompute decay for recently-updated articles (last 72h) — persists changes
 * so feed queries can rely on `articles.importance`.
 * Called by the hourly `recomputeImportanceDecay` cron.
 */
async function recomputeDecay(tenantId) {
  const enabled = await isFeatureEnabled(tenantId, 'story_levels').catch(() => false);
  if (!enabled) return { skipped: 'feature_off' };

  const rows = await db.prepare(`
    SELECT id, importance, importance_locked, importance_updated_at, published_at
    FROM articles
    WHERE tenant_id = $1
      AND importance IS NOT NULL
      AND importance != 'standard'
      AND importance_locked = false
      AND COALESCE(importance_updated_at, published_at) > NOW() - INTERVAL '120 hours'
  `).all(tenantId);

  let changed = 0;
  for (const row of rows) {
    const next = computeEffectiveImportance(row);
    if (next !== row.importance) {
      await db.prepare(
        'UPDATE articles SET importance = $1 WHERE id = $2 AND tenant_id = $3'
      ).run(next, row.id, tenantId);
      changed++;
    }
  }
  return { scanned: rows.length, changed };
}

/**
 * Refresh importance for the lead articles of a cluster when a fresh curated
 * source joins. Intentionally narrow: we only re-stamp `importance_updated_at`
 * on originals/deep-dives that match the new source's topic_tag or category in
 * the last 72h, so decay restarts without forcing a full recompute on the hot
 * path. The next auto-compute or the hourly decay cron will finish the job.
 *
 * Fire-and-forget — safe to await/ignore.
 */
async function refreshClusterOnNewSource(sourceArticle) {
  if (!sourceArticle || !sourceArticle.tenant_id) return;
  try {
    const enabled = await isFeatureEnabled(sourceArticle.tenant_id, 'story_levels').catch(() => false);
    if (!enabled) return;
    await db.prepare(`
      UPDATE articles
      SET importance_updated_at = NOW()
      WHERE tenant_id = $1
        AND content_type IN ('original', 'deep-dive')
        AND importance_locked = false
        AND importance IN ('trending', 'major', 'breaking')
        AND published_at > NOW() - INTERVAL '72 hours'
        AND (
          ($2::text IS NOT NULL AND topic_tag = $2)
          OR ($3::text IS NOT NULL AND category = $3)
        )
    `).run(sourceArticle.tenant_id, sourceArticle.topic_tag || null, sourceArticle.category || null);
  } catch (err) {
    // non-fatal
    if (process.env.DEBUG_STORY_LEVELS) console.warn('[story-levels] refreshClusterOnNewSource failed:', err.message);
  }
}

module.exports = {
  computeAndSetImportance,
  computeEffectiveImportance,
  setImportanceManual,
  unlockImportance,
  recomputeDecay,
  refreshClusterOnNewSource,
  LEVELS,
  RANK,
};
