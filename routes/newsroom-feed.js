/**
 * Deep Feed AI Admin — /api/newsroom-feed
 * Read-only chronological activity feed (Social Newsroom Phase 2).
 * Gated by editor_workspace feature flag.
 */
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { auth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { asyncHandler } = require('../lib/utils');
const { isFeatureEnabled } = require('../lib/feature-registry');

async function requireWorkspaceEnabled(req, res, next) {
  const on = await isFeatureEnabled(req.tenantId, 'editor_workspace').catch(() => false);
  if (!on) return res.status(404).json({ error: 'Editor workspace is not enabled' });
  next();
}

// GET /api/newsroom-feed
//   ?type=published,pitched (csv) — filter event types
//   ?writer_id=N — filter by actor writer
//   ?days=N — lookback (default 7)
//   ?limit=N (default 100, max 500)
router.get('/', auth, requirePermission('articles.read'), requireWorkspaceEnabled, asyncHandler(async (req, res) => {
  const types = (req.query.type || '').split(',').map(s => s.trim()).filter(Boolean);
  const writerId = req.query.writer_id ? parseInt(req.query.writer_id, 10) : null;
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);

  const params = [req.tenantId, days];
  let sql = `
    SELECT e.*, w.name AS actor_writer_name, w.avatar_url AS actor_writer_avatar
    FROM newsroom_events e
    LEFT JOIN writers w ON w.id = e.actor_writer_id AND w.tenant_id = e.tenant_id
    WHERE e.tenant_id = $1
      AND e.created_at > NOW() - make_interval(days => $2)
  `;
  if (types.length) {
    params.push(types);
    sql += ` AND e.event_type = ANY($${params.length}::text[])`;
  }
  if (writerId) {
    params.push(writerId);
    sql += ` AND e.actor_writer_id = $${params.length}`;
  }
  params.push(limit);
  sql += ` ORDER BY e.created_at DESC LIMIT $${params.length}`;

  const rows = await db.prepare(sql).all(...params);
  res.json({ events: rows, count: rows.length });
}));

module.exports = router;
