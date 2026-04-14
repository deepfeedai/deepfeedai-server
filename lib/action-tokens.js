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
async function mint({ tenantId, userId, actionKind, targetId, targetType, payload, ttlSeconds = 172800 }) {
  const raw = crypto.randomBytes(24).toString('base64url');
  const tokenHash = _hash(raw);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  await db.prepare(`
    INSERT INTO action_tokens
      (token_hash, tenant_id, user_id, action_kind, target_id, target_type, payload, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `).run(
    tokenHash,
    tenantId,
    userId,
    actionKind,
    targetId ?? null,
    targetType ?? null,
    JSON.stringify(payload || {}),
    expiresAt
  );
  return raw;
}

/**
 * Verify a raw token and mark it used in one step. Throws on any failure.
 * @param {string} raw    - token as presented by the channel
 * @param {string} source - channel tag for auditing ('discord' | 'telegram' | 'slack' | 'email' | ...)
 * @returns {Promise<Object>} the action_tokens row (pre-burn snapshot)
 */
async function verifyAndBurn(raw, source) {
  const tokenHash = _hash(raw);
  const row = await db.prepare(`SELECT * FROM action_tokens WHERE token_hash = $1`).get(tokenHash);
  if (!row) throw new Error('invalid_token');
  if (row.used_at) throw new Error('already_used');
  if (new Date(row.expires_at) < new Date()) throw new Error('expired');
  await db.prepare(`UPDATE action_tokens SET used_at = NOW(), source = $1 WHERE id = $2`).run(source || null, row.id);
  return row;
}

module.exports = { mint, verifyAndBurn };
