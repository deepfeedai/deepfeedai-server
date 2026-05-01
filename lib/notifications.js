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

const crypto = require('crypto');
const db = require('../db');
const { mint, setNotificationId } = require('./action-tokens');
const { isFeatureEnabled } = require('./feature-registry');

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
  article_revision_requested: ['web', 'telegram'],
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
 * Dispatch a rendered event card to a specific channel for one user.
 *
 * PR-C: Telegram implemented end-to-end. Discord + Slack remain stubs and
 * will be filled in by PR-D / PR-E.
 *
 * @param {string} channel
 * @param {Object} opts
 * @param {number} opts.tenantId
 * @param {number} opts.userId
 * @param {string} opts.kind
 * @param {string} [opts.title]
 * @param {string} [opts.body]
 * @param {Object} [opts.payload]       - event-specific fields consumed by the renderer
 * @param {Array}  [opts.actionable]    - [{label, token, action_kind, ...}] already minted
 * @param {boolean}[opts.allowActions]  - if false, strip buttons (feature flag off)
 */
async function dispatchToChannel(channel, { tenantId, userId, kind, title, body, payload, actionable, allowActions }) {
  if (channel === 'telegram') {
    return dispatchTelegram({ tenantId, userId, kind, title, body, payload, actionable, allowActions });
  }
  // Discord + Slack: PR-D / PR-E.
  console.log(`[notifications] (stub) dispatch → ${channel} t=${tenantId} u=${userId} kind=${kind} title=${JSON.stringify(title)} actions=${(actionable || []).length}`);
}

async function dispatchTelegram({ tenantId, userId, kind, title, body, payload, actionable, allowActions }) {
  let chatId;
  try {
    const row = await db.prepare(
      'SELECT telegram_chat_id FROM users WHERE id = $1 AND tenant_id = $2'
    ).get(userId, tenantId);
    chatId = row?.telegram_chat_id;
  } catch (err) {
    console.error('[notifications:telegram] user lookup failed:', err.message);
    return;
  }
  if (!chatId) {
    console.log(`[notifications:telegram] skip — no telegram_chat_id linked for user=${userId} tenant=${tenantId}`);
    return;
  }

  const { renderEventCard, renderButtons } = require('./notifications/renderers/telegram');
  const card = renderEventCard(kind, { title, body, ...(payload || {}) });
  const keyboard = allowActions ? renderButtons(actionable) : [];

  try {
    const { sendActionable } = require('./messaging/telegram');
    const tgResp = await sendActionable(String(chatId), card.text, keyboard, tenantId, { parseMode: card.parseMode });
    // Record chat_id + message_id on every action_token attached to this send
    // so a later cohort cascade can editMessageReplyMarkup(chat, msg, []) and
    // strip the inline keyboard off this message.
    const messageId = tgResp && tgResp.result && tgResp.result.message_id;
    if (messageId && Array.isArray(actionable) && actionable.length) {
      const { setTelegramMessage } = require('./action-tokens');
      for (const btn of actionable) {
        if (btn && btn.token_row_id) {
          setTelegramMessage(btn.token_row_id, String(chatId), messageId).catch(() => {});
        }
      }
    }
  } catch (err) {
    console.error('[notifications:telegram] send failed:', err.message);
  }
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

  // Gate the entire notifications system behind the notifications_center flag.
  // If disabled for this tenant, short-circuit — nothing gets persisted or sent.
  const centerOn = await isFeatureEnabled(tenantId, 'notifications_center').catch(() => false);
  if (!centerOn) {
    return { ok: false, error: 'notifications_center_disabled' };
  }

  console.log('[notify] kind=%s user=%d tenant=%d', kind, userId, tenantId);

  // Actionable buttons also require the cross_channel_actions flag. If it's off
  // we still deliver the message (bell + DM text) but without approve/reject
  // buttons — tokens aren't minted, so there's nothing to leak or replay.
  const actionsOn = await isFeatureEnabled(tenantId, 'cross_channel_actions').catch(() => false);

  // 1. Mint action tokens for any actionable buttons.
  //    Every token minted in this notify() call shares one cohort_id so a
  //    successful action in any channel can cascade "used_by_source=cascade"
  //    to the siblings (see burnCohortSiblings).
  const buttons = [];
  const mintedTokenIds = []; // parallel array to `buttons` — need row ids to backfill notification_id
  const cohortId = (actionsOn && Array.isArray(actionable) && actionable.length)
    ? crypto.randomBytes(12).toString('base64url')
    : null;
  if (cohortId) {
    for (const a of actionable) {
      try {
        const { raw, id } = await mint({
          tenantId,
          userId,
          actionKind: a.actionKind,
          targetId:   a.targetId,
          targetType: a.targetType,
          payload:    a.payload || {},
          cohortId,
        });
        buttons.push({
          label: a.label,
          style: a.style || 'default',
          action_kind: a.actionKind,
          target_id:   a.targetId ?? null,
          target_type: a.targetType ?? null,
          token: raw,
          token_row_id: id, // stripped before persisting to payload
        });
        mintedTokenIds.push(id);
      } catch (err) {
        console.error('[notifications] token mint failed:', err.message);
      }
    }
  }

  // Persist a clean copy of the buttons (no internal row ids) on the notification
  // under BOTH `actions` (legacy) and `actionable` (what the UI renderers read).
  const publicButtons = buttons.map(b => {
    const { token_row_id, ...rest } = b;
    return rest;
  });
  const storedPayload = { ...(payload || {}) };
  if (publicButtons.length) {
    storedPayload.actions = publicButtons;
    storedPayload.actionable = publicButtons;
  }

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

  // Back-link each minted token to the notification row we just created so
  // the action handler can later rewrite payload.actionable[] in place.
  if (notifId && mintedTokenIds.length) {
    for (const tid of mintedTokenIds) {
      setNotificationId(tid, notifId).catch(() => {});
    }
  }

  // 3. Resolve preferred channels; enqueue one job per non-web channel.
  //    Each job gets its own retry budget so a Telegram failure doesn't
  //    block or retry Discord, and vice versa.
  const channels = await resolveChannels(tenantId, userId, kind);
  const { enqueueJob } = require('./jobs/queue');
  const { JOB_TYPE, PRIORITY, CATEGORY_MAP } = require('./jobs/constants');
  const channelJobType = { telegram: JOB_TYPE.NOTIFY_TELEGRAM, discord: JOB_TYPE.NOTIFY_DISCORD, slack: JOB_TYPE.NOTIFY_SLACK, email: JOB_TYPE.NOTIFY_EMAIL };

  for (const ch of channels) {
    if (ch === 'web') continue; // already persisted above
    const jobType = channelJobType[ch];
    if (!jobType) { console.warn(`[notifications] unknown channel "${ch}" — skipping`); continue; }
    enqueueJob({
      tenantId,
      type:     jobType,
      priority: PRIORITY.HIGH,
      payload:  {
        channel:      ch,
        notifId,
        userId,
        kind,
        title:        title  || null,
        body:         body   || null,
        payload:      payload || {},
        buttons,       // includes token_row_id for Telegram back-linking
        allowActions: actionsOn,
      },
      idempotencyKey: `notify:${tenantId}:${notifId}:${ch}`,
    }).catch(err => console.error(`[notifications] enqueue ${ch} failed:`, err.message));
  }

  return { ok: true, id: notifId };
}

module.exports = { notify, dispatchToChannel, DEFAULT_CHANNELS };
