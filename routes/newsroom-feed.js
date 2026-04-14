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

  // Attach reaction tallies + reply counts for the event ids returned
  const ids = rows.map(r => r.id);
  let reactions = {};
  let replyCounts = {};
  if (ids.length) {
    const reactRows = await db.prepare(`
      SELECT event_id, emoji, COUNT(*)::int AS cnt
      FROM newsroom_reactions WHERE tenant_id = $1 AND event_id = ANY($2::int[])
      GROUP BY event_id, emoji
    `).all(req.tenantId, ids);
    for (const r of reactRows) {
      if (!reactions[r.event_id]) reactions[r.event_id] = {};
      reactions[r.event_id][r.emoji] = r.cnt;
    }
    const replyRows = await db.prepare(`
      SELECT event_id, COUNT(*)::int AS cnt FROM newsroom_replies
      WHERE tenant_id = $1 AND event_id = ANY($2::int[])
      GROUP BY event_id
    `).all(req.tenantId, ids);
    for (const r of replyRows) replyCounts[r.event_id] = r.cnt;
  }
  for (const ev of rows) {
    ev.reactions = reactions[ev.id] || {};
    ev.reply_count = replyCounts[ev.id] || 0;
  }

  res.json({ events: rows, count: rows.length });
}));

const ALLOWED_EMOJI = new Set(['🔥', '💡', '🚩', '👀']);

async function requireSocialEnabled(req, res, next) {
  const on = await isFeatureEnabled(req.tenantId, 'newsroom_social').catch(() => false);
  if (!on) return res.status(404).json({ error: 'Newsroom social features are not enabled' });
  next();
}

// POST /api/newsroom-feed/:eventId/react — body: { emoji }
router.post('/:eventId/react', auth, requirePermission('articles.read'), requireWorkspaceEnabled, requireSocialEnabled, asyncHandler(async (req, res) => {
  const { emoji } = req.body || {};
  if (!ALLOWED_EMOJI.has(emoji)) return res.status(400).json({ error: 'emoji must be one of: 🔥 💡 🚩 👀' });
  const eventId = parseInt(req.params.eventId, 10);
  const event = await db.prepare('SELECT id FROM newsroom_events WHERE id = $1 AND tenant_id = $2').get(eventId, req.tenantId);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  // Toggle: if this user already has this emoji on this event, remove it; else add
  const existing = await db.prepare(`
    SELECT id FROM newsroom_reactions
    WHERE tenant_id = $1 AND event_id = $2 AND emoji = $3 AND COALESCE(actor_user_id, 0) = $4
  `).get(req.tenantId, eventId, emoji, req.user?.sub || 0);

  if (existing) {
    await db.prepare('DELETE FROM newsroom_reactions WHERE id = $1').run(existing.id);
    res.json({ action: 'removed' });
  } else {
    await db.prepare(`
      INSERT INTO newsroom_reactions (tenant_id, event_id, actor_user_id, emoji) VALUES ($1, $2, $3, $4)
      ON CONFLICT DO NOTHING
    `).run(req.tenantId, eventId, req.user?.sub || null, emoji);
    res.json({ action: 'added' });
  }
}));

// GET /api/newsroom-feed/:eventId/replies
router.get('/:eventId/replies', auth, requirePermission('articles.read'), requireWorkspaceEnabled, requireSocialEnabled, asyncHandler(async (req, res) => {
  const eventId = parseInt(req.params.eventId, 10);
  const rows = await db.prepare(`
    SELECT r.*, w.name AS author_writer_name, w.avatar_url AS author_writer_avatar,
           u.username AS author_user_name
    FROM newsroom_replies r
    LEFT JOIN writers w ON w.id = r.author_writer_id AND w.tenant_id = r.tenant_id
    LEFT JOIN users   u ON u.id = r.author_user_id
    WHERE r.tenant_id = $1 AND r.event_id = $2
    ORDER BY r.created_at ASC
  `).all(req.tenantId, eventId);
  res.json({ replies: rows });
}));

// POST /api/newsroom-feed/:eventId/replies — body: { content, parent_reply_id? }
router.post('/:eventId/replies', auth, requirePermission('articles.read'), requireWorkspaceEnabled, requireSocialEnabled, asyncHandler(async (req, res) => {
  const { content, parent_reply_id } = req.body || {};
  if (!content || content.trim().length < 1) return res.status(400).json({ error: 'content required' });
  if (content.length > 4000) return res.status(400).json({ error: 'content too long (max 4000)' });
  const eventId = parseInt(req.params.eventId, 10);
  const event = await db.prepare('SELECT id FROM newsroom_events WHERE id = $1 AND tenant_id = $2').get(eventId, req.tenantId);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  const row = await db.prepare(`
    INSERT INTO newsroom_replies (tenant_id, event_id, parent_reply_id, author_user_id, content)
    VALUES ($1, $2, $3, $4, $5) RETURNING *
  `).get(req.tenantId, eventId, parent_reply_id || null, req.user?.sub || null, content.trim());

  res.status(201).json(row);
}));

module.exports = router;
