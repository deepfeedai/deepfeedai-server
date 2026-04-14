/**
 * Social newsroom Phase 2 — event emission helper.
 * Fire-and-forget logger for activity-feed cards. Never throws.
 */
const db = require('../db');

async function recordEvent({ tenantId, type, actorWriterId, actorUserId, targetArticleId, targetPitchId, payload }) {
  if (!tenantId || !type) return;
  try {
    await db.prepare(`
      INSERT INTO newsroom_events
        (tenant_id, event_type, actor_writer_id, actor_user_id, target_article_id, target_pitch_id, payload)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `).run(
      tenantId,
      String(type).slice(0, 64),
      actorWriterId || null,
      actorUserId || null,
      targetArticleId || null,
      targetPitchId || null,
      JSON.stringify(payload || {}),
    );
  } catch (err) {
    console.warn('[newsroom-events] record failed:', err.message);
  }
}

module.exports = { recordEvent };
