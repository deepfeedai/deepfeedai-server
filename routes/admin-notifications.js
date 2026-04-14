/**
 * Deep Feed AI — /api/admin-notifications (PR-D of notifications/actions system)
 *
 * Admin-facing in-app notification center, backed by user_notifications table
 * created in PR-A. Separate from /api/notifications (which serves the public
 * signed-in reader in-app inbox backed by the older `notifications` table).
 *
 * All endpoints require admin JWT (middleware/auth).
 * Scoped to req.user.sub|req.user.id + req.tenantId.
 *
 *   GET  /api/admin-notifications?unread=1&limit=50&offset=0
 *        → { items: [...], unread_count, has_more }
 *   GET  /api/admin-notifications/unread-count
 *        → { count }
 *   POST /api/admin-notifications/:id/read
 *        → { ok: true }
 *   POST /api/admin-notifications/mark-all-read
 *        → { ok: true, updated: N }
 */
'use strict';

const express = require('express');
const router  = express.Router();

const db = require('../db');
const { auth } = require('../middleware/auth');
const { asyncHandler } = require('../lib/utils');
const { isFeatureEnabled } = require('../lib/feature-registry');

// Every endpoint requires admin auth.
router.use(auth);

function uid(req) { return req.user && (req.user.sub || req.user.id); }

// Feature-gate helper — keeps handlers small.
async function requireFlag(req, res) {
  try {
    const on = await isFeatureEnabled(req.tenantId, 'notifications_center');
    if (!on) {
      res.status(403).json({ error: 'notifications_center_disabled' });
      return false;
    }
    return true;
  } catch {
    // Failing closed here would kill the bell entirely; fail open on registry errors.
    return true;
  }
}

function relTime(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60)     return 'just now';
  if (s < 3600)   return Math.floor(s / 60) + 'm ago';
  if (s < 86400)  return Math.floor(s / 3600) + 'h ago';
  if (s < 604800) return Math.floor(s / 86400) + 'd ago';
  return new Date(t).toLocaleDateString();
}

/**
 * Walk the payload.actionable[] / actions[] arrays and annotate each button
 * based on the token's current state. Handlers render these dumb-ly:
 *   - used      → disabled pill, label prefixed with ✓ and used-by-source
 *   - expired   → disabled pill, label prefixed with ⌛
 *   - otherwise → normal click-to-act button
 *
 * Done in a single batched SELECT to avoid N+1.
 */
async function enrichActionableTokens(rows) {
  const payloads = rows.map(r => {
    let p = r.payload;
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch { p = {}; } }
    return p || {};
  });

  // Collect every token referenced in every payload.
  const tokens = new Set();
  for (const p of payloads) {
    for (const list of [p.actionable, p.actions]) {
      if (!Array.isArray(list)) continue;
      for (const b of list) if (b && b.token) tokens.add(b.token);
    }
  }
  if (!tokens.size) return payloads;

  // We only store the HMAC hash, so re-hash and look up by hash.
  let tokenRows = [];
  try {
    const crypto = require('crypto');
    const SECRET = process.env.ACTION_TOKEN_SECRET || process.env.JWT_SECRET;
    if (SECRET) {
      const hashes = Array.from(tokens).map(raw =>
        crypto.createHmac('sha256', SECRET).update(raw).digest('hex'));
      const byHash = new Map(Array.from(tokens).map((raw, i) => [hashes[i], raw]));
      const found = await db.prepare(
        `SELECT token_hash, used_at, used_by_source, expires_at
           FROM action_tokens
          WHERE token_hash = ANY($1::text[])`
      ).all(hashes);
      tokenRows = found.map(r => ({ ...r, raw: byHash.get(r.token_hash) }));
    }
  } catch (err) {
    console.error('[admin-notifications] token enrichment failed:', err.message);
  }

  const byRaw = new Map();
  for (const r of tokenRows) byRaw.set(r.raw, r);
  const now = Date.now();

  for (const p of payloads) {
    for (const list of [p.actionable, p.actions]) {
      if (!Array.isArray(list)) continue;
      for (const btn of list) {
        if (!btn || !btn.token) continue;
        const info = byRaw.get(btn.token);
        if (!info) {
          // Token deleted by sweep → treat as expired.
          btn.expired = true;
          btn.label = '⌛ Expired';
          continue;
        }
        const originalLabel = btn.label || 'Do';
        if (info.used_at) {
          btn.used = true;
          btn.used_at = info.used_at;
          btn.used_by_source = info.used_by_source || btn.used_by_source || 'web';
          btn.label = '✓ ' + originalLabel
            + ' (from ' + btn.used_by_source + ', ' + relTime(info.used_at) + ')';
        } else if (info.expires_at && new Date(info.expires_at).getTime() < now) {
          btn.expired = true;
          btn.label = '⌛ ' + originalLabel + ' (expired)';
        }
      }
    }
  }
  return payloads;
}

function mapRowWith(r, enrichedPayload) {
  return {
    id:         r.id,
    kind:       r.kind,
    title:      r.title,
    body:       r.body,
    payload:    enrichedPayload || {},
    read_at:    r.read_at,
    created_at: r.created_at,
  };
}

// GET / — list
router.get('/', asyncHandler(async (req, res) => {
  if (!(await requireFlag(req, res))) return;
  const userId   = uid(req);
  const tenantId = req.tenantId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit  || '50', 10)));
  const offset = Math.max(0, parseInt(req.query.offset || '0', 10));
  const unreadOnly = req.query.unread === '1' || req.query.unread === 'true';

  const where = unreadOnly
    ? 'WHERE tenant_id = $1 AND user_id = $2 AND read_at IS NULL'
    : 'WHERE tenant_id = $1 AND user_id = $2';

  const rows = await db.prepare(
    `SELECT id, kind, title, body, payload, read_at, created_at
       FROM user_notifications
       ${where}
       ORDER BY created_at DESC
       LIMIT $3 OFFSET $4`
  ).all(tenantId, userId, limit + 1, offset);

  const hasMore = rows.length > limit;
  const sliced = rows.slice(0, limit);
  const enriched = await enrichActionableTokens(sliced);
  const items = sliced.map((r, i) => mapRowWith(r, enriched[i]));

  const unreadRow = await db.prepare(
    `SELECT COUNT(*)::int AS cnt FROM user_notifications
      WHERE tenant_id = $1 AND user_id = $2 AND read_at IS NULL`
  ).get(tenantId, userId);

  res.json({
    items,
    unread_count: (unreadRow && unreadRow.cnt) || 0,
    has_more: hasMore,
  });
}));

// GET /unread-count — lightweight poll
router.get('/unread-count', asyncHandler(async (req, res) => {
  if (!(await requireFlag(req, res))) return;
  const userId = uid(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const row = await db.prepare(
    `SELECT COUNT(*)::int AS cnt FROM user_notifications
      WHERE tenant_id = $1 AND user_id = $2 AND read_at IS NULL`
  ).get(req.tenantId, userId);
  res.json({ count: (row && row.cnt) || 0 });
}));

// POST /:id/read
router.post('/:id/read', asyncHandler(async (req, res) => {
  if (!(await requireFlag(req, res))) return;
  const userId = uid(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'invalid_id' });

  await db.prepare(
    `UPDATE user_notifications
        SET read_at = NOW()
      WHERE id = $1 AND user_id = $2 AND tenant_id = $3 AND read_at IS NULL`
  ).run(id, userId, req.tenantId);
  res.json({ ok: true });
}));

// POST /mark-all-read
router.post('/mark-all-read', asyncHandler(async (req, res) => {
  if (!(await requireFlag(req, res))) return;
  const userId = uid(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  await db.prepare(
    `UPDATE user_notifications
        SET read_at = NOW()
      WHERE user_id = $1 AND tenant_id = $2 AND read_at IS NULL`
  ).run(userId, req.tenantId);
  res.json({ ok: true });
}));

module.exports = router;
