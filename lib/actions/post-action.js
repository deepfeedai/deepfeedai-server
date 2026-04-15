/**
 * Deep Feed AI — post-action cascade
 *
 * After a cross-channel action token is successfully burned, this helper:
 *   1. Marks the user_notifications row read + annotates its payload.actionable[]
 *      entry for the burned token as { used, used_at, used_by_source, used_by_user_id }.
 *   2. Cascades the decision to sibling tokens minted in the same cohort (one
 *      notify() fanout → many channels). Siblings get marked used_at=NOW()
 *      with source='cascade' without being deleted — preserves the audit trail.
 *   3. For each sibling, rewrites its notification payload in place and, when
 *      Telegram chat/message ids were recorded at send time, strips the inline
 *      keyboard off the remote message so it can't be pressed again.
 *
 * Fire-and-forget. Never throws — we've already told the user "Done".
 */
'use strict';

const db = require('../../db');
const { burnCohortSiblings } = require('../action-tokens');

/**
 * Merge a "used" annotation into payload.actionable[] for the entry whose
 * client-visible token equals `tokenRaw` (we can't compare hashes from the
 * stored payload without re-hashing — but we _do_ know the row ids, so we
 * match by action_kind + target_id + target_type as a stable fingerprint).
 *
 * @param {Object} notifPayload   - parsed JSON payload
 * @param {Object} tokenRow       - action_tokens row
 * @param {Object} usage          - { used_by_source, used_by_user_id, used_at }
 * @returns {Object} the mutated payload
 */
function annotateActionable(notifPayload, tokenRow, usage) {
  if (!notifPayload || typeof notifPayload !== 'object') return notifPayload;
  const lists = [];
  if (Array.isArray(notifPayload.actionable)) lists.push(notifPayload.actionable);
  if (Array.isArray(notifPayload.actions))    lists.push(notifPayload.actions);
  for (const list of lists) {
    for (const btn of list) {
      if (!btn || btn.used) continue;
      const sameKind   = btn.action_kind === tokenRow.action_kind;
      const sameTarget = (btn.target_id ?? null) === (tokenRow.target_id ?? null)
                      && (btn.target_type ?? null) === (tokenRow.target_type ?? null);
      if (sameKind && sameTarget) {
        btn.used = true;
        btn.used_at = usage.used_at;
        btn.used_by_source = usage.used_by_source;
        btn.used_by_user_id = usage.used_by_user_id ?? null;
      }
    }
  }
  return notifPayload;
}

/**
 * Apply the annotation + (optionally) mark the notification read.
 */
async function rewriteNotification(notificationId, tokenRow, usage, { markRead } = { markRead: true }) {
  if (!notificationId) return;
  const notif = await db.prepare(
    'SELECT id, payload, read_at FROM user_notifications WHERE id = $1'
  ).get(notificationId).catch(() => null);
  if (!notif) return;

  let payload = notif.payload;
  if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { payload = {}; } }
  if (!payload || typeof payload !== 'object') payload = {};
  annotateActionable(payload, tokenRow, usage);

  try {
    if (markRead && !notif.read_at) {
      await db.prepare(
        `UPDATE user_notifications SET payload = $1, read_at = NOW() WHERE id = $2`
      ).run(JSON.stringify(payload), notif.id);
    } else {
      await db.prepare(
        `UPDATE user_notifications SET payload = $1 WHERE id = $2`
      ).run(JSON.stringify(payload), notif.id);
    }
  } catch (err) {
    console.error('[post-action] rewrite notification failed:', err.message);
  }
}

/**
 * SYNCHRONOUS phase: burn sibling tokens in the same cohort so the single-use
 * guarantee holds across channels even if the caller crashes before the
 * notification-rewrite/Telegram-cleanup phase finishes. Returns the pre-burn
 * sibling snapshot for the cleanup phase to operate on. Never throws.
 */
async function cascadeBurn(tokenRow) {
  if (!tokenRow || !tokenRow.cohort_id) return [];
  try {
    return await burnCohortSiblings(tokenRow.cohort_id, tokenRow.id, tokenRow.user_id);
  } catch (err) {
    console.error('[post-action] burnCohortSiblings failed:', err.message);
    return [];
  }
}

/**
 * FIRE-AND-FORGET phase: rewrites the primary notification + each sibling's
 * notification payload, and strips Telegram inline keyboards on siblings.
 * Safe to run after the HTTP response has been sent.
 */
async function cascadeCleanup(tokenRow, siblings, source) {
  if (!tokenRow) return;
  const actorUserId = tokenRow.user_id;
  const nowIso = new Date().toISOString();
  const primaryUsage = {
    used_at: nowIso,
    used_by_source: source || 'web',
    used_by_user_id: actorUserId,
  };

  // 1. Rewrite the notification row that hosted the primary token.
  try {
    await rewriteNotification(tokenRow.notification_id, tokenRow, primaryUsage, { markRead: true });
  } catch (err) {
    console.error('[post-action] primary rewrite failed:', err.message);
  }

  if (!siblings || !siblings.length) return;

  const cascadeUsage = {
    used_at: nowIso,
    used_by_source: 'cascade',
    used_by_user_id: actorUserId,
  };

  const { editMessageReplyMarkup } = (() => {
    try { return require('../messaging/telegram'); } catch { return {}; }
  })();

  for (const sib of siblings) {
    try {
      await rewriteNotification(sib.notification_id, sib, cascadeUsage, { markRead: true });
    } catch (err) {
      console.error('[post-action] sibling rewrite failed:', err.message);
    }
    if (editMessageReplyMarkup && sib.telegram_chat_id && sib.telegram_message_id) {
      editMessageReplyMarkup(sib.telegram_chat_id, sib.telegram_message_id, sib.tenant_id, [])
        .catch(() => {});
    }
  }
}

/**
 * Back-compat: full cascade in one call (burn + cleanup). New callers should
 * use cascadeBurn() synchronously and cascadeCleanup() fire-and-forget so the
 * sibling burn isn't lost if the cleanup phase is interrupted.
 */
async function cascade(tokenRow, source) {
  const siblings = await cascadeBurn(tokenRow);
  await cascadeCleanup(tokenRow, siblings, source);
}

module.exports = { cascade, cascadeBurn, cascadeCleanup };
