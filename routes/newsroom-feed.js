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
    SELECT e.*, w.name AS actor_writer_name, w.avatar_url AS actor_writer_avatar,
           w.presence_state AS actor_writer_presence
    FROM newsroom_events e
    LEFT JOIN writers w ON w.id = e.actor_writer_id AND w.tenant_id = e.tenant_id
    WHERE e.tenant_id = $1
      AND e.created_at > NOW() - make_interval(days => $2)
      AND e.dismissed_at IS NULL
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

// POST /api/newsroom-feed/broadcast — editor posts a message to the newsroom board.
// Routes it to the top matching writers by beat, who reply asynchronously as feed replies.
router.post('/broadcast', auth, requirePermission('articles.read'), requireWorkspaceEnabled, asyncHandler(async (req, res) => {
  const { message } = req.body || {};
  if (!message || !message.trim()) return res.status(400).json({ error: 'message required' });
  if (message.length > 2000) return res.status(400).json({ error: 'message too long (max 2000)' });

  const userId = req.user?.sub || null;
  const userName = req.user?.name || req.user?.email || 'Editor';

  // Record the broadcast event immediately
  const { recordEvent } = require('../lib/newsroom-events');
  await recordEvent({
    tenantId: req.tenantId,
    type: 'editor_broadcast',
    actorUserId: userId,
    payload: { text: message.trim(), author: userName },
  });

  // Retrieve the just-inserted event id
  const event = await db.prepare(
    "SELECT id FROM newsroom_events WHERE tenant_id = $1 AND event_type = 'editor_broadcast' ORDER BY created_at DESC LIMIT 1"
  ).get(req.tenantId);

  // Route to top-3 writers by beat relevance (keyword overlap with message words)
  const words = message.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 3);
  const writers = await db.prepare(`
    SELECT DISTINCT w.id, w.name, w.slug,
      array_agg(DISTINCT c.name) AS beats
    FROM writers w
    JOIN writer_beats wb ON wb.writer_id = w.id AND wb.tenant_id = w.tenant_id
    JOIN categories c ON c.id = wb.category_id
    WHERE w.tenant_id = $1 AND w.is_auto = true AND w.role != 'editor' AND w.role != 'designer'
    GROUP BY w.id, w.name, w.slug
  `).all(req.tenantId);

  // Score each writer by how many message words appear in their beat names
  const scored = writers.map(w => {
    const beatStr = (w.beats || []).join(' ').toLowerCase();
    const score = words.filter(word => beatStr.includes(word)).length;
    return { ...w, score };
  }).sort((a, b) => b.score - a.score || 0);

  // Take top 3 (fallback: top 3 by any score, or just first 3 if all zero)
  const targets = scored.slice(0, 3);

  if (event && targets.length) {
    const messaging = require('../lib/messaging');
    for (const w of targets) {
      setImmediate(async () => {
        try {
          const ctxKey = `broadcast:${req.tenantId}:${w.id}`;
          const meta = { platform: 'web', userId: String(userId || 'editor'), userName };
          const resp = await messaging.handleIncoming(req.tenantId, w.id, message.trim(), ctxKey, meta);
          const text = typeof resp === 'string' ? resp : (resp?.text || '');
          if (!text || !event) return;
          await db.prepare(`
            INSERT INTO newsroom_replies (tenant_id, event_id, author_writer_id, content)
            VALUES ($1, $2, $3, $4)
          `).run(req.tenantId, event.id, w.id, text.slice(0, 4000));
        } catch (err) {
          console.warn('[newsroom-feed] broadcast dispatch failed for writer', w.id, err.message);
        }
      });
    }
  }

  res.status(201).json({ ok: true, event_id: event?.id || null, routed_to: targets.map(w => w.name) });
}));

// POST /api/newsroom-feed/trigger-brief — manually trigger a daily brief now
router.post('/trigger-brief', auth, requirePermission('articles.write'), requireWorkspaceEnabled, asyncHandler(async (req, res) => {
  const { generateDailyBrief } = require('../lib/writer-agent');
  const { recordEvent } = require('../lib/newsroom-events');

  const maxwell = await db.prepare(
    "SELECT id FROM writers WHERE tenant_id = $1 AND role = 'editor' AND is_system = true LIMIT 1"
  ).get(req.tenantId);

  const brief = await generateDailyBrief(req.tenantId);
  if (!brief) return res.status(500).json({ error: 'Brief generation returned empty — check AI provider config.' });

  await recordEvent({
    tenantId: req.tenantId,
    type: 'daily_brief',
    actorWriterId: maxwell?.id || null,
    payload: { ...brief, text: brief.prose, manual: true },
  });

  res.json({ ok: true });
}));

// POST /api/newsroom-feed/trigger-digest — manually trigger a weekly digest now
router.post('/trigger-digest', auth, requirePermission('articles.write'), requireWorkspaceEnabled, asyncHandler(async (req, res) => {
  const { generateWeeklyDigest } = require('../lib/writer-agent');
  const { recordEvent } = require('../lib/newsroom-events');

  const maxwell = await db.prepare(
    "SELECT id FROM writers WHERE tenant_id = $1 AND role = 'editor' AND is_system = true LIMIT 1"
  ).get(req.tenantId);

  const digest = await generateWeeklyDigest(req.tenantId);
  if (!digest) return res.status(500).json({ error: 'Digest generation returned empty — check AI provider config.' });

  await recordEvent({
    tenantId: req.tenantId,
    type: 'weekly_digest',
    actorWriterId: maxwell?.id || null,
    payload: { ...digest, text: digest.prose, manual: true },
  });

  res.json({ ok: true });
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

// Per-event cap on autonomous agent replies — guards against ping-pong loops + budget burn
const MAX_AGENT_REPLIES_PER_EVENT = 5;

// Parse @<slug-or-name> mentions from reply text. Matches both slug-style
// (@marcus, @marcus-cole) and word-boundary names. Case-insensitive lookup
// against writers in this tenant. Returns deduped writer rows.
async function _parseMentions(text, tenantId, excludeWriterId) {
  const handles = new Set();
  const re = /@([A-Za-z][A-Za-z0-9_-]{1,40})/g;
  let m;
  while ((m = re.exec(text)) !== null) handles.add(m[1].toLowerCase());
  if (!handles.size) return [];
  const arr = Array.from(handles);
  const writers = await db.prepare(`
    SELECT id, name, slug FROM writers
    WHERE tenant_id = $1
      AND (LOWER(slug) = ANY($2::text[]) OR LOWER(REPLACE(name, ' ', '')) = ANY($2::text[]) OR LOWER(SPLIT_PART(name, ' ', 1)) = ANY($2::text[]))
  `).all(tenantId, arr);
  // Don't dispatch to a writer mentioned by themselves (loop guard)
  return writers.filter(w => w.id !== excludeWriterId);
}

// POST /api/newsroom-feed/:eventId/replies — body: { content, parent_reply_id?, author_writer_id? }
router.post('/:eventId/replies', auth, requirePermission('articles.read'), requireWorkspaceEnabled, requireSocialEnabled, asyncHandler(async (req, res) => {
  const { content, parent_reply_id, author_writer_id } = req.body || {};
  if (!content || content.trim().length < 1) return res.status(400).json({ error: 'content required' });
  if (content.length > 4000) return res.status(400).json({ error: 'content too long (max 4000)' });
  const eventId = parseInt(req.params.eventId, 10);
  const event = await db.prepare('SELECT id FROM newsroom_events WHERE id = $1 AND tenant_id = $2').get(eventId, req.tenantId);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  const row = await db.prepare(`
    INSERT INTO newsroom_replies (tenant_id, event_id, parent_reply_id, author_writer_id, author_user_id, content)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
  `).get(
    req.tenantId, eventId, parent_reply_id || null,
    author_writer_id || null,
    author_writer_id ? null : (req.user?.sub || null),
    content.trim()
  );

  // Fan out to mentioned writer agents in the background (loop guard: don't
  // re-dispatch when the reply itself was authored by an agent)
  if (!author_writer_id) {
    const mentioned = await _parseMentions(content, req.tenantId, null);
    if (mentioned.length) {
      // Cap the number of autonomous agent replies per event lifetime
      const cnt = await db.prepare(
        `SELECT COUNT(*)::int AS n FROM newsroom_replies WHERE tenant_id = $1 AND event_id = $2 AND author_writer_id IS NOT NULL`
      ).get(req.tenantId, eventId);
      const slotsLeft = Math.max(0, MAX_AGENT_REPLIES_PER_EVENT - (cnt?.n || 0));
      const targets = mentioned.slice(0, slotsLeft);

      const messaging = require('../lib/messaging');
      for (const w of targets) {
        setImmediate(async () => {
          try {
            const stripped = content.replace(new RegExp('@' + w.slug + '\\b', 'gi'), '').trim();
            const ctxKey = `feed:${eventId}`;
            const meta = { platform: 'feed', userId: String(req.user?.sub || 'editor'), userName: req.user?.username || 'editor' };
            const resp = await messaging.handleIncoming(req.tenantId, w.id, stripped || content, ctxKey, meta);
            const text = typeof resp === 'string' ? resp : (resp?.text || '');
            if (!text) return;
            await db.prepare(`
              INSERT INTO newsroom_replies (tenant_id, event_id, parent_reply_id, author_writer_id, content)
              VALUES ($1, $2, $3, $4, $5)
            `).run(req.tenantId, eventId, row.id, w.id, text.slice(0, 4000));
          } catch (err) {
            console.warn('[newsroom-feed] mention dispatch failed for writer', w.id, err.message);
          }
        });
      }
    }
  }

  res.status(201).json(row);
}));

// DELETE /api/newsroom-feed/:eventId — dismiss an event from the feed
router.delete('/:eventId', auth, requirePermission('articles.read'), requireWorkspaceEnabled, asyncHandler(async (req, res) => {
  const eventId = parseInt(req.params.eventId, 10);
  if (!eventId) return res.status(400).json({ error: 'invalid_event_id' });
  const result = await db.prepare(
    `UPDATE newsroom_events SET dismissed_at = NOW()
      WHERE id = $1 AND tenant_id = $2 AND dismissed_at IS NULL RETURNING id`
  ).get(eventId, req.tenantId);
  if (!result) return res.status(404).json({ error: 'Event not found or already dismissed' });
  res.json({ ok: true, id: result.id });
}));

module.exports = router;
