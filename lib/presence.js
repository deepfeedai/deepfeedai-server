/**
 * Social newsroom Phase 4 — writer-agent presence helpers.
 * Fire-and-forget setters; sweep cron resets stale states.
 */
const db = require('../db');

// Max age before a presence state is considered stale and reset to idle (ms)
const STALE_MS = {
  chatting: 5 * 60 * 1000,         // 5 minutes
  researching: 10 * 60 * 1000,     // 10 minutes
  drafting: 30 * 60 * 1000,        // 30 minutes
  'waiting-on-editor': 24 * 60 * 60 * 1000, // 24 hours
};

const VALID_STATES = new Set(['idle', 'chatting', 'drafting', 'researching', 'waiting-on-editor']);

async function setPresence(writerId, tenantId, state) {
  if (!writerId || !tenantId || !VALID_STATES.has(state)) return;
  try {
    await db.prepare(
      'UPDATE writers SET presence_state = $1, presence_updated_at = NOW() WHERE id = $2 AND tenant_id = $3'
    ).run(state, writerId, tenantId);
  } catch (err) {
    // Non-fatal: presence is decorative
    console.warn('[presence] setPresence failed:', err.message);
  }
}

async function clearStale(tenantId) {
  if (!tenantId) throw new Error('clearStale: tenantId required');
  try {
    for (const [state, ms] of Object.entries(STALE_MS)) {
      const seconds = Math.floor(ms / 1000);
      const params = [state, seconds];
      let sql = `
        UPDATE writers
        SET presence_state = 'idle'
        WHERE presence_state = $1
          AND presence_updated_at IS NOT NULL
          AND presence_updated_at < NOW() - make_interval(secs => $2)
      `;
      if (tenantId) { sql += ' AND tenant_id = $3'; params.push(tenantId); }
      await db.prepare(sql).run(...params);
    }
  } catch (err) {
    console.warn('[presence] clearStale failed:', err.message);
  }
}

module.exports = { setPresence, clearStale, VALID_STATES };
