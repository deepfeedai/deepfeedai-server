/**
 * Newsroom event emission helper.
 * Used by both the admin activity feed (is_public=false) and the public
 * Newsroom Glass live feed (is_public=true). Fire-and-forget — never throws.
 *
 * Public fields (Newsroom Glass):
 *   headline    — human-readable label shown in the public feed
 *   entitySlug  — slug for linking to the article/story
 *   isPublic    — true = visible in the public live feed
 *   isTerminal  — true = this event closes a story arc (e.g. published)
 */
const db = require('../db');

async function recordEvent({
  tenantId, type,
  actorWriterId, actorUserId,
  targetArticleId, targetPitchId,
  payload,
  isPublic = false, headline, entitySlug, isTerminal = false,
}) {
  if (!tenantId || !type) return null;
  try {
    const result = await db.prepare(`
      INSERT INTO newsroom_events
        (tenant_id, event_type, actor_writer_id, actor_user_id, target_article_id, target_pitch_id,
         payload, is_public, headline, entity_slug, is_terminal)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING id
    `).get(
      tenantId,
      String(type).slice(0, 64),
      actorWriterId || null,
      actorUserId || null,
      targetArticleId || null,
      targetPitchId || null,
      JSON.stringify(payload || {}),
      isPublic ? true : false,
      headline ? String(headline).slice(0, 280) : null,
      entitySlug ? String(entitySlug).slice(0, 120) : null,
      isTerminal ? true : false,
    );
    return result?.id || null;
  } catch (err) {
    console.warn('[newsroom-events] record failed:', err.message);
    return null;
  }
}

/**
 * Detect topic_tag clusters that crossed the 3-source threshold in the last
 * 2 hours and haven't yet had a wire_cluster event fired in the last 4 hours.
 * Safe to call on every agent-scan tick — the 4h guard prevents duplicates.
 */
async function checkAndEmitWireClusters(tenantId) {
  if (!tenantId) return;
  try {
    // Find topic_tags with 3+ curated sources in the last 2h
    const clusters = await db.prepare(`
      SELECT topic_tag,
             COUNT(*)::int                            AS source_count,
             MIN(title)                               AS sample_title,
             ARRAY_AGG(DISTINCT source ORDER BY source) FILTER (WHERE source IS NOT NULL) AS sources
      FROM   articles
      WHERE  tenant_id  = $1
        AND  topic_tag  IS NOT NULL
        AND  (content_type IS NULL OR content_type NOT IN ('original','deep-dive'))
        AND  created_at > NOW() - INTERVAL '2 hours'
      GROUP  BY topic_tag
      HAVING COUNT(*) >= 3
    `).all(tenantId);

    for (const c of clusters) {
      // Deduplicate: skip if we already fired a wire_cluster for this tag recently
      const recent = await db.prepare(`
        SELECT id FROM newsroom_events
        WHERE  tenant_id   = $1
          AND  event_type  = 'wire_cluster'
          AND  payload->>'topic_tag' = $2
          AND  created_at > NOW() - INTERVAL '4 hours'
        LIMIT 1
      `).get(tenantId, c.topic_tag);
      if (recent) continue;

      const label = c.topic_tag.replace(/-/g, ' ');
      await recordEvent({
        tenantId,
        type:      'wire_cluster',
        isPublic:  true,
        isTerminal: false,
        headline:  `Wire heating up · ${label} — ${c.source_count} source${c.source_count !== 1 ? 's' : ''} in 2h`,
        payload: {
          topic_tag:    c.topic_tag,
          source_count: c.source_count,
          sample_title: c.sample_title || null,
          sources:      c.sources || [],
        },
      });
    }
  } catch (err) {
    console.warn('[newsroom-events] checkAndEmitWireClusters failed:', err.message);
  }
}

/**
 * Emit a public "story in progress" event when a story_pitches row is created.
 * Fire-and-forget — safe to call from cron batch creates.
 */
async function emitPitchProposed(pitch, tenantId) {
  return recordEvent({
    tenantId,
    type:          'pitch_proposed',
    actorWriterId: pitch.writer_id || null,
    targetPitchId: pitch.id,
    isPublic:      true,
    isTerminal:    false,
    headline:      'Story in progress: ' + (pitch.headline || '').slice(0, 200),
    payload: {
      pitch_id:   pitch.id,
      pitch_type: pitch.pitch_type || 'original',
      headline:   pitch.headline,
      writer_id:  pitch.writer_id,
    },
  }).catch(() => null);
}

module.exports = { recordEvent, emitPitchProposed, checkAndEmitWireClusters };
