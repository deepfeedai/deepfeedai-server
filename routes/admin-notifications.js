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

function mapRow(r) {
  let payload = r.payload;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { payload = {}; }
  }
  return {
    id:         r.id,
    kind:       r.kind,
    title:      r.title,
    body:       r.body,
    payload:    payload || {},
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
  const items = rows.slice(0, limit).map(mapRow);

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
