/**
 * Deep Feed AI — lib/featured-rotation.js
 * Automated featured article rotation with scoring, pinning, and expiry support.
 */
const db = require('../db');

const MAX_SLOTS = 5;

/**
 * Load rotation settings for a tenant.
 */
async function getRotationConfig(tenantId) {
  const keys = [
    'featured_rotation_enabled',
    'featured_rotation_interval_hours',
    'featured_rotation_strategy',
    'featured_rotation_pool_days',
    'featured_rotation_cooldown_days',
  ];
  const rows = await db.prepare(
    "SELECT key, value FROM settings WHERE tenant_id = $1 AND key = ANY($2)"
  ).all(tenantId, keys);
  const cfg = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return {
    enabled:       cfg.featured_rotation_enabled === '1',
    intervalHours: Math.max(parseInt(cfg.featured_rotation_interval_hours) || 12, 1),
    strategy:      cfg.featured_rotation_strategy || 'score',
    poolDays:      Math.max(parseInt(cfg.featured_rotation_pool_days) || 7, 1),
    cooldownDays:  Math.max(parseInt(cfg.featured_rotation_cooldown_days) || 3, 0),
  };
}

/**
 * Main rotation entry point. Called by the cron job.
 * @param {number} tenantId
 * @param {object} opts - { force: boolean } — skip interval check when true
 */
async function rotateFeatured(tenantId, opts = {}) {
  const config = await getRotationConfig(tenantId);
  if (!config.enabled && !opts.force) {
    return { rotated: false, reason: 'Rotation not enabled' };
  }

  // Check interval: find last rotation for this tenant
  if (!opts.force) {
    const lastRun = await db.prepare(
      'SELECT rotated_at FROM featured_rotation_log WHERE tenant_id = $1 ORDER BY rotated_at DESC LIMIT 1'
    ).get(tenantId);
    if (lastRun) {
      const elapsedMs = Date.now() - new Date(lastRun.rotated_at).getTime();
      const intervalMs = config.intervalHours * 3600000;
      if (elapsedMs < intervalMs) {
        return { rotated: false, reason: 'Interval not elapsed', nextInMs: intervalMs - elapsedMs };
      }
    }
  }

  // 1. Expire stale featured articles (featured_until has passed, not pinned)
  await db.prepare(`
    UPDATE articles
    SET is_featured = 0, featured_priority = NULL, featured_source = NULL, updated_at = NOW()
    WHERE tenant_id = $1 AND is_featured = 1 AND is_pinned = 0
      AND featured_until IS NOT NULL AND featured_until <= NOW()
  `).run(tenantId);

  // 2. Identify locked slots (pinned or manually featured without expiry)
  const lockedArticles = await db.prepare(`
    SELECT id, featured_priority FROM articles
    WHERE tenant_id = $1 AND is_featured = 1
      AND (is_pinned = 1 OR (featured_source = 'manual' AND featured_until IS NULL))
  `).all(tenantId);

  // 3. Identify auto-featured articles that can be rotated out
  //    All non-pinned auto/legacy articles are eligible — featured_until is only
  //    a safety net for the public API, not a lock against the rotation cron.
  const autoFeatured = await db.prepare(`
    SELECT id, featured_priority FROM articles
    WHERE tenant_id = $1 AND is_featured = 1 AND is_pinned = 0
      AND (featured_source = 'auto' OR featured_source IS NULL)
  `).all(tenantId);

  const lockedPriorities = new Set(lockedArticles.map(a => a.featured_priority));
  const lockedIds = new Set(lockedArticles.map(a => a.id));
  const openSlotCount = MAX_SLOTS - lockedArticles.length;

  if (openSlotCount <= 0) {
    return { rotated: false, reason: 'All slots pinned/locked' };
  }

  // 4. Unfeature auto-rotated articles to free slots
  const unfeaturedIds = [];
  for (const article of autoFeatured) {
    await db.prepare(`
      UPDATE articles
      SET is_featured = 0, featured_priority = NULL, featured_source = NULL, updated_at = NOW()
      WHERE id = $1 AND tenant_id = $2
    `).run(article.id, tenantId);
    unfeaturedIds.push(article.id);
  }

  // 5. Query candidate pool
  const candidates = await db.prepare(`
    SELECT a.id, a.title, a.category, a.published_at, a.editorial_score,
           a.content_type, a.last_featured_at,
           COALESCE((SELECT COUNT(*) FROM analytics_events ae
             WHERE ae.article_slug = a.slug AND ae.event_type = 'view'
             AND ae.tenant_id = $1), 0) AS view_count
    FROM articles a
    WHERE a.tenant_id = $1
      AND a.is_published = 1
      AND (a.is_archived = 0 OR a.is_archived IS NULL)
      AND a.is_featured = 0
      AND a.image_url IS NOT NULL
      AND a.published_at >= NOW() - MAKE_INTERVAL(days => $2)
      AND (a.last_featured_at IS NULL OR a.last_featured_at < NOW() - MAKE_INTERVAL(days => $3))
    ORDER BY a.published_at DESC
    LIMIT 50
  `).all(tenantId, config.poolDays, config.cooldownDays);

  if (!candidates.length) {
    // Log empty rotation
    await db.prepare(`
      INSERT INTO featured_rotation_log (tenant_id, rotated_at, slots_filled, articles_featured, articles_unfeatured, strategy_used)
      VALUES ($1, NOW(), 0, '[]', $2, $3)
    `).run(tenantId, JSON.stringify(unfeaturedIds.map(id => ({ id }))), config.strategy);
    return { rotated: true, slotsFilled: 0, reason: 'No candidates in pool' };
  }

  // 6. Score candidates
  const scored = scoreCandidates(candidates, config.strategy, lockedArticles);

  // 7. Pick top N for open slots, assign priorities
  const availablePriorities = [];
  for (let i = 1; i <= MAX_SLOTS; i++) {
    if (!lockedPriorities.has(i)) availablePriorities.push(i);
  }

  const featuredUntil = new Date(Date.now() + config.intervalHours * 3600000).toISOString();
  const selected = scored.slice(0, availablePriorities.length);
  const featuredArticles = [];

  for (let i = 0; i < selected.length; i++) {
    const candidate = selected[i];
    const priority = availablePriorities[i];
    await db.prepare(`
      UPDATE articles
      SET is_featured = 1, featured_priority = $1, featured_source = 'auto',
          last_featured_at = NOW(), featured_until = $2, updated_at = NOW()
      WHERE id = $3 AND tenant_id = $4
    `).run(priority, featuredUntil, candidate.id, tenantId);
    featuredArticles.push({ id: candidate.id, title: candidate.title, priority });
  }

  // 8. Log rotation
  await db.prepare(`
    INSERT INTO featured_rotation_log (tenant_id, rotated_at, slots_filled, articles_featured, articles_unfeatured, strategy_used)
    VALUES ($1, NOW(), $2, $3, $4, $5)
  `).run(
    tenantId,
    selected.length,
    JSON.stringify(featuredArticles),
    JSON.stringify(unfeaturedIds.map(id => ({ id }))),
    config.strategy
  );

  console.log(`[Featured Rotation] Tenant ${tenantId}: ${selected.length} slots filled, ${unfeaturedIds.length} unfeatured (${config.strategy})`);

  return {
    rotated: true,
    slotsFilled: selected.length,
    articlesIn: featuredArticles,
    articlesOut: unfeaturedIds,
    strategy: config.strategy,
  };
}

/**
 * Score and sort candidates based on the chosen strategy.
 */
function scoreCandidates(candidates, strategy, lockedArticles) {
  const lockedCategories = new Set(lockedArticles.map(a => a.category).filter(Boolean));

  // Compute normalizers
  const maxViews = Math.max(1, ...candidates.map(c => c.view_count));
  const nowMs = Date.now();

  const scored = candidates.map(c => {
    const ageHours = Math.max(1, (nowMs - new Date(c.published_at).getTime()) / 3600000);
    const normalizedViews = c.view_count / maxViews;
    const normalizedQuality = Math.min((c.editorial_score || 50) / 100, 1);
    const recencyDecay = 1 / (1 + ageHours / 24); // ~0.5 at 24h, ~0.33 at 48h

    let score;
    switch (strategy) {
      case 'category-balanced': {
        const diversityBonus = lockedCategories.has(c.category) ? 0 : 0.2;
        score = 0.3 * normalizedViews + 0.25 * normalizedQuality + 0.25 * recencyDecay + diversityBonus;
        // Track assigned categories to keep balancing across candidates
        lockedCategories.add(c.category);
        break;
      }
      case 'recency': {
        score = recencyDecay;
        break;
      }
      case 'score':
      default: {
        const diversityBonus = lockedCategories.has(c.category) ? 0 : 0.1;
        score = 0.4 * normalizedViews + 0.3 * normalizedQuality + 0.2 * recencyDecay + diversityBonus;
        break;
      }
    }

    return { ...c, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Get the current rotation status for a tenant (for admin display).
 */
async function getRotationStatus(tenantId) {
  const config = await getRotationConfig(tenantId);

  const featured = await db.prepare(`
    SELECT id, title, featured_priority, is_pinned, featured_source, featured_until, last_featured_at
    FROM articles
    WHERE tenant_id = $1 AND is_featured = 1
    ORDER BY COALESCE(featured_priority, 99) ASC
  `).all(tenantId);

  const lastRotation = await db.prepare(
    'SELECT * FROM featured_rotation_log WHERE tenant_id = $1 ORDER BY rotated_at DESC LIMIT 1'
  ).get(tenantId);

  const recentLog = await db.prepare(
    'SELECT * FROM featured_rotation_log WHERE tenant_id = $1 ORDER BY rotated_at DESC LIMIT 10'
  ).all(tenantId);

  let nextRotationAt = null;
  if (config.enabled && lastRotation) {
    nextRotationAt = new Date(new Date(lastRotation.rotated_at).getTime() + config.intervalHours * 3600000).toISOString();
  }

  return {
    config,
    featured,
    lastRotation,
    nextRotationAt,
    recentLog,
  };
}

module.exports = { rotateFeatured, getRotationStatus, getRotationConfig };
