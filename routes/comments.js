/**
 * Deep Feed AI — routes/comments.js
 * Public comment system for article pages.
 *
 * Public endpoints (no auth):
 *   GET  /api/comments?slug=         — fetch comments for an article
 *   GET  /api/comments/leaderboard   — top commenters by count (public)
 *
 * User endpoints (requireUser middleware):
 *   POST   /api/comments                    — post a comment (queued if new user)
 *   PUT    /api/comments/:id                — edit own comment (10-min window)
 *   DELETE /api/comments/:id                — soft-delete own comment
 *   POST   /api/comments/:id/report         — report a comment
 *   POST   /api/comments/:id/react          — toggle emoji reaction
 *
 * Admin endpoints (requireAdmin middleware):
 *   GET    /api/comments/admin              — list all comments (with reports count)
 *   GET    /api/comments/admin/queue        — pending (unapproved) comments
 *   POST   /api/comments/admin/:id/approve  — approve a queued comment
 *   POST   /api/comments/admin/:id/reject   — reject (hard-delete) a queued comment
 *   DELETE /api/comments/admin/:id          — hard-delete any comment
 *   POST   /api/comments/admin/:id/hide     — hide (soft-delete) any comment
 *
 * Moderation queue:
 *   Controlled by settings: mod_queue_enabled (0/1), mod_queue_threshold (int).
 *   New users whose approved comment count is below the threshold have new comments
 *   held as is_approved=0. Once they hit the threshold they are auto-trusted.
 *   Public GET only returns is_approved=1 comments.
 */

'use strict';

const express   = require('express');
const rateLimit = require('express-rate-limit');
const jwt       = require('jsonwebtoken');
const db        = require('../db');
const requireUser  = require('../middleware/user-jwt');
const { auth: requireAdmin } = require('../middleware/auth');
const { requirePermission }  = require('../middleware/permissions');
const { asyncHandler } = require('../lib/utils');
const { checkSpam }            = require('../lib/spam');
const { logAudit }             = require('../middleware/audit');
const { sendReplyNotification } = require('../lib/notify');
const { createReplyNotification } = require('./notifications');
const { decryptSetting }       = require('../lib/crypto');

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
    // Limit by verified user ID if available (set by requireUser middleware),
    // otherwise fall back to IP
    if (req.user?.sub) return `user:${req.user.sub}`;
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
    spamScore:   row.spam_score  != null ? parseFloat(row.spam_score)  : null,
    spamReason:  row.spam_reason || null,
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
  const { slug } = req.query;
  if (!slug) return res.status(400).json({ error: 'slug is required' });

  // Derive viewer ID from JWT if present (never from query param — prevents IDOR)
  let viewer_id = null;
  try {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const payload = jwt.decode(authHeader.slice(7));
      if (payload?.sub) viewer_id = payload.sub;
    }
  } catch { /* no viewer */ }

  const rows = await db.prepare(`
    SELECT
      c.id, c.article_slug, c.parent_id, c.body, c.is_deleted, c.is_approved,
      c.created_at, c.updated_at, c.user_id,
      u.display_name, u.avatar_url, u.provider
    FROM comments c
    LEFT JOIN public_users u ON u.id = c.user_id
    WHERE c.article_slug = $1
      AND c.tenant_id = $2
      AND (c.is_approved = 1 OR c.is_approved IS NULL)
    ORDER BY c.created_at ASC
  `).all(slug, req.tenantId);

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
        AND tenant_id = $${ids.length + 1}
      GROUP BY comment_id, emoji
    `).all(...ids, req.tenantId);

    for (const r of rxRows) {
      if (!reactionMap[r.comment_id]) reactionMap[r.comment_id] = {};
      reactionMap[r.comment_id][r.emoji] = parseInt(r.cnt, 10);
    }

    // If viewer is authenticated, fetch their reactions too
    const viewerId = parseInt(viewer_id, 10);
    if (viewerId) {
      const myRows = await db.prepare(`
        SELECT comment_id, emoji FROM comment_reactions
        WHERE comment_id IN (${placeholders}) AND user_id = $${ids.length + 1} AND tenant_id = $${ids.length + 2}
      `).all(...ids, viewerId, req.tenantId);
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
      AND c.tenant_id = $1
      AND u.is_banned  = 0
    GROUP BY u.id, u.display_name, u.avatar_url, u.provider
    ORDER BY comment_count DESC
    LIMIT $2
  `).all(req.tenantId, limit);

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
router.post('/', requireUser, commentRateLimit, asyncHandler(async (req, res) => {
  const { slug, body, parentId } = req.body;
  if (!slug) return res.status(400).json({ error: 'slug is required' });

  const clean = sanitizeBody(body);
  if (!clean) return res.status(400).json({ error: 'Comment body is required' });

  // Validate parent exists (not deleted). Slug match intentionally removed —
  // the parent's stored slug may differ slightly from the computed slug if the
  // article title changed, causing false rejections. The reply's own slug is
  // set from the frontend which is authoritative.
  if (parentId) {
    const parent = await db.prepare(
      'SELECT id, parent_id FROM comments WHERE id = $1 AND tenant_id = $2 AND is_deleted = 0'
    ).get(parentId, req.tenantId);
    if (!parent) {
      return res.status(400).json({ error: 'Invalid parent comment' });
    }
    // Only one level of nesting
    if (parent.parent_id) {
      return res.status(400).json({ error: 'Replies can only be one level deep' });
    }
  }

  // ── Spam detection ───────────────────────────────────────────────
  const spamSettings = await db.prepare(`
    SELECT key, value FROM settings
    WHERE tenant_id = $1 AND key IN ('spam_blocklist','spam_perspective_enabled','spam_perspective_key','spam_block_threshold','spam_queue_threshold')
  `).all(req.tenantId);
  const spamMap    = Object.fromEntries(spamSettings.map(r => [
    r.key,
    r.key === 'spam_perspective_key' ? decryptSetting(r.value) : r.value,
  ]));
  const spamResult = await checkSpam(clean, spamMap);

  if (spamResult.action === 'block') {
    // Generic message — don't reveal why it was blocked
    return res.status(400).json({ error: 'Your comment could not be posted. Please review our community guidelines.' });
  }

  // ── Moderation queue check ────────────────────────────────────────
  // Load settings; default to queue disabled so existing deploys are unaffected
  const modSettings = await db.prepare(
    `SELECT key, value FROM settings WHERE tenant_id = $1 AND key IN ('mod_queue_enabled', 'mod_queue_threshold')`
  ).all(req.tenantId);
  const modMap      = Object.fromEntries(modSettings.map(r => [r.key, r.value]));
  const queueOn     = modMap.mod_queue_enabled === '1';
  const threshold   = parseInt(modMap.mod_queue_threshold || '1', 10);

  let isApproved = 1; // default: auto-approve
  if (spamResult.action === 'queue') {
    // Perspective flagged it — always queue regardless of user trust
    isApproved = 0;
  } else if (queueOn) {
    // Count how many approved comments this user already has
    const approvedRow = await db.prepare(
      `SELECT COUNT(*) AS cnt FROM comments WHERE user_id = $1 AND tenant_id = $2 AND is_approved = 1 AND is_deleted = 0`
    ).get(req.user.sub, req.tenantId);
    const approvedCount = parseInt(approvedRow?.cnt ?? 0, 10);
    isApproved = approvedCount >= threshold ? 1 : 0;
  }

  const row = await db.prepare(`
    INSERT INTO comments (article_slug, user_id, body, parent_id, is_approved, spam_score, spam_reason, tenant_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *
  `).get(slug, req.user.sub, clean, parentId || null, isApproved, spamResult.score ?? null, spamResult.reason ?? null, req.tenantId);

  // Attach user info for immediate render
  const user = await db.prepare(
    'SELECT display_name, avatar_url, provider FROM public_users WHERE id = $1'
  ).get(req.user.sub);

  // If queued, return a pending signal instead of the full comment
  if (!isApproved) {
    return res.status(202).json({
      queued:  true,
      message: 'Your comment is pending review and will appear once approved.',
    });
  }

  // ── Reply notification ────────────────────────────────────────────
  // Fire-and-forget: don't let email failure affect the response
  const replierId = req.user.sub;
  if (parentId && isApproved) {
    setImmediate(async () => {
      try {
        // Fetch parent comment + its author's notification prefs
        const parent = await db.prepare(`
          SELECT c.id, c.user_id, c.body,
                 u.email, u.display_name, u.provider,
                 u.notify_replies, u.notify_token
          FROM comments c
          JOIN public_users u ON u.id = c.user_id
          WHERE c.id = $1 AND c.tenant_id = $2 AND c.is_deleted = 0
        `).get(parentId, req.tenantId);

        if (!parent) { console.warn('[Notify] Parent comment not found:', parentId); return; }

        // Don't notify if replying to yourself
        if (parent.user_id === replierId) return;

        // Fetch replier's display name fresh from DB
        const replierRow = await db.prepare(
          'SELECT display_name FROM public_users WHERE id = $1'
        ).get(replierId);
        const replierName = replierRow?.display_name || 'Someone';

        // Best-effort article title lookup
        const slugWord = (slug || '').split('-').slice(0, 5).join(' ');
        const article  = await db.prepare(
          `SELECT title FROM articles WHERE LOWER(title) LIKE $1 AND tenant_id = $2 AND is_published = 1 LIMIT 1`
        ).get(`%${slugWord}%`, req.tenantId);

        // In-app notification — always created (regardless of email opt-out)
        await createReplyNotification(parent.user_id, {
          commentId:    parent.id,
          articleSlug:  slug,
          articleTitle: article?.title || slug,
          replyBody:    clean.slice(0, 200),
          replyerName:  replierName,
        }, req.tenantId);

        // Email notification — only if user has email and is opted in
        if (!parent.email) { console.warn('[Notify] Parent user has no email, skipping email'); return; }

        // notify_replies defaults to 1 — treat NULL as opted-in (migration may not have run yet)
        if (parent.notify_replies === 0) { console.warn('[Notify] User opted out of email'); return; }

        // If notify_token is missing (migration not yet applied), generate one on the fly
        let unsubToken = parent.notify_token;
        if (!unsubToken) {
          const crypto = require('crypto');
          unsubToken = crypto.randomBytes(24).toString('hex');
          await db.prepare(
            'UPDATE public_users SET notify_token = $1 WHERE id = $2'
          ).run(unsubToken, parent.user_id);
        }

        console.log(`[Notify] Sending reply notification to ${parent.email} (parent comment #${parent.id})`);

        await sendReplyNotification({
          toEmail:      parent.email,
          toName:       parent.display_name,
          replierName,
          articleSlug:  slug,
          articleTitle: article?.title || slug,
          replyBody:    clean,
          commentId:    parent.id,   // was parent.user_id — BUG FIX
          unsubToken,
        }, req.tenantId);

        console.log(`[Notify] Reply notification sent to ${parent.email}`);
      } catch (err) {
        console.warn('[Notify] Reply notification failed:', err.message, err.stack);
      }
    });
  }

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
    'SELECT * FROM comments WHERE id = $1 AND tenant_id = $2 AND is_deleted = 0'
  ).get(id, req.tenantId);
  if (!existing) return res.status(404).json({ error: 'Comment not found' });
  if (existing.user_id !== req.user.sub) return res.status(403).json({ error: 'Forbidden' });

  // Enforce 10-minute edit window
  const age = Date.now() - new Date(existing.created_at).getTime();
  if (age > EDIT_WINDOW_MS) {
    return res.status(403).json({ error: 'Edit window has closed (10 minutes after posting)' });
  }

  const updated = await db.prepare(`
    UPDATE comments SET body = $1, updated_at = NOW()
    WHERE id = $2 AND tenant_id = $3 RETURNING *
  `).get(clean, id, req.tenantId);

  const user = await db.prepare(
    'SELECT display_name, avatar_url, provider FROM public_users WHERE id = $1'
  ).get(req.user.sub);

  res.json({ comment: formatComment({ ...updated, ...user }) });
}));

/* ── DELETE /api/comments/:id — soft-delete own comment ─────────── */
router.delete('/:id', requireUser, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);

  const existing = await db.prepare(
    'SELECT * FROM comments WHERE id = $1 AND tenant_id = $2 AND is_deleted = 0'
  ).get(id, req.tenantId);
  if (!existing) return res.status(404).json({ error: 'Comment not found' });
  if (existing.user_id !== req.user.sub) return res.status(403).json({ error: 'Forbidden' });

  await db.prepare(
    'UPDATE comments SET is_deleted = 1, body = NULL, updated_at = NOW() WHERE id = $1 AND tenant_id = $2'
  ).run(id, req.tenantId);

  res.json({ ok: true });
}));

/* ── POST /api/comments/:id/report ──────────────────────────────── */
router.post('/:id/report', requireUser, asyncHandler(async (req, res) => {
  const id     = parseInt(req.params.id, 10);
  const reason = (req.body.reason || '').slice(0, 200) || null;

  const existing = await db.prepare(
    'SELECT id FROM comments WHERE id = $1 AND tenant_id = $2 AND is_deleted = 0'
  ).get(id, req.tenantId);
  if (!existing) return res.status(404).json({ error: 'Comment not found' });

  // Can't report your own comment
  const comment = await db.prepare('SELECT user_id FROM comments WHERE id = $1 AND tenant_id = $2').get(id, req.tenantId);
  if (comment.user_id === req.user.sub) {
    return res.status(400).json({ error: "You can't report your own comment" });
  }

  try {
    await db.prepare(
      'INSERT INTO comment_reports (comment_id, user_id, reason, tenant_id) VALUES ($1, $2, $3, $4)'
    ).run(id, req.user.sub, reason, req.tenantId);
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
    'SELECT id, user_id FROM comments WHERE id = $1 AND tenant_id = $2 AND is_deleted = 0'
  ).get(id, req.tenantId);
  if (!comment) return res.status(404).json({ error: 'Comment not found' });

  // Fetch any existing reaction from this user
  const existing = await db.prepare(
    'SELECT emoji FROM comment_reactions WHERE comment_id = $1 AND user_id = $2 AND tenant_id = $3'
  ).get(id, req.user.sub, req.tenantId);

  if (!emoji || (existing && existing.emoji === emoji)) {
    // Remove reaction (toggle off or explicit remove)
    await db.prepare(
      'DELETE FROM comment_reactions WHERE comment_id = $1 AND user_id = $2 AND tenant_id = $3'
    ).run(id, req.user.sub, req.tenantId);
  } else if (existing) {
    // Swap to different emoji
    await db.prepare(
      'UPDATE comment_reactions SET emoji = $1 WHERE comment_id = $2 AND user_id = $3 AND tenant_id = $4'
    ).run(emoji, id, req.user.sub, req.tenantId);
  } else {
    // New reaction
    await db.prepare(
      'INSERT INTO comment_reactions (comment_id, user_id, emoji, tenant_id) VALUES ($1, $2, $3, $4)'
    ).run(id, req.user.sub, emoji, req.tenantId);
  }

  // Return fresh counts for this comment
  const counts = await db.prepare(`
    SELECT emoji, COUNT(*) AS cnt
    FROM comment_reactions WHERE comment_id = $1 AND tenant_id = $2
    GROUP BY emoji
  `).all(id, req.tenantId);

  const reactions = {};
  for (const r of counts) reactions[r.emoji] = parseInt(r.cnt, 10);

  const myReaction = (!emoji || (existing && existing.emoji === emoji))
    ? null
    : emoji;

  res.json({ ok: true, reactions, myReaction });
}));

/* ── Admin: GET /api/comments/admin/queue ────────────────────────── */
router.get('/admin/queue', requireAdmin, requirePermission('comments.read'), asyncHandler(async (req, res) => {
  const rows = await db.prepare(`
    SELECT
      c.id, c.article_slug, c.parent_id, c.body, c.is_deleted, c.is_approved,
      c.spam_score, c.spam_reason,
      c.created_at, c.updated_at, c.user_id,
      u.display_name, u.avatar_url, u.provider,
      (SELECT COUNT(*) FROM comments ac WHERE ac.user_id = c.user_id AND ac.tenant_id = $1 AND ac.is_approved = 1 AND ac.is_deleted = 0) AS prior_approved
    FROM comments c
    LEFT JOIN public_users u ON u.id = c.user_id
    WHERE c.is_approved = 0 AND c.is_deleted = 0 AND c.tenant_id = $1
    ORDER BY c.spam_score DESC NULLS LAST, c.created_at ASC
  `).all(req.tenantId);

  res.json({
    queue: rows.map(r => ({
      ...formatComment(r),
      priorApproved: parseInt(r.prior_approved, 10),
    })),
  });
}));

/* ── Admin: POST /api/comments/admin/:id/approve ─────────────────── */
router.post('/admin/:id/approve', requireAdmin, requirePermission('comments.moderate'), asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await db.prepare(
    'UPDATE comments SET is_approved = 1, updated_at = NOW() WHERE id = $1 AND tenant_id = $2'
  ).run(id, req.tenantId);
  await logAudit(req, 'comment.approve', 'comment', id, { commentId: id });
  res.json({ ok: true });
}));

/* ── Admin: POST /api/comments/admin/:id/reject ──────────────────── */
router.post('/admin/:id/reject', requireAdmin, requirePermission('comments.moderate'), asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  // Hard-delete — rejected spam shouldn't leave a tombstone
  await db.prepare('DELETE FROM comments WHERE id = $1 AND tenant_id = $2').run(id, req.tenantId);
  await logAudit(req, 'comment.reject', 'comment', id, { commentId: id });
  res.json({ ok: true });
}));

/* ── Admin: GET /api/comments/admin ──────────────────────────────── */
router.get('/admin', requireAdmin, requirePermission('comments.read'), asyncHandler(async (req, res) => {
  const { slug, reported } = req.query;

  const params = [req.tenantId];
  let sql = `
    SELECT
      c.id, c.article_slug, c.parent_id, c.body, c.is_deleted,
      c.created_at, c.updated_at, c.user_id,
      u.display_name, u.avatar_url, u.provider,
      (SELECT COUNT(*) FROM comment_reports r WHERE r.comment_id = c.id AND r.tenant_id = $1) AS report_count
    FROM comments c
    LEFT JOIN public_users u ON u.id = c.user_id
    WHERE c.tenant_id = $1
  `;

  if (slug) {
    params.push(slug);
    sql += ` AND c.article_slug = $${params.length}`;
  }
  if (reported === '1') {
    sql += ` AND (SELECT COUNT(*) FROM comment_reports r WHERE r.comment_id = c.id AND r.tenant_id = $1) > 0`;
  }

  sql += ' ORDER BY c.created_at DESC';

  const rows = await db.prepare(sql).all(...params);
  res.json({ comments: rows.map(r => ({ ...formatComment(r), reportCount: parseInt(r.report_count, 10) })) });
}));

/* ── Admin: POST /api/comments/admin/:id/restore ────────────────────── */
// Un-hides a comment — works as long as the row still exists.
router.post('/admin/:id/restore', requireAdmin, requirePermission('comments.moderate'), asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = await db.prepare('SELECT id FROM comments WHERE id = $1 AND tenant_id = $2').get(id, req.tenantId);
  if (!row) return res.status(404).json({ error: 'Comment not found' });
  await db.prepare(
    'UPDATE comments SET is_deleted = 0, updated_at = NOW() WHERE id = $1 AND tenant_id = $2'
  ).run(id, req.tenantId);
  await logAudit(req, 'comment.restore', 'comment', id, { commentId: id });
  res.json({ ok: true });
}));

/* ── Admin: POST /api/comments/admin/:id/hide ─────────────────────── */
// Soft-hides a comment — sets is_deleted=1 but PRESERVES the body so the
// comment can be fully restored later via /restore. Reports are cleared.
// Use DELETE /admin/:id for permanent removal.
router.post('/admin/:id/hide', requireAdmin, requirePermission('comments.moderate'), asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await db.prepare(
    'UPDATE comments SET is_deleted = 1, updated_at = NOW() WHERE id = $1 AND tenant_id = $2'
  ).run(id, req.tenantId);
  // Clear reports after hiding — no further action needed on those
  await db.prepare('DELETE FROM comment_reports WHERE comment_id = $1 AND tenant_id = $2').run(id, req.tenantId);
  await logAudit(req, 'comment.hide', 'comment', id, { commentId: id });
  res.json({ ok: true });
}));

/* ── Admin: DELETE /api/comments/admin/:id ────────────────────────── */
router.delete('/admin/:id', requireAdmin, requirePermission('comments.delete'), asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await db.prepare('DELETE FROM comments WHERE id = $1 AND tenant_id = $2').run(id, req.tenantId);
  await logAudit(req, 'comment.delete', 'comment', id, { commentId: id });
  res.json({ ok: true });
}));

/* ── Admin: POST /api/comments/admin/bulk ─────────────────────────── */
// body: { ids: number[], action: 'approve' | 'hide' | 'delete' }
router.post('/admin/bulk', requireAdmin, requirePermission('comments.moderate'), asyncHandler(async (req, res) => {
  const { ids, action } = req.body;

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids must be a non-empty array' });
  }
  if (!['approve', 'hide', 'delete'].includes(action)) {
    return res.status(400).json({ error: 'action must be approve | hide | delete' });
  }

  const validIds = ids.map(id => parseInt(id, 10)).filter(n => Number.isFinite(n));
  const placeholders = validIds.map((_, i) => `$${i + 1}`).join(', ');
  const tenantParam = `$${validIds.length + 1}`;

  if (action === 'approve') {
    await db.prepare(
      `UPDATE comments SET is_approved = 1, updated_at = NOW() WHERE id IN (${placeholders}) AND tenant_id = ${tenantParam}`
    ).run(...validIds, req.tenantId);
  } else if (action === 'hide') {
    await db.prepare(
      `UPDATE comments SET is_deleted = 1, updated_at = NOW() WHERE id IN (${placeholders}) AND tenant_id = ${tenantParam}`
    ).run(...validIds, req.tenantId);
    await db.prepare(
      `DELETE FROM comment_reports WHERE comment_id IN (${placeholders}) AND tenant_id = ${tenantParam}`
    ).run(...validIds, req.tenantId);
  } else if (action === 'delete') {
    await db.prepare(
      `DELETE FROM comments WHERE id IN (${placeholders}) AND tenant_id = ${tenantParam}`
    ).run(...validIds, req.tenantId);
  }

  await logAudit(req, 'comment.bulk', 'comment', null, { action, ids: validIds, count: validIds.length });
  res.json({ ok: true, affected: validIds.length });
}));

module.exports = router;
