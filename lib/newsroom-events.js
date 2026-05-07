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
  // Newsroom Glass public feed fields
  isPublic = false, headline, entitySlug, isTerminal = false,
}) {
  if (!tenantId || !type) return;
  try {
    await db.prepare(`
      INSERT INTO newsroom_events
        (tenant_id, event_type, actor_writer_id, actor_user_id, target_article_id, target_pitch_id,
         payload, is_public, headline, entity_slug, is_terminal)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `).run(
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
  } catch (err) {
    console.warn('[newsroom-events] record failed:', err.message);
  }
}

module.exports = { recordEvent };
