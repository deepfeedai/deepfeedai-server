/**
 * Deep Feed AI — Notifications Service (PR-B of notifications/actions)
 *
 * Fire-and-forget cross-channel notifier. Always writes a row to
 * `user_notifications` (the web bell feed); optionally attaches signed
 * action-button tokens; logs intended multi-channel dispatch.
 *
 * PR-C will wire the actual Telegram/Discord/Slack renderers into
 * dispatchToChannel — today it's a stub that just logs.
 */
'use strict';

const db = require('../db');
const { mint } = require('./action-tokens');

/**
 * Default channel routing per event kind when the user has no row in
 * notification_preferences. Matches the plan's "sensible defaults".
 */
const DEFAULT_CHANNELS = {
  pitch_created:    ['web', 'telegram'],
  review_needed:    ['web', 'telegram'],
  pitch_approved:   ['web'],
  pitch_rejected:   ['web'],
  article_published: ['slack'],
  mention:          ['web'],
  enrichment_ready: ['web'],
  workflow_error:   ['web'],
};

async function resolveChannels(tenantId, userId, kind) {
  try {
    const row = await db.prepare(`
      SELECT channels FROM notification_preferences
      WHERE tenant_id = $1 AND user_id = $2 AND event_kind = $3
    `).get(tenantId, userId, kind);
    if (row && Array.isArray(row.channels) && row.channels.length) return row.channels;
  } catch { /* fall through to defaults */ }
  return DEFAULT_CHANNELS[kind] || ['web'];
}

/**
 * Stub: PR-C will replace this with real Telegram/Discord/Slack dispatch.
 * Signature intentionally mirrors what those renderers will need.
 */
function dispatchToChannel(channel, { tenantId, userId, kind, title, body, actionable }) {
  // TODO(PR-C): wire channel renderers (telegram / discord / slack) here.
  console.log(`[notifications] (stub) dispatch → ${channel} t=${tenantId} u=${userId} kind=${kind} title=${JSON.stringify(title)} actions=${(actionable || []).length}`);
}

/**
 * Fire-and-forget notification. Always resolves (errors are logged, not thrown),
 * so callers can `notify(...).catch(()=>{})` or ignore the return entirely.
 *
 * @param {Object}  opts
 * @param {number}  opts.tenantId
 * @param {number}  opts.userId
 * @param {string}  opts.kind       - event kind (see DEFAULT_CHANNELS)
 * @param {string}  [opts.title]
 * @param {string}  [opts.body]
 * @param {Object}  [opts.payload]  - extra renderable fields
 * @param {number}  [opts.eventId]  - optional FK into newsroom_events
 * @param {Array}   [opts.actionable] - [{label, actionKind, targetId, targetType, payload, style?}]
 * @returns {Promise<{ok:boolean, id?:number, error?:string}>}
 */
async function notify({ tenantId, userId, kind, title, body, payload, eventId, actionable }) {
  if (!tenantId || !userId || !kind) {
    console.warn('[notifications] notify() missing required fields');
    return { ok: false, error: 'missing_required_fields' };
  }

  // 1. Mint action tokens for any actionable buttons.
  const buttons = [];
  if (Array.isArray(actionable) && actionable.length) {
    for (const a of actionable) {
      try {
        const token = await mint({
          tenantId,
          userId,
          actionKind: a.actionKind,
          targetId:   a.targetId,
          targetType: a.targetType,
          payload:    a.payload || {},
        });
        buttons.push({
          label: a.label,
          style: a.style || 'default',
          action_kind: a.actionKind,
          target_id:   a.targetId ?? null,
          target_type: a.targetType ?? null,
          token,
        });
      } catch (err) {
        console.error('[notifications] token mint failed:', err.message);
      }
    }
  }

  const storedPayload = { ...(payload || {}) };
  if (buttons.length) storedPayload.actions = buttons;

  // 2. Always write the web-bell row.
  let notifId;
  try {
    const inserted = await db.prepare(`
      INSERT INTO user_notifications (tenant_id, user_id, event_id, kind, title, body, payload)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id
    `).get(tenantId, userId, eventId || null, kind, title || null, body || null, JSON.stringify(storedPayload));
    notifId = inserted?.id;
  } catch (err) {
    console.error('[notifications] insert failed:', err.message);
    return { ok: false, error: err.message };
  }

  // 3. Resolve preferred channels; dispatch to the non-web ones (stubbed in PR-B).
  const channels = await resolveChannels(tenantId, userId, kind);
  for (const ch of channels) {
    if (ch === 'web') continue; // already persisted above
    try {
      dispatchToChannel(ch, { tenantId, userId, kind, title, body, actionable: buttons });
    } catch (err) {
      console.error(`[notifications] dispatch ${ch} failed:`, err.message);
    }
  }

  return { ok: true, id: notifId };
}

module.exports = { notify, dispatchToChannel, DEFAULT_CHANNELS };
