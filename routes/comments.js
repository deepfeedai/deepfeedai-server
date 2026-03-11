/**
 * Deep Feed AI — routes/comments.js
 * Public comment system for article pages.
 *
 * Public endpoints (no auth):
 *   GET  /api/comments?slug=         — fetch comments for an article
 *   GET  /api/comments/leaderboard   — top commenters by count (public)
 *
 * User endpoints (requireUser middleware):
 *   POST   /api/comments              — post a comment (rate-limited)
 *   PUT    /api/comments/:id          — edit own comment (10-min window)
 *   DELETE /api/comments/:id          — soft-delete own comment
 *   POST   /api/comments/:id/report   — report a comment
 *
 * Admin endpoints (requireAdmin middleware):
 *   GET    /api/comments/admin        — list all comments (with reports count)
 *   DELETE /api/comments/admin/:id    — hard-delete any comment
 *   POST   /api/comments/admin/:id/hide — hide (soft-delete) any comment
 */

'use strict';

const express   = require('express');
const rateLimit = require('express-rate-limit');
const jwt       = require('jsonwebtoken');
const db        = require('../db');
const requireUser  = require('../middleware/user-jwt');
const { auth: requireAdmin } = require('../middleware/auth');
const { asyncHandler } = require('../lib/utils');

const router = express.Router();

const MAX_BODY_LEN   = 1000;
const EDIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const ALLOWED_EMOJIS = new Set(['👍', '❤️', '😂', '😮']);

/* ── Rate limiter — 5 comments per 5 min per user ────────────────── */
const commentRateLimit = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Too many comments. Please wait a few minutes before posting again.' },
  // Suppress IPv6 key generator validation — we handle this in keyGenerator above
  validate: { keyGeneratorIpFallback: false },
  keyGenerator: (req) => {
    // Limit by user ID (from JWT) rather than IP — fairer for shared networks
    try {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        const payload = jwt.decode(authHeader.slice(7));
        if (payload?.sub) return `user:${payload.sub}`;
      }
    } catch {}
    return req.ip || 'unknown';
  },
});

/* ── Helpers ─────────────────────────────────────────────────────── */

/** Strip HTML tags and trim. Returns sanitized string or null if empty. */
function sanitizeBody(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const stripped = raw.replace(/<[^>]*>/g, '').trim();
  if (!stripped) return null;
  if (stripped.length > MAX_BODY_LEN) return stripped.slice(0, MAX_BODY_LEN);
  return stripped;
}

/** Shape a raw DB comment row into a safe public object */
function formatComment(row) {
  const isDeleted = !!row.is_deleted;
  return {
    id:          row.id,
    articleSlug: row.article_slug,
    parentId:    row.parent_id || null,
    body:        isDeleted ? null : row.body,
    isDeleted,
    createdAt:   row.created_at,
    updatedAt:   row.updated_at,
    user: isDeleted ? null : {
      id:          row.user_id,
      displayName: row.display_name,
      avatarUrl:   row.avatar_url || null,
      provider:    row.provider,
    },
  };
}

/* ── GET /api/comments?slug= ─────────────────────────────────────── */
// Fetches all non-hard-deleted comments for an article, joined with user info
// and aggregated reaction counts. Optional ?viewer_id= to flag user's own reaction.
router.get('/', asyncHandler(async (req, res) => {
  const { slug, viewer_id } = req.query;
  if (!slug) return res.status(400).json({ error: 'slug is required' });

  const rows = await db.prepare(`
    SELECT
      c.id, c.article_slug, c.parent_id, c.body, c.is_deleted,
      c.created_at, c.updated_at, c.user_id,
      u.display_name, u.avatar_url, u.provider
    FROM comments c
    LEFT JOIN public_users u ON u.id = c.user_id
    WHERE c.article_slug = $1
    ORDER BY c.created_at ASC
  `).all(slug);

  // Batch-fetch reaction counts for all comments in one query
  const ids = rows.map(r => r.id);
  let reactionMap = {};   // { commentId: { '👍': 3, '❤️': 1 } }
  let myReactions  = {};  // { commentId: '👍' }

  if (ids.length > 0) {
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
    const rxRows = await db.prepare(`
      SELECT comment_id, emoji, COUNT(*) AS cnt
      FROM comment_reactions
      WHERE comment_id IN (${placeholders})
      GROUP BY comment_id, emoji
    `).all(...ids);

    for (const r of rxRows) {
      if (!reactionMap[r.comment_id]) reactionMap[r.comment_id] = {};
      reactionMap[r.comment_id][r.emoji] = parseInt(r.cnt, 10);
    }

    // If viewer is authenticated, fetch their reactions too
    const viewerId = parseInt(viewer_id, 10);
    if (viewerId) {
      const myRows = await db.prepare(`
        SELECT comment_id, emoji FROM comment_reactions
        WHERE comment_id IN (${placeholders}) AND user_id = $${ids.length + 1}
      `).all(...ids, viewerId);
      for (const r of myRows) myReactions[r.comment_id] = r.emoji;
    }
  }

  const comments = rows.map(r => ({
    ...formatComment(r),
    reactions:   reactionMap[r.id]  || {},
    myReaction:  myReactions[r.id]  || null,
  }));

  res.json({ comments, count: rows.filter(r => !r.is_deleted).length });
}));

/* ── GET /api/comments/leaderboard ──────────────────────────────────
   Public endpoint — returns top N commenters ranked by comment count.
   ?limit=10 (max 50)
 ─────────────────────────────────────────────────────────────────── */
router.get('/leaderboard', asyncHandler(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);

  const rows = await db.prepare(`
    SELECT
      u.id,
      u.display_name,
      u.avatar_url,
      u.provider,
      COUNT(c.id) AS comment_count
    FROM public_users u
    JOIN comments c ON c.user_id = u.id
    WHERE c.is_deleted = 0
      AND u.is_banned  = 0
    GROUP BY u.id, u.display_name, u.avatar_url, u.provider
    ORDER BY comment_count DESC
    LIMIT $1
  `).all(limit);

  res.json({
    leaderboard: rows.map((r, i) => ({
      rank:         i + 1,
      id:           r.id,
      displayName:  r.display_name,
      avatarUrl:    r.avatar_url || null,
      provider:     r.provider,
      commentCount: parseInt(r.comment_count, 10),
    })),
  });
}));

/* ── POST /api/comments — post a new comment ─────────────────────── */
router.post('/', commentRateLimit, requireUser, asyncHandler(async (req, res) => {
  const { slug, body, parentId } = req.body;
  if (!slug) return res.status(400).json({ error: 'slug is required' });

  const clean = sanitizeBody(body);
  if (!clean) return res.status(400).json({ error: 'Comment body is required' });

  // Validate parent exists and belongs to same article
  if (parentId) {
    const parent = await db.prepare(
      'SELECT id, article_slug FROM comments WHERE id = $1 AND is_deleted = 0'
    ).get(parentId);
    if (!parent || parent.article_slug !== slug) {
      return res.status(400).json({ error: 'Invalid parent comment' });
    }
    // Only one level of nesting
    const grandparent = await db.prepare(
      'SELECT parent_id FROM comments WHERE id = $1'
    ).get(parentId);
    if (grandparent?.parent_id) {
      return res.status(400).json({ error: 'Replies can only be one level deep' });
    }
  }

  const row = await db.prepare(`
    INSERT INTO comments (article_slug, user_id, body, parent_id)
    VALUES ($1, $2, $3, $4)
    RETURNING *
  `).get(slug, req.user.sub, clean, parentId || null);

  // Attach user info for immediate render
  const user = await db.prepare(
    'SELECT display_name, avatar_url, provider FROM public_users WHERE id = $1'
  ).get(req.user.sub);

  res.status(201).json({
    comment: formatComment({ ...row, ...user }),
  });
}));

/* ── PUT /api/comments/:id — edit own comment ────────────────────── */
router.put('/:id', requireUser, asyncHandler(async (req, res) => {
  const id   = parseInt(req.params.id, 10);
  const clean = sanitizeBody(req.body.body);
  if (!clean) return res.status(400).json({ error: 'Comment body is required' });

  const existing = await db.prepare(
    'SELECT * FROM comments WHERE id = $1 AND is_deleted = 0'
  ).get(id);
  if (!existing) return res.status(404).json({ error: 'Comment not found' });
  if (existing.user_id !== req.user.sub) return res.status(403).json({ error: 'Forbidden' });

  // Enforce 10-minute edit window
  const age = Date.now() - new Date(existing.created_at).getTime();
  if (age > EDIT_WINDOW_MS) {
    return res.status(403).json({ error: 'Edit window has closed (10 minutes after posting)' });
  }

  const updated = await db.prepare(`
    UPDATE comments SET body = $1, updated_at = NOW()
    WHERE id = $2 RETURNING *
  `).get(clean, id);

  const user = await db.prepare(
    'SELECT display_name, avatar_url, provider FROM public_users WHERE id = $1'
  ).get(req.user.sub);

  res.json({ comment: formatComment({ ...updated, ...user }) });
}));

/* ── DELETE /api/comments/:id — soft-delete own comment ─────────── */
router.delete('/:id', requireUser, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);

  const existing = await db.prepare(
    'SELECT * FROM comments WHERE id = $1 AND is_deleted = 0'
  ).get(id);
  if (!existing) return res.status(404).json({ error: 'Comment not found' });
  if (existing.user_id !== req.user.sub) return res.status(403).json({ error: 'Forbidden' });

  await db.prepare(
    'UPDATE comments SET is_deleted = 1, body = NULL, updated_at = NOW() WHERE id = $1'
  ).run(id);

  res.json({ ok: true });
}));

/* ── POST /api/comments/:id/report ──────────────────────────────── */
router.post('/:id/report', requireUser, asyncHandler(async (req, res) => {
  const id     = parseInt(req.params.id, 10);
  const reason = (req.body.reason || '').slice(0, 200) || null;

  const existing = await db.prepare(
    'SELECT id FROM comments WHERE id = $1 AND is_deleted = 0'
  ).get(id);
  if (!existing) return res.status(404).json({ error: 'Comment not found' });

  // Can't report your own comment
  const comment = await db.prepare('SELECT user_id FROM comments WHERE id = $1').get(id);
  if (comment.user_id === req.user.sub) {
    return res.status(400).json({ error: "You can't report your own comment" });
  }

  try {
    await db.prepare(
      'INSERT INTO comment_reports (comment_id, user_id, reason) VALUES ($1, $2, $3)'
    ).run(id, req.user.sub, reason);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23505') { // unique_violation — already reported
      return res.status(409).json({ error: 'You have already reported this comment' });
    }
    throw err;
  }
}));

/* ── POST /api/comments/:id/react ────────────────────────────────── */
// Toggle a reaction on a comment. If the user already reacted with the same
// emoji, it's removed (unlike). If they reacted with a different emoji, it's
// swapped. Passing no emoji or an empty string removes any existing reaction.
router.post('/:id/react', requireUser, asyncHandler(async (req, res) => {
  const id    = parseInt(req.params.id, 10);
  const emoji = (req.body.emoji || '').trim();

  // Validate emoji if provided
  if (emoji && !ALLOWED_EMOJIS.has(emoji)) {
    return res.status(400).json({ error: 'Invalid emoji. Allowed: 👍 ❤️ 😂 😮' });
  }

  const comment = await db.prepare(
    'SELECT id, user_id FROM comments WHERE id = $1 AND is_deleted = 0'
  ).get(id);
  if (!comment) return res.status(404).json({ error: 'Comment not found' });

  // Fetch any existing reaction from this user
  const existing = await db.prepare(
    'SELECT emoji FROM comment_reactions WHERE comment_id = $1 AND user_id = $2'
  ).get(id, req.user.sub);

  if (!emoji || (existing && existing.emoji === emoji)) {
    // Remove reaction (toggle off or explicit remove)
    await db.prepare(
      'DELETE FROM comment_reactions WHERE comment_id = $1 AND user_id = $2'
    ).run(id, req.user.sub);
  } else if (existing) {
    // Swap to different emoji
    await db.prepare(
      'UPDATE comment_reactions SET emoji = $1 WHERE comment_id = $2 AND user_id = $3'
    ).run(emoji, id, req.user.sub);
  } else {
    // New reaction
    await db.prepare(
      'INSERT INTO comment_reactions (comment_id, user_id, emoji) VALUES ($1, $2, $3)'
    ).run(id, req.user.sub, emoji);
  }

  // Return fresh counts for this comment
  const counts = await db.prepare(`
    SELECT emoji, COUNT(*) AS cnt
    FROM comment_reactions WHERE comment_id = $1
    GROUP BY emoji
  `).all(id);

  const reactions = {};
  for (const r of counts) reactions[r.emoji] = parseInt(r.cnt, 10);

  const myReaction = (!emoji || (existing && existing.emoji === emoji))
    ? null
    : emoji;

  res.json({ ok: true, reactions, myReaction });
}));

/* ── Admin: GET /api/comments/admin ──────────────────────────────── */
router.get('/admin', requireAdmin, asyncHandler(async (req, res) => {
  const { slug, reported } = req.query;

  let sql = `
    SELECT
      c.id, c.article_slug, c.parent_id, c.body, c.is_deleted,
      c.created_at, c.updated_at, c.user_id,
      u.display_name, u.avatar_url, u.provider,
      (SELECT COUNT(*) FROM comment_reports r WHERE r.comment_id = c.id) AS report_count
    FROM comments c
    LEFT JOIN public_users u ON u.id = c.user_id
  `;
  const params = [];

  if (slug) {
    params.push(slug);
    sql += ` WHERE c.article_slug = $${params.length}`;
  }
  if (reported === '1') {
    sql += params.length ? ' AND' : ' WHERE';
    sql += ` (SELECT COUNT(*) FROM comment_reports r WHERE r.comment_id = c.id) > 0`;
  }

  sql += ' ORDER BY c.created_at DESC';

  const rows = await db.prepare(sql).all(...params);
  res.json({ comments: rows.map(r => ({ ...formatComment(r), reportCount: parseInt(r.report_count, 10) })) });
}));

/* ── Admin: POST /api/comments/admin/:id/hide ─────────────────────── */
router.post('/admin/:id/hide', requireAdmin, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await db.prepare(
    'UPDATE comments SET is_deleted = 1, body = NULL, updated_at = NOW() WHERE id = $1'
  ).run(id);
  // Clear reports after hiding
  await db.prepare('DELETE FROM comment_reports WHERE comment_id = $1').run(id);
  res.json({ ok: true });
}));

/* ── Admin: DELETE /api/comments/admin/:id ────────────────────────── */
router.delete('/admin/:id', requireAdmin, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await db.prepare('DELETE FROM comments WHERE id = $1').run(id);
  res.json({ ok: true });
}));

module.exports = router;
