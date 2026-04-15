/**
 * Deep Feed AI — Action Tokens
 *
 * Single-use HMAC-signed tokens that let users perform actions (approve / reject /
 * assign) from outside the admin UI — e.g. a Discord button, a Telegram inline
 * keyboard, a Slack action, or an email link.
 *
 * Design:
 *   - Raw token is random 24 bytes, base64url-encoded. Never persisted.
 *   - Only the HMAC-SHA256 (ACTION_TOKEN_SECRET → JWT_SECRET fallback) is stored.
 *   - Tokens are burned on first successful verify (used_at set).
 *   - Default TTL: 48h. Callers can override via ttlSeconds.
 *
 * PR-A scope: module only. Endpoints + channel renderers land in later PRs.
 */
'use strict';

const crypto = require('crypto');
const db = require('../db');

const SECRET = process.env.ACTION_TOKEN_SECRET || process.env.JWT_SECRET;

function _hash(raw) {
  if (!SECRET) throw new Error('ACTION_TOKEN_SECRET (or JWT_SECRET) not configured');
  return crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
}

/**
 * Mint a new single-use action token.
 * @param {Object} opts
 * @param {number} opts.tenantId
 * @param {number} opts.userId       - user who is authorized to perform the action
 * @param {string} opts.actionKind   - e.g. 'pitch.approve', 'pitch.reject', 'pitch.assign'
 * @param {number} [opts.targetId]
 * @param {string} [opts.targetType] - e.g. 'pitch', 'article'
 * @param {Object} [opts.payload]    - extra context restored on verify
 * @param {number} [opts.ttlSeconds] - default 48h
 * @returns {Promise<string>} raw token to embed in the channel message / link
 */
async function mint({ tenantId, userId, actionKind, targetId, targetType, payload, ttlSeconds = 172800, cohortId = null }) {
  const raw = crypto.randomBytes(24).toString('base64url');
  const tokenHash = _hash(raw);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const inserted = await db.prepare(`
    INSERT INTO action_tokens
      (token_hash, tenant_id, user_id, action_kind, target_id, target_type, payload, expires_at, cohort_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING id
  `).get(
    tokenHash,
    tenantId,
    userId,
    actionKind,
    targetId ?? null,
    targetType ?? null,
    JSON.stringify(payload || {}),
    expiresAt,
    cohortId
  );
  // Return both the raw token (for embedding) and the row id (for back-linking
  // a notification_id / telegram message ids after the token has been created).
  return { raw, tokenHash, id: inserted?.id };
}

/**
 * Back-compat wrapper for callers that only want the raw token string.
 * Prefer mint() for new code so you can record the row id.
 */
async function mintRaw(opts) {
  const r = await mint(opts);
  return r.raw;
}

/**
 * Attach a user_notifications.id to an already-minted action_token row so
 * the action handler can later rewrite that notification's payload.actionable[]
 * in place (mark used / expired) instead of scanning payload::text.
 */
async function setNotificationId(tokenRowId, notificationId) {
  if (!tokenRowId || !notificationId) return;
  try {
    await db.prepare(
      'UPDATE action_tokens SET notification_id = $1 WHERE id = $2'
    ).run(notificationId, tokenRowId);
  } catch (err) {
    console.error('[action-tokens] setNotificationId failed:', err.message);
  }
}

/**
 * Record the Telegram chat/message the token was delivered to. Called by the
 * Telegram dispatcher immediately after sendActionable so a later cohort
 * cascade can strip the inline keyboard off sibling messages.
 */
async function setTelegramMessage(tokenRowId, chatId, messageId) {
  if (!tokenRowId || !chatId || !messageId) return;
  try {
    await db.prepare(
      'UPDATE action_tokens SET telegram_chat_id = $1, telegram_message_id = $2 WHERE id = $3'
    ).run(String(chatId), Number(messageId), tokenRowId);
  } catch (err) {
    console.error('[action-tokens] setTelegramMessage failed:', err.message);
  }
}

/**
 * Mark sibling tokens in a cohort used (without deleting them) so a single
 * cohort-wide decision cascades to every channel fanout. Returns the list of
 * sibling rows so the caller can update their user_notifications payloads and
 * strip remote message keyboards.
 *
 * @param {string} cohortId
 * @param {number} exceptId   - the token row that triggered the cascade
 * @param {number} actorUserId- user who took the successful action
 * @returns {Promise<Array>}  - sibling rows (pre-burn snapshot)
 */
async function burnCohortSiblings(cohortId, exceptId, actorUserId) {
  if (!cohortId) return [];
  const siblings = await db.prepare(`
    SELECT * FROM action_tokens
     WHERE cohort_id = $1
       AND id <> $2
       AND used_at IS NULL
  `).all(cohortId, exceptId || 0);
  if (!siblings.length) return [];
  await db.prepare(`
    UPDATE action_tokens
       SET used_at = NOW(),
           source = 'cascade',
           used_by_source = 'cascade',
           used_by_user_id = $1
     WHERE cohort_id = $2
       AND id <> $3
       AND used_at IS NULL
  `).run(actorUserId || null, cohortId, exceptId || 0);
  return siblings;
}

/**
 * Verify a raw token and mark it used in one step. Throws on any failure.
 * Atomic: a single conditional UPDATE prevents the classic check-then-act race
 * where two concurrent presses both pass the SELECT-side guards before either
 * has written used_at. Only the row that the UPDATE actually mutates is
 * returned; everyone else gets the appropriate error from the read-only
 * follow-up lookup.
 *
 * @param {string} raw           - token as presented by the channel
 * @param {string} source        - channel tag for auditing ('discord' | 'telegram' | 'slack' | 'email' | ...)
 * @param {number|null} actorUserId - user who actually pressed/clicked; defaults
 *   to null which preserves prior behaviour for legacy callers. Stored on
 *   used_by_user_id so post-action.rewriteNotification finds the right state.
 * @returns {Promise<Object>} the action_tokens row (pre-burn snapshot semantics)
 */
async function verifyAndBurn(raw, source, actorUserId = null) {
  const tokenHash = _hash(raw);
  const row = await db.prepare(`
    UPDATE action_tokens
       SET used_at = NOW(),
           source = $2,
           used_by_source = $2,
           used_by_user_id = $3
     WHERE token_hash = $1
       AND used_at IS NULL
       AND expires_at > NOW()
     RETURNING *
  `).get(tokenHash, source || null, actorUserId);
  if (row) return row;

  // Distinguish missing vs. used vs. expired for a useful error message.
  const existing = await db.prepare(
    'SELECT used_at, expires_at FROM action_tokens WHERE token_hash = $1'
  ).get(tokenHash);
  if (!existing) throw new Error('invalid_token');
  if (existing.used_at) throw new Error('already_used');
  if (new Date(existing.expires_at) <= new Date()) throw new Error('expired');
  throw new Error('invalid_token');
}

module.exports = {
  mint,
  mintRaw,
  verifyAndBurn,
  setNotificationId,
  setTelegramMessage,
  burnCohortSiblings,
};
